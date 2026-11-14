# Integrated explorer design

Mode: Operate. Three connected parts preserve the supplied interfaces and make the downloaded NISAR data inspectable.

- **World map at `/`:** the downloaded Canopy Watch light, three-column interface provides map tools, a central geographic viewport and scene information. Blue footprints show files available on the local server, currently one scene. Clicking a footprint opens the image; drawing a rectangle or entering coordinates checks actual data coverage and opens that selected area. Bundled Natural Earth land remains beneath the external Esri imagery and labels, so geographic context and local scene selection remain available when the background service fails.
- **Shared explorer at `/explorer/`:** the dark-green explorer from `alizbeeb5/TerraPhase` main at `9f2140f09659f06d2f61dab6ccb3bc61b72e6d52` supplies the inspection workspace. Forest-green surfaces, lime controls, muted text, compact image tools and an adjacent evidence panel retain its visual identity. On mobile, the workspace stacks and controls wrap while the image stays prominent.
- **Actual NISAR integration:** geographic HH/HV tiles support pan, zoom and native-detail inspection, with a grayscale legend and numeric backscatter values in dB. Whole-scene and selected-area downloads use the prepared source data. The source has a 10 m native grid; further enlargement adds no detail. Terrain view drapes the radar texture over a real DEM with matching geographic bounds, using a sampled 129 × 129 mesh overview and physical vertical exaggeration.

The shared observed reference case and synthetic radar lab remain distinct modes with their own evidence and labels. The actual GCOV scene is a single acquisition and does not establish temporal forest loss or change. Loading, unavailable-background and invalid-selection messages explain the current state. Visible keyboard focus and keyboard-operable footprints support navigation alongside pointer and touch controls.

The legacy simple viewer remains at `/viewer/`. Integration work belongs on `mohamad-elrizz`; GitHub main remains untouched. Synced references and the downloaded HTML remain read-only.

Finish review: **ship**, with no material fixes requested. All 18 backend tests passed, and the complete workflow passed in real Chrome at desktop and mobile sizes.
