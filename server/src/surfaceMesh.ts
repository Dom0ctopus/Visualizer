import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { multiscaleGroupsIn } from './backfill.js'
import { readZarrArrayInfo, readZarrLevels, readZRange } from './zarrReader.js'
import type { TypedArray, TypedArrayConstructor } from './zarrWriter.js'

/**
 * Per-segment surface meshes for the "Surface meshes" 3D tab, generated from
 * each segmentation layer's native-resolution label map (pyramid level 0).
 *
 * Algorithm: multi-label naive surface nets. Every grid cell (2x2x2 voxel
 * corners) whose corners disagree about membership in label L gets one
 * vertex for L, at the average of the midpoints of its membership-crossing
 * edges; every voxel edge that crosses L's boundary emits one quad joining
 * the four cells around it. The volume is conceptually padded with a
 * one-voxel border of background, so segments touching the array's edge
 * still produce closed surfaces. Then Taubin (lambda/mu) smoothing removes
 * the voxel staircase without the shrinkage plain Laplacian smoothing
 * causes -- which matters for 1-2 voxel wide vessels and nerves.
 *
 * Streams the level two Z slices at a time (read in bands from the level's
 * own axial chunks), so memory is bounded by a couple of slices plus the
 * output meshes, not by the label map's size.
 */

const READ_BAND_SLICES = 32
const TAUBIN_ITERATIONS = 10
const TAUBIN_LAMBDA = 0.5
const TAUBIN_MU = -0.53
// Map key = cellIndex * LABEL_KEY_MULTIPLIER + label. Labels at or above this
// are ignored (3D Slicer label values are small integers in practice).
const LABEL_KEY_MULTIPLIER = 1 << 20

export interface MeshManifestEntry {
  layer: number
  labelValue: number
  file: string
  vertexCount: number
  triangleCount: number
}

export interface MeshManifest {
  version: 1
  segments: MeshManifestEntry[]
  /** [x, y, z] mm, union of every mesh's vertices. */
  boundsMin: [number, number, number]
  boundsMax: [number, number, number]
}

class GrowableF32 {
  data = new Float32Array(1024)
  length = 0
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const next = new Float32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = a
    this.data[this.length++] = b
    this.data[this.length++] = c
  }
}

class GrowableU32 {
  data = new Uint32Array(1024)
  length = 0
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = a
    this.data[this.length++] = b
    this.data[this.length++] = c
  }
}

interface LabelMesh {
  positions: GrowableF32
  indices: GrowableU32
  vertexCount: number
}

// Cube corner n sits at (n & 1, (n >> 1) & 1, (n >> 2) & 1). The 12 edges
// are the corner pairs differing in exactly one bit.
const CUBE_EDGES: Array<[number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7]
]

// For each 8-bit corner-membership mask, the vertex offset within the cell:
// the mean of the midpoints of every edge with exactly one member endpoint.
const VERTEX_OFFSET = (() => {
  const table = new Float32Array(256 * 3)
  for (let mask = 1; mask < 255; mask++) {
    let sx = 0
    let sy = 0
    let sz = 0
    let n = 0
    for (const [u, v] of CUBE_EDGES) {
      if (((mask >> u) & 1) === ((mask >> v) & 1)) continue
      sx += ((u & 1) + (v & 1)) / 2
      sy += (((u >> 1) & 1) + ((v >> 1) & 1)) / 2
      sz += (((u >> 2) & 1) + ((v >> 2) & 1)) / 2
      n++
    }
    table[mask * 3] = sx / n
    table[mask * 3 + 1] = sy / n
    table[mask * 3 + 2] = sz / n
  }
  return table
})()

/** Padded slice (one-voxel background border) plus per-row nonzero x-range,
 *  both in padded coordinates. rowLo = -1 marks an empty row. */
interface PaddedSlice {
  data: TypedArray
  rowLo: Int32Array
  rowHi: Int32Array
}

function makePaddedSlice(ctor: TypedArrayConstructor, pw: number, ph: number): PaddedSlice {
  return { data: new ctor(pw * ph) as TypedArray, rowLo: new Int32Array(ph).fill(-1), rowHi: new Int32Array(ph).fill(-1) }
}

