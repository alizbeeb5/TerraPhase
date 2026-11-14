# TerraPhase: Canopy Watch with real NISAR data

This starter backend reads a NISAR Level-2 GCOV HDF5 file, creates georeferenced full-resolution images, and serves PNG map tiles with a matching legend. The original HDF5 file is opened read-only.

## Canopy Watch forest change

The current [Canopy Watch app](canopy-watch/) compares real satellite imagery from Rondônia and Louisiana in aligned before, after, and radar-difference panels. It includes 3D terrain and an OpenAI patch interpreter.

Run `cd canopy-watch && npm run dev` and open [http://127.0.0.1:3000/](http://127.0.0.1:3000/). See the [Canopy Watch README](canopy-watch/README.md) for data sources and interpreter setup.

## Open the integrated application

**Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/) after starting the server.**

1. The world map shows rectangles for NISAR files actually prepared on this server. Currently there is one scene over Panama.
2. Use **Find available image**, then click the blue footprint to open the whole scene. Or choose **Select box** and draw a rectangle inside it. A coordinate form is also available.
3. The selection opens your friend's shared explorer in **Your NISAR image** mode, using the real GCOV tiles. Scroll or use +/− to zoom, drag or use keyboard arrows to pan, switch HH/HV, and use **Full detail** to reach the native grid.
4. **3D terrain** drapes this area's actual radar texture onto a real elevation DEM. Rotate, zoom and adjust vertical exaggeration. The slope toggle uses DEM-derived slope, not a radar layover classification.
5. Export evidence as JSON, download the whole-scene GeoTIFF, or download a native cropped GeoTIFF for a selected area up to 64 million pixels. Choose a smaller rectangle for larger crops.

