"""Build regional one-month-ahead rainfall deficit outlooks from archived NOAA observations.

Run: python canopy-watch/pipeline/drought/train_outlook.py
Requires numpy and scikit-learn. Source JSON is kept in noaa-history.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parents[1] / "web" / "drought"
DIVISIONS = {"1609": "louisiana", "0802": "north-florida", "3107": "eastern-north-carolina"}
PERCENTILE = 0.20


def date_key(index):
    year, month = divmod(index, 12)
    return f"{year:04d}-{month + 1:02d}"


def predictors(series, index):
    # Historical windows use dates strictly before the month being estimated.
    seasons = np.arange(index - 360, index, 12)
    totals = series[seasons - 2] + series[seasons - 1] + series[seasons]
    threshold = float(np.quantile(totals, PERCENTILE))
    observed = float(series[index - 2:index].sum())
    residual = threshold - observed
    conditional = (np.count_nonzero(series[seasons] < residual) + 0.5) / (len(seasons) + 1) if residual > 0 else 0.0
    # Compare antecedent rainfall with observations ending in the same calendar month.
    recent = []
    for span in (1, 3, 6):
        historical = sum(series[seasons - k] for k in range(1, span + 1))
        typical = historical.mean()
        recent.append(float(series[index - span:index].sum() / typical - 1))
    features = [float(np.log(np.clip(conditional, 0.01, 0.99) / np.clip(1 - conditional, 0.01, 0.99))), *recent]
    return features, threshold, observed, conditional


def brier(predictions, observed):
    return float(np.mean((np.asarray(predictions) - np.asarray(observed)) ** 2))


def train(source, division, event):
    raw = source.read_bytes()
    data = json.loads(raw)
    if data["description"]["units"] != "Inches":
        raise ValueError(f"Unexpected rainfall unit for division {division}")
    months = sorted(data["data"])
    start = int(months[0][:4]) * 12 + int(months[0][4:]) - 1
    if any(date_key(start + i).replace("-", "") != key for i, key in enumerate(months)):
        raise ValueError(f"Non-contiguous rainfall history for division {division}")
    series = np.array([float(data["data"][key]["value"]) * 25.4 for key in months])
    if not np.all(np.isfinite(series) & (series >= 0)):
        raise ValueError(f"Invalid rainfall totals for division {division}")

    # Use validation for model selection and keep the later period for independent evaluation.
    rows = []
    for i in range(366, len(series)):
        year = (start + i) // 12
        if year > 2025:
            break
        x, threshold, known, conditional = predictors(series, i)
        rows.append((year, x, known < threshold, conditional, int(known + series[i] < threshold)))
    fit = [row for row in rows if row[0] <= 2000]
    validation = [row for row in rows if 2001 <= row[0] <= 2010]
    test = [row for row in rows if 2011 <= row[0] <= 2025]
    model = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=1000))
    model.fit([row[1] for row in fit], [row[-1] for row in fit])

    def evaluate(samples):
        observed = [row[-1] for row in samples]
        probabilities = model.predict_proba([row[1] for row in samples])[:, 1]
        probabilities = np.where([row[2] for row in samples], probabilities, 0)
        return {"months": len(samples), "dryMonths": sum(observed), "logisticBrier": brier(probabilities, observed),
                "baselineBrier": brier([row[3] for row in samples], observed)}

    validation_scores, test_scores = evaluate(validation), evaluate(test)
    use_logistic = validation_scores["logisticBrier"] < validation_scores["baselineBrier"]
    index = len(series)
    x, threshold, known, baseline = predictors(series, index)
    logistic = float(model.predict_proba([x])[0, 1]) if known < threshold else 0.0
    target = date_key(start + index)
    seasonal_totals = known + series[np.arange(index - 360, index, 12)]
    low, middle, high = np.quantile(seasonal_totals, [0.1, 0.5, 0.9])
    return {
        "schema": "terraphase-rainfall-outlook/v1", "eventId": event + "-drought",
        "division": division, "through": date_key(start + len(series) - 1), "target": target,
        "targetDefinition": "Three-month precipitation below the 20th percentile for that ending month",
        "referenceYears": [(start + len(series)) // 12 - 30, (start + len(series)) // 12 - 1],
        "thresholdMm": round(threshold, 1), "priorTwoMonthsMm": round(known, 1),
        "rainfallRange": {
            "observed": [{"month": date_key(start + i), "cumulativeMm": round(float(series[index - 2:i + 1].sum()), 1)}
                         for i in range(index - 2, index)],
            "lowMm": round(float(low), 1), "medianMm": round(float(middle), 1), "highMm": round(float(high), 1),
        },
        "probability": round(logistic if use_logistic else baseline, 6),
        "baselineProbability": round(baseline, 6), "model": "logistic" if use_logistic else "conditional-climatology",
        "modelLabel": "Logistic rainfall model" if use_logistic else "Conditional climatology",
        "validation": {"years": [2001, 2010], **validation_scores},
        "backtest": {"years": [2011, 2025], **test_scores},
        "source": {"name": "NOAA NCEI Climate at a Glance nClimDiv", "sha256": hashlib.sha256(raw).hexdigest(),
                   "url": f"https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/divisional/time-series/{division}/pcp/1/0/1950-2026.json"},
    }


def main():
    for division, event in DIVISIONS.items():
        data = train(HERE / "noaa-history" / f"{division}.json", division, event)
        (OUTPUT / f"{event}-outlook.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(event, data["modelLabel"], data["probability"], data["backtest"])


if __name__ == "__main__":
    main()