function fillPaddedSlice(dst: PaddedSlice, src: TypedArray | null, srcOffset: number, sx: number, sy: number, pw: number): void {
  dst.data.fill(0)
  dst.rowLo.fill(-1)
  dst.rowHi.fill(-1)
  if (!src) return
  for (let y = 0; y < sy; y++) {
    const rowStart = srcOffset + y * sx
    const row = src.subarray(rowStart, rowStart + sx)
    let lo = -1
    let hi = -1
    for (let x = 0; x < sx; x++) {
      if (row[x] > 0) {
        if (lo < 0) lo = x
        hi = x
      }
    }
    if (lo < 0) continue
    const pr = y + 1
    dst.data.set(row, pr * pw + 1)
    dst.rowLo[pr] = lo + 1
    dst.rowHi[pr] = hi + 1
  }
}

/** Union of the nonzero x-ranges of the given rows across two slices. */
function rowUnion(a: PaddedSlice, b: PaddedSlice, r0: number, r1: number): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const s of [a, b]) {
    for (let r = r0; r <= r1; r++) {
      if (r < 0 || r >= s.rowLo.length || s.rowLo[r] < 0) continue
      if (s.rowLo[r] < lo) lo = s.rowLo[r]
      if (s.rowHi[r] > hi) hi = s.rowHi[r]
    }
  }
  return [lo, hi]
}

function taubinSmooth(positions: Float32Array, vertexCount: number, indices: Uint32Array, triangleCount: number): void {
  // CSR adjacency from triangle edges. On a closed surface every edge is in
  // two triangles, so duplicates weight every neighbor equally.
  const degree = new Uint32Array(vertexCount + 1)
  for (let t = 0; t < triangleCount * 3; t += 3) {
    degree[indices[t]] += 2
    degree[indices[t + 1]] += 2
    degree[indices[t + 2]] += 2
  }
  const offsets = new Uint32Array(vertexCount + 1)
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] = offsets[v] + degree[v]
  const neighbors = new Uint32Array(offsets[vertexCount])
  const cursor = offsets.slice(0, vertexCount)
  for (let t = 0; t < triangleCount * 3; t += 3) {
    const a = indices[t]
    const b = indices[t + 1]
    const c = indices[t + 2]
    neighbors[cursor[a]++] = b
    neighbors[cursor[a]++] = c
    neighbors[cursor[b]++] = a
    neighbors[cursor[b]++] = c
    neighbors[cursor[c]++] = a
    neighbors[cursor[c]++] = b
  }

  const scratch = new Float32Array(vertexCount * 3)
  const pass = (src: Float32Array, dst: Float32Array, factor: number) => {
    for (let v = 0; v < vertexCount; v++) {
      const start = offsets[v]
      const end = offsets[v + 1]
      const i = v * 3
      if (end === start) {
        dst[i] = src[i]
        dst[i + 1] = src[i + 1]
        dst[i + 2] = src[i + 2]
        continue
      }
      let ax = 0
      let ay = 0
      let az = 0
      for (let k = start; k < end; k++) {
        const j = neighbors[k] * 3
        ax += src[j]
        ay += src[j + 1]
        az += src[j + 2]
      }
      const inv = 1 / (end - start)
      dst[i] = src[i] + factor * (ax * inv - src[i])
      dst[i + 1] = src[i + 1] + factor * (ay * inv - src[i + 1])
      dst[i + 2] = src[i + 2] + factor * (az * inv - src[i + 2])
    }
  }
  for (let it = 0; it < TAUBIN_ITERATIONS; it++) {
    pass(positions, scratch, TAUBIN_LAMBDA)
    pass(scratch, positions, TAUBIN_MU)
  }
}

/**
 * Meshes every nonzero label in one multiscale group's level 0. Returns the
 * meshes keyed by label, positions already in physical [x, y, z] mm.
 */
