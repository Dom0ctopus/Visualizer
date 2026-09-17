import path from 'node:path'
import { readRawNrrdVolume } from './nrrdRawReader.js'
import { applyAxisFlips, buildPyramid, downsample2xNearest, reversedAxes, writeMultiscaleGroup, type Level, type TypedArray } from './zarrWriter.js'

/**
 * Converts an uploaded 3D Slicer-style multi-layer segmentation NRRD into
 * one OME-Zarr (NGFF 0.4 / Zarr v2) multiscale label-map group per layer, so
 * the itk-vtk-viewer engine can render segmentation overlays without ever
 * loading the whole label map into one WebGL texture (same motivation as
 * zarrConvert.ts's intensity-volume conversion).
 *
 * Read via nrrdRawReader.ts's direct NRRD parser (no itk-wasm/WASM pipeline
 * involved) -- a multi-layer segmentation's extra "list"-kind axis is a 3D-
 * Slicer-specific convention this app already has to parse by hand for
 * segment metadata (segmentTree.ts), so parsing the array layout by hand
 * alongside it is more predictable than trusting a generic ND image reader
 * with a non-spatial axis it wasn't primarily built to special-case.
 *
 * Each layer's pyramid uses nearest-neighbor downsampling (never averaging
 * -- see downsample2xNearest) since label values are categorical, not
 * continuous intensities.
 *
 * Output layout: outputZarrPath/layer{N}/scale{i}, one complete multiscale
 * group per layer, N from 0 to layerCount-1.
 */
export async function convertSegmentationNrrdToOmeZarr(nrrdPath: string, outputZarrPath: string): Promise<void> {
  const parsed = await readRawNrrdVolume(nrrdPath)
  const { ctor, dtype, size, layerCount, spacing, origin, direction, data } = parsed
  const [sx, sy, sz] = size
  const voxelsPerLayer = sx * sy * sz
  const flip = reversedAxes(direction)

  for (let layer = 0; layer < layerCount; layer++) {
    const layerData = data.subarray(layer * voxelsPerLayer, (layer + 1) * voxelsPerLayer) as TypedArray
    const rawLayer: Level = { data: layerData, size }
    const { level: base, origin: layerOrigin } = applyAxisFlips(rawLayer, origin, spacing, flip, ctor)
    const levels = buildPyramid(base, ctor, downsample2xNearest)
    await writeMultiscaleGroup(path.join(outputZarrPath, `layer${layer}`), levels, dtype, ctor, spacing, layerOrigin, 'nearest')
  }
}
