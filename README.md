# Visualizer

A browser-based viewer for large micro-CT volumes and their 3D Slicer segmentations. Volumes and segmentations are converted server-side into chunked, multiscale [OME-Zarr](https://ngff.openmicroscopy.org/) pyramids, so scans far larger than a single GPU texture can be browsed interactively: three linked 2D panes read slices directly from the pyramid, and a 3D pane renders a voxel volume ([itk-vtk-viewer](https://github.com/Kitware/itk-vtk-viewer)), or per-segment surface meshes ([three.js](https://threejs.org/)).

A simpler, low-resolution [NiiVue](https://github.com/niivue/niivue) viewer that loads whole volumes into the GPU is kept as a separate, shelved project in [`niivue-fallback/`](niivue-fallback/README.md).

## Features

- **Upload and library**: upload NRRD volumes and 3D Slicer segmentation NRRDs from the sidebar. Files are stored server-side (`server/data/`) and converted in the background, one job at a time; anything already uploaded can be reloaded later without re-uploading.
- **Three linked 2D panes** (axial, coronal, sagittal):
  - Click any pane to move the shared cursor; the other two panes jump to that point, and each pane shows where the other two planes cut it (Slicer colors: axial red, coronal green, sagittal yellow).
  - Oriented consistently: axial is shown radiologically (patient right on screen left, anterior up), coronal and sagittal with superior up, with R/L/A/P/S/I labels on every pane.
  - Displayed at true physical proportions, so anisotropic voxels aren't squashed.
  - Scroll to page through a pane's axis, ctrl/cmd+scroll to zoom, drag to pan. Voxels stay crisp at any zoom.
  - GPU-composited: window/level, zoom and pan only change shader uniforms, so they're instant regardless of slice size or how many segmentations are overlaid.
- **Resolution picker**: every pyramid level is selectable for the 2D panes; coarser levels load faster.
- **Editors and viewers**: only editors can upload, delete, save defaults or open itk-vtk-viewer's own menu; everyone else gets the saved look and a minimal toolbar (crop box and wipes, blend, blend fade, capture). The server decides who is an editor with `EDITORS`: `local` (the default) means requests from the machine the server runs on, including through the Vite dev/preview proxy; `all` and `none` do what they say. Editors' **Save look** stores the voxel render's opacity curve, color range, sample distance, scattering, label blend and fade settings per volume (`server/data/render-defaults/`), applied whenever anyone loads that volume; the crop box's **Save as default** does the same for the box.
- **Blend fade**: **Grow** / **Fade** sweep the label blend between a minimum and maximum (%) over a set number of seconds, by the clock, for recordings.
- **Segment tree**: segment metadata (name, color, layer) from the Slicer NRRD header, grouped into systems by the first delimiter in each name (e.g. `Skeletal_Femur` &rarr; system "Skeletal", segment "Femur"), with per-segment/system/file visibility and opacity, and search.
- **Color schemes**: **Segmentation** (each segment's color from its segmentation file) or **Real to life**: general tissue-type colors (nervous tissue, muscle, heart, vessel, gill, gut wall, stomach, liver/digestive gland, exocrine gland, pigmented sac, renal tissue, gonad, reproductive tract, beak/chitin, cartilage) sampled from photographs of fresh dissections, matched to segments by name and by file (e.g. everything in a brain segmentation is nervous tissue), with small lightness steps so segments of the same tissue stay distinguishable. The Segments panel reports how many segments matched; unmatched ones keep their file colors. Applies to the 2D panes, the voxel render, the surface meshes and the segment tree; the choice is in the Segments panel and in each 3D tab's toolbar. In the surface mesh viewer, hard structures (beak, cartilage) also get a glossier, clear-coated finish in either scheme. Sources and method: [`docs/real-to-life-palette/`](docs/real-to-life-palette/README.md).
- **Hover-to-identify**: hovering shows the segment under the cursor in a tooltip and in the status bar above the panes, in the 2D panes and in both 3D views. The surface mesh viewer picks the frontmost visible surface exactly (a one-pixel ID render on the GPU). The voxel render casts the ray through the loaded volume and composites opacity as the renderer does (CT opacity, label blend, segment visibility/opacity, crop planes), naming the segment where the view becomes mostly opaque: at full blend the first visible segment; at lower blend CT in front hides segments behind it; at blend 0 nothing is named. Soft, semi-transparent edges can differ from the render by a voxel or so. Hover pauses while dragging.
- **Snapshot, record, turntable**: both 3D views have a capture bar. **Snapshot** saves a PNG of the render at full device resolution; **Record** saves a video of the render itself (MP4 where the browser supports recording it, otherwise WebM), capturing whatever you do while it runs; **Turntable** rotates the view continuously about the same axis as dragging horizontally (the screen's vertical axis through the rotation center), for turntable clips. Snapshots and recordings carry a scale bar (in recordings it follows the zoom). Files download named after the view and the time.
- **Scale bars**: both 3D views show a live scale bar, measured at the camera's focal plane (where the rotation center is), and the same bar is drawn into captures. It replaces itk-vtk-viewer's own, which measures at the near clip plane and so under-reads.
- **Search focus**: type in the Segments search and press **Enter** (or **Focus**) to single out the matches (a matching system or file name selects all of its segments); **Shift+Enter** (or **Add**) adds the matches to the focus set; **Esc** (or **Clear**) ends it. To focus only some of them, pick segments in the tree instead: click one to select it, **Shift+click** to select a range, **⌘/Ctrl+click** to add or remove one (Shift or ⌘/Ctrl+click on a file or system selects all of its shown segments); the selection survives changing the search, so it can be built up over several searches. Then **Focus** (replace the focus set) or **Add to focus** in the bar above the tree. For recordings, tick **Fade focus changes over N s** under the search box: focusing then fades the rest out gradually (from no fade up to the Focus strength), adding fades just the new segments in, replacing crossfades, and Clear or removing a segment fades back -- eased, by the clock, with the voxel render updated every frame at full quality while it runs. Focusing makes the matches visible, and one **Focus** strength (in the sidebar and both 3D toolbars; 0 = no fade, 100% = hidden) fades everything else in every view: the 2D panes, the surface meshes and the voxel render (where it scales the other segments' label weights, alongside the label blend). The 2D panes jump to the focused set -- its volume-weighted center, moved on each axis to the nearest slice that contains some of it (the center of a left and a right kidney lies between them) -- and outline it with a white line and dark halo. Centers come from per-segment statistics (voxel counts, centroids, per-slice histograms) that the server computes once per segmentation from a coarse pyramid level and caches beside its store (`GET /api/segmentations/:id/segment-stats`).
- **Collapsible segment tree**: segmentation files and systems collapse and expand (chevron or click the name; Collapse all / Expand all above the tree). A search shows its matches whatever is collapsed.
- **Stable transparency in the surface mesh viewer**: see-through segments use weighted blended order-independent transparency, so overlapping segments don't swap in front of each other as the view rotates, and the clip planes hug the scene for depth precision where neighbouring surfaces nearly coincide.
- **3D pane, two tabs**:
  - **Voxel render**: itk-vtk-viewer volume rendering. itk-vtk-viewer can only hold one label image, so every loaded segmentation's layers are merged server-side into one label map at the finest resolution that fits its voxel budget. Labels are drawn in each segment's own color, matching the 2D panes, surface meshes and segment tree (so the tree doubles as the legend); the toolbar's **Palette** option switches to itk-vtk-viewer's own categorical palette. Colors apply once the merged label map is built (the Segmentations panel shows its progress).
  - **Surface meshes**: smooth per-segment surfaces generated on the server from each segmentation's native-resolution label map, rendered with three.js in each segment's own color and opacity, driven by the segment tree. Rotate by dragging, zoom with scroll, pan with right-drag.

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
  - `jobQueue.ts` runs conversions, mesh generation and backfills one at a time to bound memory, conversions first. A mesh job in progress pauses (between slices) when an upload arrives and resumes from its last finished layer afterwards. `GET /api/jobs` reports the running job, its progress and the queue; the sidebar shows this under Upload and in each library row, and the server logs `[jobs]` lines, including a `still running` heartbeat every 30s. On startup, the server backfills orthogonal copies and meshes for anything uploaded before those features existed, and restarts conversions and mesh jobs a previous run left unfinished.

In dev, Vite proxies `/api` to the backend (see `vite.config.ts`), so both run together.

## Development

```sh
npm install
npm run dev:all   # runs the Vite dev server and the backend together
```

Then open the printed local URL (typically `http://localhost:5173`), upload a volume, then one or more segmentations.

To run either side alone: `npm run dev` (frontend only) or `npm run dev:server` (backend only, on port 8787). `npm run dev:server:watch` restarts the backend on file changes, but its file watcher can itself become a source of memory pressure with a large `server/data/`; prefer plain `dev:server` unless you're editing backend code.

The 2D panes and the mesh tab need WebGL2.

### Segmentation NRRD requirements

Segmentation files must carry 3D Slicer's per-segment key/value metadata (`Segment0_Name:=`, `Segment0_Color:=`, `Segment0_LabelValue:=`, `Segment0_Layer:=`, ...), which is what Slicer writes when exporting a segmentation as NRRD. Files without it are rejected with an explanation. Only the `left-posterior-superior` space is supported.

## Build

```sh
npm run build                        # frontend production build (dist/)
npm run typecheck --prefix server    # backend typecheck
npm run lint
```

The backend runs as a plain Node process (`npm start --prefix server`); there's no bundling step for it.