async function meshLayer(groupPath: string): Promise<Map<number, { positions: Float32Array; indices: Uint32Array }>> {
  const levels = await readZarrLevels(groupPath)
  const level0 = levels.find((l) => l.index === 0)!
  const arrayDir = path.join(groupPath, level0.levelPath)
  const { shape, ctor } = await readZarrArrayInfo(arrayDir)
  const [sz, sy, sx] = shape
  const [originZ, originY, originX] = level0.origin
  const [spacingZ, spacingY, spacingX] = level0.spacing
  const pw = sx + 2
  const ph = sy + 2

  const meshes = new Map<number, LabelMesh>()
  const meshFor = (label: number): LabelMesh => {
    let m = meshes.get(label)
    if (!m) {
      m = { positions: new GrowableF32(), indices: new GrowableU32(), vertexCount: 0 }
      meshes.set(label, m)
    }
    return m
  }

  // Slices are streamed in bands; slice(k) for k in [-1, sz] (the two ends
  // are the virtual background padding).
  let band: TypedArray | null = null
  let bandZ0 = -1
  const sliceSource = async (k: number): Promise<{ src: TypedArray | null; offset: number }> => {
    if (k < 0 || k >= sz) return { src: null, offset: 0 }
    if (!band || k < bandZ0 || k >= bandZ0 + READ_BAND_SLICES) {
      bandZ0 = k
      band = await readZRange(arrayDir, k, Math.min(READ_BAND_SLICES, sz - k))
    }
    return { src: band, offset: (k - bandZ0) * sy * sx }
  }

  let lower = makePaddedSlice(ctor, pw, ph)
  let upper = makePaddedSlice(ctor, pw, ph)
  {
    const s = await sliceSource(-1)
    fillPaddedSlice(lower, s.src, s.offset, sx, sy, pw)
  }
  let prevMap = new Map<number, number>()
  let curMap = new Map<number, number>()
  const labels: number[] = []

  const quad = (label: number, k0: number, k1: number, k2: number, k3: number, reverse: boolean, m0: Map<number, number>, m1: Map<number, number>, m2: Map<number, number>, m3: Map<number, number>) => {
    const v0 = m0.get(k0 * LABEL_KEY_MULTIPLIER + label)
    const v1 = m1.get(k1 * LABEL_KEY_MULTIPLIER + label)
    const v2 = m2.get(k2 * LABEL_KEY_MULTIPLIER + label)
    const v3 = m3.get(k3 * LABEL_KEY_MULTIPLIER + label)
    if (v0 === undefined || v1 === undefined || v2 === undefined || v3 === undefined) return
    const idx = meshFor(label).indices
    if (reverse) {
      idx.push3(v0, v2, v1)
      idx.push3(v0, v3, v2)
    } else {
      idx.push3(v0, v1, v2)
      idx.push3(v0, v2, v3)
    }
  }

  for (let k = -1; k < sz; k++) {
    const s = await sliceSource(k + 1)
    fillPaddedSlice(upper, s.src, s.offset, sx, sy, pw)
    const L = lower.data
    const U = upper.data

    // 1. One vertex per (cell, label) straddling that label's boundary.
    for (let r = 0; r < ph - 1; r++) {
      const [lo, hi] = rowUnion(lower, upper, r, r + 1)
      if (lo > hi) continue
      const x0 = Math.max(0, lo - 1)
      const x1 = Math.min(pw - 2, hi)
      for (let px = x0; px <= x1; px++) {
        const i0 = r * pw + px
        const i2 = i0 + pw
        const c0 = L[i0], c1 = L[i0 + 1], c2 = L[i2], c3 = L[i2 + 1]
        const c4 = U[i0], c5 = U[i0 + 1], c6 = U[i2], c7 = U[i2 + 1]
        if (c0 === c1 && c0 === c2 && c0 === c3 && c0 === c4 && c0 === c5 && c0 === c6 && c0 === c7) continue
        labels.length = 0
        for (const v of [c0, c1, c2, c3, c4, c5, c6, c7]) {
          if (v > 0 && v < LABEL_KEY_MULTIPLIER && !labels.includes(v)) labels.push(v)
        }
        for (const label of labels) {
          const mask =
            (c0 === label ? 1 : 0) | (c1 === label ? 2 : 0) | (c2 === label ? 4 : 0) | (c3 === label ? 8 : 0) |
            (c4 === label ? 16 : 0) | (c5 === label ? 32 : 0) | (c6 === label ? 64 : 0) | (c7 === label ? 128 : 0)
          if (mask === 255) continue
          const m = meshFor(label)
          const o = mask * 3
          // Cell min corner in unpadded voxel coordinates is (px-1, r-1, k).
          m.positions.push3(
            originX + (px - 1 + VERTEX_OFFSET[o]) * spacingX,
            originY + (r - 1 + VERTEX_OFFSET[o + 1]) * spacingY,
            originZ + (k + VERTEX_OFFSET[o + 2]) * spacingZ
          )
          curMap.set(i0 * LABEL_KEY_MULTIPLIER + label, m.vertexCount++)
        }
      }
    }

    // 2. Z edges between slices k and k+1: the four cells around each are
    //    all in this layer. Winding is counter-clockwise seen from outside.
    for (let pr = 1; pr < ph - 1; pr++) {
      const [lo, hi] = rowUnion(lower, upper, pr, pr)
      if (lo > hi) continue
      for (let px = lo; px <= hi; px++) {
        const i = pr * pw + px
        const a = L[i]
        const b = U[i]
        if (a === b) continue
        const kA = i - pw - 1
        const kB = i - pw
        const kC = i
        const kD = i - 1
        if (a > 0) quad(a, kA, kB, kC, kD, false, curMap, curMap, curMap, curMap)
        if (b > 0) quad(b, kA, kB, kC, kD, true, curMap, curMap, curMap, curMap)
      }
    }

    // 3. X and Y edges within slice k (the slice shared by layers k-1 and
    //    k), now that both layers' vertices are known.
    if (k >= 0) {
      for (let pr = 0; pr < ph - 1; pr++) {
        const [lo, hi] = rowUnion(lower, lower, pr, pr + 1)
        if (lo > hi) continue
        for (let px = Math.max(0, lo - 1); px <= Math.min(pw - 2, hi); px++) {
          const i = pr * pw + px
          const p = L[i]
          // X edge (px, pr) -> (px+1, pr)
          const q = L[i + 1]
          if (p !== q && pr >= 1) {
            const kA = i - pw
            const kB = i
            if (p > 0) quad(p, kA, kB, kB, kA, false, prevMap, prevMap, curMap, curMap)
            if (q > 0) quad(q, kA, kB, kB, kA, true, prevMap, prevMap, curMap, curMap)
          }
          // Y edge (px, pr) -> (px, pr+1)
          const w = L[i + pw]
          if (p !== w && px >= 1) {
            const kA = i - 1
            const kB = i
            if (p > 0) quad(p, kA, kA, kB, kB, false, prevMap, curMap, curMap, prevMap)
            if (w > 0) quad(w, kA, kA, kB, kB, true, prevMap, curMap, curMap, prevMap)
          }
        }
      }
    }

    const swapSlice = lower
    lower = upper
    upper = swapSlice
    const swapMap = prevMap
    prevMap = curMap
    curMap = swapMap
    curMap.clear()
  }

  const result = new Map<number, { positions: Float32Array; indices: Uint32Array }>()
  for (const [label, m] of meshes) {
    const positions = m.positions.data.slice(0, m.positions.length)
    const indices = m.indices.data.slice(0, m.indices.length)
    if (indices.length === 0) continue
    taubinSmooth(positions, m.vertexCount, indices, indices.length / 3)
    result.set(label, { positions, indices })
  }
  return result
}

