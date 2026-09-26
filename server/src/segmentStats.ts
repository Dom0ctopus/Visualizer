import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './store.js'
import { readZarrLevels, readZRange } from './zarrReader.js'

/**
 * Per-segment statistics for search focus (the 2D panes jump to a focused
 * set's center): for every label of every layer, its voxel count, physical
 * centroid and how many voxels each slice along z, y and x holds. Computed
 * once per segmentation from a coarse pyramid level (the finest one within
 * STATS_VOXEL_BUDGET -- plenty for picking a slice) and cached next to its
 * store; a segmentation's labels never change after conversion.
 */

const STATS_VOXEL_BUDGET = 32 * 1024 * 1024
const BAND_SLICES = 16
const STATS_FILE = 'segment-stats.json'
const STATS_VERSION = 1

export interface LabelStats {
  /** Voxels at the stats level. */
  voxels: number
  /** [z, y, x] mm. */
  centroid: [number, number, number]
  /** Voxels per slice along each axis, trimmed to the occupied range:
   *  counts[i] is slice start + i. */
  histograms: { z: AxisHistogram; y: AxisHistogram; x: AxisHistogram }
}

export interface AxisHistogram {
  start: number
  counts: number[]
}

export interface LayerStats {
  /** The stats level's geometry, [z, y, x]; slice i along an axis is at
   *  origin + i * spacing mm. */
  origin: [number, number, number]
  spacing: [number, number, number]
  size: [number, number, number]
  /** By label value. */
  labels: Record<string, LabelStats>
}

export interface SegmentationStats {
  version: number
  /** By layer index. */
  layers: Record<string, LayerStats>
}

function trimmed(counts: Float64Array | number[]): AxisHistogram {
  let start = 0
  let end = counts.length
  while (start < end && counts[start] === 0) start++
  while (end > start && counts[end - 1] === 0) end--
  return { start, counts: Array.from(counts.slice(start, end)) }
}

async function computeLayerStats(layerGroupPath: string): Promise<LayerStats> {
  const levels = await readZarrLevels(layerGroupPath)
  const level = levels.find((lv) => lv.size[0] * lv.size[1] * lv.size[2] <= STATS_VOXEL_BUDGET) ?? levels[levels.length - 1]
  const [sz, sy, sx] = level.size
  const arrayDir = path.join(layerGroupPath, level.levelPath)
  interface Accum {
    voxels: number
    sum: [number, number, number]
    hz: Float64Array
    hy: Float64Array
    hx: Float64Array
  }
  const accums = new Map<number, Accum>()
  const accumFor = (label: number): Accum => {
    let a = accums.get(label)
    if (!a) {
      a = { voxels: 0, sum: [0, 0, 0], hz: new Float64Array(sz), hy: new Float64Array(sy), hx: new Float64Array(sx) }
      accums.set(label, a)
    }
    return a
  }
  for (let z0 = 0; z0 < sz; z0 += BAND_SLICES) {
    const nz = Math.min(BAND_SLICES, sz - z0)
    const band = await readZRange(arrayDir, z0, nz)
    let i = 0
    for (let dz = 0; dz < nz; dz++) {
      const z = z0 + dz
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++, i++) {
          const label = band[i] as number
          if (label <= 0) continue
          const a = accumFor(label)
          a.voxels++
          a.sum[0] += z
          a.sum[1] += y
          a.sum[2] += x
          a.hz[z]++
          a.hy[y]++
          a.hx[x]++
        }
      }
    }
  }
  const labels: Record<string, LabelStats> = {}
  for (const [label, a] of accums) {
    labels[label] = {
      voxels: a.voxels,
      centroid: [0, 1, 2].map((axis) => level.origin[axis] + (a.sum[axis] / a.voxels) * level.spacing[axis]) as [number, number, number],
      histograms: { z: trimmed(a.hz), y: trimmed(a.hy), x: trimmed(a.hx) }
    }
  }
  return { origin: level.origin, spacing: level.spacing, size: level.size, labels }
}

const inFlight = new Map<string, Promise<SegmentationStats>>()

/** The stats for a converted segmentation store (one `layerN` group per
 *  layer), computing and caching them on first request. */
export function getSegmentationStats(segZarrPath: string): Promise<SegmentationStats> {
  let pending = inFlight.get(segZarrPath)
  if (pending) return pending
  pending = (async () => {
    const cachePath = path.join(segZarrPath, STATS_FILE)
    if (existsSync(cachePath)) {
      try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8')) as SegmentationStats
        if (cached.version === STATS_VERSION) return cached
      } catch {
        // recompute below
      }
    }
    const layers: Record<string, LayerStats> = {}
    for (const entry of (await readdir(segZarrPath)).sort()) {
      const match = /^layer(\d+)$/.exec(entry)
      if (match) layers[match[1]] = await computeLayerStats(path.join(segZarrPath, entry))
    }
    const stats: SegmentationStats = { version: STATS_VERSION, layers }
    await writeFileAtomic(cachePath, JSON.stringify(stats))
    return stats
  })()
  inFlight.set(segZarrPath, pending)
  void pending.finally(() => inFlight.delete(segZarrPath))
  return pending
}
