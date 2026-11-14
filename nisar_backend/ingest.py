"""One-time, bounded-memory HDF5 -> lossless COG conversion."""

from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
from uuid import uuid4

import h5py
import numpy as np
import rasterio
from rasterio import shutil as rio_shutil
from rasterio.warp import transform_bounds, transform as reproject_points

from .product import discover, identification, product_footprint, read_layer, scene_id
from .render import power_to_db, render_legend, render_preview, validate_style


def grid_footprint(source) -> dict:
    """Densify the projected grid's edges before transforming to WGS84."""
    b = source.bounds
    points = []
    for start, end in (((b.left, b.bottom), (b.right, b.bottom)),
                       ((b.right, b.bottom), (b.right, b.top)),
                       ((b.right, b.top), (b.left, b.top)),
                       ((b.left, b.top), (b.left, b.bottom))):
        points.extend(zip(np.linspace(start[0], end[0], 33, endpoint=False),
                          np.linspace(start[1], end[1], 33, endpoint=False)))
    points.append(points[0])
    longitude, latitude = reproject_points(source.crs, "EPSG:4326", *zip(*points))
    return {"type": "Polygon", "coordinates": [list(map(list, zip(longitude, latitude)))]}


def convert_layer(file, layer_path, directory, vmin, vmax, cmap, acquisition) -> dict:
    layer = read_layer(file, layer_path)
    key = f"{layer.frequency}_{layer.polarization}"
    temporary = directory / f"{key}.working.tif"
    cog = directory / f"{key}.tif"
    height, width = layer.shape
    stride = max(1, math.ceil(math.sqrt(height * width / 250_000)))
    samples = []
    invalid_count = 0
    profile = dict(driver="GTiff", width=width, height=height, count=1, dtype=layer.dtype,
                   crs=layer.crs, transform=layer.transform, nodata=np.nan,
                   tiled=True, blockxsize=512, blockysize=512, compress="DEFLATE",
                   predictor=3, BIGTIFF="YES")
    dataset = file[layer.path]
    with rasterio.Env(GDAL_CACHEMAX=128 * 1024 * 1024):
        with rasterio.open(temporary, "w", **profile) as target:
            count = math.ceil(width / 512) * math.ceil(height / 512)
            next_progress = 0
            for index, (_, window) in enumerate(target.block_windows(1)):
                row, col = int(window.row_off), int(window.col_off)
                data = dataset[row:row + int(window.height), col:col + int(window.width)]
                invalid = ~np.isfinite(data)
                if layer.fill is not None and np.isfinite(layer.fill):
                    invalid |= data == layer.fill
                invalid_count += int(invalid.sum())
                data[invalid] = np.nan
                target.write(data, 1, window=window)
                # Sample on a globally aligned regular grid, not just one corner.
                sample = data[(-row) % stride::stride, (-col) % stride::stride]
                samples.append(sample[np.isfinite(sample) & (sample > 0)])
                progress = int((index + 1) * 100 / count)
                if progress >= next_progress:
                    print(f"{key}: reading {progress}%", flush=True)
                    next_progress = progress + 10
            target.update_tags(AREA_OR_POINT="Area", source_dataset=layer.path,
                               radiometry="gamma0 power (linear)", units="1")
        sampled = np.concatenate(samples)
        if not sampled.size:
            raise ValueError(f"No positive finite backscatter sampled in {layer.path}.")
        db = power_to_db(sampled).compressed()
        low, high = np.percentile(db, [2, 98]).tolist()
        if high <= low:
            low, high = low - 1, high + 1
        low = float(low if vmin is None else vmin)
        high = float(high if vmax is None else vmax)
        validate_style(low, high, cmap)
        print(f"{key}: building COG and linear-power average overviews...", flush=True)
        rio_shutil.copy(temporary, cog, driver="COG", compress="DEFLATE",
                        predictor="FLOATING_POINT", blocksize=512, BIGTIFF="YES",
                        overview_resampling="AVERAGE", NUM_THREADS="2")
    temporary.unlink()
    with rasterio.open(cog) as source:
        bbox = list(transform_bounds(source.crs, "EPSG:4326", *source.bounds, densify_pts=41))
        if bbox[0] > bbox[2] or bbox[2] - bbox[0] > 180:
            raise ValueError("Antimeridian scenes require split footprints; this initial backend does not support them.")
        if bbox[1] < -85.05112878 or bbox[3] > 85.05112878:
            raise ValueError("This scene exceeds Web Mercator's latitude range.")
        footprint = grid_footprint(source)
        overviews = source.overviews(1)
        projected_bounds = list(source.bounds)
    spacing = [layer.transform.a, abs(layer.transform.e)]
    latitude = (bbox[1] + bbox[3]) / 2
    native_zoom = max(0, min(22, math.ceil(math.log2(
        156543.03392804097 * math.cos(math.radians(latitude)) / min(spacing)))))
    preview_name = f"{key}.preview.png"
    legend_name = f"{key}.legend.png"
    render_preview(cog, directory / preview_name, low, high, cmap,
                   f"{layer.polarization[:2]} backscatter | {layer.frequency} | {acquisition}")
    (directory / legend_name).write_bytes(render_legend(low, high, cmap, layer.polarization))
    return {"id": key, "frequency": layer.frequency, "polarization": layer.polarization,
            "hdf5_dataset": layer.path, "cog": cog.name, "preview": preview_name, "legend": legend_name,
            "width": width, "height": height, "dtype": layer.dtype,
            "crs": layer.crs.to_string(), "transform": list(layer.transform)[:6],
            "pixel_spacing_m": spacing, "bounds_projected": projected_bounds,
            "bounds_wgs84": bbox, "grid_footprint": footprint, "overviews": overviews,
            "native_zoom": native_zoom, "nodata_count": invalid_count,
            "radiometry": "gamma0", "stored_units": "linear power (dimensionless)",
            "display": {"units": "dB", "formula": "10 * log10(power)", "vmin": low,
                        "vmax": high, "colormap": cmap, "sample_count": int(sampled.size),
                        "stretch": "sampled 2nd-98th percentiles" if vmin is None and vmax is None else "custom limits",
                        "zero_and_negative_values": "transparent (dB undefined)",
                        "overview_resampling": "average linear power, then convert to dB"}}


