#!/usr/bin/env python3
"""Fetch and align only the area-sized crops needed for the Rondônia case."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse
from urllib.request import urlopen

HANSEN = "https://storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12/Hansen_GFC-2024-v1.12_"


def azure_tokens(urls):
    containers = {(urlparse(url).hostname.split(".")[0], urlparse(url).path.split("/")[1])
                  for url in urls if ".blob.core.windows.net/" in url}
    tokens = {}
    for account, container in sorted(containers):
        endpoint = f"https://planetarycomputer.microsoft.com/api/sas/v1/token/{account}/{container}"
        with urlopen(endpoint, timeout=30) as response:
            tokens[account, container] = json.load(response)["token"]
    return tokens


def fetch_crops(manifest, output):
    output.mkdir(parents=True, exist_ok=True)
    jobs = []
    for index, scene in enumerate(manifest["radar"]):
        year = scene["date"][:4]
        prefix = "repeat" if index and year == manifest["radar"][index-1]["date"][:4] else "sar"
        for band, url in scene["assets"].items():
            jobs.append((f"{prefix}{year}-{band}", url, "average"))
    for scene in manifest["optical"]:
        for band, url in scene["assets"].items():
            jobs.append((f'opt{scene["date"][:4]}-{band}', url, "near"))
    jobs.extend([
        ("dem", manifest["dem"], "bilinear"),
        ("cover", HANSEN + "treecover2000_00N_070W.tif", "near"),
        ("loss", HANSEN + "lossyear_00N_070W.tif", "near"),
    ])
    tokens = azure_tokens(url for _, url, _ in jobs)
    env = {**os.environ, "GDAL_DISABLE_READDIR_ON_OPEN":"EMPTY_DIR", "GDAL_HTTP_TIMEOUT":"45",
           "GDAL_HTTP_MAX_RETRY":"2", "CPL_VSIL_CURL_USE_HEAD":"NO", "CPL_VSIL_CURL_CHUNK_SIZE":"65536"}

    def warp(job):
        name, url, method = job
        path = output / f"crop-{name}.tif"
        if path.exists():
            return
        parsed = urlparse(url)
        token = tokens.get((parsed.hostname.split(".")[0], parsed.path.split("/")[1]))
        if token:
            url += "?" + token
        temporary = path.with_suffix(".partial.tif")
        try:
            process = subprocess.run(
                ["gdalwarp", "-overwrite", "-q", "-te", *map(str,manifest["bounds"]),
                 "-tr", "20", "20", "-t_srs", f'EPSG:{manifest["epsg"]}', "-r", method,
                 "-co", "COMPRESS=DEFLATE", "/vsicurl/" + url, str(temporary)],
                env=env, capture_output=True, timeout=360,
            )
            if process.returncode:
                raise RuntimeError(f"GDAL failed while preparing {name} (exit {process.returncode})")
            temporary.replace(path)
            print(name, flush=True)
        finally:
            temporary.unlink(missing_ok=True)

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(warp, jobs))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest",type=Path)
    parser.add_argument("output",type=Path)
    args = parser.parse_args()
    fetch_crops(json.loads(args.manifest.read_text()), args.output)


if __name__ == "__main__":
    main()
