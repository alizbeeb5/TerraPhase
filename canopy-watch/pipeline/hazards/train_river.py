"""Train and backtest a 60-minute stage model using USGS Kerrville observations."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / "web" / "hazards" / "guadalupe-river-flood" / "outlook.json"
GAUGE = "08166200"
ENDPOINT = "https://waterservices.usgs.gov/nwis/iv/?"
HOUR = 3600
STEP = 900
RISING = 0.15


def period(start, end, cache):
    year = start[:4]
    name = "gauge-event" if year == "2025" else f"gauge-{year}-{start[5:]}"
    file = cache / name
    params = {"format": "json", "sites": GAUGE, "parameterCd": "00065", "startDT": start, "endDT": end}
    url = ENDPOINT + urlencode(params)
    if not file.exists():
        with urlopen(url, timeout=45) as response:
            file.write_bytes(response.read())
    raw = file.read_bytes()
    series = json.loads(raw)["value"]["timeSeries"]
    measurements = {}
    for stream in series:
        for block in stream["values"]:
            for record in block["value"]:
                stage = float(record["value"])
                stamp = int(datetime.fromisoformat(record["dateTime"]).timestamp())
                if np.isfinite(stage) and -10 < stage < 100 and stamp % STEP == 0:
                    measurements[stamp] = stage
    if not measurements:
        raise ValueError(f"USGS returned no readings for {start}")
    return measurements, {"url": url, "sha256": hashlib.sha256(raw).hexdigest()}


def features(series, stamp):
    values = [series.get(stamp - offset * STEP) for offset in range(5)]
    if None in values:
        return None
    now, previous, half_hour, _, hour = values
    return [now, now - previous, now - half_hour, now - hour]


def rows(series):
    result = [(stamp, features(series, stamp), series.get(stamp + HOUR)) for stamp in sorted(series)]
    return [(stamp, x, target) for stamp, x, target in result if x is not None and target is not None]


def evaluate(samples, model):
    x = np.array([sample[1] for sample in samples])
    y = np.array([sample[2] for sample in samples])
    current = x[:, 0]
    dynamic = np.abs(x[:, 2]) >= RISING
    predicted = current + model.predict(x)
    return {
        "samples": len(x), "changingSamples": int(dynamic.sum()),
        "trainedMaeFt": round(float(np.mean(abs(predicted - y))), 3),
        "persistenceMaeFt": round(float(np.mean(abs(current - y))), 3),
        "trainedChangingMaeFt": round(float(np.mean(abs(predicted[dynamic] - y[dynamic]))), 3),
        "persistenceChangingMaeFt": round(float(np.mean(abs(current[dynamic] - y[dynamic]))), 3),
    }


def build(cache):
    windows = [(f"{year}-{a}", f"{year}-{b}") for year in range(2018, 2025)
               for a, b in (("01-01", "06-30"), ("07-01", "12-31"))]
    windows.append(("2025-07-03", "2025-07-08"))
    with ThreadPoolExecutor(max_workers=6) as pool:
        downloads = list(pool.map(lambda window: period(*window, cache), windows))
    buckets = []
    for left, right in [(0, 8), (8, 12), (12, 14)]:
        merged = {stamp: value for series, _ in downloads[left:right] for stamp, value in series.items()}
        buckets.append(rows(merged))
    fit, validation, test = buckets
    x = np.array([sample[1] for sample in fit])
    y = np.array([sample[2] for sample in fit])
    model = HistGradientBoostingRegressor(max_leaf_nodes=8, max_iter=120, l2_regularization=.5,
                                          learning_rate=.08, min_samples_leaf=10, random_state=0)
    weights = np.where(np.abs(x[:, 2]) >= RISING, 11, 1)
    model.fit(x, y - x[:, 0], sample_weight=weights)
    development = evaluate(validation, model)
    held_out = evaluate(test, model)
    event = downloads[-1][0]
    first = int(datetime.fromisoformat("2025-07-04T00:00:00-05:00").timestamp())
    finish = first + 18 * HOUR
    replay = []
    for stamp in range(first, finish + STEP, STEP):
        x = features(event, stamp - HOUR)
        replay.append({
            "utc": datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z"),
            "observedFt": event.get(stamp),
            "predictedFt": round(float(x[0] + model.predict([x])[0]), 2) if x is not None else None,
            "persistenceFt": x[0] if x is not None else None,
        })
    return {
        "schema": "terraphase-river-outlook/v1", "station": GAUGE, "location": "Guadalupe River at Kerrville, TX",
        "model": "Gradient-boosted stage change",
        "trainingPeakFt": float(y.max()),
        "horizonMinutes": 60, "trainedYears": [2018, 2021],
        "validation": {"years": [2022, 2023], **development},
        "heldOut": {"years": [2024, 2024], **held_out}, "replay": replay,
        "sources": [source for _, source in downloads],
        "stationUrl": "https://waterdata.usgs.gov/monitoring-location/USGS-08166200/",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    outlook = build(args.cache)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(outlook, indent=2) + "\n", encoding="utf-8")
    print(outlook["model"], outlook["validation"], outlook["heldOut"])


if __name__ == "__main__":
    main()