def ingest(source: Path, catalog: Path, frequency="frequencyA", polarizations=("HHHH",),
           vmin=None, vmax=None, cmap="gray") -> Path:
    source, catalog = source.resolve(strict=True), catalog.resolve()
    original_stat = source.stat()
    if source.suffix.lower() not in (".h5", ".hdf5"):
        raise ValueError("Expected a NISAR HDF5 product.")
    if source.is_relative_to(catalog):
        raise ValueError("Keep source HDF5 products outside the generated catalog.")
    scene = scene_id(source)
    destination = catalog / scene
    if destination.exists():
        raise FileExistsError(f"Scene already prepared: {destination}. Use a different --catalog to rebuild.")
    catalog.mkdir(parents=True, exist_ok=True)
    staging = catalog / f".tmp-{uuid4().hex}"
    staging.mkdir()
    try:
        with h5py.File(source, "r") as file:
            available = discover(file)
            selected = [p for p in available if p.split("/")[-2] == frequency
                        and (polarizations == ("all",) or p.split("/")[-1] in polarizations)]
            missing = set(polarizations) - {p.rsplit("/", 1)[-1] for p in selected} - {"all"}
            if not selected or missing:
                raise ValueError(f"Requested layer(s) unavailable: {sorted(missing)}. Available: {available}")
            identity = identification(file)
            polygon = product_footprint(identity)
            layers = [convert_layer(file, p, staging, vmin, vmax, cmap,
                                     identity.get("zeroDopplerStartTime", "time unavailable")) for p in selected]
        final_stat = source.stat()
        if (final_stat.st_size, final_stat.st_mtime_ns) != (original_stat.st_size, original_stat.st_mtime_ns):
            raise ValueError("The source file changed during preparation. Run again with a stable input file.")
        metadata = {"schema_version": 1, "id": scene,
                    "prepared_at": datetime.now(timezone.utc).isoformat(),
                    "source": {"path": str(source), "name": source.name,
                               "size_bytes": original_stat.st_size, "mtime_ns": original_stat.st_mtime_ns},
                    "identification": identity, "footprint": polygon or layers[0]["grid_footprint"],
                    "footprint_kind": "product boundingPolygon" if polygon else "projected grid boundary",
                    "layers": {layer["id"]: layer for layer in layers}}
        (staging / "scene.json").write_text(json.dumps(metadata, indent=2, allow_nan=False), encoding="utf-8")
        staging.rename(destination)  # Only publish a fully successful conversion.
    except BaseException:
        # Restrict recursive cleanup to this invocation's generated staging directory.
        if staging.resolve().parent == catalog and staging.name.startswith(".tmp-"):
            shutil.rmtree(staging)
        raise
    return destination

