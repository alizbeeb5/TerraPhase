"""Package two catalogued NISAR drought cases from NASA CMR and NOAA NCEI.

Run from the repository root: python canopy-watch/pipeline/drought/package_browse.py
Requires Pillow. The optional --cache directory retains original downloads.
"""
import argparse
import calendar
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import statistics
import tempfile
from urllib.parse import urlencode
from urllib.request import urlopen

from PIL import Image

OUT = Path(__file__).resolve().parents[2] / "web" / "drought"
CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
NOAA = "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/divisional/time-series"
CASES = {
    "north-florida": {
        "granules": ("G4245143313-ASF", "G4311534924-ASF"),
        "collection": "NISAR_L2_GCOV_PROVISIONAL_V1",
        "division": "0802",
        "region": "Florida North",
        "months": ("202606", "202607", "202608", "202609"),
        "record": {
            "label": "NWS Jacksonville drought statement · September 17, 2026",
            "url": "https://www.weather.gov/media/jax/DGT/DGT_JAX_09172026.pdf",
            "scope": "The report describes improving drought and lingering effects in the Lower Santa Fe River basin four days after the second NISAR pass.",
        },
        "rain_limit": "June–September totals provide regional context. June and part of July precede the first scene, and the September total extends beyond the second scene.",
    },
    "eastern-north-carolina": {
        "granules": ("G4405630052-ASF", "G4409297842-ASF"),
        "collection": "NISAR_L2_GCOV_V1",
        "division": "3107",
        "region": "North Carolina Central Coastal Plain",
        "months": ("202608", "202609", "202610"),
        "record": {
            "label": "U.S. Drought Monitor · November 10, 2026",
            "url": "https://droughtmonitor.unl.edu/services/data/summary/html/usdm_summary_20261110.html",
            "scope": "The regional narrative documents worsening drought in eastern North Carolina five days after the second NISAR pass.",
        },
        "rain_limit": "August–October totals show antecedent conditions at division scale. November was incomplete at packaging and is omitted.",
    },
}
POLARIZATIONS = {"HH": "HHHH", "HV": "HVHV"}
DATE_LIMIT = "2026-11-15"
MAX_DOWNLOAD = 12_000_000


def fetch(url, cache, name):
    item = cache / name
    if item.exists():
        return item.read_bytes()
    with urlopen(url, timeout=35) as response:
        payload = response.read(MAX_DOWNLOAD + 1)
    if len(payload) > MAX_DOWNLOAD:
        raise ValueError(f"Download too large: {name}")
    item.write_bytes(payload)
    return payload


def get_scene(cmr_id, collection, cache, output):
    query = CMR + "?" + urlencode({"concept_id": cmr_id})
    response = json.loads(fetch(query, cache, f"{cmr_id}.json"))
    entries = response["feed"]["entry"]
    if len(entries) != 1 or entries[0]["id"] != cmr_id:
        raise ValueError(f"CMR lookup did not uniquely resolve {cmr_id}")
    scene = entries[0]
    product = scene["producer_granule_id"]

    def source(filename):
        return next(link["href"] for link in scene["links"]
                    if link["href"].startswith("https://nisar.asf.earthdatacloud.nasa.gov/")
                    and f"/{collection}/" in link["href"] and link["href"].endswith("/" + filename))

    bands = {}
    for band, suffix in POLARIZATIONS.items():
        original = product + "_NATIVE_A_" + suffix + ".png"
        url = source(original)
        raw = fetch(url, cache, original)
        filename = f"{cmr_id}-{band}.webp"
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG":
                raise ValueError(f"Unexpected browse image format for {cmr_id}")
            image = image.convert("RGBA")
            image.thumbnail((1120, 1120), Image.Resampling.LANCZOS)
            image.save(output / filename, "WEBP", quality=84, method=6)
            width, height = image.size
        bands[band] = {
            "path": f"/drought/{output.name}/{filename}", "sourceUrl": url,
            "sourceSha256": hashlib.sha256(raw).hexdigest(), "width": width, "height": height,
        }
    return {
        "id": product, "cmrId": cmr_id, "date": scene["time_start"], "metadataUrl": query,
        "scienceUrl": source(product + ".h5"), "bands": bands,
    }


