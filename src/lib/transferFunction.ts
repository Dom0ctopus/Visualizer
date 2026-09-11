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

// CTvox's own curve editor draws these as smooth curves through each control point
// (confirmed against a real screenshot: a curve with several points rendered as a
// series of arcs/parabolas, not straight segments), so reconstructing them with
// linear interpolation gets the shape wrong for any curve with 3+ points -- flat or
// 2-point curves are unaffected since a straight line and a spline coincide there.
// Catmull-Rom passes exactly through every control point (unlike a fitted Bezier),
// using the segment's own neighbors to estimate tangents, which matches an editor
// where you place points and the curve bends smoothly between them.
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

function interpolate(points: CurvePoint[], t: number): number {
  if (t <= points[0].position) return points[0].value
  const last = points[points.length - 1]
  if (t >= last.position) return last.value
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]
    const p2 = points[i + 1]
    if (t >= p1.position && t <= p2.position) {
      const span = p2.position - p1.position
      const frac = span === 0 ? 0 : (t - p1.position) / span
      const p0 = points[i - 1] ?? p1
      const p3 = points[i + 2] ?? p2
      return catmullRom(p0.value, p1.value, p2.value, p3.value, frac)
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

// niivue's 3D volume-render bake pass has a real limitation with custom, varying
// (non-flat) colormaps registered via `colormap`/`cmapper.addColormap`: the 2D
// slice panes render them correctly, but the 3D render always comes out fully
// black, reproduced even with a trivial 2-point gradient LUT and confirmed
// independent of curve shape or point count. `colormapLabel` uses a different,
// unaffected code path (the same one segmentation overlays already rely on for
// correct multi-color 3D rendering); for a non-label volume it's sampled with
// linear interpolation across a normalized [min, max] window (via cal_min/cal_max),
// the same as any other continuous colormap, so a fixed-resolution table is fine.
const TABLE_RESOLUTION = 256

/**
 * Builds a linearly-sampled LUT covering [dataMin, dataMax] (typically the volume's
 * current window, cal_min/cal_max, matching what CTvox's curve editor treats as the
 * 0..1 domain). Voxels outside that window are forced fully transparent -- niivue
 * clamps out-of-range samples to the table's edge texel rather than extrapolating,
 * so without this a "flat" curve (opacity 1 at every point, CTvox's actual on-disk
 * default) would make the *entire* volume -- background included -- fully opaque,
 * rendering as a solid box instead of the intended windowed structure.
 */
// Forcing only the single bottom texel transparent assumes real dead-space voxels
// sit exactly at (or below) the window floor. In practice sensor/reconstruction
// noise spreads dead space over a small range, and since it's usually the majority
// of the volume's voxels, even a small fraction poking just above a single-texel
// cutoff -- landing on the curve's real (often near-1) opacity there -- accumulates
// along ray-marched rays into a visible haze/box. Widening the forced-transparent
// region to the bottom slice of the table (a soft floor, not a single sample) is the
// standard fix for this in volume renderers.
const DEAD_ZONE_FRACTION = 0.03

export function buildTransferFunctionColormap(tf: ParsedTransferFunction, dataMin: number, dataMax: number): TransferFunctionLut {
  const min = dataMin
  const max = Math.max(min + 1e-6, dataMax)
  const entries = TABLE_RESOLUTION
  const lut = new Uint8ClampedArray(entries * 4)

  for (let i = 0; i < entries; i++) {
    const t = i / (entries - 1)
    const gain = interpolate(tf.luminosity, t)
    const opacity = t < DEAD_ZONE_FRACTION ? 0 : interpolate(tf.opacity, t)
    const gray = Math.round(clamp01(t * gain) * 255)
    const k = i * 4
    lut[k] = gray
    lut[k + 1] = gray
    lut[k + 2] = gray
    lut[k + 3] = Math.round(clamp01(opacity) * 255)
  }

  return { lut, min, max }
}
