# Product

## Platform
web, served locally by the existing FastAPI backend.

## Users and purpose
The user is building a NISAR Space Apps project. They need to inspect their downloaded GCOV image in a website, pan and zoom to the native data, and see a legend. Their friend is building a map interface similar to ASF Search.

## Confirmed constraints
- The supplied HDF5 is read-only. Existing full-resolution COGs and tile endpoints are already available.
- The landing page is the user's downloaded Canopy Watch world map. The catalog currently contains one actual NISAR scene. Its footprint or an area selected inside it opens the shared explorer from GitHub main.
- Offer familiar map navigation, geographic footprints, HH/HV switching and downloads.
- Preserve the source's 10 m native grid; enlargement beyond that cannot invent detail.
- This work extends the existing local server. Public hosting is outside this change.

## Integrated sources
- World-map layout: `canopy_watch_nisar_deforestation_explorer (1).html`, preserved as a reference without editing the downloaded file.
- Shared explorer and its case/lab: `alizbeeb5/TerraPhase` main at `9f2140f09659f06d2f61dab6ccb3bc61b72e6d52`.
- Real NISAR path: existing GCOV COGs, native XYZ tiles, HH/HV legends, geographic crop selection and native exports.
- Shared reference-case and radar-lab features remain separate from the actual NISAR scene. One NISAR acquisition does not support temporal loss/change conclusions.
- 3D uses a real DEM and the radar texture over identical geographic bounds; it is a sampled overview, with explicit vertical exaggeration.
- Work belongs on `mohamad-elrizz`; do not change GitHub main.

## Reference
ASF Search is the user's stated interaction reference. The viewer should follow familiar map controls and let the imagery occupy the main screen.
