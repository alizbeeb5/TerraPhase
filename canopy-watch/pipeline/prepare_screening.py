"""Recover bounded display-derived dB estimates and align WorldCover for the web screen."""
import argparse
from base64 import b64decode, b64encode
import hashlib
from io import BytesIO
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image

TILE = ("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
        "ESA_WorldCover_10m_2021_v200_N27W093_Map.tif")


def pack(array):
    return b64encode(array.astype(np.uint8).tobytes()).decode("ascii")


def recover_change(layer, shape):
    url = layer["change"]
    with Image.open(BytesIO(b64decode(url.split(",", 1)[1]))) as image:
        rgba = np.array(image.convert("RGBA"), dtype=np.float32)
    if rgba.shape[:2] != shape:
        raise ValueError("Radar and analysis grid dimensions differ.")
    rgb, alpha = rgba[..., :3], rgba[..., 3]
    zero = np.array([39, 46, 54], dtype=np.float32)
    loss = np.array([40, 195, 214], dtype=np.float32) - zero
    gain = np.array([255, 159, 79], dtype=np.float32) - zero
    offset = rgb - zero
    loss_fraction = np.clip(offset @ loss / (loss @ loss), 0, 1)
    gain_fraction = np.clip(offset @ gain / (gain @ gain), 0, 1)
    loss_error = np.sum((offset - loss_fraction[..., None] * loss) ** 2, axis=-1)
    gain_error = np.sum((offset - gain_fraction[..., None] * gain) ** 2, axis=-1)
    delta = np.where(loss_error < gain_error, -8 * loss_fraction, 8 * gain_fraction)
    # One byte per pixel. 255 is reserved for nodata.
    encoded = np.rint(np.clip(delta, -8, 8) * (127 / 8)) + 127
    return pack(np.where(alpha == 255, encoded, 255))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("comparison", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--worldcover", default="/vsicurl/" + TILE)
    args = parser.parse_args()
    source = args.comparison.read_bytes()
    comparison = json.loads(source)
    grid = comparison["grid"]
    width, height = grid["width"], grid["height"]
    with TemporaryDirectory() as directory:
        aligned = Path(directory) / "worldcover.tif"
        subprocess.run([
            "gdalwarp", "-q", "-te", *map(str, grid["bounds"]), "-ts", str(width), str(height),
            "-t_srs", f'EPSG:{grid["epsg"]}', "-r", "near", "-ot", "Byte", "-dstnodata", "0",
            args.worldcover, str(aligned),
        ], check=True)
        with Image.open(aligned) as image:
            cover = np.array(image)
    if cover.shape != (height, width) or not np.isin(cover, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]).all():
        raise ValueError("Unexpected WorldCover classification grid.")
    if not np.isin(cover, [10, 95]).any():
        raise ValueError("WorldCover contains no mapped trees in the selected grid.")
    payload = {
        "schema": "canopy-watch-screening/v1",
        "comparisonSha256": hashlib.sha256(source).hexdigest(),
        "grid": grid,
        "landCover": {"name": "ESA WorldCover 2021 v200", "tile": TILE, "classes": [10, 95]},
        "cover": pack(cover),
        "HH": recover_change(comparison["layers"]["HH"], cover.shape),
        "HV": recover_change(comparison["layers"]["HV"], cover.shape),
    }
    args.output.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
