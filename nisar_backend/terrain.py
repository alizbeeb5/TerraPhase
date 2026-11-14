"""Real DEM sampling on the exact Web Mercator extent of the radar texture.

Prefer GCOV_DEM_PATH (a georeferenced elevation GeoTIFF in metres), otherwise
use public Mapzen Terrain Tiles. Never substitute procedural heights on failure.
"""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import math
import os
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import uuid4

import numpy as np
from PIL import Image
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.vrt import WarpedVRT

from .regions import dimensions_m, mercator_bounds, parse_bbox
from .render import WEB_MERCATOR_LIMIT

WORLD = 2 * WEB_MERCATOR_LIMIT
TILE_ENDPOINT = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"
ATTRIBUTION = "Mapzen Terrain Tiles; SRTM/GMTED2010 courtesy of USGS; ETOPO1 courtesy of NOAA."
ATTRIBUTION_URL = "https://github.com/tilezen/joerd/blob/master/docs/attribution.md"


class TerrainUnavailable(RuntimeError):
    pass


def decode_terrarium(pixels):
    rgb = np.asarray(pixels, dtype=np.float32)
    heights = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
    if rgb.shape[-1] == 4:
        heights[rgb[..., 3] == 0] = np.nan
    heights[heights <= -32768] = np.nan
    return heights


def fetch_tile(cache: Path, z: int, x: int, y: int):
    path = cache / str(z) / str(x) / f"{y}.png"
    if path.is_file():
        data = path.read_bytes()
    else:
        url = f"{TILE_ENDPOINT}/{z}/{x}/{y}.png"
        try:
            with urlopen(Request(url, headers={"User-Agent": "TerraPhase-GCOV/0.1"}), timeout=20) as response:
                data = response.read(1_048_577)
            if len(data) > 1_048_576:
                raise TerrainUnavailable("The elevation service returned an oversized tile.")
        except (URLError, TimeoutError, OSError) as error:
            raise TerrainUnavailable("Could not load elevation data. Check your Internet connection or configure GCOV_DEM_PATH with a local DEM.") from error
    try:
        with Image.open(BytesIO(data)) as image:
            if image.size != (256, 256):
                raise TerrainUnavailable("An elevation tile has unexpected dimensions.")
            heights = decode_terrarium(image.convert("RGBA"))
    except (OSError, ValueError) as error:
        raise TerrainUnavailable("An elevation tile could not be decoded.") from error
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        pending = path.with_name(f"{y}.{uuid4().hex}.pending")
        try:
            pending.write_bytes(data)
            pending.replace(path)
        finally:
            pending.unlink(missing_ok=True)
    return heights


def tile_plan(bounds, grid):
    left, bottom, right, top = mercator_bounds(bounds)
    step = min((right - left) / (grid - 1), (top - bottom) / (grid - 1))
    zoom = min(14, max(0, math.ceil(math.log2(WORLD / (256 * step)))))
    while True:
        factor = 256 * 2**zoom / WORLD
        x0, x1 = (left + WEB_MERCATOR_LIMIT) * factor - .5, (right + WEB_MERCATOR_LIMIT) * factor - .5
        y0, y1 = (WEB_MERCATOR_LIMIT - top) * factor - .5, (WEB_MERCATOR_LIMIT - bottom) * factor - .5
        max_tile = 2**zoom - 1
        first_x, last_x = max(0, math.floor(x0 / 256)), min(max_tile, math.floor((x1 + 1) / 256))
        first_y, last_y = max(0, math.floor(y0 / 256)), min(max_tile, math.floor((y1 + 1) / 256))
        if (last_x - first_x + 1) * (last_y - first_y + 1) <= 16 or zoom == 0:
            return zoom, (first_x, first_y, last_x, last_y), (x0, y0, x1, y1)
        zoom -= 1


