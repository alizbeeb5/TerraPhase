"""Read-only HTTP API over preprocessed scenes; no arbitrary file-path input."""

from functools import lru_cache
import json
import os
from pathlib import Path
import re
import sysconfig
from threading import Lock
from typing import Annotated, Literal
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .render import render_legend, render_tile, tile_bounds, validate_style
from .regions import export_crop, parse_bbox, region_info, region_texture
from .terrain import TerrainUnavailable, terrain_grid

DEFAULT_CATALOG = Path(__file__).resolve().parents[1] / "data" / "catalog"
STATIC_DIRECTORY = Path(__file__).resolve().parent / "static"
EXPLORER_DIRECTORY = Path(__file__).resolve().parents[1] / "dist"
if not EXPLORER_DIRECTORY.is_dir():
    EXPLORER_DIRECTORY = Path(sysconfig.get_path("data")) / "share" / "terraphase" / "explorer"
Identifier = re.compile(r"^[A-Za-z0-9_-]+$")
DbLimit = Annotated[float | None, Query(ge=-300, le=300)]
Colormap = Annotated[Literal["gray", "viridis"] | None, Query()]
legend_lock = Lock()  # Matplotlib figure rendering is not thread safe.


class Catalog:
    def __init__(self, path):
        self.root = Path(path).resolve()

    def scene(self, scene_id):
        if not Identifier.fullmatch(scene_id):
            raise HTTPException(404, "Unknown scene")
        directory = (self.root / scene_id).resolve()
        if directory.parent != self.root:
            raise HTTPException(404, "Unknown scene")
        try:
            data = json.loads((directory / "scene.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise HTTPException(404, "Unknown scene") from None
        return directory, data

    def layer(self, scene_id, layer_id):
        directory, scene = self.scene(scene_id)
        layer = scene["layers"].get(layer_id)
        if layer is None:
            raise HTTPException(404, "Unknown layer. Check the scene metadata for available layers.")
        return directory, scene, layer

    def asset(self, directory, name):
        path = (directory / name).resolve()
        if path.parent != directory or not path.is_file():
            raise HTTPException(404, "Prepared asset is missing")
        return path


def style(layer, vmin, vmax, cmap):
    default = layer["display"]
    low = default["vmin"] if vmin is None else vmin
    high = default["vmax"] if vmax is None else vmax
    color = cmap or default["colormap"]
    try:
        validate_style(low, high, color)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return low, high, color


@lru_cache(maxsize=256)
def cached_tile(path: str, z: int, x: int, y: int, low: float, high: float, cmap: str, clip=None) -> bytes:
    return render_tile(path, z, x, y, low, high, cmap, clip)


def bbox_query(value):
    try:
        return parse_bbox(value)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@lru_cache(maxsize=64)
def cached_legend(low: float, high: float, cmap: str, polarization: str) -> bytes:
    with legend_lock:
        return render_legend(low, high, cmap, polarization)


def create_app(catalog_path=None) -> FastAPI:
    catalog = Catalog(catalog_path or os.environ.get("GCOV_CATALOG", DEFAULT_CATALOG))
    app = FastAPI(title="NISAR GCOV backend", version="0.1.0",
                  description="Scene footprints, gamma0 dB PNG tiles, legends and lossless COG downloads.")
    origins = [s.strip() for s in os.environ.get("GCOV_CORS_ORIGINS", "http://localhost:3000,http://localhost:5173").split(",") if s.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET"],
                       allow_headers=["*"], expose_headers=["Content-Disposition"])

    @app.get("/", include_in_schema=False)
    def viewer() -> FileResponse:
        return FileResponse(STATIC_DIRECTORY / "canopy.html", media_type="text/html",
                            headers={"Cache-Control": "no-cache"})

    @app.get("/viewer", include_in_schema=False)
    def simple_viewer() -> FileResponse:
        return FileResponse(STATIC_DIRECTORY / "index.html", media_type="text/html",
                            headers={"Cache-Control": "no-cache"})

    app.mount("/assets", StaticFiles(directory=STATIC_DIRECTORY), name="viewer_assets")
    app.mount("/explorer", StaticFiles(directory=EXPLORER_DIRECTORY, html=True), name="main_explorer")

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "catalog_ready": catalog.root.is_dir()}

    def layer_urls(request, scene_id, layer_id):
        arguments = {"scene_id": scene_id, "layer_id": layer_id}
        return {name: str(request.url_for(name, **arguments)) for name in
                ("tilejson", "legend", "preview", "download")}

    @app.get("/api/scenes")
    def scenes(request: Request) -> dict:
        features = []
        for manifest in sorted(catalog.root.glob("*/scene.json")):
            if manifest.parent.name.startswith("."):
                continue
            _, scene = catalog.scene(manifest.parent.name)
            identity = scene["identification"]
            features.append({"type": "Feature", "id": scene["id"], "geometry": scene["footprint"],
                             "properties": {"id": scene["id"],
                                            "acquired_at": identity.get("zeroDopplerStartTime"),
                                            "footprint_kind": scene["footprint_kind"],
                                            "bounds_wgs84": next(iter(scene["layers"].values()))["bounds_wgs84"],
                                            "layers": list(scene["layers"]),
                                            "metadata_url": str(request.url_for("scene_metadata", scene_id=scene["id"]))}})
        return {"type": "FeatureCollection", "features": features}

    @app.get("/api/scenes/{scene_id}")
    def scene_metadata(request: Request, scene_id: str) -> dict:
        _, scene = catalog.scene(scene_id)
        # Local filesystem paths stay private to the backend.
        return {"id": scene["id"], "source_filename": scene["source"]["name"],
                "identification": scene["identification"], "footprint": scene["footprint"],
                "footprint_kind": scene["footprint_kind"],
                "layers": {key: {**{k: v for k, v in layer.items() if k not in ("cog", "preview", "legend", "grid_footprint")},
                                 "urls": layer_urls(request, scene_id, key)}
                           for key, layer in scene["layers"].items()}}

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/tilejson.json", name="tilejson")
    def tilejson(request: Request, scene_id: str, layer_id: str,
                 vmin: DbLimit = None, vmax: DbLimit = None, cmap: Colormap = None,
                 bbox: str | None = None) -> dict:
        _, _, layer = catalog.layer(scene_id, layer_id)
        low, high, color = style(layer, vmin, vmax, cmap)
        parameters = {"vmin": low, "vmax": high, "cmap": color}
        clip = bbox_query(bbox) if bbox is not None else None
        if clip is not None:
            parameters["bbox"] = ",".join(map(str, clip))
        query = urlencode(parameters)
        url = str(request.url_for("tile", scene_id=scene_id, layer_id=layer_id, z=0, x=0, y=0))
        template = url.rsplit("/tiles/", 1)[0] + "/tiles/{z}/{x}/{y}.png?" + query
        west, south, east, north = clip or layer["bounds_wgs84"]
        return {"tilejson": "3.0.0", "name": f"{scene_id} / {layer_id}", "scheme": "xyz",
                "tiles": [template], "minzoom": 0, "maxzoom": 22,
                "bounds": [west, south, east, north],
                "center": [(west + east) / 2, (south + north) / 2, layer["native_zoom"]],
                "attribution": "NASA / ISRO NISAR", "native_zoom": layer["native_zoom"],
                "legend_url": str(request.url_for("legend", scene_id=scene_id, layer_id=layer_id)) + "?" + urlencode({"vmin":low,"vmax":high,"cmap":color}),
                "display": {"vmin": low, "vmax": high, "colormap": color, "units": "dB"}}

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/tiles/{z}/{x}/{y}.png", name="tile")
    def tile(scene_id: str, layer_id: str, z: int, x: int, y: int,
             vmin: DbLimit = None, vmax: DbLimit = None, cmap: Colormap = None,
             bbox: str | None = None) -> Response:
        directory, _, layer = catalog.layer(scene_id, layer_id)
        low, high, color = style(layer, vmin, vmax, cmap)
        try:
            tile_bounds(z, x, y)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        path = catalog.asset(directory, layer["cog"])
        clip = bbox_query(bbox) if bbox is not None else None
        with rasterio_environment():
            data = cached_tile(str(path), z, x, y, low, high, color, clip)
        return Response(data, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/legend.png", name="legend")
    def legend(scene_id: str, layer_id: str, vmin: DbLimit = None,
               vmax: DbLimit = None, cmap: Colormap = None) -> Response:
        _, _, layer = catalog.layer(scene_id, layer_id)
        low, high, color = style(layer, vmin, vmax, cmap)
        return Response(cached_legend(low, high, color, layer["polarization"]), media_type="image/png")

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/preview.png", name="preview")
    def preview(scene_id: str, layer_id: str) -> FileResponse:
        directory, _, layer = catalog.layer(scene_id, layer_id)
        return FileResponse(catalog.asset(directory, layer["preview"]), media_type="image/png")

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/download.tif", name="download")
    def download(scene_id: str, layer_id: str) -> FileResponse:
        directory, _, layer = catalog.layer(scene_id, layer_id)
        return FileResponse(catalog.asset(directory, layer["cog"]), media_type="image/tiff",
                            filename=f"{scene_id}_{layer_id}_gamma0_power.tif")

    def selected_region(scene_id, layer_id, bbox):
        directory, scene, layer = catalog.layer(scene_id, layer_id)
        bounds = bbox_query(bbox)
        cog = catalog.asset(directory, layer["cog"])
        try:
            with rasterio_environment():
                info = region_info(cog, bounds, scene["footprint"])
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return cog, layer, info

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/region")
    def selection(scene_id: str, layer_id: str, bbox: str) -> dict:
        _, _, info = selected_region(scene_id, layer_id, bbox)
        return info

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/texture.png")
    def texture(scene_id: str, layer_id: str, bbox: str,
                size: Annotated[int, Query(ge=128, le=2048)] = 1024,
                vmin: DbLimit = None, vmax: DbLimit = None, cmap: Colormap = None) -> Response:
        cog, layer, info = selected_region(scene_id, layer_id, bbox)
        low, high, color = style(layer, vmin, vmax, cmap)
        with rasterio_environment():
            content = region_texture(cog, info["bbox"], size, low, high, color)
        return Response(content, media_type="image/png")

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/terrain")
    def terrain(scene_id: str, layer_id: str, bbox: str,
                grid: Annotated[int, Query(ge=65, le=257)] = 129) -> dict:
        if grid not in (65, 129, 257):
            raise HTTPException(422, "Terrain grid must be 65, 129, or 257 vertices per side.")
        _, _, info = selected_region(scene_id, layer_id, bbox)
        try:
            with rasterio_environment():
                result = terrain_grid(info["bbox"], grid, catalog.root.parent / "dem-cache")
        except TerrainUnavailable as error:
            raise HTTPException(503, str(error)) from error
        return result

    @app.get("/api/scenes/{scene_id}/layers/{layer_id}/crop.tif")
    def crop(scene_id: str, layer_id: str, bbox: str) -> FileResponse:
        cog, _, info = selected_region(scene_id, layer_id, bbox)
        try:
            with rasterio_environment():
                path = export_crop(cog, info["bbox"], catalog.root.parent / "exports")
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return FileResponse(path, media_type="image/tiff", filename=f"{scene_id}_{layer_id}_selection.tif")

    return app


def rasterio_environment():
    import rasterio
    return rasterio.Env(GDAL_CACHEMAX=128 * 1024 * 1024, GDAL_NUM_THREADS="1")


app = create_app()

