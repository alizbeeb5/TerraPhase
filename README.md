# Canopy Watch

A NASA Space Apps project for investigating possible forest disturbance with radar. Open **Explore case** to view five observed Sentinel-1A passes over Rondônia, Brazil. **Radar lab** demonstrates a persistent synthetic clearing and a one-pass terrain artifact using NISAR-style HH and HV signals.

## Run the explorer locally

```sh
python3 -m http.server 8000 --directory dist
```

Open http://localhost:8000. The application serves bundled rasters and metadata. It requires no runtime API calls outside the server. For external submission, host the contents of `dist/` on a static host.

## Rebuild the case

The pipeline uses Python's GDAL bindings, GDAL command-line programs, NumPy and SciPy. On Debian or Ubuntu the packages are `gdal-bin python3-gdal python3-numpy python3-scipy`.

```sh
/usr/bin/python3 pipeline/fetch_case.py pipeline/rondonia.json cache
/usr/bin/python3 pipeline/build_case.py cache pipeline/rondonia.json dist/data
```

The acquisition manifest records the exact Sentinel-1 RTC and Sentinel-2 surface reflectance scene IDs, asset URLs, grid bounds and DEM source. The fetcher requests temporary public access through Planetary Computer and crops the source grids with GDAL. It writes only the local study window. The notebook runs the same acquisition and analysis stages and plots the footprint comparison.

## Interpretation

The displayed study area uses a 20 m UTM 20S grid. The radar alert requires a cross-polarized (VH) drop greater than 3.5 dB from the 2019 baseline, at least 24 eight-connected cells and validity on every acquisition date. The baseline forest proxy starts from Hansen 2000 canopy cover of at least 30% and excludes mapped loss through 2019. A 3 × 3 mean on linear gamma-zero power precedes the dB conversion. Unique first detections are tracked across dates.

The featured footprint is the intersection of the August 30 and September 11, 2022 radar detections. It was selected for strong overlap with Hansen annual tree-cover loss. The stable comparison was selected for absence of mapped loss and radar alerts within its footprint. These selected examples describe one local case. They do not imply general accuracy or validate the 3.5 dB threshold beyond the case. The 20 m output spacing describes the analysis grid, not independent sensor resolution.

### Demo walkthrough

1. Zoom to A and sweep the optical comparison over the outlined patch.
2. Choose Radar alerts and move between the 2021 and the final two 2022 acquisitions.
3. Choose Loss reference, then B to compare with nearby stable forest.
4. In Radar lab, choose B on Pass 3 and toggle steep slopes. Move to Pass 4 to see the temporary signal recover. Open 3D terrain for the same simulated hillside.

### Data credits

- Copernicus Sentinel-1 and Sentinel-2, via the Microsoft Planetary Computer [RTC catalog](https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc) and [L2A catalog](https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a).
- Copernicus DEM GLO-30, [Registry of Open Data on AWS](https://registry.opendata.aws/copernicus-dem/).
- Hansen / UMD / Google / USGS / NASA, [Global Forest Change v1.12](https://developers.google.com/earth-engine/datasets/catalog/UMD_hansen_global_forest_change_2024_v1_12).
- Alaska Satellite Facility, [NISAR GCOV documentation](https://nisar-docs.asf.alaska.edu/gcov/), for the simulated lesson and guidance on future GCOV cases.
