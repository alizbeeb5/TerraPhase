from io import BytesIO
import json
import math

from fastapi.testclient import TestClient
import h5py
import numpy as np
from PIL import Image
from pyproj import Transformer
import pytest
import rasterio
from rasterio.enums import Resampling

from nisar_backend.api import create_app
from nisar_backend.ingest import ingest
from nisar_backend.product import inspect_product, read_layer
from nisar_backend.render import colorize, power_to_db, tile_bounds, overview_level, WEB_MERCATOR_LIMIT
from nisar_backend.verify import verify_scene


@pytest.fixture(scope="module")
def prepared(tmp_path_factory):
    root = tmp_path_factory.mktemp("gcov")
    source = root / "sample.h5"
    rows, cols = np.indices((1024, 1024))
    power = np.asarray(10 ** ((-25 + rows / 70 + cols / 100) / 10), dtype="float32")
    power[:64, :64] = np.nan
    power[100:108, 100:108] = 0
    power[120:128, 120:128] = -0.1
    power[160:168, 160:168] = -9999  # An explicit fill value must become NaN.
    with h5py.File(source, "w") as file:
        grid = file.create_group("/science/LSAR/GCOV/grids/frequencyA")
        for name, factor in (("HHHH", 1), ("HVHV", 0.25)):
            array = power.copy()
            array[array != -9999] *= factor
            dataset = grid.create_dataset(name, data=array, chunks=(512, 512))
            dataset.attrs["_FillValue"] = -9999.0
        for name, coordinates in (("xCoordinates", 500005 + np.arange(1024) * 10),
                                  ("yCoordinates", 3809995 - np.arange(1024) * 10)):
            grid.create_dataset(name, data=coordinates).attrs["pixel_coordinate_convention"] = "center"
        grid["xCoordinateSpacing"] = 10.0
        grid["yCoordinateSpacing"] = -10.0
        grid["projection"] = 32636
        grid["projection"].attrs["epsg_code"] = 32636
        identity = file.create_group("/science/LSAR/identification")
        identity["zeroDopplerStartTime"] = np.bytes_("2026-11-07T23:44:45")
        transformer = Transformer.from_crs(32636, 4326, always_xy=True)
        ring = [transformer.transform(x, y) for x, y in
                ((500000, 3799760), (510240, 3799760), (510240, 3810000),
                 (500000, 3810000), (500000, 3799760))]
        identity["boundingPolygon"] = np.bytes_("POLYGON ((" + ", ".join(f"{x} {y}" for x, y in ring) + "))")
    original = source.read_bytes()
    catalog = root / "catalog"
    directory = ingest(source, catalog, polarizations=("HHHH", "HVHV"))
    assert source.read_bytes() == original
    return source, catalog, directory, power


def test_db_is_power_not_amplitude():
    result = power_to_db(np.array([1, 10, 100, 0, -1, np.nan, np.inf]))
    np.testing.assert_allclose(result[:3], [0, 10, 20])
    assert result.mask.tolist() == [False, False, False, True, True, True, True]


def test_png_transparency_and_scale():
    data = np.array([[0.01, 0.1, 1.0], [0, -1, np.nan]])
    pixels = np.array(Image.open(BytesIO(colorize(data, -20, 0, "gray"))))
    assert pixels[0, :, 0].tolist() == [0, 128, 255]
    assert pixels[0, :, 3].tolist() == [255, 255, 255]
    assert pixels[1, :, 3].tolist() == [0, 0, 0]


def test_cog_preserves_native_values_and_pixel_centers(prepared):
    source, _, directory, power = prepared
    report = inspect_product(source)
    assert len(report["layers"]) == 2
    assert report["layers"][0]["pixel_spacing_m"] == [10, 10]
    with rasterio.open(directory / "frequencyA_HHHH.tif") as cog:
        expected = power.copy()
        expected[expected == -9999] = np.nan
        np.testing.assert_array_equal(cog.read(1), expected)
        assert cog.xy(0, 0) == (500005, 3809995)
        assert cog.crs.to_epsg() == 32636
        assert cog.res == (10, 10)
        assert cog.overviews(1) == [2]
        assert cog.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert cog.dtypes == ("float32",)
        overview = cog.read(1, out_shape=(512, 512), resampling=Resampling.nearest)
        np.testing.assert_allclose(overview[200, 200], np.mean(power[400:402, 400:402]), rtol=1e-6)
    manifest = json.loads((directory / "scene.json").read_text())
    assert manifest["footprint_kind"] == "product boundingPolygon"
    assert manifest["layers"]["frequencyA_HHHH"]["display"]["units"] == "dB"
    report = verify_scene(directory, full=True)
    assert report["layers"]["frequencyA_HHHH"]["native_values_equal"] is True
    assert report["layers"]["frequencyA_HHHH"]["pixels_compared"] == 1024 * 1024


