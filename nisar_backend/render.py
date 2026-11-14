"""All renderers share one scene-wide dB scale, including the legend."""

from io import BytesIO
from contextlib import ExitStack
import math

import matplotlib
matplotlib.use("Agg")
from matplotlib import colormaps
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.colors import Normalize
from matplotlib.figure import Figure
import numpy as np
from PIL import Image
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform

COLORMAPS = ("gray", "viridis")
WEB_MERCATOR_LIMIT = 20037508.342789244


def validate_style(vmin: float, vmax: float, cmap: str) -> None:
    if not math.isfinite(vmin) or not math.isfinite(vmax) or vmax <= vmin:
        raise ValueError("The dB maximum must be finite and greater than the minimum.")
    if cmap not in COLORMAPS:
        raise ValueError(f"Colormap must be one of {COLORMAPS}.")


def power_to_db(power) -> np.ma.MaskedArray:
    array = np.ma.asarray(power)
    values = np.asarray(array.data)
    valid = ~np.ma.getmaskarray(array) & np.isfinite(values) & (values > 0)
    result = np.full(values.shape, np.nan, dtype=np.float64)
    # Covariance diagonals contain POWER: 10*log10, not amplitude's 20*log10.
    np.log10(values, out=result, where=valid)
    result *= 10
    return np.ma.array(result, mask=~valid)


def colorize(power, vmin: float, vmax: float, cmap: str) -> bytes:
    validate_style(vmin, vmax, cmap)
    db = power_to_db(power)
    normalized = np.clip((db.filled(vmin) - vmin) / (vmax - vmin), 0, 1)
    rgba = colormaps[cmap](normalized, bytes=True)
    rgba[..., 3] = np.where(np.ma.getmaskarray(db), 0, 255)
    buffer = BytesIO()
    Image.fromarray(rgba).save(buffer, format="PNG")
    return buffer.getvalue()


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    if not 0 <= z <= 22 or not 0 <= x < 2**z or not 0 <= y < 2**z:
        raise ValueError("Invalid XYZ tile coordinates.")
    span = 2 * WEB_MERCATOR_LIMIT / 2**z
    left = -WEB_MERCATOR_LIMIT + x * span
    top = WEB_MERCATOR_LIMIT - y * span
    return left, top - span, left + span, top


def overview_level(native_resolution: float, target_resolution: float, factors: list[int]) -> int | None:
    """Choose an existing overview that is at least as detailed as the output."""
    selected = None
    for index, factor in enumerate(factors):
        if native_resolution * factor <= target_resolution:
            selected = index
    return selected


def render_tile(cog, z: int, x: int, y: int, vmin: float, vmax: float, cmap: str) -> bytes:
    bounds = tile_bounds(z, x, y)
    # A separate dataset per request avoids sharing GDAL handles across threads.
    with ExitStack() as stack:
        native = stack.enter_context(rasterio.open(cog))
        web_transform, _, _ = calculate_default_transform(
            native.crs, "EPSG:3857", native.width, native.height, *native.bounds)
        level = overview_level(max(abs(web_transform.a), abs(web_transform.e)),
                               (bounds[2] - bounds[0]) / 256, native.overviews(1))
        # A VRT constructed at the final tile resolution may otherwise scan the
        # full-resolution source. Explicitly open the chosen GeoTIFF overview.
        source = native if level is None else stack.enter_context(rasterio.open(cog, overview_level=level))
        with WarpedVRT(source, crs="EPSG:3857", transform=from_bounds(*bounds, 256, 256),
                       width=256, height=256, src_nodata=np.nan, nodata=np.nan,
                       resampling=Resampling.average, warp_mem_limit=64) as vrt:
            power = vrt.read(1, masked=True)
    return colorize(power, vmin, vmax, cmap)


def render_legend(vmin: float, vmax: float, cmap: str, polarization: str) -> bytes:
    validate_style(vmin, vmax, cmap)
    figure = Figure(figsize=(6.4, 1.45), dpi=130)
    FigureCanvasAgg(figure)
    axis = figure.add_axes((0.09, 0.52, 0.82, 0.20))
    figure.colorbar(matplotlib.cm.ScalarMappable(norm=Normalize(vmin, vmax), cmap=cmap),
                    cax=axis, orientation="horizontal", ticks=np.linspace(vmin, vmax, 5))
    axis.set_xlabel(f"{polarization[:2]} gamma0 backscatter (dB) | 10 log10(power)", fontsize=10)
    figure.text(0.09, 0.90, "Darker: weaker return     Brighter: stronger return" if cmap == "gray"
                else "Low backscatter                                       High backscatter", fontsize=10)
    buffer = BytesIO()
    figure.savefig(buffer, format="png", facecolor="white")
    return buffer.getvalue()


def render_preview(cog, output, vmin: float, vmax: float, cmap: str, title: str) -> None:
    validate_style(vmin, vmax, cmap)
    with rasterio.open(cog) as source:
        scale = min(1, 1800 / max(source.width, source.height))
        power = source.read(1, out_shape=(max(1, round(source.height * scale)),
                                          max(1, round(source.width * scale))),
                            masked=True, resampling=Resampling.average)
        bounds = source.bounds
        crs = source.crs.to_string()
    figure = Figure(figsize=(11, 10), dpi=180, layout="constrained")
    FigureCanvasAgg(figure)
    axis = figure.add_subplot()
    axis.set_facecolor("#dbe3e9")
    image = axis.imshow(power_to_db(power), cmap=cmap, vmin=vmin, vmax=vmax,
                        extent=(bounds.left, bounds.right, bounds.bottom, bounds.top),
                        origin="upper", interpolation="nearest")
    axis.set(title=title, xlabel=f"Easting (m) | {crs}", ylabel="Northing (m)")
    axis.ticklabel_format(style="plain", useOffset=False)
    figure.colorbar(image, ax=axis, shrink=0.80, pad=0.025,
                    label="gamma0 backscatter (dB) | 10 log10(power)", extend="both")
    figure.suptitle("NISAR GCOV", fontsize=18, fontweight="bold")
    figure.get_layout_engine().set(rect=(0, 0.03, 1, 1))
    figure.text(0.5, 0.015, "Overview image. Blue-gray: no displayed data. Zoom using the tile API or the GeoTIFF in QGIS.",
                ha="center", fontsize=9)
    figure.savefig(output, format="png")

