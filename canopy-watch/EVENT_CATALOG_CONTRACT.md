# Task 2 catalog contract and merge handoff

Branch: feat/event-types-drought. Merge Task 2 first, then rebase Task 1.

`listEvents()` remains async and returns isolated JSON objects. Existing IDs `rondonia` and `louisiana`, paths and forest viewer routing are preserved. Each entry includes stable `id`, `type` (`forest-disturbance` or `drought`), `center` (lat/lon), `beforeDate`, `afterDate`, `status`, `evidenceLayers`, `manifestPath`, and `capabilities`.

`capabilities.comparison` controls whether an event can open, independently of provisional status. `capabilities.forecast` is false for all current events. Task 1 may enable it only when that event has an actual evaluated forecast asset; the presence of an AI endpoint is insufficient.

URL: `/?type=drought&q=Louisiana` filters both the site list and globe through one result array. `/?event=louisiana-drought&type=drought` opens the drought workspace. Return links preserve filter and search. Unknown event IDs return to the globe with an unavailable message.

Task 2 changed atlas.js, index.html, comparison/events.js (shared contract), drought viewer/data, ingestion/tests and one required cross-platform asset path fix in scripts/build.mjs. It did not modify compare.js, risk/report components or worker endpoints. Task 1 should import the catalog rather than assuming every event supports forest reporting. Forest-only AI endpoints should not accept the drought event by default.

Louisiana drought uses the existing real GCOV display archive and independent NOAA climate division 9 precipitation. It retains provisional/display-derived labels; it does not claim raw paired HDF5 validation or SME2 availability. NOAA monthly anomalies are recomputed from 30 same-calendar-month observations in 1991–2020, inches converted to mm (25.4). The full NOAA response and SHA256 are retained. The June–August context includes days before the first GCOV observation, which the viewer states. The U.S. Drought Monitor regional narrative is linked; no site-level drought category is inferred.

Validation: 22 JavaScript tests; 3 Python HDF5 fixture tests; Chrome desktop/mobile flow covering drought filtering, search/empty state, refresh, direct links, Back to globe, radar zoom, both forest comparisons, and no uncaught browser errors. Build succeeds on Windows with normalized nested asset paths. Native full-product drought-pair validation awaits the original paired GCOV inputs; only one raw Panama acquisition is present locally.

Run from repo root: `node --test canopy-watch/tests/*.test.js`; `../.venv/Scripts/python.exe -m unittest discover -s canopy-watch/pipeline/drought -p test_ingest.py`. Browser check: set PLAYWRIGHT_MODULE to your installed Playwright module; start canopy-watch with `node scripts/dev.mjs --port 3012`, then run `node canopy-watch/tests/drought.browser.cjs` from repo root. Screenshot outputs are local and ignored by Git.
