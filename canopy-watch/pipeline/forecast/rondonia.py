"""Backtest and export the Rondônia tree-cover-loss outlook.

Run from the repository root with GDAL (gdalwarp), NumPy, Pillow, SciPy and
scikit-learn: python canopy-watch/pipeline/forecast/rondonia.py /tmp/hansen-cache
The local cache contains projected excerpts of the public source rasters.
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
OUT = REPO / "canopy-watch/web/rondonia"
BASE = "https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/"
BOUNDS = (400500, 8925500, 425520, 8941520)
CROP = (414, 34, 768, 254)  # Same window as package_rondonia.py.
CELL_M = 30
LAST_YEAR = 2025
FRACTION = 0.10
FEATURES = ["distance to recent mapped loss", "distance to the surviving year-2000 canopy edge",
            "mapped loss in the local neighborhood"]


def load_layer(cache, layer):
    path = cache / f"{layer}-utm30.tif"
    if not path.exists():
        temp = path.with_suffix(".tmp.tif")
        url = BASE + f"Hansen_GFC-2025-v1.13_{layer}_00N_070W.tif"
        subprocess.run([
            "gdalwarp", "-q", "-overwrite", "-t_srs", "EPSG:32720",
            "-te", *map(str, BOUNDS), "-tr", str(CELL_M), str(CELL_M),
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
    return sum(row[metric] for row in results) / sum(row["lossCells"] for row in results)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    cache = parser.parse_args().cache
    cache.mkdir(parents=True, exist_ok=True)
    loss = load_layer(cache, "lossyear")
    cover = load_layer(cache, "treecover2000")
    land = load_layer(cache, "datamask")
    if loss.shape != cover.shape or loss.shape != land.shape:
        raise ValueError("Hansen layers must share the same grid")
    start_forest = (cover >= 30) & (cover <= 100) & (land == 1) & (loss <= LAST_YEAR - 2000)
    loss_year = np.where((loss > 0) & (loss <= LAST_YEAR - 2000), 2000 + loss.astype(np.int16), 0)
    rows, cols = np.indices(loss.shape)
    holdout = (rows // 65 + 2 * (cols // 65)) % 4 == 0
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
    chosen = "model" if hit_share(tune, "modelHits") > hit_share(tune, "proximityHits") else "proximity"
    recall = hit_share(test, chosen + "Hits")
    if recall <= FRACTION:
        raise ValueError(f"Held-out capture {recall:.1%} did not beat the 10% area benchmark")

    # Rank only within the displayed window. The outer study grid provides edge context.
    case = json.loads((REPO / "dist/data/case.json").read_text())
    grid = json.loads((OUT / "comparison.json").read_text())["grid"]
    west, _, _, north = case["bounds"]
    x0, y0, x1, y1 = CROP
    assert case["epsg"] == grid["epsg"] == 32720 and case["pixelM"] == grid["spacingM"] == 20
    assert (x1 - x0, y1 - y0) == (grid["width"], grid["height"])
    dst_x = west + (np.arange(x0, x1) + .5) * grid["spacingM"]
    dst_y = north - (np.arange(y0, y1) + .5) * grid["spacingM"]
    source_cols = ((dst_x - BOUNDS[0]) / CELL_M).astype(int)
    source_rows = ((BOUNDS[3] - dst_y) / CELL_M).astype(int)
    sample = np.ix_(source_rows, source_cols)
    inside = np.zeros(loss.shape, dtype=bool)
    inside[sample] = True
    eligible, distance, values = states[LAST_YEAR]
    eligible = eligible & inside
    scores = -distance
    if chosen == "model":
        scores = np.full(eligible.shape, -np.inf)
        scores[eligible] = model.decision_function(values[eligible])
    predicted = highest(scores, eligible)
    drawn = predicted[sample]
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
    Image.fromarray(encoded).save(OUT / "outlook-zones.png", optimize=True)
    payload = {
        "schema": "canopy-watch-outlook/v1", "eventId": "rondonia", "grid": grid,
        "bounds": [west + x0 * 20, north - y1 * 20, west + x1 * 20, north - y0 * 20],
        "cutoff": "2025-12-31", "targetYear": 2026,
        "model": "Logistic ranking" if chosen == "model" else "Distance to recent mapped loss",
        "drivers": FEATURES if chosen == "model" else FEATURES[:1],
        "rankedForestShare": FRACTION,
        "priorityGridAreaHa": round(float(drawn.sum() * grid["spacingM"] ** 2 / 10000), 2),
        "evaluation": {"heldOut": test, "tuning": tune, "selectedCapture": recall,
                       "baselineCapture": hit_share(test, "proximityHits"),
                       "logisticCapture": hit_share(test, "modelHits")},
        "zoneRaster": "/rondonia/outlook-zones.png", "zones": zones,
        "source": {"name": "Hansen/UMD/Google/USGS/NASA Global Forest Change v1.13",
                   "url": BASE + "download.html", "license": "CC BY 4.0",
                   "processing": "30 m UTM nearest-neighbor inputs, projected and ranked; rendered on the 20 m viewer grid"},
    }
    (OUT / "outlook.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(json.dumps({"chosen": chosen, "evaluation": payload["evaluation"], "zones": count}, indent=2))


if __name__ == "__main__":
    main()
