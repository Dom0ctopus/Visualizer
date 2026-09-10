// Parser for 3D Slicer/CTvox-style transfer function (.tf) files, reverse-engineered
// from real exports (Bruker doesn't publish the format). Confirmed structure:
//
//   bytes 0-1    magic "tf"
//   byte 2       version (1)
//   byte 3       reserved
//   bytes 4-22   fixed header fields (unidentified, constant across samples)
//   ...          "mode" byte at offset 14: 2 = opacity-only, 3 = +luminosity, 4 = +color
//   block A      (mode - 1) constant baseline (position, value) float32 pairs —
//                fixed defaults for CTvox's other channels; only mode 2's pairs are
//                confirmed unused/irrelevant for opacity-only import
//   1 byte       flag, always 1
//   1 byte       point count N (total curve points, including an implicit first
//                point at position 0.0 that is never stored)
//   8 bytes      zero padding
//   block B      (N - 1) float32 (position, opacity) pairs, one per stored point,
//                position ascending, values normalized 0..1
//
// Only mode 2 (plain opacity curve, no custom color/luminosity) is understood well
// enough to import with confidence — modes 3/4 add channels whose exact byte
// assignment isn't pinned down yet.

export interface OpacityPoint {
  position: number
  opacity: number
}

export interface ParsedTransferFunction {
  mode: number
  points: OpacityPoint[]
}

const MAGIC = 0x66_74 // "tf" as little-endian uint16 read from bytes[0..1] ("t"=0x74,"f"=0x66)

export function parseCtvoxTransferFunction(buffer: ArrayBuffer): ParsedTransferFunction {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  if (bytes.length < 24 || view.getUint16(0, true) !== MAGIC) {
    throw new Error('Not a recognized CTvox transfer function file (missing "tf" signature).')
  }

  const mode = bytes[14]
  if (mode !== 2) {
    throw new Error(
      `This transfer function uses a color/luminosity mode (mode ${mode}) that isn't supported yet — only plain ` +
        `opacity-curve transfer functions can be imported currently.`
    )
  }

  const blockAFloats = 2
  const flagPos = 23 + blockAFloats * 4
  const countPos = flagPos + 1
  const padding = 8
  const blockBStart = countPos + 1 + padding

  if (bytes.length <= flagPos || bytes[flagPos] !== 1) {
    throw new Error('Unrecognized transfer function structure (missing expected marker byte).')
  }

  const count = bytes[countPos]
  const pairCount = count - 1
  const expectedLength = blockBStart + pairCount * 8
  if (count < 1 || expectedLength !== bytes.length) {
    throw new Error('Unrecognized transfer function structure (unexpected file length).')
  }

  const points: OpacityPoint[] = [{ position: 0, opacity: 1 }]
  let offset = blockBStart
  for (let i = 0; i < pairCount; i++) {
    const position = view.getFloat32(offset, true)
    const opacity = view.getFloat32(offset + 4, true)
    points.push({ position, opacity })
    offset += 8
  }

  return { mode, points }
}

export interface GrayscaleColormap {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
}

/**
 * Builds a niivue-compatible colormap from opacity control points: an identity
 * grayscale ramp (color == intensity) with alpha driven by the transfer function's
 * own knots, letting niivue's colormap interpolation reproduce the curve exactly.
 */
export function buildGrayscaleColormapFromPoints(points: OpacityPoint[]): GrayscaleColormap {
  const sorted = [...points].sort((a, b) => a.position - b.position)
  const I = sorted.map((p) => Math.round(Math.max(0, Math.min(1, p.position)) * 255))
  const A = sorted.map((p) => Math.round(Math.max(0, Math.min(1, p.opacity)) * 255))

  if (I[0] !== 0) {
    I.unshift(0)
    A.unshift(A[0])
  }
  if (I[I.length - 1] !== 255) {
    I.push(255)
    A.push(A[A.length - 1])
  }

  const gray = I.slice()
  return { R: gray, G: gray, B: gray, A, I }
}
