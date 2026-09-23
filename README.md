# Visualizer

A browser-based viewer for large micro-CT volumes and their 3D Slicer segmentations. Volumes and segmentations are converted server-side into chunked, multiscale [OME-Zarr](https://ngff.openmicroscopy.org/) pyramids, so scans far larger than a single GPU texture can be browsed interactively: three linked 2D panes read slices directly from the pyramid, and a 3D pane renders a voxel volume ([itk-vtk-viewer](https://github.com/Kitware/itk-vtk-viewer)), per-segment surface meshes ([Luxar](https://github.com/royerlab/luxar), or [three.js](https://threejs.org/) without it), or a Gaussian-splat "atlas" of the scan colored by segment (Luxar).

A simpler, low-resolution [NiiVue](https://github.com/niivue/niivue) viewer that loads whole volumes into the GPU is kept as a separate, shelved project in [`niivue-fallback/`](niivue-fallback/README.md).

## Features

- **Upload and library**: upload NRRD volumes and 3D Slicer segmentation NRRDs from the sidebar. Files are stored server-side (`server/data/`) and converted in the background, one job at a time; anything already uploaded can be reloaded later without re-uploading.
- **Three linked 2D panes** (axial, coronal, sagittal):
  - Click any pane to move the shared cursor; the other two panes jump to that point, and each pane shows where the other two planes cut it (Slicer colors: axial red, coronal green, sagittal yellow).
  - Oriented consistently: axial is shown radiologically (patient right on screen left, anterior up), coronal and sagittal with superior up, with R/L/A/P/S/I labels on every pane.
  - Displayed at true physical proportions, so anisotropic voxels aren't squashed.
  - Scroll to page through a pane's axis, ctrl/cmd+scroll to zoom, drag to pan. Voxels stay crisp at any zoom.
  - GPU-composited: window/level, zoom and pan only change shader uniforms, so they're instant regardless of slice size or how many segmentations are overlaid.
- **Resolution picker**: every pyramid level is selectable for fast fly-through browsing, and "Inspect here" (axial pane) drills into native resolution for a bounded neighborhood around the current slice.
- **Segment tree**: segment metadata (name, color, layer) from the Slicer NRRD header, grouped into systems by the first delimiter in each name (e.g. `Skeletal_Femur` &rarr; system "Skeletal", segment "Femur"), with per-segment/system/file visibility and opacity, and search.
- **Hover-to-identify**: hovering a 2D pane shows the segment under the cursor in a tooltip and in the status bar above the panes.
- **3D pane, three tabs**:
  - **Voxel render**: itk-vtk-viewer volume rendering. itk-vtk-viewer can only hold one label image, so every loaded segmentation's layers are merged server-side into one label map at the finest resolution that fits its voxel budget (colored with itk-vtk-viewer's own palette).
  - **Surface meshes**: smooth per-segment surfaces generated on the server from each segmentation's native-resolution label map, in each segment's own color and opacity. With Luxar installed (see below) they're compiled into a streamed Luxar scene: large surfaces get decimated coarser levels so the viewer only draws the detail the view needs (the finest level is the exact surface), each segment is a Luxar layer driven by the segment tree, and hovering a surface names it. The **Basic** toggle (and the fallback without Luxar) is a plain three.js viewer. Rotate by dragging, zoom with scroll, pan with right-drag.
  - **Splat atlas** (needs Luxar): in the style of Luxar's TotalSegmentator demo, the CT is fitted with 3D Gaussians and each is colored by the segment under its center (sampled from the segmentation's native resolution, so thin structures keep their color), one toggleable layer per segment system plus a dim "unlabeled tissue" layer; hover names the segment. Built on request, at Draft / Standard / High quality. It's an artistic, lossy representation for presentation, not the voxel data.

## Architecture

- `src/` &mdash; Vite + React + TypeScript frontend.
  - `src/components/ItkVtkViewerPage.tsx` is the app; `ZarrSliceCanvas.tsx` is one 2D pane; `MeshViewer.tsx` is the surface-mesh tab.
  - `src/lib/zarrClient.ts` reads OME-Zarr chunks directly from the backend's static file store (with an in-memory LRU chunk cache); `src/lib/sliceRenderer.ts` is the WebGL2 slice compositor; `src/lib/sliceGeometry.ts` maps between screen and voxel coordinates.
  - `src/hooks/useZarrSliceViewer.ts` (base slices), `useSegmentationOverlays.ts` (segmentation slices), `useSegmentationMerge3D.ts` (voxel-render merge), `useItkVtkViewer.ts` (voxel render), `useZarrSegmentations.ts` (segment state).
