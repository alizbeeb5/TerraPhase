"""Export a small, self-contained Canopy Watch case from two local GCOV products."""
from base64 import b64encode
from datetime import datetime, timezone
from io import BytesIO
import json
import math
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

import h5py
import numpy as np
from PIL import Image
import rasterio
from rasterio.transform import array_bounds, from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import from_bounds

from gcov_product import read_layer

CHANNELS = {"HH": "HHHH", "HV": "HVHV"}
DISPLAY_DB = {"HH": (-30, 5), "HV": (-36, -3)}
MAX_NATIVE_PIXELS = 8_000_000
MAP_LIMIT = 800
DEM_SIZE = 65
DEM_SOURCE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"


def scene_metadata(path):
    parts = path.stem.split("_")
    if len(parts) < 15 or parts[:4] != ["NISAR", "L2", "PR", "GCOV"]:
        raise ValueError(f"Expected an original NISAR L2 production GCOV filename: {path.name}")
    acquired = datetime.strptime(parts[11], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    return {"id": path.stem, "date": acquired.isoformat(), "track": parts[5],
            "pass": parts[6], "frame": parts[7], "bandwidth": parts[8],
            "polarization": parts[9], "release": parts[13]}


def resolve_scene(folder, acquisition):
    key = datetime.strptime(acquisition, "%Y-%m-%d").strftime("%Y%m%d")
    paths = sorted(Path(folder).glob(f"NISAR_L2_PR_GCOV_*_{key}T*.h5"))
    if len(paths) != 1:
        raise ValueError(f"Found {len(paths)} files for {acquisition}. Set its full filename in the options.")
    return paths[0]


def read_power(file, layer, window):
    row0 = max(0, math.floor(window.row_off) - 2)
    col0 = max(0, math.floor(window.col_off) - 2)
    row1 = min(layer.shape[0], math.ceil(window.row_off + window.height) + 2)
    col1 = min(layer.shape[1], math.ceil(window.col_off + window.width) + 2)
    height, width = row1 - row0, col1 - col0
    if min(height, width) < 1 or height * width > MAX_NATIVE_PIXELS:
        raise ValueError("The selected window has no coverage or is too large. Adjust the bounding box.")
    selection = np.s_[row0:row1, col0:col1]
    dataset = file[layer.path]
    power = dataset[selection].astype(np.float32)
    valid = np.isfinite(power) & (power > 0)
    if layer.fill is not None and np.isfinite(layer.fill):
        valid &= power != layer.fill
    if "mask" in dataset.parent:
        mask = dataset.parent["mask"][selection]
        valid &= (mask > 0) & (mask < 255)
    power[~valid] = np.nan
    return power, layer.transform * rasterio.Affine.translation(col0, row0)


def aligned_layer(file, band, bounds, target_crs, transform, shape):
    layer = read_layer(file, f"/science/LSAR/GCOV/grids/frequencyA/{CHANNELS[band]}")
    source_bounds = transform_bounds(target_crs, layer.crs, *bounds, densify_pts=21)
    power, source_transform = read_power(file, layer, from_bounds(*source_bounds, transform=layer.transform))
    aligned = np.full(shape, np.nan, np.float32)
    reproject(power, aligned, src_transform=source_transform, src_crs=layer.crs, src_nodata=np.nan,
              dst_transform=transform, dst_crs=target_crs, dst_nodata=np.nan, resampling=Resampling.average)
    # Require complete sampled coverage where the input contains invalid pixels.
    coverage = np.zeros(shape, np.float32)
    reproject(np.isfinite(power).astype(np.float32), coverage, src_transform=source_transform,
              src_crs=layer.crs, dst_transform=transform, dst_crs=target_crs, resampling=Resampling.average)
    aligned[coverage < 0.999] = np.nan
    return aligned


def render(values, limits, change=False):
    valid = np.isfinite(values)
    t = np.clip((np.where(valid, values, 0) - limits[0]) / (limits[1] - limits[0]), 0, 1)
    colors = np.array([[40, 195, 214], [39, 46, 54], [255, 159, 79]]) if change else np.array(
        [[14, 21, 23], [221, 234, 223]])
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    for channel in range(3):
        rgba[..., channel] = np.interp(t, np.linspace(0, 1, len(colors)), colors[:, channel]).round()
    rgba[..., 3] = valid * 255
    with BytesIO() as output:
        Image.fromarray(rgba).save(output, "WEBP", lossless=True, method=4)
        return "data:image/webp;base64," + b64encode(output.getvalue()).decode("ascii")


def terrain(bounds, crs, dem_path):
    left, bottom, right, top = bounds
    dx, dy = (right - left) / (DEM_SIZE - 1), (top - bottom) / (DEM_SIZE - 1)
    grid = from_origin(left - dx / 2, top + dy / 2, dx, dy)
    height = np.full((DEM_SIZE, DEM_SIZE), np.nan, np.float32)
    try:
        if dem_path:
            with rasterio.open(dem_path) as source:
                reproject(rasterio.band(source, 1), height, dst_transform=grid, dst_crs=crs,
                          dst_nodata=np.nan, resampling=Resampling.bilinear)
            label = "Supplied DEM (metres)"
        else:
            extent = array_bounds(DEM_SIZE, DEM_SIZE, grid)
            query = urlencode({"bbox": ",".join(map(str, extent)), "bboxSR": crs.to_epsg(),
                               "imageSR": crs.to_epsg(), "size": f"{DEM_SIZE},{DEM_SIZE}",
                               "format": "tiff", "pixelType": "F32", "adjustAspectRatio": "false",
                               "interpolation": "RSP_BilinearInterpolation", "f": "image"})
            with urlopen(f"{DEM_SOURCE}/exportImage?{query}", timeout=30) as reply:
                data = reply.read(4_000_001)
            if len(data) > 4_000_000:
                raise ValueError("Elevation response exceeded 4 MB.")
            with rasterio.MemoryFile(data) as memory, memory.open() as source:
                if source.count != 1 or source.crs is None:
                    raise ValueError("The elevation service returned an unexpected raster.")
                reproject(rasterio.band(source, 1), height, dst_transform=grid, dst_crs=crs,
                          dst_nodata=np.nan, resampling=Resampling.bilinear)
            label = "USGS 3DEP"
        if not np.isfinite(height).all() or np.any((height < -500) | (height > 9000)):
            raise ValueError("Elevation grid has missing or invalid samples.")
        return {"size": DEM_SIZE, "elevation": height.round(2).ravel().tolist(), "source": label}
    except (OSError, ValueError, rasterio.errors.RasterioError) as exc:
        print(f"Terrain unavailable: {exc}. For 3D, provide a DEM GeoTIFF in metres and rerun.")
        return None


def export_comparison(before_path, after_path, bbox, label, output, dem_path=None, threshold=3.0):
    before_path, after_path, output = map(Path, (before_path, after_path, output))
    if not math.isfinite(threshold) or threshold <= 0:
        raise ValueError("Choose a positive change threshold in dB.")
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
        raise ValueError("Use a valid west, south, east, north bounding box.")
    before_info, after_info = map(scene_metadata, (before_path, after_path))
    for key in ("track", "pass", "frame", "bandwidth", "polarization", "release"):
        if before_info[key] != after_info[key]:
            raise ValueError(f"Select a repeat-pass pair with matching {key}.")
    if before_info["date"] >= after_info["date"]:
        raise ValueError("The before acquisition must precede the after acquisition.")

    with h5py.File(before_path, "r") as first, h5py.File(after_path, "r") as last:
        anchor = read_layer(first, "/science/LSAR/GCOV/grids/frequencyA/HVHV")
        box = transform_bounds("EPSG:4326", anchor.crs, *bbox, densify_pts=21)
        native = from_bounds(*box, transform=anchor.transform)
        factor = max(1, math.ceil(max(native.width, native.height) / MAP_LIMIT))
        x0, y0 = math.floor(native.col_off), math.floor(native.row_off)
        cols = math.ceil((native.col_off + native.width - x0) / factor)
        rows = math.ceil((native.row_off + native.height - y0) / factor)
        transform = anchor.transform * rasterio.Affine.translation(x0, y0) * rasterio.Affine.scale(factor)
        bounds = array_bounds(rows, cols, transform)
        output_layers = {}
        for channel in CHANNELS:
            print(f"Reading {channel} from both HDF5 files…", flush=True)
            power_before = aligned_layer(first, channel, bounds, anchor.crs, transform, (rows, cols))
            power_after = aligned_layer(last, channel, bounds, anchor.crs, transform, (rows, cols))
            db_before, db_after = 10 * np.log10(power_before), 10 * np.log10(power_after)
            valid = np.isfinite(db_before) & np.isfinite(db_after)
            if not valid.any():
                raise ValueError(f"No shared valid {channel} pixels. Check the region and scene dates.")
            delta = db_after - db_before
            db_before[~valid] = db_after[~valid] = np.nan
            pixel_area_km2 = abs(transform.a * transform.e) / 1e6
            output_layers[channel] = {
                "before": render(db_before, DISPLAY_DB[channel]),
                "after": render(db_after, DISPLAY_DB[channel]),
                "change": render(delta, (-8, 8), change=True),
                "range": list(DISPLAY_DB[channel]),
                "validPct": round(100 * valid.mean(), 1),
                "medianDb": round(float(np.nanmedian(delta)), 2),
                "dropKm2": round(float(np.count_nonzero(delta <= -threshold) * pixel_area_km2), 3),
                "riseKm2": round(float(np.count_nonzero(delta >= threshold) * pixel_area_km2), 3),
            }
    print("Sampling elevation on the comparison grid…", flush=True)
    package = {
        "schema": "canopy-watch-comparison/v1", "label": label,
        "scenes": [before_info, after_info], "bbox": list(bbox),
        "grid": {"width": cols, "height": rows, "widthM": bounds[2] - bounds[0],
                 "heightM": bounds[3] - bounds[1], "bounds": list(bounds),
                 "epsg": anchor.crs.to_epsg(), "spacingM": transform.a},
        "thresholdDb": threshold, "layers": output_layers,
        "terrain": terrain(bounds, anchor.crs, dem_path),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(package, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    temporary.replace(output)
    print(f"Saved {output.name} ({output.stat().st_size / 1e6:.2f} MB)")
    return output