def rainfall(case, cache):
    division = case["division"]
    url = (f"{NOAA}/{division}/pcp/1/0/1991-2026.json"
           "?base_prd=true&begbaseyear=1991&endbaseyear=2020")
    name = f"noaa-{division}-precipitation.json"
    raw = fetch(url, cache, name)
    record = json.loads(raw)
    if record["description"]["units"] != "Inches":
        raise ValueError(f"Unexpected precipitation units: {division}")
    data = record["data"]
    rows = []
    for key in case["months"]:
        month = key[4:]
        observed = float(data[key]["value"])
        normal = statistics.mean(float(data[f"{year}{month}"]["value"]) for year in range(1991, 2021))
        rows.append({"month": key[:4] + "-" + month, "precipitationMm": round(observed * 25.4, 3),
                     "normalMm": round(normal * 25.4, 3), "anomalyMm": round((observed - normal) * 25.4, 3)})
    if not any(row["anomalyMm"] < 0 for row in rows):
        raise ValueError(f"No monthly rainfall deficits in {division} over the selected context window")
    (OUT / name).write_bytes(raw)
    first, last = rows[0]["month"], rows[-1]["month"]
    year, month = map(int, last.split("-"))
    return {
        "id": "precipitation-anomaly", "units": "mm",
        "measurement": "Monthly precipitation minus the same calendar month's 1991–2020 mean",
        "resolution": f"NOAA {case['region']} climate division ({division}) area mean",
        "dates": [first + "-01", f"{last}-{calendar.monthrange(year, month)[1]}"],
        "source": "NOAA NCEI nClimDiv / Climate at a Glance", "sourceUrl": url,
        "sourceSha256": hashlib.sha256(raw).hexdigest(), "rawPath": f"/drought/{name}",
        "baseline": "1991–2020 (30 observations per calendar month)", "status": "observed", "series": rows,
    }


def package(name, case, cache):
    output = OUT / name
    output.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=2) as executor:
        before, after = executor.map(lambda cmr_id: get_scene(cmr_id, case["collection"], cache, output), case["granules"])
    parts = [item["id"].split("_") for item in (before, after)]
    if (parts[0][5:11] != parts[1][5:11] or parts[0][13] != parts[1][13]
            or not before["date"] < after["date"] or after["date"][:10] > DATE_LIMIT):
        raise ValueError(f"Invalid repeat-pass pair for {name}")
    track, direction, frame = parts[0][5:8]
    manifest = {
        "schema": "terraphase-drought/v1", "id": f"{name}-drought", "status": "provisional",
        "limitations": [
            "The independently rendered ASF browse images show full GCOV scenes. Display brightness may vary with image scaling.",
            "The paired previews support visual inspection. Quantitative backscatter change and soil moisture require science data.",
            case["rain_limit"],
        ],
        "layers": [{
            "id": "gcov", "presentation": "official-browse", "units": "display intensity",
            "measurement": "Official GCOV backscatter browse imagery", "resolution": "Resized whole-scene previews",
            "source": "NASA / ISRO NISAR L2 GCOV · ASF DAAC", "collection": case["collection"],
            "maturity": "Validated GCOV" if case["collection"] == "NISAR_L2_GCOV_V1" else "Provisional GCOV",
            "dates": [before["date"][:10], after["date"][:10]], "scenes": [before, after],
            "geometry": {"track": int(track), "frame": int(frame), "direction": "Descending" if direction == "D" else "Ascending",
                         "release": parts[0][13]},
        }, rainfall(case, cache)],
        "independentRecord": case["record"],
    }
    (OUT / f"{name}.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, help="Keep raw source data in this directory")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as scratch:
        cache = args.cache or Path(scratch)
        cache.mkdir(parents=True, exist_ok=True)
        for name, case in CASES.items():
            package(name, case, cache)


if __name__ == "__main__":
    main()
