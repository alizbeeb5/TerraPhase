"""Read GCOV metadata explicitly; do not depend on GDAL's HDF5 driver."""

from dataclasses import dataclass
from pathlib import Path
import re

import h5py
import numpy as np
from affine import Affine
from pyproj import CRS
from shapely import from_wkt
from shapely.geometry import mapping

DIAGONALS = ("HHHH", "HVHV", "VVVV", "VHVH", "RHRH", "RVRV")


def scalar(value):
    """Turn a small HDF5 scalar into JSON-safe Python data."""
    if isinstance(value, np.ndarray):
        return scalar(value.item()) if value.size == 1 else [scalar(v) for v in value]
    if isinstance(value, (bytes, np.bytes_)):
        return value.decode("utf-8").rstrip("\x00")
    if isinstance(value, np.generic):
        return value.item()
    return value


@dataclass(frozen=True)
class Layer:
    path: str
    frequency: str
    polarization: str
    shape: tuple[int, int]
    dtype: str
    transform: Affine
    crs: CRS
    fill: float | None


def grid_transform(group: h5py.Group, shape: tuple[int, int]) -> Affine:
    x = np.asarray(group["xCoordinates"][:], dtype=np.float64)
    y = np.asarray(group["yCoordinates"][:], dtype=np.float64)
    if x.ndim != 1 or y.ndim != 1 or (y.size, x.size) != shape:
        raise ValueError("Coordinate vector lengths do not match the raster.")
    dx = float(group["xCoordinateSpacing"][()])
    dy = float(group["yCoordinateSpacing"][()])
    if not np.all(np.isfinite(x)) or not np.all(np.isfinite(y)):
        raise ValueError("Nonfinite grid coordinates.")
    if dx <= 0 or dy >= 0 or not np.isfinite(dx + dy):
        raise ValueError("Expected a north-up grid: positive X spacing, negative Y spacing.")
    if not np.allclose(np.diff(x), dx, rtol=1e-7, atol=1e-6):
        raise ValueError("X coordinates are not a regular grid.")
    if not np.allclose(np.diff(y), dy, rtol=1e-7, atol=1e-6):
        raise ValueError("Y coordinates are not a regular grid.")
    for coordinate in (group["xCoordinates"], group["yCoordinates"]):
        convention = scalar(coordinate.attrs.get("pixel_coordinate_convention", "center"))
        if convention != "center":
            raise ValueError(f"Unsupported pixel coordinate convention: {convention}")
    # NISAR coordinates denote pixel CENTERS. GeoTIFF needs the upper-left EDGE.
    return Affine(dx, 0, x[0] - dx / 2, 0, dy, y[0] - dy / 2)


def read_layer(file: h5py.File, path: str) -> Layer:
    dataset = file[path]
    if dataset.ndim != 2 or dataset.dtype.kind != "f" or dataset.dtype.itemsize not in (4, 8):
        raise ValueError(f"{path} must be a real float32/float64 diagonal covariance layer.")
    if path.rsplit("/", 1)[-1] not in DIAGONALS:
        raise ValueError("Only diagonal backscatter terms can be rendered as gamma0 power.")
    group = dataset.parent
    projection = group["projection"]
    epsg = scalar(projection.attrs.get("epsg_code", projection[()]))
    crs = CRS.from_epsg(int(epsg))
    if not crs.is_projected or any(abs(a.unit_conversion_factor - 1) > 1e-9 for a in crs.axis_info):
        raise ValueError("This backend expects the NISAR projected grid in metres.")
    raw_fill = dataset.attrs.get("_FillValue")
    fill = float(scalar(raw_fill)) if raw_fill is not None else None
    return Layer(path, group.name.rsplit("/", 1)[-1], dataset.name.rsplit("/", 1)[-1],
                 dataset.shape, dataset.dtype.name, grid_transform(group, dataset.shape), crs, fill)


def discover(file: h5py.File) -> list[str]:
    paths = []
    for radar in ("LSAR", "SSAR"):
        root = f"/science/{radar}/GCOV/grids"
        if root not in file:
            continue
        for frequency in ("frequencyA", "frequencyB"):
            for polarization in DIAGONALS:
                path = f"{root}/{frequency}/{polarization}"
                if path in file:
                    paths.append(path)
    if not paths:
        raise ValueError("No supported GCOV diagonal backscatter layers found.")
    return paths


def identification(file: h5py.File) -> dict:
    result = {}
    for radar in ("LSAR", "SSAR"):
        root = f"/science/{radar}/identification"
        if root not in file:
            continue
        for key in ("productType", "zeroDopplerStartTime", "zeroDopplerEndTime",
                    "orbitPassDirection", "trackNumber", "frameNumber", "boundingPolygon"):
            if key in file[root]:
                result[key] = scalar(file[root][key][()])
        break
    return result


def product_footprint(identity: dict) -> dict | None:
    """Use the product's WGS84 polygon, never a guessed rectangle."""
    text = identity.get("boundingPolygon")
    if not text:
        return None
    geometry = from_wkt(text)
    if geometry.geom_type not in ("Polygon", "MultiPolygon") or not geometry.is_valid or geometry.is_empty:
        raise ValueError("The product boundingPolygon is not a valid polygon.")
    west, south, east, north = geometry.bounds
    if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
        raise ValueError("The product footprint is outside WGS84 longitude/latitude limits.")
    return mapping(geometry)


def scene_id(source: Path) -> str:
    # Stable readable ID; never accept arbitrary paths via the HTTP API.
    return re.sub(r"[^A-Za-z0-9_-]", "_", source.stem)


def inspect_product(source: Path) -> dict:
    with h5py.File(source, "r") as file:
        identity = identification(file)
        layers = []
        for path in discover(file):
            layer = read_layer(file, path)
            layers.append({"path": path, "shape": list(layer.shape), "dtype": layer.dtype,
                           "crs": layer.crs.to_string(),
                           "pixel_spacing_m": [layer.transform.a, abs(layer.transform.e)]})
    return {"scene_id": scene_id(source), "size_bytes": source.stat().st_size,
            "identification": identity, "layers": layers}

