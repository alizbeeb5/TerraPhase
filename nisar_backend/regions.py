"""Geographic AOIs shared by 2D clipping, 3D textures and native exports."""

from contextlib import ExitStack
from hashlib import sha256
import math
from pathlib import Path
from threading import Lock
from uuid import uuid4

import numpy as np
from pyproj import Geod, Transformer
import rasterio
from rasterio import shutil as rio_shutil
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform, transform_bounds
from rasterio.windows import Window, from_bounds as window_from_bounds
from shapely.geometry import box, shape

from .render import colorize, overview_level

WGS84 = Geod(ellps="WGS84")
export_lock = Lock()
MAX_CROP_PIXELS = 64_000_000


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    try:
        bounds = tuple(float(part.strip()) for part in value.split(","))
    except (ValueError, AttributeError):
        raise ValueError("Use bbox=west,south,east,north in longitude/latitude.") from None
    if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds):
        raise ValueError("The selection needs four finite coordinates.")
    west, south, east, north = bounds
    if not (-180 <= west < east <= 180 and -85.05112878 <= south < north <= 85.05112878):
        raise ValueError("Select a nonzero rectangle within the map; antimeridian selections are unsupported.")
    return bounds


def mercator_bounds(bounds):
    return transform_bounds("EPSG:4326", "EPSG:3857", *bounds)


def dimensions_m(bounds):
    west, south, east, north = bounds
    _, _, width = WGS84.inv(west, (south + north) / 2, east, (south + north) / 2)
    _, _, height = WGS84.inv((west + east) / 2, south, (west + east) / 2, north)
    return abs(width), abs(height)


def clip_mask(power, transform, bounds):
    """Mask by output pixel centres; bounds and transform are both Web Mercator."""
    left, bottom, right, top = bounds
    x = transform.c + (np.arange(power.shape[1]) + .5) * transform.a
    y = transform.f + (np.arange(power.shape[0]) + .5) * transform.e
    outside = (x[None, :] < left) | (x[None, :] >= right) | (y[:, None] <= bottom) | (y[:, None] > top)
    return np.ma.array(power, mask=np.ma.getmaskarray(power) | outside)


def read_region_power(cog, bounds, width=512, height=512):
    """Read a bounded texture in the SAME Mercator extent used by the DEM mesh."""
    projected = mercator_bounds(bounds)
    transform = from_bounds(*projected, width, height)
    with ExitStack() as stack:
        native = stack.enter_context(rasterio.open(cog))
        web_transform, _, _ = calculate_default_transform(native.crs, "EPSG:3857", native.width, native.height, *native.bounds)
        level = overview_level(max(abs(web_transform.a), abs(web_transform.e)),
                               min(abs(transform.a), abs(transform.e)), native.overviews(1))
        source = native if level is None else stack.enter_context(rasterio.open(cog, overview_level=level))
        vrt = stack.enter_context(WarpedVRT(source, crs="EPSG:3857", transform=transform,
                                           width=width, height=height, nodata=np.nan,
                                           src_nodata=np.nan, resampling=Resampling.average,
                                           warp_mem_limit=64))
        return vrt.read(1, masked=True)


def texture_dimensions(bounds, size):
    left, bottom, right, top = mercator_bounds(bounds)
    ratio = (right - left) / (top - bottom)
    return (size, max(1, round(size / ratio))) if ratio >= 1 else (max(1, round(size * ratio)), size)


def region_texture(cog, bounds, size, low, high, cmap):
    width, height = texture_dimensions(bounds, size)
    return colorize(read_region_power(cog, bounds, width, height), low, high, cmap)


def native_window(source, bounds):
    projected = transform_bounds("EPSG:4326", source.crs, *bounds, densify_pts=41)
    window = window_from_bounds(*projected, source.transform)
    # Include every native pixel whose centre might be in the selection.
    col0 = max(0, math.floor(window.col_off))
    row0 = max(0, math.floor(window.row_off))
    col1 = min(source.width, math.ceil(window.col_off + window.width))
    row1 = min(source.height, math.ceil(window.row_off + window.height))
    if col1 <= col0 or row1 <= row0:
        raise ValueError("The selection does not overlap the image grid.")
    return Window(col0, row0, col1 - col0, row1 - row0)


