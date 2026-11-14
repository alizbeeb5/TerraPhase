# Viewer design

Mode: Operate. A familiar geographic image viewer, following the user's ASF Search reference.

The local FastAPI root opens the image viewer. The map takes the entire working area under a compact header. A narrow white sidebar holds acquisition information, HH/HV selection, fit/full-detail navigation and downloads. Teal identifies the selected footprint and active controls. The background is a quiet dark blue-gray so grayscale radar pixels remain clear. A white legend stays anchored at the map's lower right, with numeric minimum, midpoint and maximum backscatter values in dB. Segoe UI and Arial system typography support compact, readable controls. On small screens, the sidebar becomes a compact strip above the map; secondary information collapses while the full-resolution download remains visible.

Image content leads immediately; there is no introduction screen. Bundled Leaflet provides wheel, keyboard, pointer drag and touch navigation, alongside Fit image and World view controls. View full detail opens native zoom 14 for the supplied 10 m grid; further zoom enlarges existing samples. Keyboard focus is visible, controls have text labels, and status messages distinguish loading, unavailable imagery and an empty catalog.

Finish review: ship. Browser tests passed, including the compact mobile controls and visible full-resolution download.
