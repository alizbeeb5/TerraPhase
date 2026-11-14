# Verified result - 14 November 2026

## Interactive website

The actual image viewer is now served at `http://127.0.0.1:8080/`. A real Chrome browser check passed image visibility, matching legend, HH/HV switching, native-detail tile requests, mouse-wheel zoom, keyboard panning, fit-to-image, world view, and mobile layout without horizontal overflow or JavaScript exceptions. The check asserts that the page never requests the overview PNG. Screenshots and its report are in `data/validation/viewer/`.

The supplied GCOV file was converted successfully, with its original HDF5 file opened read-only. Its recorded size and modification time remained unchanged.

## Source and outputs

- Scene: `NISAR_L2_PR_GCOV_035_040_D_084_4005_DHDH_A_20261107T234445_20261107T234518_P05036_N_F_J_001`.
- Prepared layers: frequency-A HHHH (HH) and HVHV (HV).
- Each native grid: 33,768 columns x 33,048 rows, float32, 10 m spacing, EPSG:32617.
- Each COG has average-power overviews at factors 2, 4, 8, 16, 32, 64 and 128.
- HH COG: 2,067,670,149 bytes. HV COG: 2,061,106,974 bytes.

## Exhaustive data comparison

Every native pixel was compared directly between each generated COG and its original HDF5 layer, using 4,290 block windows per layer. The comparison treats matching NaN no-data as equal and normalizes explicit fill values as documented in the README.

| Layer | Pixels compared | Finite source pixels compared | Result |
|---|---:|---:|---|
| HH | 1,115,964,864 | 578,629,858 | All equal |
| HV | 1,115,964,864 | 578,629,858 | All equal |

Total: **2,231,929,728 native pixels compared**, with no mismatches. Projection, shape, affine transform, pixel spacing and COG layout checks also passed. This validates preservation of the supplied measurements; it does not independently assess the satellite product's calibration or scientific quality.

Machine-readable evidence is in `data/validation/native-pixels.json`.

## API and rendering

The running server at `http://127.0.0.1:8080` passed real HTTP requests for both layers:

- Tiles at zoom 6, 10, 14 and 17 returned valid 256 x 256 RGBA PNGs containing data.
- These eight measured tile requests took 0.053-0.139 seconds each on this machine. These are local observations with the current filesystem cache, not a concurrency/load benchmark.
- Legends and preview PNGs were decoded successfully.
- Scientific GeoTIFF downloads supported byte ranges and returned HTTP 206 for a 16-byte request.
- Both previews, the HH legend, and representative native/oversampled tiles were inspected visually.

Machine-readable HTTP results and sample tiles are in `data/validation/`.

## Automated tests and dependencies

`python -m pytest -q`: **8 passed**. The test runner emitted one third-party Starlette warning about future HTTPX test-client changes; no tests failed. `python -m pip check` reported no broken requirements. Exact dependency versions are recorded in `requirements-tested.txt`.

The tests cover power-to-dB conversion, transparency, every native pixel in a synthetic product, half-pixel georeferencing, linear-power averaging, overview selection, tile rendering, invalid requests, footprints, legends, previews, CORS and download ranges.

## Delivered artifacts

- `output/HH_backscatter.png` and `output/HV_backscatter.png`: image previews with legends.
- `output/HH_legend.png` and `output/HV_legend.png`: separate default legends.
- `data/catalog/<scene-id>/*.tif`: full-resolution COGs for QGIS and map tiles.
- `output/nisar-gcov-backend.zip`: code, tests, setup scripts and documentation. The ZIP excludes the Python environment, original HDF5 product, and multi-gigabyte generated data.

The PNGs are overview images. Full-detail zooming uses the tile API or the COGs; zooming past the native 10 m grid enlarges existing samples.
