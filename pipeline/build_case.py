#!/usr/bin/env python3
"""Build static Canopy Watch assets from aligned GeoTIFF crops."""
import argparse
import json
from pathlib import Path

import numpy as np
from osgeo import gdal, osr
from scipy import ndimage

gdal.UseExceptions()
THRESHOLD = -3.5
MIN_CELLS = 24
STRUCTURE = np.ones((3, 3), dtype=np.uint8)
gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")


def read(path, reference=None):
    source = gdal.Open(str(path))
    grid = (source.RasterXSize, source.RasterYSize, source.GetGeoTransform(), source.GetProjection())
    if reference is not None and grid != reference:
        raise ValueError(f"{path.name} does not match the reference grid")
    data = source.ReadAsArray()
    nodata = source.GetRasterBand(1).GetNoDataValue()
    if nodata is not None and nodata != 0:
        data = np.where(data == nodata, np.nan, data)
    return data, grid


def png(output, name, channels):
    if channels.ndim == 2:
        channels = channels[None, ...]
    bands, height, width = channels.shape
    raster = gdal.GetDriverByName("MEM").Create("", width, height, bands, gdal.GDT_Byte)
    for index, channel in enumerate(channels, start=1):
        raster.GetRasterBand(index).WriteArray(channel)
    gdal.GetDriverByName("PNG").CreateCopy(str(output / f"{name}.png"), raster)


def rgba(output, name, mask, color):
    channels = np.zeros((4, *mask.shape), dtype=np.uint8)
    channels[:3, mask] = np.asarray(color[:3])[:, None]
    channels[3, mask] = color[3]
    png(output, name, channels)


def db(power):
    valid = np.isfinite(power) & (power > 0)
    measured = np.where(valid, power, 0.0)
    weight = ndimage.uniform_filter(valid.astype(np.float64), size=3)
    avg = ndimage.uniform_filter(measured.astype(np.float64), size=3) / np.maximum(weight, 1e-8)
    return np.where(valid & (weight > 0.99), 10 * np.log10(np.maximum(avg, 1e-8)), np.nan)


def members(mask):
    labels, _ = ndimage.label(mask, STRUCTURE)
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    return labels, counts


