import { fetchSegmentStats, type AxisHistogram, type LayerStats } from './api'
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

/** Physical position (mm, [z, y, x]) to show a focused set at: the
 *  voxel-weighted center of the set, moved on each axis to the nearest
 *  slice that actually contains some of it (the center of, say, a left and
 *  a right kidney lies between them). Null when none of it has voxels. */
export async function focusTarget(
  focused: Array<{ recordId: string; layer: number; labelValue: number }>
): Promise<[number, number, number] | null> {
  const stats = await Promise.all([...new Set(focused.map((f) => f.recordId))].map(async (id) => [id, await fetchSegmentStats(id)] as const))
  const byRecord = new Map(stats)
  const entries: Array<{ layer: LayerStats; voxels: number; centroid: [number, number, number]; histograms: AxisHistogram[] }> = []
  for (const f of focused) {
    const layer = byRecord.get(f.recordId)?.layers[String(f.layer)]
    const label = layer?.labels[String(f.labelValue)]
    if (!layer || !label || label.voxels === 0) continue
    // Voxels weigh by physical volume, so layers at different resolutions compare.
    const voxelVolume = layer.spacing[0] * layer.spacing[1] * layer.spacing[2]
    entries.push({
      layer,
      voxels: label.voxels * voxelVolume,
      centroid: label.centroid,
      histograms: [label.histograms.z, label.histograms.y, label.histograms.x]
    })
  }
  const total = entries.reduce((sum, e) => sum + e.voxels, 0)
  if (total === 0) return null
  const center = [0, 1, 2].map((axis) => entries.reduce((sum, e) => sum + e.centroid[axis] * e.voxels, 0) / total)
  return [0, 1, 2].map((axis) => {
    let best = center[axis]
    let bestDistance = Infinity
    for (const e of entries) {
      const h = e.histograms[axis]
      for (let i = 0; i < h.counts.length; i++) {
        if (h.counts[i] === 0) continue
        const position = e.layer.origin[axis] + (h.start + i) * e.layer.spacing[axis]
        const distance = Math.abs(position - center[axis])
        if (distance < bestDistance) {
          bestDistance = distance
          best = position
        }
      }
    }
    return best
  }) as [number, number, number]
}
