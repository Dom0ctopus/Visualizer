# Visualizer

A client/server four-panel viewer for micro-CT volumes and their NRRD segmentations, built with [NiiVue](https://github.com/niivue/niivue).

- **Four-panel layout**: axial, coronal, sagittal, and 3D render, kept in sync with a shared crosshair.
- **Backend-managed library**: uploaded volumes and segmentations are stored server-side (`server/data/`) and can be reloaded later without re-uploading.
- **Segment tree**: segmentations exported from 3D Slicer carry per-label metadata (name, color, layer) in the NRRD header. The backend parses this and groups segments into "systems" by splitting each segment's name on its first delimiter (e.g. `Skeletal_Femur` → system "Skeletal", segment "Femur"). The sidebar shows a checkbox tree: file → system → segment.
- **Per-segment opacity**: hovering any row (file, system, or segment) pops up an opacity slider; adjusting it at the system or file level applies to all of its segments.
- **Search**: filter the tree by segment or system name, then bulk show/hide everything currently matching.
- **Multi-layer segmentations**: Slicer segmentations with overlapping structures (stored as 4D NRRDs, one "layer" per non-overlapping group) are loaded as separate overlay volumes per layer, so overlapping segments render and toggle independently.

## Architecture

- `src/` — Vite + React + TypeScript frontend. Renders volumes with NiiVue; talks to the backend over `/api/*`.
- `server/` — Express + TypeScript backend. Accepts NRRD uploads, parses Slicer segment metadata, stores files on disk, and serves them back by ID.

In dev, Vite proxies `/api` to the backend (see `vite.config.ts`), so both can be run together.

## Development

```sh
npm install
npm run dev:all   # runs the Vite dev server and the backend together
```

Then open the printed local URL (typically `http://localhost:5173`). Upload a volume NRRD file from the sidebar, then upload one or more Slicer-exported segmentation NRRD files.

To run either side alone: `npm run dev` (frontend only) or `npm run dev:server` (backend only, on port 8787).

### Segmentation NRRD requirements

The backend expects segmentation files to carry 3D Slicer's per-segment key/value metadata (`Segment0_Name:=`, `Segment0_Color:=`, `Segment0_LabelValue:=`, `Segment0_Layer:=`, ...) — this is the standard format Slicer writes when exporting a segmentation as NRRD. Files without this metadata are rejected with an explanation.

## Build

```sh
npm run build           # frontend production build (dist/)
npm run typecheck --prefix server   # backend typecheck
```

The backend runs as a plain Node process (`npm start --prefix server`); there's no bundling step for it.
