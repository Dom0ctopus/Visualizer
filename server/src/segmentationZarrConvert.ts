import path from 'node:path'
import { readNrrdHeaderAndData, type ParsedNrrdHeader } from './nrrdHeader.js'
import {
  applyAxisFlips,
  buildPyramid,
  downsample2xNearest,
  reversedAxes,
  writeMultiscaleGroup,
  zarrDtypeFor,
  type Level,
  type TypedArray,
  type TypedArrayConstructor
} from './zarrWriter.js'

// Maps NRRD's "type" field spellings to the same canonical component-type
// strings zarrDtypeFor already understands (itk-wasm's own componentType
// vocabulary) -- kept in sync with niivue's own NRRD type switch
// (node_modules/@niivue/niivue/src/nvimage/ImageReaders/nrrd.ts) so a file
// that displays correctly in the niivue engine is read identically here.
function nrrdComponentType(type: string): string {
  switch (type.toLowerCase()) {
    case 'uchar':
    case 'unsigned char':
    case 'uint8':
    case 'uint8_t':
      return 'uint8'
    case 'signed char':
    case 'int8':
    case 'int8_t':
      return 'int8'
    case 'short':
    case 'short int':
    case 'signed short':
    case 'signed short int':
    case 'int16':
    case 'int16_t':
      return 'int16'
    case 'ushort':
    case 'unsigned short':
    case 'unsigned short int':
    case 'uint16':
    case 'uint16_t':
      return 'uint16'
    case 'int':
    case 'signed int':
    case 'int32':
    case 'int32_t':
      return 'int32'
    case 'uint':
    case 'unsigned int':
    case 'uint32':
    case 'uint32_t':
      return 'uint32'
    case 'float':
      return 'float32'
    case 'double':
      return 'float64'
    default:
      throw new Error(`Unsupported NRRD data type: ${type}`)
  }
}

// "(1,0,0) (0,1,0) (0,0,1) none" -> [[1,0,0],[0,1,0],[0,0,1],null]. The
// non-spatial "list"/layer axis (present on a multi-layer segmentation) has
// no direction of its own, written as the literal token "none".
function parseSpaceDirections(text: string): Array<number[] | null> {
  const tokens = text.match(/\(([^)]*)\)|none/gi) ?? []
  return tokens.map((tok) => (tok.toLowerCase() === 'none' ? null : tok.slice(1, -1).split(',').map(Number)))
}

function vectorNorm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
}

interface ParsedSegmentationNrrd {
  ctor: TypedArrayConstructor
  dtype: string
  size: [number, number, number]
  layerCount: number
  spacing: number[]
  origin: number[]
  direction: [number, number, number, number, number, number, number, number, number]
  /** Flat buffer covering every layer back-to-back: layer L's voxels are
   *  data[L * sx*sy*sz .. (L+1) * sx*sy*sz). Matches 3D Slicer's own layout
   *  (and what niivue's frame4D slicing already assumes for this same file
   *  in the niivue engine) -- the layer/"list" axis is the last (slowest)
   *  one in "sizes", not the first, unlike the unrelated vector-NRRD
   *  convention where a component axis is listed first. */
  data: TypedArray
}

function parseSegmentationHeader(header: ParsedNrrdHeader, byteLength: number): Omit<ParsedSegmentationNrrd, 'data'> {
  const sizesText = header.fields['sizes']
  const typeText = header.fields['type']
  const directionsText = header.fields['space directions']
  if (!sizesText || !typeText) throw new Error('NRRD header is missing required "sizes" or "type" field')

  const sizes = sizesText.trim().split(/\s+/).map(Number)
  if (sizes.length < 3 || sizes.slice(0, 3).some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error(`Invalid NRRD "sizes" field: ${sizesText}`)
  }
  const size: [number, number, number] = [sizes[0], sizes[1], sizes[2]]
  const layerCount = sizes.length >= 4 ? sizes[3] : 1
  if (!Number.isFinite(layerCount) || layerCount <= 0) {
    throw new Error(`Invalid NRRD 4th "sizes" entry (layer count): ${sizesText}`)
  }

  const { dtype, ctor } = zarrDtypeFor(nrrdComponentType(typeText))

  const directionVectors = directionsText ? parseSpaceDirections(directionsText) : []
  const spatialVectors = directionVectors.slice(0, 3).map((v) => v ?? [1, 0, 0])
  while (spatialVectors.length < 3) spatialVectors.push([0, 0, 0])
  const spacing = spatialVectors.map((v) => vectorNorm(v) || 1)
  const direction = [
    spatialVectors[0][0] ?? 1,
    spatialVectors[0][1] ?? 0,
    spatialVectors[0][2] ?? 0,
    spatialVectors[1][0] ?? 0,
    spatialVectors[1][1] ?? 1,
    spatialVectors[1][2] ?? 0,
    spatialVectors[2][0] ?? 0,
    spatialVectors[2][1] ?? 0,
    spatialVectors[2][2] ?? 1
  ] as [number, number, number, number, number, number, number, number, number]

  const originText = header.fields['space origin']
  const originMatch = originText?.match(/\(([^)]*)\)/)
  const origin = originMatch ? originMatch[1].split(',').map(Number) : [0, 0, 0]

  const nVoxelsTotal = size[0] * size[1] * size[2] * layerCount
  const expectedBytes = nVoxelsTotal * ctor.BYTES_PER_ELEMENT
  if (byteLength < expectedBytes) {
    throw new Error(`NRRD segmentation data size mismatch: expected at least ${expectedBytes} bytes, found ${byteLength}`)
  }

  return { ctor, dtype, size, layerCount, spacing, origin: origin.length === 3 ? origin : [0, 0, 0], direction }
}

async function readSegmentationNrrd(nrrdPath: string): Promise<ParsedSegmentationNrrd> {
  const { header, data: rawBytes } = await readNrrdHeaderAndData(nrrdPath)
  const parsed = parseSegmentationHeader(header, rawBytes.byteLength)
  const nVoxelsTotal = parsed.size[0] * parsed.size[1] * parsed.size[2] * parsed.layerCount
  const data = new parsed.ctor(rawBytes.buffer, rawBytes.byteOffset, nVoxelsTotal) as TypedArray
  return { ...parsed, data }
}

/**
 * Converts an uploaded 3D Slicer-style multi-layer segmentation NRRD into
 * one OME-Zarr (NGFF 0.4 / Zarr v2) multiscale label-map group per layer, so
 * the itk-vtk-viewer engine can render segmentation overlays without ever
 * loading the whole label map into one WebGL texture (same motivation as
 * zarrConvert.ts's intensity-volume conversion).
 *
 * Read directly from the raw NRRD bytes (via nrrdHeader.ts) rather than
 * through itk-wasm's generic reader used for intensity volumes: a
 * multi-layer segmentation's extra "list"-kind axis is a 3D-Slicer-specific
 * convention this app already has to parse by hand for segment metadata
 * (segmentTree.ts), so parsing the array layout by hand alongside it is more
 * predictable than trusting a generic ND image reader with a non-spatial
 * axis it wasn't primarily built to special-case.
 *
 * Each layer's pyramid uses nearest-neighbor downsampling (never averaging
 * -- see downsample2xNearest) since label values are categorical, not
 * continuous intensities.
 *
 * Output layout: outputZarrPath/layer{N}/scale{i}, one complete multiscale
 * group per layer, N from 0 to layerCount-1.
 */
export async function convertSegmentationNrrdToOmeZarr(nrrdPath: string, outputZarrPath: string): Promise<void> {
  const parsed = await readSegmentationNrrd(nrrdPath)
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
