"""Backtest and export the Rondônia or Louisiana tree-cover-loss outlook.

Run from the repository root with GDAL (gdalwarp), NumPy, Pillow, SciPy and
scikit-learn: python canopy-watch/pipeline/forecast/rondonia.py /tmp/hansen-cache
Add --event louisiana to build the Louisiana outlook. The local cache contains
projected excerpts of the public source rasters.
"""
import argparse
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, label, uniform_filter
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

REPO = Path(__file__).resolve().parents[3]
WEB = REPO / "canopy-watch/web"
BASE = "https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/"
DATA_WINDOWS = {
    "rondonia": ((400500, 8925500, 425520, 8941520), "00N_070W"),
    "louisiana": ((749510, 3303000, 776510, 3320010), "30N_100W"),
}
CROP = (414, 34, 768, 254)  # Same window as package_rondonia.py.
CELL_M = 30
LAST_YEAR = 2025
FRACTION = 0.10
FEATURES = ["distance to recent mapped loss", "distance to the surviving year-2000 canopy edge",
            "mapped loss in the local neighborhood"]


def load_layer(cache, layer, bounds, tile, epsg):
    path = cache / f"{layer}-utm30.tif"
    if not path.exists():
        temp = path.with_suffix(".tmp.tif")
        url = BASE + f"Hansen_GFC-2025-v1.13_{layer}_{tile}.tif"
        subprocess.run([
            "gdalwarp", "-q", "-overwrite", "-t_srs", f"EPSG:{epsg}",
            "-te", *map(str, bounds), "-tr", str(CELL_M), str(CELL_M),
            "-r", "near", "-ot", "Byte", "-dstnodata", "255",
            "--config", "GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR",
            "--config", "CPL_VSIL_CURL_USE_HEAD", "NO", f"/vsicurl/{url}", str(temp),
        ], check=True)
        temp.replace(path)
    with Image.open(path) as image:
        return np.asarray(image)


def state_at(year, loss_year, start_forest):
    survived = start_forest & ((loss_year == 0) | (loss_year > year))
    recent = start_forest & (loss_year > year - 3) & (loss_year <= year)
    if not recent.any():
        raise ValueError(f"No recent mapped loss before cutoff {year}")
    distance = distance_transform_edt(~recent) * CELL_M
    edge = distance_transform_edt(survived) * CELL_M
    density = uniform_filter(recent.astype(np.float32), size=17)
    features = np.stack([np.log1p(distance), np.log1p(edge), density], axis=-1)
    return survived, distance, features


def highest(scores, domain):
    indices = np.flatnonzero(domain)
    count = int(np.ceil(FRACTION * indices.size))
    ordered = np.argsort(-scores.flat[indices], kind="stable")
    picked = np.zeros(domain.shape, dtype=bool)
    picked.flat[indices[ordered[:count]]] = True
    return picked


def evaluate(years, states, loss_year, domain, model):
    results = []
    for year in years:
        eligible, distance, features = states[year - 1]
        eligible = eligible & domain
        actual = eligible & (loss_year == year)
        baseline = highest(-distance, eligible)
        scores = np.full(eligible.shape, -np.inf)
        scores[eligible] = model.decision_function(features[eligible])
        added = highest(scores, eligible)
        results.append({"year": year, "lossCells": int(actual.sum()), "eligibleCells": int(eligible.sum()),
                        "proximityHits": int((actual & baseline).sum()),
                        "modelHits": int((actual & added).sum())})
    return results


def hit_share(results, metric):
    losses = sum(row["lossCells"] for row in results)
    return sum(row[metric] for row in results) / losses if losses else None


def comparison_grid(event):
    if event == "louisiana":
        grid = json.loads((WEB / "canopy-watch-louisiana.json").read_text())["grid"]
        return grid, grid["bounds"]

    # The Brazil comparison is a fixed crop of the original study area.
    case = json.loads((REPO / "dist/data/case.json").read_text())
    grid = json.loads((WEB / "rondonia/comparison.json").read_text())["grid"]
    west, _, _, north = case["bounds"]
    x0, y0, x1, y1 = CROP
    spacing = grid["spacingM"]
    assert case["epsg"] == grid["epsg"] and case["pixelM"] == spacing
    assert (x1 - x0, y1 - y0) == (grid["width"], grid["height"])
    bounds = [west + x0 * spacing, north - y1 * spacing, west + x1 * spacing, north - y0 * spacing]
    return grid, [int(value) if value == int(value) else value for value in bounds]


