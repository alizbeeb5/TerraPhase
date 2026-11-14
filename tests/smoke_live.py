"""Exercise a running server against its real catalog; save representative tiles."""

import argparse
from io import BytesIO
import json
import math
from pathlib import Path
import time
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image
from pyproj import Transformer

from nisar_backend.render import WEB_MERCATOR_LIMIT


def get(url, headers=None):
    with urlopen(Request(url, headers=headers or {}), timeout=180) as response:
        return response.status, response.read(), dict(response.headers)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--output", type=Path, default=Path("data/validation"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    status, body, _ = get(args.base_url + "/api/scenes")
    assert status == 200
    features = json.loads(body)["features"]
    assert features, "No completed scene is available"
    results = {}
    for feature in features:
        status, body, _ = get(feature["properties"]["metadata_url"])
        assert status == 200
        scene = json.loads(body)
        for key, layer in scene["layers"].items():
            status, body, _ = get(layer["urls"]["tilejson"])
            assert status == 200
            info = json.loads(body)
            lon, lat, native_zoom = info["center"]
            web_x, web_y = Transformer.from_crs(4326, 3857, always_xy=True).transform(lon, lat)
            tiles = []
            for z in (6, 10, native_zoom, 17):
                span = 2 * WEB_MERCATOR_LIMIT / 2**z
                x = math.floor((web_x + WEB_MERCATOR_LIMIT) / span)
                y = math.floor((WEB_MERCATOR_LIMIT - web_y) / span)
                url = info["tiles"][0].replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
                before = time.perf_counter()
                status, body, _ = get(url)
                seconds = time.perf_counter() - before
                assert status == 200
                pixels = np.asarray(Image.open(BytesIO(body)))
                assert pixels.shape == (256, 256, 4)
                assert pixels[..., 3].any(), f"Empty central tile for {key} at zoom {z}"
                output = args.output / f"{key}.z{z}.png"
                output.write_bytes(body)
                tiles.append({"z": z, "x": x, "y": y, "seconds": round(seconds, 3),
                              "bytes": len(body), "visible_pixels": int((pixels[..., 3] > 0).sum())})
                print(f"{key}: zoom {z} rendered in {seconds:.3f}s", flush=True)
            status, body, _ = get(info["legend_url"])
            assert status == 200
            Image.open(BytesIO(body)).verify()
            status, body, _ = get(layer["urls"]["preview"])
            assert status == 200
            Image.open(BytesIO(body)).verify()
            status, body, headers = get(layer["urls"]["download"], {"Range": "bytes=0-15"})
            assert status == 206 and len(body) == 16
            results[key] = {"tiles": tiles, "legend_png_valid": True,
                            "preview_png_valid": True, "download_range_status": status}
    report = {"base_url": args.base_url, "scenes_checked": len(features), "layers": results}
    (args.output / "http-checks.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

