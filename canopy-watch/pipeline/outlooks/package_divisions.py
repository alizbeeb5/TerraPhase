"""Package NOAA climate-division boundaries for the regional rainfall outlook maps."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
from urllib.request import urlretrieve

NOAA = "https://www.ncei.noaa.gov/pub/data/cirs/climdiv/CONUS_CLIMATE_DIVISIONS.shp.zip"
OUTPUT = Path(__file__).resolve().parents[2] / "web/drought/climate-divisions.json"
STATES = ("LA", "FL", "NC", "TX", "MS", "AL", "GA", "SC", "VA", "AR", "TN")


def package(archive):
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / "divisions.geojson"
        subprocess.run([
            "ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326", "-simplify", ".025",
            "-lco", "COORDINATE_PRECISION=4", "-select", "CLIMDIV,NAME,ST_ABBRV",
            "-where", "ST_ABBRV IN (" + ",".join(repr(state) for state in STATES) + ")",
            str(output), "/vsizip/" + str(archive.resolve()),
        ], check=True)
        data = json.loads(output.read_text())
    features = []
    for feature in data["features"]:
        row = feature["properties"]
        features.append({"id": str(row["CLIMDIV"]).zfill(4), "name": row["NAME"].title(),
                         "state": row["ST_ABBRV"], "geometry": feature["geometry"]})
    divisions = {feature["id"] for feature in features}
    if not {"0802", "1609", "3107"} <= divisions:
        raise ValueError("An outlook climate division is missing from the NOAA archive")
    OUTPUT.write_text(json.dumps({"source": NOAA, "divisions": features}, separators=(",", ":")) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="Location of the cached NOAA boundaries ZIP")
    args = parser.parse_args()
    if not args.archive.exists():
        urlretrieve(NOAA, args.archive)
    package(args.archive)


if __name__ == "__main__":
    main()