The shared **Explore case** and **Radar lab** remain available, including their optical comparison, timeline, evidence, and terrain features. Their Sentinel-1 case and explicitly synthetic radar lesson are separate from your NISAR measurements. The single NISAR date does not enable change alerts, loss totals, or before/after analysis. The simpler original image viewer remains at [/viewer](http://127.0.0.1:8080/viewer).

The world-map source is the supplied HTML. The explorer in `dist/` and its bundled case/pipeline were integrated from [GitHub main at 9f2140f](https://github.com/alizbeeb5/TerraPhase/commit/9f2140f09659f06d2f61dab6ccb3bc61b72e6d52). The remote main branch is not edited by this integration.

The website requests full-resolution XYZ tiles as you zoom; it does not enlarge the overview PNG. Above the native zoom it enlarges existing pixels. `/docs` is developer documentation, not the image viewer.

### Elevation and map backgrounds

No DEM file was supplied. The backend therefore retrieves public [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) and caches them in `data/dem-cache/`. Elevation/bathymetry is decoded in metres before interpolation. Both the radar texture and DEM use the same Web Mercator extent, with the north edge at row zero. Exaggeration scales actual relative elevation. A failed DEM request produces an error; no procedural terrain is substituted.

To use your own georeferenced elevation GeoTIFF instead, set `$env:GCOV_DEM_PATH = 'C:\data\elevation.tif'` before starting the server. Elevations must be in metres. Original DEM sampling and the 3D mesh are independent of the 10 m radar grid; 3D is a sampled overview, while 2D retains native radar detail. Terrain credits are linked in the data/method dialog.

Esri satellite backgrounds require Internet access. A bundled public-domain Natural Earth coastline keeps the world map available while those backgrounds load or when offline. Radar data, reference-case assets, and the shared UI are served locally. Previously cached DEM areas also remain available offline.

The pipeline is:

```text
GCOV .h5 -> lossless linear-power COG + averaged overviews
                                    -> PNG preview with legend
                                    -> FastAPI XYZ tiles + legend + GeoJSON footprints
                                    -> your friend's map / QGIS
```

The supplied product has frequency-A HH and HV grids of **33,768 columns x 33,048 rows**, with **10 m pixel spacing** in **EPSG:32617 (UTM zone 17N)**. Its footprint covers Panama and nearby waters, acquired on **7 November 2026 at 23:44:45 UTC**. The file also contains frequency-B HH and HV grids at 80 m spacing. The sample preparation uses frequency A; `inspect` lists both frequencies and `--frequency frequencyB` selects the other grid when preparing a separate catalog.

## Run on Windows

Open PowerShell in this folder. Python 3.11 or newer is required; the supplied environment was tested with Python 3.14.

`requirements-tested.txt` records the exact Windows/Python 3.14 versions used here. To reproduce that environment, add `-c requirements-tested.txt` to the install command. Other Python versions should use the dependency ranges in `pyproject.toml` so pip can select compatible releases.

```powershell
# First installation only
.\setup.ps1

# Prepare the supplied file: HH and HV at frequency A
.\prepare-sample.ps1

# Start the read-only backend
.\start.ps1
```

If PowerShell blocks a local script, use the equivalent Python commands below rather than changing your machine's execution policy.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[test]'

$gcovFile = Join-Path $env:USERPROFILE 'Downloads\NISAR_L2_PR_GCOV_035_040_D_084_4005_DHDH_A_20261107T234445_20261107T234518_P05036_N_F_J_001.h5'
.\.venv\Scripts\python.exe -m nisar_backend.cli inspect $gcovFile
.\.venv\Scripts\python.exe -m nisar_backend.cli prepare $gcovFile --polarizations HHHH HVHV
.\.venv\Scripts\python.exe -m uvicorn nisar_backend.api:app --host 127.0.0.1 --port 8080
```

Once prepared, skip preparation on later runs. The converter refuses to overwrite a completed scene. To try a different preparation, choose a new `--catalog` folder and point `GCOV_CATALOG` at it before starting the server. A scene becomes visible to the API only after all selected layers finish successfully. A failed conversion removes only its generated staging folder.

Open [the image viewer](http://127.0.0.1:8080/) to explore the image. Developers can use [API documentation](http://127.0.0.1:8080/docs) to try endpoints, or [scene footprints](http://127.0.0.1:8080/api/scenes) to get the scene ID and metadata URL.

## Output files

Under `data/catalog/<scene-id>/`, each prepared layer has:

| File | Purpose |
|---|---|
| `frequencyA_HHHH.tif` | HH, full native grid, scientific linear gamma0 power, losslessly compressed COG |
| `frequencyA_HVHV.tif` | HV, same format |
| `*.preview.png` | Overview image with coordinates and a color bar; intended for a quick look |
| `*.legend.png` | Separate legend for the default display scale |
| `scene.json` | Projection, pixel spacing, footprint, display limits and source provenance |

The GeoTIFF retains the source floating-point precision, coordinate system and pixel spacing. Nonfinite values and an explicit dataset `_FillValue` become NaN no-data. Finite zero and negative values remain in the GeoTIFF; they are transparent in the dB display because their logarithm is undefined. The renderer does not treat the HDF5 storage default fill value as authoritative no-data metadata.

## Zooming and resolution

A single PNG is a fixed-size preview. For QGIS-like zooming, the frontend requests 256 x 256 XYZ tiles for the visible part of the map. At low zoom, the backend uses averaged overviews; as you zoom in, it reads the native image data. Source values are averaged in **linear power** before converting to dB, so bright targets are not incorrectly averaged in logarithmic space.

Detail is finite: `pixel_spacing_m` reports the actual grid spacing; it is not a claim about the instrument's independent spatial resolution. Zooming beyond that spacing only enlarges existing samples. The tile metadata includes an approximate `native_zoom` for the scene's center latitude. The server allows zoom 0-22; a map can set `maxNativeZoom` to the reported native zoom and continue enlarging tiles above it.

To inspect the output immediately in QGIS, add `frequencyA_HHHH.tif` as a raster layer. It is georeferenced and has overviews. QGIS initially sees **linear power**, so to match the web display use Raster Calculator with `10 * log10("your_layer@1")` on positive pixels, then use the manifest's display minimum and maximum. The PNG preview and API tiles already apply this conversion.

## What the legend means

GCOV diagonal terms are calibrated, radiometrically terrain-corrected gamma0 **power**. The display uses:

```text
gamma0_dB = 10 * log10(gamma0_power)
```

HHHH represents HH backscatter; HVHV represents HV. These are radar measurements, not optical photographs. The grayscale legend maps lower dB to black and higher dB to white. A shared scene/layer scale is chosen from a bounded, regularly spaced sample's 2nd and 98th percentiles. Values outside those limits are visually clipped; their original values remain in the GeoTIFF. This is a contrast stretch, not land classification. Blue-gray in the exported preview indicates no displayed data; tile no-data is transparent.

Display limits can be set during preparation (`--vmin -25 --vmax 0`) or on tile/legend/TileJSON requests (`?vmin=-25&vmax=0&cmap=viridis`). Supported colormaps are `gray` and `viridis`. Use the same limits for tiles and legends. The TileJSON endpoint does this automatically through its returned `tiles` and `legend_url`. Static preview PNGs always use the preparation-time style.

Only real diagonal covariance terms are accepted. Complex off-diagonal terms require a separate interpretation and are intentionally excluded from this power renderer. GCOV's mask encodes subswath information; this starter preserves its supplied backscatter without inventing an additional boolean quality mask. It does not classify water, vegetation, layover, or shadow.

## Frontend integration

Your friend can keep their current frontend. The API provides the data needed for the click-to-view flow:

| Endpoint | Result |
|---|---|
| `GET /api/scenes` | GeoJSON FeatureCollection of clickable scene footprints |
| `GET /api/scenes/{scene}` | Available layers, grid spacing and absolute asset URLs |
| `GET /api/scenes/{scene}/layers/{layer}/tilejson.json` | XYZ URL template, bounds, display limits and matching legend URL |
| `GET /api/scenes/{scene}/layers/{layer}/tiles/{z}/{x}/{y}.png` | Geographically positioned transparent PNG tile |
| `GET /api/scenes/{scene}/layers/{layer}/legend.png` | Legend for the requested display style |
| `GET /api/scenes/{scene}/layers/{layer}/preview.png` | Exported preview with its legend |
| `GET /api/scenes/{scene}/layers/{layer}/download.tif` | Full-resolution scientific COG download, including byte-range support |
| `GET /api/scenes/{scene}/layers/{layer}/region?bbox=w,s,e,n` | Validate a rectangular selection and report native grid dimensions |
| `GET /api/scenes/{scene}/layers/{layer}/texture.png?bbox=w,s,e,n` | Radar texture on the same extent as the 3D terrain |
| `GET /api/scenes/{scene}/layers/{layer}/terrain?bbox=w,s,e,n&grid=129` | Real DEM vertex heights and slopes, with source attribution |
| `GET /api/scenes/{scene}/layers/{layer}/crop.tif?bbox=w,s,e,n` | Lossless native-grid crop, with geographic masking |

Tiles and TileJSON accept the same optional `bbox` to make everything outside the selection transparent. Selections with no downloaded coverage or usable backscatter are rejected. Coordinates always use west, south, east, north in WGS84 longitude/latitude; drawn rectangles are not expanded into arbitrary fixed-size squares.

The footprint uses the product's own `boundingPolygon` when present. This normally follows the radar swath more closely than a square. When absent, the API explicitly labels the fallback as the projected grid boundary, which may include no-data margins. GeoJSON uses longitude, latitude. Leaflet bounds use latitude, longitude. Tiles use XYZ with Y increasing southward, not the flipped TMS convention.

For an existing Leaflet map called `map`, the essential JavaScript is:

```javascript
const API = "http://127.0.0.1:8080";
let activeRaster;
let selectionVersion = 0;

async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

const catalog = await getJSON(`${API}/api/scenes`);
const footprints = L.geoJSON(catalog, {
  style: { color: "#167aab", weight: 2, fillOpacity: 0.12 },
  onEachFeature(feature, polygon) {
    polygon.on("click", async () => {
      const version = ++selectionVersion;
      try {
        const scene = await getJSON(feature.properties.metadata_url);
        const layer = scene.layers.frequencyA_HHHH ?? Object.values(scene.layers)[0];
        const info = await getJSON(layer.urls.tilejson);
        if (version !== selectionVersion) return; // Ignore a stale click response.
        if (activeRaster) map.removeLayer(activeRaster);
        activeRaster = L.tileLayer(info.tiles[0], {
          tileSize: 256, minZoom: info.minzoom, maxZoom: info.maxzoom,
          maxNativeZoom: info.native_zoom, attribution: info.attribution,
          bounds: [[info.bounds[1], info.bounds[0]], [info.bounds[3], info.bounds[2]]]
        }).addTo(map);
        map.fitBounds(polygon.getBounds());
        // Update existing frontend controls:
        // legendImage.src = info.legend_url;
        // downloadLink.href = layer.urls.download;
      } catch (error) {
        console.error("The scene could not be loaded:", error);
        // Show an error message in your frontend.
      }
    });
  }
}).addTo(map);
if (catalog.features.length) map.fitBounds(footprints.getBounds());
```

The backend permits browser requests from `http://localhost:3000` and `http://localhost:5173` by default. Set `GCOV_CORS_ORIGINS` to a comma-separated list for other origins, such as `http://127.0.0.1:3000`. It serves locally on port 8080 to avoid interfering with another project's usual port 8000.

## Validation

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m nisar_backend.cli verify 'data/catalog/<scene-id>'
# Optional exhaustive comparison, still using bounded-memory block reads:
.\.venv\Scripts\python.exe -m nisar_backend.cli verify 'data/catalog/<scene-id>' --full
```

Tests compare every base-resolution pixel in a synthetic product, confirm pixel-center placement and average overviews, exercise dB conversion and transparency, and check actual tile rendering, missing data, API validation, legends, CORS and download ranges. `verify` compares 32 deterministic native pixel windows per prepared layer directly against your original HDF5 file and checks its file size/modification time. Window sampling is not an exhaustive comparison of a multi-gigabyte product.

`verify --full` instead compares every native pixel in each prepared layer, treating corresponding NaNs as equal. It takes longer because it reads both the source and the COGs in full, without loading them into memory at once.

## Scope and deployment

This is a local backend foundation for already downloaded, administrator-prepared products. HDF5 parsing and conversion happen once in the CLI, not inside a tile request. Disk usage grows with selected layers; preparation needs space for the working GeoTIFF and final COG. Memory is bounded by raster blocks, a small display sample, and GDAL caches rather than loading whole image arrays.

Tiles have a bounded in-process cache (256 tiles); multiple server processes each have their own cache. For public deployment, add your project's authentication/download policy, a reverse proxy/CDN and load/concurrency limits. There is no upload endpoint, automatic ASF catalog synchronization, database, job queue, or Internet hosting in this starter. It does not change your friend's frontend. This initial implementation rejects polar scenes outside Web Mercator and scenes crossing the antimeridian; those need a different map projection or split geometry.

## Technical references

- [ASF GCOV documentation](https://github.com/ua-asf/nisar-docs/blob/main/data-products/level-2/gcov.md): calibrated gamma0 power, diagonal layers, projection and metadata.
- [GDAL COG driver](https://gdal.org/en/stable/drivers/raster/cog.html): tiled lossless GeoTIFFs and overview generation.
- [Rasterio virtual warping](https://rasterio.readthedocs.io/en/stable/topics/virtual-warping.html): rendering source data into a map tile's grid.

