// Parser for CTvox transfer function (.tf) files, reverse-engineered from real
// exports (Bruker doesn't publish the format). Confirmed structure, validated
// against 8 real files including one with both curves customized:
//
//   bytes 0-1    magic "tf"
//   byte 2       version (1)
//   byte 3       reserved
//   bytes 4-13   fixed header fields (unidentified, constant across samples)
//   byte 14      opacity curve's total point count (>= 2)
//   bytes 15-22  reserved (zero)
//   ...          opacity curve: (count - 1) float32 (position, value) pairs.
//                The first point is always implicit at position 0.0 and is
//                never stored.
//   1 byte       flag, always 1
//   1 byte       luminosity curve's total point count (>= 2)
//   8 bytes      zero padding
//   ...          luminosity curve: (count - 1) float32 (position, value) pairs,
//                same implicit-first-point convention as opacity.
//
// CTvox's editor (see its "Channel" dropdown: Opacity / Luminosity / R / G / B)
// stores one curve per channel that's been touched; R/G/B aren't understood yet
// (no real sample customizes them), so any leftover bytes after the two curves
// above means the file uses those and is rejected rather than guessed at.
//
// Rendering semantics: opacity is the alpha curve directly. Luminosity acts as
// a gain multiplier on the natural grayscale ramp (both curves default to a
// flat 1.0, which is why an all-default file renders as plain opaque grayscale).

export interface CurvePoint {
  position: number
  value: number
}

export interface ParsedTransferFunction {
  opacity: CurvePoint[]
  luminosity: CurvePoint[]
}

const MAGIC = 0x66_74 // "tf" as little-endian uint16 (bytes "t"=0x74, "f"=0x66)
const PADDING_BYTES = 8

function readCurve(view: DataView, bytes: Uint8Array, totalPoints: number, startByte: number): { points: CurvePoint[]; nextOffset: number } {
  if (totalPoints < 2) {
    throw new Error('Unrecognized transfer function structure (curve has fewer than 2 points).')
  }
  const points: CurvePoint[] = [{ position: 0, value: 1 }]
  let offset = startByte
  for (let i = 0; i < totalPoints - 1; i++) {
    if (offset + 8 > bytes.length) {
      throw new Error('Unrecognized transfer function structure (truncated curve data).')
    }
    const position = view.getFloat32(offset, true)
    const value = view.getFloat32(offset + 4, true)
    points.push({ position, value })
    offset += 8
  }
  return { points, nextOffset: offset }
}

export function parseCtvoxTransferFunction(buffer: ArrayBuffer): ParsedTransferFunction {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  if (bytes.length < 24 || view.getUint16(0, true) !== MAGIC) {
    throw new Error('Not a recognized CTvox transfer function file (missing "tf" signature).')
  }

  const opacityCount = bytes[14]
  const { points: opacity, nextOffset: afterOpacity } = readCurve(view, bytes, opacityCount, 23)

  const flagPos = afterOpacity
  if (bytes.length <= flagPos + 1 || bytes[flagPos] !== 1) {
    throw new Error('Unrecognized transfer function structure (missing expected marker byte).')
  }
  const luminosityCount = bytes[flagPos + 1]
  const luminosityStart = flagPos + 2 + PADDING_BYTES
  const { points: luminosity, nextOffset: afterLuminosity } = readCurve(view, bytes, luminosityCount, luminosityStart)

  if (afterLuminosity !== bytes.length) {
    throw new Error(
      'This transfer function uses additional color channels (R/G/B) that aren\'t supported yet — only opacity and luminosity curves can be imported currently.'
    )
  }

  return { opacity, luminosity }
}

function interpolate(points: CurvePoint[], t: number): number {
  if (t <= points[0].position) return points[0].value
  const last = points[points.length - 1]
  if (t >= last.position) return last.value
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (t >= a.position && t <= b.position) {
      const span = b.position - a.position
      const frac = span === 0 ? 0 : (t - a.position) / span
      return a.value + (b.value - a.value) * frac
    }
  }
  return last.value
}

export interface TransferFunctionLut {
  lut: Uint8ClampedArray
  min: number
  max: number
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Builds a direct-index label-style LUT (one entry per raw intensity value from
 * dataMin to dataMax) rather than a named/registered continuous colormap.
 *
 * niivue's 3D volume-render bake pass has a real limitation with custom, varying
 * (non-flat) colormaps registered via `colormap`/`cmapper.addColormap`: the 2D
 * slice panes render them correctly, but the 3D render always comes out fully
 * black, reproduced even with a trivial 2-point gradient LUT and confirmed
 * independent of curve shape or point count. `colormapLabel` uses a different,
 * unaffected code path (the same one segmentation overlays already rely on for
 * correct multi-color 3D rendering), at the cost of nearest-index rather than
 * interpolated lookup -- immaterial here since the LUT already has one entry
 * per representable intensity.
 */
export function buildTransferFunctionColormap(tf: ParsedTransferFunction, dataMin: number, dataMax: number): TransferFunctionLut {
  const min = Math.floor(dataMin)
  const max = Math.max(min + 1, Math.ceil(dataMax))
  const entries = max - min + 1
  const lut = new Uint8ClampedArray(entries * 4)

  for (let i = 0; i < entries; i++) {
    const t = i / (entries - 1)
    const gain = interpolate(tf.luminosity, t)
    const opacity = interpolate(tf.opacity, t)
    const gray = Math.round(clamp01(t * gain) * 255)
    const k = i * 4
    lut[k] = gray
    lut[k + 1] = gray
    lut[k + 2] = gray
    lut[k + 3] = Math.round(clamp01(opacity) * 255)
  }

  return { lut, min, max }
}
