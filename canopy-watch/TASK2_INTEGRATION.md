# Task 2: comparison workspace handoff

Base: `canopy-watch-forest-comparison` at `c1e8639`. Work branch: `feat/event-comparison`.
Use this same base for Task 1, or cherry-pick the Task 2 commit after bringing that base into your branch. Do not replace the current main app with an unrelated branch snapshot.

## Ownership

Task 2 owns `web/compare.js`, `web/compare.css`, `web/screening.js`, `web/comparison/**`, the comparison pipeline, interpreter worker, and `tests/**` inside `canopy-watch/`.
Task 1 owns `web/index.html`, `web/styles.css`, the globe, routing, and dependency manifests/lockfiles. These shared shell files and package files were not modified by Task 2.

## Globe integration (vanilla JavaScript, no new dependencies)

Read the event catalog:

```js
import { listEvents } from '/comparison/events.js';
const events = await listEvents();
// id, name, location, center: {lat, lon}, beforeDate, afterDate, status
```

Two integration options:

1. Keep the existing `#start` and `#comparison` nodes in `index.html`; hide your globe while showing this workspace. Existing `/?event=louisiana` and `/?event=rondonia` URLs still work.
2. Replace those nodes with `<div id="event-comparison-root"></div>` and import `/compare.js` after that root exists. The comparison module mounts its own markup from `/comparison/workspace.js`, so Task 1 does not need to edit comparison internals.

Load `/compare.css` after the shell CSS. Comparison styling is light and scoped to `#comparison`, using `--bg`, `--surface`, `--stroke`, `--ink`, `--muted`, and `--lime`. The shell stylesheet continues to supply layout primitives from the original application.

```js
const { openComparison } = await import('/compare.js');
// Import initializes the event in the URL (default: rondonia).
// Globe/router owns visibility and URL updates:
const url = new URL(location.href);
url.searchParams.set('event', selectedEventId);
history.pushState(null, '', url);
await openComparison(selectedEventId);
document.addEventListener('comparison:back', showGlobe);
```

`openComparison` validates the event ID, loads real assets, and displays loading/errors inside the workspace. The exported catalog contains approximate study-area navigation coordinates, not a forest-loss polygon. The Back button is present in the new root integration; the globe owns its navigation behavior. Keep the root mounted when hiding it; the module is a singleton and does not support multiple simultaneous comparison instances.

## Delivered behavior

- Aligned before, after and change panels with shared pan/zoom, keyboard controls, cursor, patch focus, and optional change overlay.
- Dedicated change map and optional before/after swipe, with acquisition dates and dB units.
- Valid common coverage derived from image alpha masks; transparent data gaps shown on checkerboard, not labeled unchanged.
- Candidate area, valid analyzed area, percentage denominators, historical forest screening area, and downloadable evidence JSON.
- Dynamic Louisiana HV connected-component screening. Threshold/minimum-area changes update patches and totals together. Empty results disable patch interpretation.
- Rondônia selected mapped-loss footprint remains distinct from the stable control and is explicitly not an exhaustive scene total.
- Acquisition metadata checks, image size checks, grid bounds/spacing checks, and screening/comparison checksum verification.
- Server-owned AI evidence includes settings, quantitative context and limitations. The browser submits IDs/settings only; model failure leaves maps usable.

## Numerical data and limits

The current Louisiana archive has display-derived, quantized delta values clipped to ±8 dB. It remains approximate; this work does not reconstruct missing scientific measurements. The 0.06 dB screening margin is exposed in the UI/evidence.

`pipeline/export_comparison.py` now exports optional little-endian float32 numerical changes before display clipping. `prepare_screening.py` carries them into screening inputs. Once regenerated from original HDF5 data, browser and server automatically use these values and remove the quantization margin. Re-run both pipeline steps together; the build rejects a stale screening checksum. Original HDF5 files are not bundled here, so this pipeline was not rerun on those files.

Existing same-grid exports are validated, not reprojected in the browser. Arbitrary external pair uploads and dynamic event ingestion are outside this task. Original HDF5 pair alignment remains in the Python pipeline.

## Validation

Run from `canopy-watch`: `npm test` and `npm run build`.
Tests cover real archive compatibility and checksums, nodata, connected components, minimum area, denominator math, stable-control exclusion, raw numerical changes, invalid pair rejection, viewport bounds, server-owned AI evidence, authentication guards, and provider failure.

No dependencies added. No global theme, routing, manifests, or main-branch changes. Live OpenAI generation requires the existing deployment secret; tests use a mocked provider and do not charge the account.