def grid_sample(grid, view_bounds, model_bounds, shape):
    west, _, _, north = view_bounds
    spacing = grid["spacingM"]
    x = west + (np.arange(grid["width"]) + .5) * spacing
    y = north - (np.arange(grid["height"]) + .5) * spacing
    columns = np.floor((x - model_bounds[0]) / CELL_M).astype(int)
    rows = np.floor((model_bounds[3] - y) / CELL_M).astype(int)
    if columns.min() < 0 or columns.max() >= shape[1] or rows.min() < 0 or rows.max() >= shape[0]:
        raise ValueError("Comparison grid must lie within the model area")
    return np.ix_(rows, columns)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    parser.add_argument("--event", choices=DATA_WINDOWS, default="rondonia")
    args = parser.parse_args()
    event = args.event
    cache = args.cache / event
    out = WEB / event
    out.mkdir(parents=True, exist_ok=True)
    model_bounds, tile = DATA_WINDOWS[event]
    grid, view_bounds = comparison_grid(event)
    cache.mkdir(parents=True, exist_ok=True)
    loss, cover, land = (load_layer(cache, layer, model_bounds, tile, grid["epsg"])
                         for layer in ("lossyear", "treecover2000", "datamask"))
    if loss.shape != cover.shape or loss.shape != land.shape:
        raise ValueError("Hansen layers must share the same grid")
    start_forest = (cover >= 30) & (cover <= 100) & (land == 1) & (loss <= LAST_YEAR - 2000)
    loss_year = np.where((loss > 0) & (loss <= LAST_YEAR - 2000), 2000 + loss.astype(np.int16), 0)
    sample = grid_sample(grid, view_bounds, model_bounds, loss.shape)
    inside = np.zeros(loss.shape, dtype=bool)
    inside[sample] = True
    rows, cols = np.indices(loss.shape)
    holdout = (rows // 65 + 2 * (cols // 65)) % 4 == 0
    if event == "louisiana":
        # Reserve the whole Louisiana comparison footprint for independent testing.
        holdout |= inside
    # Keep a buffer between training labels and the spatial holdout.
    train = (distance_transform_edt(~holdout) * CELL_M > 180)
    states = {year: state_at(year, loss_year, start_forest) for year in range(2014, LAST_YEAR + 1)}
    features, targets = [], []
    rng = np.random.default_rng(2026)
    for year in range(2015, 2021):
        eligible, _, values = states[year - 1]
        eligible = eligible & train
        target = eligible & (loss_year == year)
        flips = np.flatnonzero(target)
        stable = np.flatnonzero(eligible & ~target)
        controls = rng.choice(stable, min(stable.size, flips.size * 5), replace=False)
        selected = np.concatenate([flips, controls])
        features.append(values.reshape(-1, 3)[selected])
        targets.append(target.flat[selected])
    model = make_pipeline(StandardScaler(), LogisticRegression(solver="lbfgs"))
    model.fit(np.concatenate(features), np.concatenate(targets))
    tune = evaluate((2021, 2022), states, loss_year, train, model)
    test = evaluate((2023, 2024, 2025), states, loss_year, holdout, model)
    model_tune = hit_share(tune, "modelHits")
    baseline_tune = hit_share(tune, "proximityHits")
    chosen = "model" if model_tune is not None and model_tune > baseline_tune else "proximity"
    local_test = evaluate((2023, 2024, 2025), states, loss_year, inside, model) if event == "louisiana" else None
    recall = hit_share(test, chosen + "Hits")
    if recall is None or recall <= FRACTION:
        raise ValueError(f"Held-out capture {recall} did not beat the 10% area benchmark")

    # Rank only within the displayed window. The outer study grid provides edge context.
    eligible, distance, values = states[LAST_YEAR]
    eligible = eligible & inside
    scores = -distance
    if chosen == "model":
        scores = np.full(eligible.shape, -np.inf)
        scores[eligible] = model.decision_function(values[eligible])
    predicted = highest(scores, eligible)
    drawn = predicted[sample]
    if not drawn.any():
        raise ValueError("No forest cells were ranked within the displayed window")
    zone_labels, count = label(drawn, structure=np.ones((3, 3)))
    zones = []
    for zone in range(1, count + 1):
        cells = zone_labels == zone
        yy, xx = np.where(cells)
        recent_distances = distance[sample][cells]
        zones.append({"id": zone, "center": [int(xx[len(xx) // 2]), int(yy[len(yy) // 2])],
                      "medianRecentLossDistanceM": int(np.median(recent_distances))})
    if count >= 65536:
        raise ValueError("Zone raster exceeds the two-byte encoding")
    encoded = np.zeros((*drawn.shape, 3), dtype=np.uint8)
    encoded[..., 0] = zone_labels % 256
    encoded[..., 1] = zone_labels // 256
    Image.fromarray(encoded).save(out / "outlook-zones.png", optimize=True)
    payload = {
        "schema": "canopy-watch-outlook/v1", "eventId": event, "grid": grid,
        "bounds": view_bounds,
        "cutoff": "2025-12-31", "targetYear": 2026,
        "model": "Logistic ranking" if chosen == "model" else "Distance to recent mapped loss",
        "drivers": FEATURES if chosen == "model" else FEATURES[:1],
        "rankedForestShare": FRACTION,
        "priorityGridAreaHa": round(float(drawn.sum() * grid["spacingM"] ** 2 / 10000), 2),
        "evaluation": {"heldOut": test, "tuning": tune, "selectedCapture": recall,
                       "baselineCapture": hit_share(test, "proximityHits"),
                       "logisticCapture": hit_share(test, "modelHits"),
                       **({"localHeldOut": local_test, "localCapture": hit_share(local_test, chosen + "Hits")}
                          if local_test is not None else {})},
        "zoneRaster": f"/{event}/outlook-zones.png", "zones": zones,
        "source": {"name": "Hansen/UMD/Google/USGS/NASA Global Forest Change v1.13",
                   "url": BASE + "download.html", "license": "CC BY 4.0",
                   "processing": f"30 m UTM nearest-neighbor inputs, projected and ranked; rendered on the {grid['spacingM']:g} m viewer grid"},
    }
    (out / "outlook.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(json.dumps({"chosen": chosen, "evaluation": payload["evaluation"], "zones": count}, indent=2))


if __name__ == "__main__":
    main()
