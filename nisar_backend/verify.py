"""Compare native COG pixels against the original HDF5 source."""

import json
from pathlib import Path

import h5py
import numpy as np
import rasterio
from rasterio.windows import Window

from .product import read_layer


def verify_scene(directory: Path, windows_per_layer=32, full=False) -> dict:
    directory = directory.resolve(strict=True)
    metadata = json.loads((directory / "scene.json").read_text(encoding="utf-8"))
    source = Path(metadata["source"]["path"])
    stat = source.stat()
    if stat.st_size != metadata["source"]["size_bytes"] or stat.st_mtime_ns != metadata["source"]["mtime_ns"]:
        raise ValueError("The source file has changed since preparation.")
    result = {}
    rng = np.random.default_rng(42)
    with h5py.File(source, "r") as file:
        for key, info in metadata["layers"].items():
            layer = read_layer(file, info["hdf5_dataset"])
            with rasterio.open(directory / info["cog"]) as cog:
                if cog.shape != layer.shape or cog.transform != layer.transform or cog.crs != layer.crs:
                    raise ValueError(f"Grid mismatch in {key}.")
                if cog.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG":
                    raise ValueError(f"{key} is not marked as a COG.")
                h, w = layer.shape
                size = min(128, h, w)
                if full:
                    windows = (window for _, window in cog.block_windows(1))
                else:
                    positions = [(0, 0), (h - size, w - size), ((h - size) // 2, (w - size) // 2)]
                    positions.extend((int(rng.integers(0, h - size + 1)), int(rng.integers(0, w - size + 1)))
                                     for _ in range(max(0, windows_per_layer - 3)))
                    windows = (Window(col, row, size, size) for row, col in positions)
                finite_count = 0
                pixels_compared = 0
                windows_compared = 0
                for window in windows:
                    row, col = int(window.row_off), int(window.col_off)
                    expected = file[layer.path][row:row + int(window.height), col:col + int(window.width)]
                    invalid = ~np.isfinite(expected)
                    if layer.fill is not None and np.isfinite(layer.fill):
                        invalid |= expected == layer.fill
                    expected[invalid] = np.nan
                    actual = cog.read(1, window=window)
                    np.testing.assert_array_equal(actual, expected, err_msg=f"Pixel mismatch: {key} at {row}, {col}")
                    finite_count += int(np.isfinite(expected).sum())
                    pixels_compared += expected.size
                    windows_compared += 1
                    if full and windows_compared % 1000 == 0:
                        print(f"{key}: verified {windows_compared} blocks", flush=True)
                if not finite_count:
                    raise ValueError(f"Verification sampled no finite data in {key}.")
                result[key] = {"comparison": "every native pixel" if full else "sampled windows",
                               "windows_compared": windows_compared, "pixels_compared": pixels_compared,
                               "finite_pixels_compared": finite_count, "native_values_equal": True,
                               "pixel_spacing_m": list(cog.res), "overviews": cog.overviews(1),
                               "cog_size_bytes": (directory / info["cog"]).stat().st_size}
    return {"scene_id": metadata["id"], "source_stat_unchanged": True, "layers": result}

