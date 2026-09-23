# niivue fallback viewer (shelved)

A low-resolution fallback viewer built on [NiiVue](https://github.com/niivue/niivue): axial, coronal, sagittal, and 3D panels kept in sync with a shared crosshair, plus per-segment color and opacity and a searchable segment tree. NiiVue loads each volume whole into one GPU texture, so it only works for scans small enough to fit. The primary app (repo root) uses itk-vtk-viewer with OME-Zarr pyramids instead.

This project is **shelved**. It isn't built, linted, or type-checked with the primary app, and it isn't maintained alongside it. It was split out of the primary app as-is.

## Running it

It talks to the same backend as the primary app, and reads each volume's and segmentation's original NRRD through `/api/files/:id`.

```sh
# from the repo root: start the shared backend
npm run dev:server

# in another terminal
cd niivue-fallback
npm install
npm run dev        # http://localhost:5174, proxies /api to the backend on :8787
```

Files uploaded through either app appear in both, since they share the backend's library.
