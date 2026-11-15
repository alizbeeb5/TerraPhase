"""Package matched public Sentinel-1 RTC crops, terrain and NASA reference layers."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "web" / "hazards"
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
TERRAIN = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium"
ARC = "https://gis.earthdata.nasa.gov/portal/rest/services/"
COLLECTION = "sentinel-1-rtc"
NODATA = -9999
DEM_SIZE = 72
SCALE = (-26, 4)
CHANGE = 8
ENV = {**os.environ, "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "CPL_VSIL_CURL_USE_HEAD": "NO",
       "GDAL_HTTP_TIMEOUT": "30", "GDAL_HTTP_MAX_RETRY": "2", "CPL_VSIL_CURL_CHUNK_SIZE": "65536"}


def get(url, cache):
    target = cache / hashlib.sha256(url.encode()).hexdigest()
    if not target.exists():
        with urlopen(url, timeout=40) as response:
            body = response.read()
        target.write_bytes(body)
    return target


def read_image(path, mode=None):
    with Image.open(path) as image:
        return np.array(image.convert(mode) if mode else image)


def run_gdal(args):
    process = subprocess.run(args, env=ENV, capture_output=True, timeout=210)
    if process.returncode:
        raise RuntimeError(f"{args[0]} failed for {args[-1]} (exit {process.returncode})")


def crop_scene(item_id, case, size, cache):
    source = f"{STAC}/collections/{COLLECTION}/items/{item_id}"
    item = json.loads(get(source, cache).read_bytes())
    p = item["properties"]
    asset = item["assets"]["vv"]["href"]
    output = cache / f"{case['id']}-{item_id}-{size[0]}x{size[1]}.tif"
    if not output.exists():
        account = asset.split("://")[1].split(".")[0]
        container = asset.split("/")[3]
        token_url = STAC.replace("/stac/", "/sas/") + f"/token/{account}/{container}"
        with urlopen(token_url, timeout=30) as response:
            token = json.load(response)["token"]
        temp = output.with_suffix(".partial.tif")
        try:
            run_gdal(["gdalwarp", "-q", "-overwrite", "-te", *map(str, case["bounds"]),
                      "-t_srs", "EPSG:4326", "-ts", *map(str, size), "-r", "average",
                      "-dstnodata", str(NODATA), "/vsicurl/" + asset + "?" + token, str(temp)])
            temp.replace(output)
        finally:
            temp.unlink(missing_ok=True)
    raw = read_image(output)
    valid = np.isfinite(raw) & (raw > 0)
    if valid.sum() < .01 * raw.size:
        raise ValueError(f"No adequate radar coverage: {item_id}")
    data = np.full(raw.shape, np.nan, dtype=np.float32)
    data[valid] = 10 * np.log10(raw[valid])
    return {"id": item_id, "date": p["datetime"][:10], "track": p["sat:relative_orbit"],
            "orbit": p["sat:orbit_state"], "source": source, "asset": asset}, data


def merge_slices(slices):
    scene = {**slices[0][0], "sources": [entry for entry, _ in slices]}
    stack = np.stack([array for _, array in slices])
    count = np.isfinite(stack).sum(axis=0)
    result = np.full(count.shape, np.nan, dtype=np.float32)
    # Average overlapping slices in linear power. Keep missing coverage transparent.
    linear = np.nansum(10 ** (stack / 10), axis=0)
    valid = count > 0
    result[valid] = 10 * np.log10(linear[valid] / count[valid])
    return scene, result


def save_layer(matrix, lo, hi, colors, path):
    valid = np.isfinite(matrix)
    position = np.clip(np.where(valid, matrix, lo), lo, hi)
    x = np.linspace(lo, hi, len(colors))
    rgba = np.empty((*matrix.shape, 4), dtype=np.uint8)
    for i, values in enumerate(zip(*colors)):
        rgba[..., i] = np.rint(np.interp(position, x, values)).astype(np.uint8)
    rgba[..., 3] = valid * 255
    Image.fromarray(rgba).save(path, "WEBP", quality=86, method=6)


def dimensions(bounds):
    west, south, east, north = bounds
    width_m = (east - west) * 111195 * math.cos(math.radians((north + south) / 2))
    height_m = (north - south) * 111195
    longest = max(width_m, height_m)
    return (round(width_m / longest * 700), round(height_m / longest * 700)), round(width_m), round(height_m)


def terrain(bounds, cache):
    west, south, east, north = bounds
    zoom = 10
    tile_count = 2 ** zoom
    x = (np.linspace(west, east, DEM_SIZE) + 180) / 360 * tile_count * 256
    lat = np.radians(np.linspace(north, south, DEM_SIZE))
    y = (1 - np.arcsinh(np.tan(lat)) / np.pi) / 2 * tile_count * 256
    xt, yt = (x // 256).astype(int), (y // 256).astype(int)
    tiles = [(int(i), int(j)) for i in np.unique(xt) for j in np.unique(yt)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = pool.map(lambda ij: get(f"{TERRAIN}/{zoom}/{ij[0]}/{ij[1]}.png", cache), tiles)
        tiles = {coords: read_image(path, "RGB").astype(np.float32) for coords, path in zip(tiles, paths)}
    grid = []
    for j, row in enumerate(y.astype(int)):
        for i, col in enumerate(x.astype(int)):
            r, g, b = tiles[xt[i], yt[j]][row % 256, col % 256]
            grid.append(round(float(r * 256 + g + b / 256 - 32768), 1))
    return {"source": "Mapzen terrain tiles (AWS Open Data)", "url": "https://registry.opendata.aws/terrain-tiles/",
            "size": DEM_SIZE, "elevation": grid}


def official_layer(case, size, cache, folder):
    reference = case.get("reference")
    if not reference:
        return None
    is_los = reference["kind"] == "los"
    service = ARC + reference["service"] + "/ImageServer/exportImage?"
    params = {
        "f": "image", "bbox": ",".join(map(str, case["bounds"])), "bboxSR": 4326, "imageSR": 4326,
        "size": ",".join(map(str, size)), "adjustAspectRatio": "false", "format": "tiff" if is_los else "png32",
        "interpolation": "RSP_NearestNeighbor",
        "mosaicRule": json.dumps({"mosaicMethod": "esriMosaicLockRaster", "lockRasterIds": [reference["raster"]]}),
        "renderingRule": json.dumps({"rasterFunction": "None"}),
    }
    url = service + urlencode(params)
    raw = get(url, cache)
    output = folder / "reference.webp"
    if is_los:
        # GeoTIFF exports from this service contain their own map transform.
        array = cache / f"{case['id']}-los-aligned.tif"
        run_gdal(["gdalwarp", "-q", "-overwrite", "-te", *map(str, case["bounds"]),
                  "-t_srs", "EPSG:4326", "-ts", *map(str, size), "-r", "near", str(raw), str(array)])
        matrix = read_image(array)
        matrix[(np.abs(matrix) < .05) | (np.abs(matrix) > 100) | ~np.isfinite(matrix)] = np.nan
        valid = np.isfinite(matrix)
        if valid.sum() < .01 * matrix.size:
            raise ValueError("No meaningful displacement coverage")
        save_layer(matrix, -50, 50, [(50, 111, 209), (238, 238, 238), (189, 43, 65)], output)
    else:
        rgba = read_image(raw, "RGBA")
        valid = (rgba[..., 2] == 255) & (rgba[..., 1] == 0) & (rgba[..., 0] == 0) & (rgba[..., 3] > 0)
        if not np.any(valid):
            raise ValueError("No mapped surface water in OPERA view")
        water = np.zeros_like(rgba)
        water[valid] = (43, 151, 255, 245)
        Image.fromarray(water).save(output, "WEBP", lossless=True)
    return {"path": f"/hazards/{case['id']}/reference.webp", "label": reference["label"],
            "legend": reference["legend"], "dates": reference["dates"], "source": url}


def package(case, cache):
    bounds = case["bounds"]
    size, width_m, height_m = dimensions(bounds)
    case_id = case["id"]
    folder = OUT / case_id
    folder.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        ids = [item_id for group in case["scenes"] for item_id in group]
        crops = dict(zip(ids, pool.map(lambda scene: crop_scene(scene, case, size, cache), ids)))
    scenes = [merge_slices([crops[scene] for scene in group]) for group in case["scenes"]]
    tracks = {(source["track"], source["orbit"]) for scene, _ in scenes for source in scene["sources"]}
    if len(tracks) != 1 or any(b[0]["date"] >= a[0]["date"] for b, a in zip(scenes, scenes[1:])):
        raise ValueError(f"Scenes must be chronological and from one repeat track: {case_id}")
    _, baseline = scenes[0]
    root = f"/hazards/{case_id}/"
    for index, (scene, values) in enumerate(scenes):
        filename = f"radar-{index}.webp"
        save_layer(values, *SCALE, [(17, 27, 31), (227, 235, 226)], folder / filename)
        scene["path"] = root + filename
        scene["coveragePct"] = round(float(np.isfinite(values).mean() * 100), 1)
        if index:
            change = values - baseline
            valid = np.isfinite(change)
            if valid.mean() < .6:
                raise ValueError(f"Less than 60% common radar coverage for {case_id} {scene['date']}")
            name = f"change-{index}.webp"
            save_layer(change, -CHANGE, CHANGE, [(34, 196, 216), (38, 47, 53), (255, 153, 82)], folder / name)
            scene["changePath"] = root + name
            scene["change"] = {"coveragePct": round(float(valid.mean() * 100), 1),
                               "medianDb": round(float(np.median(change[valid])), 2)}
    manifest = {key: value for key, value in case.items() if key not in ("scenes", "reference", "bounds")}
    terrain_model = terrain(bounds, cache)
    terrain_file = folder / "terrain.json"
    terrain_file.write_text(json.dumps(terrain_model, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest.update({"schema": "terraphase-hazard/v1", "sensor": "Copernicus Sentinel-1 VV RTC",
                     "grid": {"width": size[0], "height": size[1], "widthM": width_m, "heightM": height_m,
                              "bounds": bounds, "crs": "EPSG:4326"}, "radarRange": list(SCALE),
                     "changeRange": [-CHANGE, CHANGE], "scenes": [scene for scene, _ in scenes],
                     "terrainPath": root + terrain_file.name, "terrainSource": terrain_model["source"],
                     "reference": official_layer(case, size, cache, folder)})
    (folder / "comparison.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(case_id, [(scene["date"], scene["coveragePct"]) for scene, _ in scenes], flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    parser.add_argument("--event", help="Package one event")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    config = json.loads((HERE / "cases.json").read_text())
    selected = [case for case in config if args.event is None or case["id"] == args.event]
    if not selected:
        parser.error("Unknown event")
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda case: package(case, args.cache), selected))


if __name__ == "__main__":
    main()
