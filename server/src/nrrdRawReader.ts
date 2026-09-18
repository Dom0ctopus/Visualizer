import path from 'node:path'
import { readNrrdHeaderAndData, type ParsedNrrdHeader } from './nrrdHeader.js'
import { reversedAxes, zarrDtypeFor, type TypedArray, type TypedArrayConstructor } from './zarrWriter.js'

// Maps NRRD's "type" field spellings to the same canonical component-type
// strings zarrDtypeFor already understands (itk-wasm's own componentType
// vocabulary) -- kept in sync with niivue's own NRRD type switch
// (node_modules/@niivue/niivue/src/nvimage/ImageReaders/nrrd.ts) so a file
// that displays correctly in the niivue engine is read identically here.
export function nrrdComponentType(type: string): string {
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

export interface ParsedNrrdVolume {
  ctor: TypedArrayConstructor
  dtype: string
  size: [number, number, number]
  /** 1 for a plain 3D volume; >1 for a 3D Slicer multi-layer segmentation,
   *  where it's the 4th "sizes" entry. */
  layerCount: number
  spacing: number[]
  origin: number[]
  direction: [number, number, number, number, number, number, number, number, number]
  /** For layerCount > 1, layer L's voxels are data[L * sx*sy*sz .. (L+1) *
   *  sx*sy*sz) -- the layer/"list" axis is the last (slowest) one in
   *  "sizes", not the first, unlike the unrelated vector-NRRD convention
   *  where a component axis is listed first. Matches what niivue's own
   *  frame4D slicing already assumes for this same file in the niivue
   *  engine. */
  data: TypedArray
}

function parseNrrdGeometry(header: ParsedNrrdHeader, byteLength: number): Omit<ParsedNrrdVolume, 'data'> {
  const sizesText = header.fields['sizes']
  const typeText = header.fields['type']
  const directionsText = header.fields['space directions']
  if (!sizesText || !typeText) throw new Error('NRRD header is missing required "sizes" or "type" field')

  // ITK (and therefore itk-wasm's reader, used previously) treats an NRRD's
  // direction vectors as already being in its own native LPS physical space
  // -- true without any correction exactly when the file declares "space:
  // left-posterior-superior" (or omits "space" entirely, the same default).
  // A file declaring a different frame (RAS/LAS) needs its own axis-sign
  // correction applied on top of ours to mean the same thing, which this
  // reader doesn't do -- rather than silently rendering such a file
  // mirrored/flipped, fail clearly so it's obvious this is unsupported
  // rather than a mysterious orientation bug.
  const space = header.fields['space']?.toLowerCase()
  if (space && !space.includes('left-posterior-superior') && space !== 'lps') {
    throw new Error(`Unsupported NRRD "space" frame: "${header.fields['space']}" (only left-posterior-superior is supported)`)
  }

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
    throw new Error(`NRRD data size mismatch: expected at least ${expectedBytes} bytes, found ${byteLength}`)
  }

  return { ctor, dtype, size, layerCount, spacing, origin: origin.length === 3 ? origin : [0, 0, 0], direction }
}

/**
 * Reads a whole attached-data NRRD (volume or multi-layer segmentation)
 * directly, with no itk-wasm/WASM pipeline involved. Used for both
 * zarrConvert.ts (plain volumes) and segmentationZarrConvert.ts
 * (multi-layer label maps) -- see nrrdHeader.ts's readNrrdHeaderAndData for
 * why: itk-wasm's Node pipeline runner can fail opaquely (a bare numeric
 * exception code, no message, "Build module in Debug mode for exception
 * message information") on large inputs, which a genuinely native-
 * resolution scan can trigger. Plain Node Buffer/TypedArray handling here
 * has no WASM linear-memory ceiling to hit.
 */
export async function readRawNrrdVolume(nrrdPath: string): Promise<ParsedNrrdVolume> {
  const { header, data: rawBytes } = await readNrrdHeaderAndData(nrrdPath)
  const parsed = parseNrrdGeometry(header, rawBytes.byteLength)
  const nVoxelsTotal = parsed.size[0] * parsed.size[1] * parsed.size[2] * parsed.layerCount
  const data = new parsed.ctor(rawBytes.buffer, rawBytes.byteOffset, nVoxelsTotal) as TypedArray

  // Diagnostic: print each converted file's own parsed geometry so a
  // volume/segmentation pair claimed to be "the same scan" can be directly
  // compared in the server console -- a size or space-directions-sign
  // (reversedAxes) mismatch here would explain a segmentation overlay that
  // doesn't align, without needing the user to paste raw NRRD header text.
  console.log(
    `[nrrd-geometry] ${path.basename(nrrdPath)}: size=${JSON.stringify(parsed.size)} layerCount=${parsed.layerCount} ` +
      `spacing=${JSON.stringify(parsed.spacing)} origin=${JSON.stringify(parsed.origin)} ` +
      `direction=${JSON.stringify(parsed.direction)} reversedAxes=${JSON.stringify(reversedAxes(parsed.direction))}`
  )

  return { ...parsed, data }
}
