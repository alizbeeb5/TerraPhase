# Drought pipeline

Use original GCOV HDF5 files outside Git. Run `python pipeline/drought/ingest.py BEFORE.h5 AFTER.h5 --bbox WEST SOUTH EAST NORTH --output LOCAL_OUTPUT` from canopy-watch. The shared gcov_product reader and export_comparison alignment functions are reused. This exports linear gamma0, dB, masks and source identities on one common grid; it does not retrieve soil moisture.

The Louisiana demonstration reuses the archived, real June 21 / September 1 GCOV comparison. It is display-derived and provisional; original paired HDF5 files are not present locally. No native numeric measurements are reconstructed from its images. NOAA nClimDiv Southeast Louisiana (1609), monthly precipitation, is independent regional context, not a 10 m raster. Anomalies subtract the 1991–2020 mean for the same calendar month. June–August includes part of June before the first radar observation and is labeled as monthly context.

### North Florida and eastern North Carolina

From the repository root, run `python canopy-watch/pipeline/drought/package_browse.py --cache /tmp/terraphase-drought-sources` with Pillow installed. The script resolves the pinned CMR granules, fetches official frequency-A HH/HV previews and NOAA divisional observations, then writes the browser assets and provenance. It uses public downloads. The links in each event identify the original HDF5 files for use with Earthdata Login and the science ingestion pipeline.

These two events pair whole-scene, independently rendered ASF previews with NOAA division-scale observations and an independent drought statement. Image scaling can vary by acquisition. Visual comparisons do not support subtracting the preview intensities or interpreting them as soil moisture.

### Rainfall outlook

Run `python canopy-watch/pipeline/drought/train_outlook.py` with NumPy and scikit-learn installed. The script uses the archived NOAA monthly precipitation series for divisions 0802, 1609 and 3107 in `noaa-history/`. It estimates the probability that a three-month total ending in the next unobserved month falls below the previous 30 years' same-season 20th percentile. Two months of each total are already observed.

The logistic model uses the seasonal baseline and antecedent rainfall over one, three and six months. The validation period (2001–2010) chooses the method with the lower Brier score. The held-out backtest (2011–2025) evaluates both methods independently. Each historical prediction uses only prior observations for its inputs. The chart adds the 10th, 50th and 90th percentiles for the remaining month's historical rainfall to the observed two-month total. This is a rainfall deficit outlook for the climate division. Soil moisture, drought severity and individual map pixels have no modeled probabilities.
