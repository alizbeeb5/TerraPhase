# Product

## Platform
web, served locally by the existing FastAPI backend.

## Users and purpose
The user is building a NISAR Space Apps project. They need to inspect their downloaded GCOV image in a website, pan and zoom to the native data, and see a legend. Their friend is building a map interface similar to ASF Search.

## Confirmed constraints
- The supplied HDF5 is read-only. Existing full-resolution COGs and tile endpoints are already available.
- The actual image viewer must be the landing page, with the image visible immediately.
- Offer familiar map navigation, geographic footprints, HH/HV switching and downloads.
- Preserve the source's 10 m native grid; enlargement beyond that cannot invent detail.
- This work extends the existing local server. Public hosting is outside this change.

## Reference
ASF Search is the user's stated interaction reference. The viewer should follow familiar map controls and let the imagery occupy the main screen.