def public_dem(bounds, grid, cache):
    zoom, (first_x, first_y, last_x, last_y), (x0, y0, x1, y1) = tile_plan(bounds, grid)
    coordinates = [(x, y) for y in range(first_y, last_y + 1) for x in range(first_x, last_x + 1)]
    mosaic = np.empty(((last_y - first_y + 1) * 256, (last_x - first_x + 1) * 256), dtype=np.float32)
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = [pool.submit(fetch_tile, cache, zoom, x, y) for x, y in coordinates]
        for (x, y), job in zip(coordinates, jobs):
            mosaic[(y-first_y)*256:(y-first_y+1)*256, (x-first_x)*256:(x-first_x+1)*256] = job.result()
    px, py = np.meshgrid(np.linspace(x0, x1, grid) - first_x * 256,
                         np.linspace(y0, y1, grid) - first_y * 256)
    px = np.clip(px, 0, mosaic.shape[1] - 1)
    py = np.clip(py, 0, mosaic.shape[0] - 1)
    ix, iy = np.floor(px).astype(int), np.floor(py).astype(int)
    jx, jy = np.minimum(ix + 1, mosaic.shape[1] - 1), np.minimum(iy + 1, mosaic.shape[0] - 1)
    dx, dy = px - ix, py - iy
    # Decode elevation BEFORE interpolating; RGB interpolation can corrupt carries.
    heights = ((mosaic[iy, ix] * (1-dx) + mosaic[iy, jx] * dx) * (1-dy) +
               (mosaic[jy, ix] * (1-dx) + mosaic[jy, jx] * dx) * dy)
    return heights, {"name": "Mapzen Terrain Tiles (real DEM)", "tile_zoom": zoom,
                     "tiles_used": len(coordinates), "attribution": ATTRIBUTION,
                     "attribution_url": ATTRIBUTION_URL,
                     "vertical_datum": "Source DEM vertical datum; elevation/bathymetry in metres"}


def local_dem(path, bounds, grid):
    left, bottom, right, top = mercator_bounds(bounds)
    dx, dy = (right-left)/(grid-1), (top-bottom)/(grid-1)
    # The mesh samples VERTICES, including the extent edges, not cell centres.
    transform = Affine(dx, 0, left-dx/2, 0, -dy, top+dy/2)
    try:
        with rasterio.open(path) as source:
            if source.crs is None:
                raise TerrainUnavailable("The local DEM must have a coordinate reference system.")
            if source.units[0] and source.units[0].lower() not in ("m", "metre", "metres", "meter", "meters"):
                raise TerrainUnavailable("The local DEM must contain elevations in metres.")
            with WarpedVRT(source, crs="EPSG:3857", width=grid, height=grid,
                           transform=transform, dtype="float32", nodata=np.nan,
                           resampling=Resampling.bilinear, warp_mem_limit=64) as vrt:
                heights = vrt.read(1, masked=True).filled(np.nan)
    except rasterio.errors.RasterioError as error:
        raise TerrainUnavailable("The configured local elevation GeoTIFF could not be opened.") from error
    return heights, {"name": "Local elevation DEM", "attribution": "Elevation DEM supplied by the server owner.",
                     "vertical_datum": "As supplied in the local DEM (metres)"}


def terrain_grid(bounds, grid, cache: Path, dem_path=None):
    configured = dem_path or os.environ.get("GCOV_DEM_PATH")
    heights, source = local_dem(configured, bounds, grid) if configured else public_dem(bounds, grid, cache)
    if not np.isfinite(heights).all():
        raise TerrainUnavailable("The DEM has missing elevation samples in this selection. Choose a smaller area or supply a complete local DEM.")
    width, height = dimensions_m(bounds)
    gy, gx = np.gradient(heights, height / (grid - 1), width / (grid - 1))
    slopes = np.degrees(np.arctan(np.hypot(gx, gy)))
    return {"bbox": list(bounds), "crs": "EPSG:3857", "extent_mercator": list(mercator_bounds(bounds)),
            "rows": grid, "columns": grid, "width_m": width, "height_m": height,
            "elevation_m": heights.astype(np.float32).ravel().tolist(),
            "slope_degrees": slopes.astype(np.float32).ravel().tolist(),
            "min_elevation_m": float(heights.min()), "max_elevation_m": float(heights.max()),
            "source": source, "mesh_spacing_m": [width / (grid - 1), height / (grid - 1)],
            "orientation": "row 0 is north; column 0 is west; texture uses this same extent"}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Cache and verify real terrain for an image selection.")
    parser.add_argument("--bbox", required=True)
    parser.add_argument("--grid", type=int, choices=(65, 129, 257), default=129)
    parser.add_argument("--cache", type=Path, default=Path("data/dem-cache"))
    args = parser.parse_args()
    result = terrain_grid(parse_bbox(args.bbox), args.grid, args.cache)
    result.pop("elevation_m")
    result.pop("slope_degrees")
    print(json.dumps(result, indent=2))
