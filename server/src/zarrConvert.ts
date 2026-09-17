import { nrrdReadImageNode } from '@itk-wasm/image-io'
import { applyAxisFlips, buildPyramid, downsample2xAverage, reversedAxes, writeMultiscaleGroup, zarrDtypeFor, type Level, type TypedArray } from './zarrWriter.js'

/**
 * Converts an uploaded NRRD volume into a chunked, multiscale OME-Zarr (NGFF
 * 0.4 / Zarr v2) store on disk -- so the itk-vtk-viewer engine can pick
 * whichever resolution level fits in memory instead of requiring the whole
 * volume to fit in one WebGL 3D texture up front, the way niivue does.
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
  const { image } = await nrrdReadImageNode(nrrdPath)
  if (!image.data) throw new Error('NRRD file has no voxel data')
  const { dtype, ctor } = zarrDtypeFor(image.imageType.componentType)
  const [sx, sy, sz] = image.size
  const rawBase: Level = { data: image.data as TypedArray, size: [sx, sy, sz] }

  const spacing = image.spacing.length === 3 ? image.spacing : [1, 1, 1]
  const rawOrigin = image.origin.length === 3 ? image.origin : [0, 0, 0]
  // image.direction is always floating-point in practice (a 3x3 direction-
  // cosine matrix); itk-wasm's TypedArray union is broader only to cover
  // other fields like index arrays.
  const direction = image.direction as unknown as Float64Array
  const { level: base, origin } = applyAxisFlips(rawBase, rawOrigin, spacing, reversedAxes(direction), ctor)

  const levels = buildPyramid(base, ctor, downsample2xAverage)
  await writeMultiscaleGroup(outputZarrPath, levels, dtype, ctor, spacing, origin, 'average')
}