def region_info(cog, requested, footprint):
    if shape(footprint).intersection(box(*requested)).area <= 0:
        raise ValueError("No downloaded NISAR coverage in that selection. Select inside the outlined scene.")
    with rasterio.open(cog) as source:
        extent = transform_bounds(source.crs, "EPSG:4326", *source.bounds, densify_pts=41)
        bounds = (max(requested[0], extent[0]), max(requested[1], extent[1]),
                  min(requested[2], extent[2]), min(requested[3], extent[3]))
        window = native_window(source, bounds)
        spacing = list(source.res)
    sample = read_region_power(cog, bounds, 96, 96)
    finite = ~np.ma.getmaskarray(sample) & np.isfinite(sample.data) & (sample.data > 0)
    if not finite.any():
        raise ValueError("No usable backscatter was found in the selected area.")
    width_m, height_m = dimensions_m(bounds)
    return {"requested_bbox": list(requested), "bbox": list(bounds),
            "clipped_to_grid": tuple(bounds) != tuple(requested),
            "native_width": int(window.width), "native_height": int(window.height),
            "native_pixel_count": int(window.width * window.height), "pixel_spacing_m": spacing,
            "width_m": width_m, "height_m": height_m,
            "crop_download_available": window.width * window.height <= MAX_CROP_PIXELS,
            "sampled_data_fraction": float(finite.mean())}


def export_crop(cog: Path, bounds, cache: Path) -> Path:
    """Lossless, native-grid crop; pixels outside the geographic rectangle are NaN."""
    with rasterio.open(cog) as source:
        window = native_window(source, bounds)
        if window.width * window.height > MAX_CROP_PIXELS:
            raise ValueError("Select a smaller area for a cropped download (maximum 64 million pixels), or download the whole scene.")
    key = sha256((str(cog.resolve()) + repr(tuple(bounds))).encode()).hexdigest()[:24]
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / f"{key}.tif"
    with export_lock:
        if destination.is_file():
            return destination
        temporary = cache / f"{key}.{uuid4().hex}.working.tif"
        pending = cache / f"{key}.{uuid4().hex}.pending.tif"
        try:
            with rasterio.open(cog) as source:
                profile = source.profile.copy()
                profile.update(driver="GTiff", width=int(window.width), height=int(window.height),
                               transform=source.window_transform(window), nodata=np.nan,
                               tiled=True, blockxsize=512, blockysize=512,
                               compress="DEFLATE", predictor=3, zlevel=1, BIGTIFF="IF_SAFER")
                to_wgs = Transformer.from_crs(source.crs, 4326, always_xy=True)
                with rasterio.open(temporary, "w", **profile) as target:
                    for _, block in target.block_windows(1):
                        original = Window(window.col_off + block.col_off, window.row_off + block.row_off,
                                          block.width, block.height)
                        values = source.read(1, window=original)
                        transform = target.window_transform(block)
                        x = transform.c + (np.arange(int(block.width)) + .5) * transform.a
                        y = transform.f + (np.arange(int(block.height)) + .5) * transform.e
                        longitude, latitude = to_wgs.transform(*np.meshgrid(x, y))
                        valid = ((longitude >= bounds[0]) & (longitude < bounds[2]) &
                                 (latitude > bounds[1]) & (latitude <= bounds[3]))
                        values[~valid] = np.nan
                        target.write(values, 1, window=block)
                    target.update_tags(radiometry="gamma0 linear power", selection_wgs84=repr(tuple(bounds)))
            rio_shutil.copy(temporary, pending, driver="COG", compress="DEFLATE", level=1,
                            predictor="FLOATING_POINT", overview_resampling="AVERAGE")
            pending.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
            pending.unlink(missing_ok=True)
    return destination
