# Drought pipeline

Use original GCOV HDF5 files outside Git. Run `python pipeline/drought/ingest.py BEFORE.h5 AFTER.h5 --bbox WEST SOUTH EAST NORTH --output LOCAL_OUTPUT` from canopy-watch. The shared gcov_product reader and export_comparison alignment functions are reused. This exports linear gamma0, dB, masks and source identities on one common grid; it does not retrieve soil moisture.

The Louisiana demonstration reuses the archived, real June 21 / September 1 GCOV comparison. It is display-derived and provisional; original paired HDF5 files are not present locally. No native numeric measurements are reconstructed from its images. NOAA nClimDiv Southeast Louisiana (1609), monthly precipitation, is independent regional context, not a 10 m raster. Anomalies subtract the 1991–2020 mean for the same calendar month. June–August includes part of June before the first radar observation and is labeled as monthly context.

### North Florida and eastern North Carolina

From the repository root, run `python canopy-watch/pipeline/drought/package_browse.py --cache /tmp/terraphase-drought-sources` with Pillow installed. The script resolves the pinned CMR granules, fetches official frequency-A HH/HV previews and NOAA divisional observations, then writes the browser assets and provenance. It uses public downloads. The links in each event identify the original HDF5 files for use with Earthdata Login and the science ingestion pipeline.

These two events pair whole-scene, independently rendered ASF previews with NOAA division-scale observations and an independent drought statement. Image scaling can vary by acquisition. Visual comparisons do not support subtracting the preview intensities or interpreting them as soil moisture.