/**
 * Generates meshes for every layer of a converted segmentation store and
 * writes them, plus a manifest.json, to outputDir: one binary file per
 * (layer, label) -- [u32 vertexCount][u32 triangleCount][f32 xyz * vertexCount][u32 abc * triangleCount].
 */
export async function generateSegmentationMeshes(segStorePath: string, outputDir: string): Promise<MeshManifest> {
  const tmpDir = `${outputDir}.tmp`
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })

  const entries: MeshManifestEntry[] = []
  const boundsMin: [number, number, number] = [Infinity, Infinity, Infinity]
  const boundsMax: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  for (const groupPath of await multiscaleGroupsIn(segStorePath, 'segmentation')) {
    const layer = Number(path.basename(groupPath).replace('layer', ''))
    const meshes = await meshLayer(groupPath)
    for (const [labelValue, { positions, indices }] of meshes) {
      const vertexCount = positions.length / 3
      const triangleCount = indices.length / 3
      for (let i = 0; i < positions.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (positions[i + a] < boundsMin[a]) boundsMin[a] = positions[i + a]
          if (positions[i + a] > boundsMax[a]) boundsMax[a] = positions[i + a]
        }
      }
      const header = new Uint32Array([vertexCount, triangleCount])
      const file = `${layer}_${labelValue}.bin`
      await writeFile(path.join(tmpDir, file), Buffer.concat([
        Buffer.from(header.buffer),
        Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
        Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength)
      ]))
      entries.push({ layer, labelValue, file, vertexCount, triangleCount })
    }
  }

  if (!Number.isFinite(boundsMin[0])) {
    boundsMin.fill(0)
    boundsMax.fill(0)
  }
  const manifest: MeshManifest = { version: 1, segments: entries, boundsMin, boundsMax }
  await writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest))
  await rm(outputDir, { recursive: true, force: true })
  await rename(tmpDir, outputDir)
  return manifest
}
