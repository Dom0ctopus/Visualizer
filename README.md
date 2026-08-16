# Visualizer

A browser-based four-panel viewer for micro-CT volumes and their NRRD segmentations, built with [NiiVue](https://github.com/niivue/niivue).

- **Four-panel layout**: axial, coronal, sagittal, and 3D render, kept in sync with a shared crosshair.
- **Load a volume**: any NRRD (or NIfTI) file as the base grayscale volume, with adjustable window/level.
- **Load segmentations**: add one or more NRRD label volumes as color-coded, opacity-adjustable overlays. Each label value within a segmentation gets its own distinct color; multiple segmentation files get distinct color ranges from each other.

## Development

```sh
npm install
npm run dev
```

Then open the printed local URL. Use the sidebar to load a volume NRRD file, then add segmentation NRRD files as overlays.

## Build

```sh
npm run build
```
