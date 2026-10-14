import { fetchLayerStats, type AxisHistogram } from './api'
import type { SegmentState } from '../types'

/**
 * Search focus: a set of segments the views single out -- the rest fade
 * (by a shared strength) in the 2D panes, the surface meshes and the voxel
 * render, and the 2D panes jump to the set and outline it.
 */

/** Identifies a segment across loaded segmentations. */
export function focusKey(recordId: string, segmentKey: string): string {
  return `${recordId}|${segmentKey}`
}

/** A focus as the views apply it: segments in `keys` show fully, the rest
 *  at `fade` (an opacity multiplier) -- except those in `partial`, part way
 *  in (1) or out (0) while a timed focus change fades them. */
export interface FocusSpec {
  keys: ReadonlySet<string>
  fade: number
  partial?: ReadonlyMap<string, number> | null
}

/** The opacity multiplier a focus gives one segment (by focusKey). */
export function focusMultiplier(spec: FocusSpec, key: string): number {
  const t = spec.partial?.get(key)
  if (t !== undefined) return spec.fade + (1 - spec.fade) * t
  return spec.keys.has(key) ? 1 : spec.fade
}

export interface FocusMatch {
  recordId: string
  key: string
}

/** The segments a search selects, by the segment tree's own rule: a
 *  matching file name selects the whole file, a matching system its
 *  segments, otherwise segments whose name matches. */
export function matchSegments(segmentations: Array<{ recordId: string; name: string; segments: SegmentState[] }>, text: string): FocusMatch[] {
  const filter = text.trim().toLowerCase()
  if (!filter) return []
  const matches: FocusMatch[] = []
  for (const loaded of segmentations) {
    const fileMatches = loaded.name.toLowerCase().includes(filter)
    for (const seg of loaded.segments) {
      if (fileMatches || seg.system.toLowerCase().includes(filter) || seg.name.toLowerCase().includes(filter)) {
        matches.push({ recordId: loaded.recordId, key: seg.key })
      }
    }
  }
  return matches
}

/** Physical position (mm, [z, y, x]) to show one segment at: its
 *  centroid, moved on each axis to the nearest slice that actually contains
 *  some of it (a curved or hollow segment's centroid can lie outside it).
 *  Only that segment's layer statistics are fetched. Null when it has no
 *  voxels. */
export async function segmentTarget(segment: { recordId: string; layer: number; labelValue: number }): Promise<[number, number, number] | null> {
  const layer = await fetchLayerStats(segment.recordId, segment.layer)
  const label = layer.labels[String(segment.labelValue)]
  if (!label || label.voxels === 0) return null
  const histograms: AxisHistogram[] = [label.histograms.z, label.histograms.y, label.histograms.x]
  return [0, 1, 2].map((axis) => {
    const center = label.centroid[axis]
    const h = histograms[axis]
    let best = center
    let bestDistance = Infinity
    for (let i = 0; i < h.counts.length; i++) {
      if (h.counts[i] === 0) continue
      const position = layer.origin[axis] + (h.start + i) * layer.spacing[axis]
      const distance = Math.abs(position - center)
      if (distance < bestDistance) {
        bestDistance = distance
        best = position
      }
    }
    return best
  }) as [number, number, number]
}