def test_refuses_overwrite_and_invalid_grid(prepared):
    source, catalog, _, _ = prepared
    with pytest.raises(FileExistsError):
        ingest(source, catalog)
    with h5py.File(source, "r") as file:
        with pytest.raises(ValueError, match="diagonal"):
            read_layer(file, "/science/LSAR/GCOV/grids/frequencyA/xCoordinates")


def test_api_metadata_legend_download_and_cors(prepared):
    _, catalog, _, _ = prepared
    with TestClient(create_app(catalog)) as client:
        assert client.get("/health").json()["status"] == "ok"
        scenes = client.get("/api/scenes").json()
        assert len(scenes["features"]) == 1
        assert scenes["features"][0]["geometry"]["type"] == "Polygon"
        metadata = client.get("/api/scenes/sample").json()
        assert "path" not in metadata
        layer = metadata["layers"]["frequencyA_HHHH"]
        tilejson = client.get(layer["urls"]["tilejson"]).json()
        assert "{z}/{x}/{y}.png?" in tilejson["tiles"][0]
        assert tilejson["display"]["vmin"] == layer["display"]["vmin"]
        legend = client.get(tilejson["legend_url"])
        assert legend.status_code == 200
        assert Image.open(BytesIO(legend.content)).width > 500
        preview = client.get(layer["urls"]["preview"])
        assert Image.open(BytesIO(preview.content)).height > 1000
        response = client.get(layer["urls"]["download"], headers={"Range": "bytes=0-15"})
        assert response.status_code == 206
        assert len(response.content) == 16
        response = client.get("/api/scenes", headers={"Origin": "http://localhost:3000"})
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
        assert client.get("/api/scenes/missing").status_code == 404
        assert client.get("/api/scenes/sample/layers/bad/legend.png").status_code == 404
        assert client.get(layer["urls"]["legend"] + "?vmin=10&vmax=0").status_code == 422
        assert client.get(layer["urls"]["tilejson"] + "?cmap=invalid").status_code == 422


def test_actual_map_tiles_and_no_data(prepared):
    _, catalog, directory, _ = prepared
    with rasterio.open(directory / "frequencyA_HHHH.tif") as source:
        center_x, center_y = source.xy(512, 512)
        web_x, web_y = Transformer.from_crs(source.crs, 3857, always_xy=True).transform(center_x, center_y)
    z = 14
    span = 2 * WEB_MERCATOR_LIMIT / 2**z
    x = math.floor((web_x + WEB_MERCATOR_LIMIT) / span)
    y = math.floor((WEB_MERCATOR_LIMIT - web_y) / span)
    with TestClient(create_app(catalog)) as client:
        base = "/api/scenes/sample/layers/frequencyA_HHHH/tiles"
        response = client.get(f"{base}/{z}/{x}/{y}.png")
        assert response.status_code == 200
        pixels = np.array(Image.open(BytesIO(response.content)))
        assert pixels.shape == (256, 256, 4)
        assert (pixels[..., 3] == 255).any()
        assert np.ptp(pixels[..., 0]) > 0
        outside = client.get(f"{base}/14/0/0.png")
        assert not np.array(Image.open(BytesIO(outside.content)))[..., 3].any()
        assert client.get(f"{base}/3/8/0.png").status_code == 422
        assert client.get(f"{base}/23/0/0.png").status_code == 422
        assert client.get(f"{base}/14/{x}/{y}.png?vmin=nan").status_code == 422


def test_xyz_convention():
    west, south, east, north = tile_bounds(0, 0, 0)
    assert west == south == -WEB_MERCATOR_LIMIT
    assert east == north == WEB_MERCATOR_LIMIT
    assert tile_bounds(1, 0, 0) == (-WEB_MERCATOR_LIMIT, 0, 0, WEB_MERCATOR_LIMIT)


def test_overview_selection_retains_native_detail():
    assert overview_level(10, 9, [2, 4, 8, 16]) is None
    assert overview_level(10, 20, [2, 4, 8, 16]) == 0
    assert overview_level(10, 159, [2, 4, 8, 16]) == 2
    assert overview_level(10, 1000, [2, 4, 8, 16]) == 3
    assert overview_level(10, 1000, []) is None

