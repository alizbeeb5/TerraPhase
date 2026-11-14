"""Package the real Rondônia comparison from the archived event rasters."""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, label

from export_comparison import render

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path, help="Directory with the archived event rasters")
parser.add_argument("output", type=Path)
args = parser.parse_args()
source, output = args.source, args.output
output.mkdir(parents=True, exist_ok=True)
case = json.loads((source / "case.json").read_text())
shape = (case["height"], case["width"])
structure = np.ones((3, 3))
box = (414, 34, 768, 254)
left, top, right, bottom = box
roi = np.s_[top:bottom, left:right]

def radar(index):
    return np.frombuffer(gzip.decompress((source / f"vh-{index}.bin.gz").read_bytes()),
                         dtype="<f4").reshape(shape)

def flags(delta):
    labels, _ = label(delta < case["threshold"], structure)
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    return counts[labels] >= round(case["minimumAreaHa"] * 10000 / case["pixelM"] ** 2)

before, after, repeat = (radar(i) for i in (0, 3, 4))
delta = after - before
components, _ = label(flags(delta) & flags(repeat - before), structure)
counts = np.bincount(components.ravel())
counts[0] = 0
outline = np.array(Image.open(source / "outline.png"))[..., 3] > 0
neighbors = binary_dilation(outline, iterations=1) & (components > 0)
candidates = np.unique(components[neighbors])
members = components == max(candidates, key=lambda value: counts[value])
control = np.array(Image.open(source / "control.png"))[..., 3] > 0
reference = np.frombuffer(gzip.decompress((source / "loss-reference.bin.gz").read_bytes()),
                          dtype=np.uint8).reshape(shape) != 0
cell_ha = case["pixelM"] ** 2 / 10000
patches = []
for identifier, name, mask, meta in zip((1, 2), ("Mapped forest-loss footprint", "Nearby stable forest"),
                                       (members, control), case["patches"]):
    assert round(mask.sum() * cell_ha, 2) == meta["areaHa"]
    assert round(float(delta[mask].mean()), 2) == meta["series"][3]["delta"]
    assert round(100 * float(reference[mask].mean()), 1) == meta["referencePct"]
    rr, cc = np.where(mask[roi])
    assert len(rr) == mask.sum()
    patches.append({"id": identifier, "name": name, "areaHa": meta["areaHa"],
                    "meanDb": meta["series"][3]["delta"], "repeatDb": meta["series"][4]["delta"],
                    "referencePct": meta["referencePct"], "longitude": meta["longitude"],
                    "latitude": meta["latitude"], "box": [int(cc.min()), int(rr.min()),
                                                          int(cc.max()) + 1, int(rr.max()) + 1]})

for index, name in enumerate(("before", "after")):
    with Image.open(source / f"optical-{index}.png") as image:
        image.crop(box).save(output / f"optical-{name}.webp", lossless=True, method=5)

for name, mask in (("patches", members[roi] + 2 * control[roi]), ("reference", reference[roi])):
    if name == "reference":
        image = Image.new("RGBA", (mask.shape[1], mask.shape[0]), (255, 255, 255, 0))
        image.putalpha(Image.fromarray(mask.astype(np.uint8) * 255))
    else:
        image = Image.fromarray(mask.astype(np.uint8) * 100)
    image.save(output / f"{name}.png")

grid_size = 65
terrain = json.loads((source / "terrain.json").read_text())
elevation = Image.fromarray(np.array(terrain["elevation"], dtype=np.float32)
                            .reshape(terrain["height"], terrain["width"]))
extent = (left * terrain["width"] / shape[1], top * terrain["height"] / shape[0],
          right * terrain["width"] / shape[1], bottom * terrain["height"] / shape[0])
heights = np.asarray(elevation.resize((grid_size, grid_size), Image.Resampling.BILINEAR, box=extent))
values = delta[roi]
valid = np.isfinite(values)
grid = {"width": right-left, "height": bottom-top, "epsg": case["epsg"], "spacingM": case["pixelM"],
        "widthM": (right-left)*case["pixelM"], "heightM": (bottom-top)*case["pixelM"]}
comparison = {
    "schema": "canopy-watch-comparison/v1", "label": case["title"], "grid": grid,
    "thresholdDb": abs(case["threshold"]), "scenes": [case["radar"][i] for i in (0, 3)],
    "optical": case["optical"], "repeat": case["radar"][4], "patches": patches,
    "reference": case["reference"],
    "terrain": {"size": grid_size, "source": "Copernicus DEM GLO-30", "elevation": heights.round(1).ravel().tolist()},
    "layers": {"VH": {
        "before": render(before[roi], (-25, -9)), "after": render(after[roi], (-25, -9)),
        "change": render(values, (-8, 8), change=True), "range": [-25, -9],
        "validPct": round(100 * valid.mean(), 1), "medianDb": round(float(np.nanmedian(values)), 2),
        "dropKm2": round(float((values <= case["threshold"]).sum()) * cell_ha / 100, 3),
        "riseKm2": round(float((values >= -case["threshold"]).sum()) * cell_ha / 100, 3),
    }},
}
(output / "comparison.json").write_text(json.dumps(comparison, separators=(",", ":"), allow_nan=False))