- `server/` &mdash; Express + TypeScript backend: uploads, Slicer segment-metadata parsing, background conversion, and static serving of the converted data.
  - `zarrConvert.ts` / `segmentationZarrConvert.ts` build each upload's pyramid (`zarrWriter.ts`).
  - `orthogonalCopies.ts` writes coronal- and sagittal-chunked copies of the finest pyramid levels. The primary arrays are chunked one Z slice per chunk (ideal for axial reads, but a coronal/sagittal slice would span every chunk in the level); the copies make every plane a handful of chunk reads. They roughly triple a converted store's disk footprint and add ~60% to its write time.
  - `surfaceMesh.ts` generates the segment meshes (multi-label surface nets with Taubin smoothing, streamed two slices at a time).
  - `segmentationMergeConvert.ts` builds the voxel-render merge on demand.
  - `luxarScenes.ts` + `luxar/build_scene.py` compile Luxar scenes (mesh scene; splat atlas) in the separate Python environment, cached under `server/data/luxar/` by their inputs and invalidated when an input is deleted or its meshes regenerated.
  - `jobQueue.ts` runs conversions, mesh generation and backfills one at a time to bound memory, conversions first. A mesh job in progress pauses (between slices) when an upload arrives and resumes from its last finished layer afterwards. `GET /api/jobs` reports the running job, its progress and the queue; the sidebar shows this under Upload and in each library row, and the server logs `[jobs]` lines, including a `still running` heartbeat every 30s. On startup, the server backfills orthogonal copies and meshes for anything uploaded before those features existed, and restarts conversions and mesh jobs a previous run left unfinished. Luxar builds (a separate Python process) run on their own lane of the queue, so a long splat fit never holds up an upload.

In dev, Vite proxies `/api` to the backend (see `vite.config.ts`), so both run together.

## Development

```sh
npm install
npm run dev:all   # runs the Vite dev server and the backend together
```

Then open the printed local URL (typically `http://localhost:5173`), upload a volume, then one or more segmentations.

To run either side alone: `npm run dev` (frontend only) or `npm run dev:server` (backend only, on port 8787). `npm run dev:server:watch` restarts the backend on file changes, but its file watcher can itself become a source of memory pressure with a large `server/data/`; prefer plain `dev:server` unless you're editing backend code.

The 2D panes and the mesh tab need WebGL2.

### Luxar (optional)

The Luxar mesh viewer and the splat atlas need [Luxar](https://github.com/royerlab/luxar)'s Python package in its own environment. Install it once with:

```sh
npm run setup:luxar
```

This creates `server/.luxar-venv` (Python 3.12+; it uses [uv](https://docs.astral.sh/uv/) if you have it) and installs the pinned `luxar[gsplats]`, which includes PyTorch. The server picks it up without a restart; set `LUXAR_PYTHON` to use a different interpreter. Without it, the app works as before with the three.js mesh viewer.

Splat fitting is the slow part and runs on PyTorch's best device: an NVIDIA GPU (CUDA), Apple silicon (MPS), or the CPU. Draft (fitted on a grid of at most 128 voxels per side) is the CPU default: a small test scan took about 3½ minutes on a 4-core CPU, and a full-size scan should take several minutes more. Standard (256) and High (512, like Luxar's own CT atlas demo) are meant for a GPU; on a CPU they can take hours. Builds run in the background and are cached, so each only has to happen once. Each layer's brightness is balanced automatically so dense bone doesn't drown out soft tissue and thin vessels; press <kbd>L</kbd> in the viewer to adjust layers by hand.

### Segmentation NRRD requirements

Segmentation files must carry 3D Slicer's per-segment key/value metadata (`Segment0_Name:=`, `Segment0_Color:=`, `Segment0_LabelValue:=`, `Segment0_Layer:=`, ...), which is what Slicer writes when exporting a segmentation as NRRD. Files without it are rejected with an explanation. Only the `left-posterior-superior` space is supported.

## Build

```sh
npm run build                        # frontend production build (dist/)
npm run typecheck --prefix server    # backend typecheck
npm run lint
```

The backend runs as a plain Node process (`npm start --prefix server`); there's no bundling step for it.
