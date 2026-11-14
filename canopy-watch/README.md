# Canopy Watch

Canopy Watch compares the same projected footprint in three aligned panels. The before and after panels share one extent and radiometric scale in radar mode. The difference panel shows after minus before, with a common footprint outline across all panels. Select a footprint or review the full study area. The terrain view drapes a radar layer over elevation.

## Events

- **Rondônia, Brazil** compares Sentinel-1 VH from August 2019 and August 2022, a September 2022 radar repeat, Sentinel-2 optical imagery, and Hansen annual tree-cover loss. The selected 8.24 ha footprint overlaps mapped tree-cover loss in the 2020–2022 reference interval. Its mean radar change was −6.33 dB, compared with −0.13 dB over the nearby stable footprint. The radar assets retain eligible forest cells. Dark gaps mark excluded cells. The example was selected for strong agreement with the map and does not provide a general accuracy estimate.
- **Louisiana, USA** compares NASA–ISRO NISAR L-band GCOV on June 21 and September 1, 2026. Screening uses ESA WorldCover 2021 tree cover and mangroves, an HV decrease, and eight-neighbor connected patches. The default is a 3 dB drop and 1 ha minimum patch area. These candidate footprints have no independent forest-loss confirmation. Their dB values are estimated from quantized display imagery clipped at ±8 dB.

## Development

Run `npm run dev` for local use or `npm run build` for the host worker. The interpreter uses the OpenAI Responses API and looks up the selected event and footprint on the server. For local interpretation, provide `OPENAI_API_KEY` in the server environment before starting the app. Configure the same variable as a server secret when deploying.

To regenerate Louisiana from original GCOV HDF5 files, call `export_comparison` in `pipeline/export_comparison.py`, then run `python pipeline/prepare_screening.py web/canopy-watch-louisiana.json web/louisiana-screening.json`. To regenerate Rondônia, recover the archived `dist/events` raster assets from the original Canopy Watch Site source at commit `06060cb` and run `python pipeline/package_rondonia.py <asset-directory> web/rondonia`.

- [Sentinel-1 RTC](https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc)
- [Sentinel-2 L2A](https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a)
- [Hansen Global Forest Change v1.12](https://storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12/download.html)
- [NISAR GCOV](https://nisar-docs.asf.alaska.edu/gcov/)
- [ESA WorldCover 2021](https://esa-worldcover.org/en/data-access)
