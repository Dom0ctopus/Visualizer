import { readRawNrrdVolume } from './nrrdRawReader.js'
import { applyAxisFlips, buildPyramid, downsample2xAverage, reversedAxes, writeMultiscaleGroup, type Level } from './zarrWriter.js'

/**
 * Converts an uploaded NRRD volume into a chunked, multiscale OME-Zarr (NGFF
 * 0.4 / Zarr v2) store on disk -- so the itk-vtk-viewer engine can pick
 * whichever resolution level fits in memory instead of requiring the whole
 * volume to fit in one WebGL 3D texture up front, the way niivue does.
 *
 * Read via nrrdRawReader.ts's direct NRRD parser rather than itk-wasm's
 * generic reader (used here originally): itk-wasm's Node.js pipeline runner
 * executes the actual reader as a separate WASM module invocation, which
 * can fail opaquely on a genuinely native-resolution scan -- confirmed
 * directly, the only error surfaced was a bare numeric exception code with
 * itk-wasm's own generic "Build module in Debug mode for exception message
 * information" fallback, no usable message, no stack trace. A plain Node
 * Buffer/TypedArray read has no WASM linear-memory ceiling to hit. This
 * also matches how segmentationZarrConvert.ts already has to read its own
 * NRRDs by hand (for their multi-layer "list" axis, which itk-wasm's reader
 * isn't exercised against here) -- both now share the same reader.
 *
 * Written by hand rather than through @fideus-labs/ngff-zarr: that library
 * (and the zarrita version it's built on) only ever writes Zarr v3 storage --
 * the "version" option controls just the OME metadata dialect, not the
 * underlying array format -- while itk-vtk-viewer's bundled reader (and, as
 * of this writing, @itk-viewer/io's too) only understands Zarr v2's
 * .zattrs/.zgroup/.zarray layout. Until the viewer side catches up to Zarr
 * v3, writing NGFF 0.4 directly is the only combination that round-trips.
 */
export async function convertNrrdToOmeZarr(nrrdPath: string, outputZarrPath: string): Promise<void> {
  const { ctor, dtype, size, layerCount, spacing, origin: rawOrigin, direction, data } = await readRawNrrdVolume(nrrdPath)
  if (layerCount !== 1) {
    throw new Error(
      `This NRRD has ${layerCount} layers (a 3D Slicer multi-layer segmentation) -- upload it as a segmentation, not a volume.`
    )
  }
  const rawBase: Level = { data, size }
  const { level: base, origin } = applyAxisFlips(rawBase, rawOrigin, spacing, reversedAxes(direction), ctor)

  const levels = buildPyramid(base, ctor, downsample2xAverage)
  await writeMultiscaleGroup(outputZarrPath, levels, dtype, ctor, spacing, origin, 'average')
}
