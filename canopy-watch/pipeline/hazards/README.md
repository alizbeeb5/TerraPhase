# Hazard comparisons

The atlas packages four public study areas on matched Sentinel-1 C-band VV terrain-corrected grids. Each study stores the radar and change display rasters, acquisition IDs, upstream provenance and an elevation grid. The Hubbard and Krasheninnikov workspaces link to published NISAR observations for independent context. The Texas layer shows surface water mapped from Sentinel-1 on July 11, 2025. The Venezuela overlay uses the June 18–30 NISAR line-of-sight product from NASA ARIA, distinct from the Sentinel-1 brightness-change pair. The terrain drape uses the static Mapzen elevation tiles.

From the repository root, with GDAL, Pillow, NumPy and scikit-learn installed:

```bash
python canopy-watch/pipeline/hazards/package_radar.py /tmp/terraphase-hazard-radar
python canopy-watch/pipeline/hazards/train_river.py /tmp/terraphase-hazard-stage
```

The radar download uses the Planetary Computer public catalog, ranges out the study crops and keeps transient access tokens outside the app. The date control in Krasheninnikov compares each selected pass against June 27, 2026, after the eruption began. Display imagery clips backscatter to a common scale. The median radar difference uses valid cells before display clipping.

The Texas replay learns one-hour stage changes from recent observations at USGS gauge 08166200. Training uses 2018–2021, validation uses 2022–2023, and the independent test uses 2024. The July 4, 2025 replay shows the gradient-boosted series, a persistence baseline and observations. Windows with missing recent observations have no model value. The model is local to one gauge and does not model the flood footprint. The other three studies provide conditional monitoring guidance based on the published observations and data limitations.
