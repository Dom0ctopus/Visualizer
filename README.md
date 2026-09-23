# Visualizer

A client/server micro-CT volume and segmentation viewer, built with two interchangeable rendering engines:

- **niivue** (default) &mdash; a four-panel layout (axial, coronal, sagittal, 3D render) built on [NiiVue](https://github.com/niivue/niivue)'s own multiplanar renderer, with per-segment opacity/color and a searchable segment tree.
- **itk-vtk-viewer** (experimental) &mdash; a second engine on [itk-vtk-viewer](https://github.com/Kitware/itk-vtk-viewer)/vtk.js, built for scans too large for niivue's GPU-texture-per-volume model. Volumes and segmentations are converted server-side into chunked, multiscale [OME-Zarr](https://ngff.openmicroscopy.org/) pyramids, streamed and composited directly by the frontend for the 2D panes.

Both engines share the same backend-managed library (`server/data/`) and the same Slicer-exported segmentation metadata, so a volume/segmentation pair uploaded once is usable from either.

## Features

- **Backend-managed library**: uploaded volumes and segmentations are stored server-side and can be reloaded later without re-uploading. Each upload kicks off a background OME-Zarr conversion for the itk-vtk-viewer engine; the niivue engine reads the original NRRD directly.
- **Segment tree**: segmentations exported from 3D Slicer carry per-label metadata (name, color, layer) in the NRRD header. The backend parses this and groups segments into "systems" by splitting each segment's name on its first delimiter (e.g. `Skeletal_Femur` &rarr; system "Skeletal", segment "Femur"). The sidebar shows a checkbox tree: file &rarr; system &rarr; segment.
- **Per-segment opacity**: hovering any row (file, system, or segment) pops up an opacity slider; adjusting it at the system or file level applies to all of its segments.
- **Search**: filter the tree by segment or system name, then bulk show/hide everything currently matching.
- **Multi-layer segmentations**: Slicer segmentations with overlapping structures (stored as 4D NRRDs, one "layer" per non-overlapping group) are loaded as separate overlays per layer, so overlapping segments render and toggle independently.
- **Hover-to-identify**: in the itk-vtk-viewer engine, hovering any 2D pane shows the segment under the cursor both in a tooltip that follows the mouse and in a status bar above the panes &mdash; useful for identifying a structure without hunting for it in the sidebar tree.

### niivue engine

The classic four-panel layout: axial, coronal, sagittal, and a 3D render, kept in sync with a shared crosshair, with window/level and zoom controls, an optional custom transfer function for the 3D render, and a "Reset View"/"Clear All" toolbar.

### itk-vtk-viewer engine (experimental)

- **3-up 2D + 3D layout**: the left column shows all three orthogonal planes (axial, coronal, sagittal) at once, each independently scrollable, zoomable (ctrl/cmd+scroll or the sidebar's zoom buttons), and pannable (drag); the right column holds the 3D render.
- **Resolution picker**: every pyramid level is independently selectable for fast fly-through browsing at whichever resolution suits the current task, plus an "Inspect here" control (on the Axial pane) that drills into native resolution for a bounded neighborhood around the current slice without paying native-resolution cost across the whole stack.
- **Cumulative 3D view**: since itk-vtk-viewer's 3D label-image overlay can only ever hold one label image at a time, every loaded segmentation's every layer is combined server-side into a single merged label-map pyramid, so the 3D pane shows everything currently loaded at once rather than just the first segmentation. The 2D panes still show each segment in its own exact Slicer-defined color; the 3D pane uses itk-vtk-viewer's own built-in categorical palette instead, a limitation of its label-image API.
- **Physical-space alignment**: a segmentation's own grid is not assumed to share the base volume's pixel dimensions, origin, or spacing &mdash; both a cropped Slicer export and a segmentation authored against a resampled ROI volume are handled by trusting each grid's own physical origin/spacing, the same way 3D Slicer itself aligns otherwise-unrelated nodes.

## Architecture

- `src/` &mdash; Vite + React + TypeScript frontend. Talks to the backend over `/api/*`.
  - `src/hooks/useNiivue.ts` drives the niivue engine.
  - `src/hooks/useItkVtkViewer.ts`, `useZarrSliceViewer.ts`, `useSegmentationOverlays.ts`, `useSegmentationMerge3D.ts`, `useZarrSegmentations.ts` drive the itk-vtk-viewer engine; `src/lib/zarrClient.ts` reads OME-Zarr chunks directly out of the backend's static file store.
- `server/` &mdash; Express + TypeScript backend. Accepts NRRD uploads, parses Slicer segment metadata, stores files on disk, converts volumes/segmentations to OME-Zarr in the background, and serves everything back by ID.
  - `server/src/zarrConvert.ts` / `segmentationZarrConvert.ts` build a volume's/segmentation's own multiscale pyramid on upload.
  - `server/src/segmentationMergeConvert.ts` builds the itk-vtk-viewer engine's cumulative 3D merge on demand.

In dev, Vite proxies `/api` to the backend (see `vite.config.ts`), so both can be run together.

## Development

```sh
npm install
npm run dev:all   # runs the Vite dev server and the backend together
```

Then open the printed local URL (typically `http://localhost:5173`). Upload a volume NRRD file from the sidebar, then upload one or more Slicer-exported segmentation NRRD files.

To run either side alone: `npm run dev` (frontend only) or `npm run dev:server` (backend only, on port 8787). `npm run dev:server` runs the backend as a plain process; `npm run dev:server:watch` restarts it on file changes, but note that a `tsx watch` file watcher scanning a large `server/data/` directory (many converted volumes) can itself become a source of memory pressure &mdash; prefer the plain `dev:server` unless you're actively editing backend code.

### Segmentation NRRD requirements

The backend expects segmentation files to carry 3D Slicer's per-segment key/value metadata (`Segment0_Name:=`, `Segment0_Color:=`, `Segment0_LabelValue:=`, `Segment0_Layer:=`, ...) &mdash; this is the standard format Slicer writes when exporting a segmentation as NRRD. Files without this metadata are rejected with an explanation.

## Build

```sh
npm run build           # frontend production build (dist/)
npm run typecheck --prefix server   # backend typecheck
```

The backend runs as a plain Node process (`npm start --prefix server`); there's no bundling step for it.
