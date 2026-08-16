// Qualitative palette for segmentation label overlays. Chosen for mutual contrast
// against both the grayscale CT background and each other.
export const SEGMENTATION_PALETTE: Array<[number, number, number]> = [
  [239, 68, 68], // red
  [34, 197, 94], // green
  [59, 130, 246], // blue
  [234, 179, 8], // yellow
  [217, 70, 239], // magenta
  [20, 184, 166], // teal
  [249, 115, 22], // orange
  [168, 85, 247], // purple
  [236, 72, 153], // pink
  [132, 204, 22], // lime
  [14, 165, 233], // sky
  [244, 63, 94] // rose
]

export function paletteColorCss(index: number): string {
  const [r, g, b] = SEGMENTATION_PALETTE[index % SEGMENTATION_PALETTE.length]
  return `rgb(${r}, ${g}, ${b})`
}

export interface SegmentationLut {
  lut: Uint8ClampedArray
  min: number
  max: number
}

/**
 * Builds a discrete label lookup table for a segmentation volume: label 0 (background)
 * is fully transparent, and each subsequent integer label gets a distinct opaque color.
 * `colorOffset` shifts the starting palette index so multiple loaded segmentation files
 * don't all start on the same color.
 */
export function buildSegmentationLut(maxLabel: number, colorOffset: number): SegmentationLut {
  const labelCount = Math.max(1, Math.round(maxLabel))
  const entries = labelCount + 1
  const lut = new Uint8ClampedArray(entries * 4)
  for (let label = 0; label < entries; label++) {
    const i = label * 4
    if (label === 0) {
      lut[i + 3] = 0
      continue
    }
    const [r, g, b] = SEGMENTATION_PALETTE[(colorOffset + label - 1) % SEGMENTATION_PALETTE.length]
    lut[i] = r
    lut[i + 1] = g
    lut[i + 2] = b
    lut[i + 3] = 255
  }
  return { lut, min: 0, max: entries - 1 }
}