def value_avg(arr, mask):
    values = arr[mask & np.isfinite(arr)]
    return round(float(values.mean()), 2) if values.size else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    meta = json.loads(args.manifest.read_text())

    def raster(name, grid=None):
        return read(args.inputs / f"crop-{name}.tif", grid)

    cover, grid = raster("cover")
    loss, _ = raster("loss", grid)
    dem, _ = raster("dem", grid)
    width, height, gt, projection = grid
    epsg = int(meta["epsg"])
    if len(meta["radar"]) < 3 or len({r["orbit"] for r in meta["radar"]}) != 1:
        raise ValueError("This case needs at least three observations on one relative orbit.")
    if gt[2] != 0 or gt[4] != 0 or gt[1] <= 0 or gt[5] >= 0:
        raise ValueError("Use a north-up projected grid in metres.")
    baseline_year = int(meta["radar"][0]["date"][:4])
    last_year = int(meta["radar"][-1]["date"][:4])
    cell_ha = abs(gt[1] * gt[5]) / 10000
    yy, xx = np.indices((height, width))
    forest = (cover >= 30) & ((loss == 0) | (loss > baseline_year - 2000))
    independent_loss = (loss > baseline_year - 2000) & (loss <= last_year - 2000)
    gy, gx = np.gradient(dem, abs(gt[5]), gt[1])
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    steep = slope > 25
    rgba(args.output, "slope", steep, (216, 128, 255, 170))
    rgba(args.output, "reference", independent_loss & forest, (124, 222, 245, 180))

    vh, vv = [], []
    for i, source in enumerate(meta["radar"]):
        year = source["date"][:4]
        prefix = "repeat" if i and year == meta["radar"][i - 1]["date"][:4] else "sar"
        for band, series in (("vh", vh), ("vv", vv)):
            power, _ = raster(f"{prefix}{year}-{band}", grid)
            values = db(power)
            series.append(values)
            lo, hi = (-25, -9) if band == "vh" else (-19, -4)
            shade = np.where(np.isfinite(values), np.clip((values - lo) / (hi - lo), 0, 1), 0)
            rgb = (np.array([17, 25, 23])[:, None, None] + shade * np.array([211, 205, 192])[:, None, None]).astype(np.uint8)
            png(args.output, f"{band}-{i}", rgb)

    deltas = [image - vh[0] for image in vh]
    eligible = forest & np.logical_and.reduce([np.isfinite(image) for image in vh])
    if eligible.sum() < 1000:
        raise ValueError("The case does not have enough overlapping valid forest cells.")
    flags, first_seen = [], np.full(forest.shape, -1)
    acquisition_stats = []
    for index, delta in enumerate(deltas):
        labels, counts = members(eligible & (delta < THRESHOLD))
        flag = counts[labels] >= MIN_CELLS
        new = flag & (first_seen == -1)
        first_seen[new] = index
        flags.append(flag)
        rgba(args.output, f"alert-{index}", flag, (255, 160, 82, 185))
        acquisition_stats.append({
            "areaHa": round(float(flag.sum() * cell_ha), 2),
            "newHa": round(float(new.sum() * cell_ha), 2),
        })

    # Select the final connected patch with strongest overlap against independent reference.
    labels, sizes = members(flags[-2] & flags[-1])
    overlap = np.bincount(labels[independent_loss].ravel(), minlength=len(sizes))
    overlap[0] = 0
    if not overlap.any():
        raise ValueError("No final radar patch overlaps independently mapped tree-cover loss.")
    fractions = overlap / np.maximum(sizes, 1)
    score = overlap * fractions
    score[fractions < 0.35] = 0
    if not score.any():
        raise ValueError("No patch has at least 35% independent overlap.")
    selected_patch = labels == int(score.argmax())
    rgba(args.output, "selected", selected_patch, (255, 207, 110, 205))
    edge = ndimage.binary_dilation(selected_patch, iterations=3) & ~selected_patch
    rgba(args.output, "outline", edge, (255, 207, 110, 245))

    # Nearby forest control. Require no mapped loss or threshold flags in its footprint.
    if not flags[-1].any():
        raise ValueError("No final change candidate.")
    patch_y, patch_x = ndimage.center_of_mass(selected_patch)
    clean = eligible & (loss == 0) & ~np.logical_or.reduce(flags)
    radius = 8
    safe = ndimage.minimum_filter(clean.astype(np.uint8), size=2 * radius + 1, mode="constant") == 1
    distance = np.hypot(xx - patch_x, yy - patch_y)
    control_cost = np.where(safe & (distance > 65) & (xx > 35) & (xx < width - 35) & (yy > 35) & (yy < height - 35),
                            distance + 12 * np.abs(deltas[-1]), np.inf)
    if not np.isfinite(control_cost).any():
        raise ValueError("No nearby stable comparison footprint passed the control criteria.")
    cy, cx = np.unravel_index(control_cost.argmin(), control_cost.shape)
    control_patch = ((xx - cx) ** 2 + (yy - cy) ** 2) <= radius ** 2
    rgba(args.output, "control", control_patch, (192, 237, 121, 175))

    src = osr.SpatialReference(wkt=projection)
    geo = osr.SpatialReference()
    geo.ImportFromEPSG(4326)
    geo.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tx = osr.CoordinateTransformation(src, geo)

    def describe(mask, key, title):
        y, x = ndimage.center_of_mass(mask)
        lon, lat, _ = tx.TransformPoint(gt[0] + (x + 0.5) * gt[1], gt[3] + (y + 0.5) * gt[5])
        counts = int(mask.sum())
        return {
            "id": key, "title": title, "x": (float(x) + 0.5) / width, "y": (float(y) + 0.5) / height,
            "latitude": round(lat, 5), "longitude": round(lon, 5),
            "areaHa": round(counts * cell_ha, 2),
            "referencePct": round(float((mask & independent_loss).sum() * 100 / counts), 1),
            "steepPct": round(float((mask & steep).sum() * 100 / counts), 1),
            "elevation": [round(float(dem[mask].min())), round(float(dem[mask].max()))],
            "series": [{"delta": value_avg(d, mask), "flaggedHa": round(float((f & mask).sum() * cell_ha), 2)}
                       for d, f in zip(deltas, flags)],
        }

    for index, source in enumerate(meta["optical"]):
        year = source["date"][:4]
        visual, _ = raster("opt" + year + "-visual", grid)
        scl, _ = raster("opt" + year + "-SCL", grid)
        clear = np.isin(scl, (4, 5, 6))
        source["validCasePct"] = round(float(clear.mean() * 100), 1)
        source["validPatchPct"] = round(float(clear[selected_patch].mean() * 100), 1)
        visual = visual[:3].astype(np.uint8)
        visual[:, ~clear] = np.array([66, 76, 73])[:, None]
        png(args.output, f"optical-{index}", visual)

    terrain_width = 60
    terrain_height = max(2, round(terrain_width * height / width))
    terrain = dem[np.ix_(np.linspace(0, height - 1, terrain_height).round().astype(int),
                         np.linspace(0, width - 1, terrain_width).round().astype(int))]
    (args.output / "terrain.json").write_text(json.dumps({"width": terrain_width, "height": terrain_height,
        "elevation": np.nan_to_num(terrain).round().astype(int).ravel().tolist()}))
    meta.update({
        "title": "Rondônia, Brazil", "width": width, "height": height,
        "widthM": width * gt[1], "heightM": height * abs(gt[5]), "pixelM": gt[1],
        "threshold": THRESHOLD, "minimumAreaHa": round(MIN_CELLS * cell_ha, 2),
        "forestValidHa": round(float(eligible.sum() * cell_ha), 1),
        "patches": [describe(selected_patch, "patch", "Possible disturbance"),
                    describe(control_patch, "control", "Stable forest comparison")],
        "stats": acquisition_stats,
        "baselineForest": "Hansen Global Forest Change v1.12, tree cover ≥30% in 2000, excluding mapped loss through 2019.",
        "reference": "Hansen Global Forest Change v1.12, 2020–2022 annual tree-cover loss.",
        "gridTransform": list(gt),
    })
    (args.output / "case.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps({key: meta[key] for key in ("patches", "stats", "forestValidHa")}, indent=2))


if __name__ == "__main__":
    main()
