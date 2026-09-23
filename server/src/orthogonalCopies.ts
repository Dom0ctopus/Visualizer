import Blosc from 'numcodecs/blosc'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TypedArray, TypedArrayConstructor } from './zarrWriter.js'

/**
 * Coronal- and sagittal-chunked copies of a pyramid level, stored as sibling
 * arrays of the level (`scale0` -> `scale0_coronal`, `scale0_sagittal`) in
 * the same zarr group. They aren't listed in the NGFF multiscales metadata,
 * so itk-vtk-viewer never sees them; only the 2D panes' readers
 * (src/lib/zarrClient.ts) use them.
 *
 * Why: the primary arrays are chunked one Z index per chunk (see
 * zarrWriter.ts's sliceOptimizedChunkShape), which makes an axial slice one
 * chunk but a coronal or sagittal slice one chunk *per Z index* -- the whole
 * level. These copies make every orthogonal read a handful of chunks:
 *
 *   coronal:  chunks [bandZ, 1, sx]   -> a coronal slice at y is ceil(sz/bandZ) chunks
 *   sagittal: chunks [bandZ, sy, 1]   -> a sagittal slice at x is ceil(sz/bandZ) chunks
 *
 * bandZ is chosen so one band of the source (bandZ * sy * sx voxels) fits in
 * ORTHO_BAND_BYTES: both copies are written a band at a time from that one
 * buffer, so memory stays bounded however large the level is.
 *
 * Compressed with zstd level 1 rather than the primary arrays' level 5: on a
 * 512^3 CT-like benchmark that kept the extra conversion time to ~60% (vs
 * ~120% at level 3) while compressing ~1.5x better than lz4. Expect a
 * converted store to take roughly 3x the disk it did without these copies.
 */
const ORTHO_BAND_BYTES = 256 * 1024 * 1024
const ORTHO_BLOSC_CONFIG = { id: 'blosc', cname: 'zstd', clevel: 1, shuffle: 1 } as const
const orthoCodec = Blosc.fromConfig(ORTHO_BLOSC_CONFIG)
const WRITE_CONCURRENCY = 32

export type OrthoAxis = 'coronal' | 'sagittal'

export function orthogonalArrayDir(levelDir: string, axis: OrthoAxis): string {
  return `${levelDir}_${axis}`
}

/** A copy is complete once its .zarray exists -- written last, after every chunk. */
export async function hasOrthogonalCopies(levelDir: string): Promise<boolean> {
  for (const axis of ['coronal', 'sagittal'] as const) {
    try {
      await stat(path.join(orthogonalArrayDir(levelDir, axis), '.zarray'))
    } catch {
      return false
    }
  }
  return true
}

/** Encodes and writes chunks with bounded concurrency, so file I/O overlaps
 *  encoding without queueing an unbounded number of buffers in memory. */
class ChunkWriter {
  private inFlight = new Set<Promise<void>>()

  async write(filePath: string, data: TypedArray): Promise<void> {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const compressed = await orthoCodec.encode(bytes)
    const p = writeFile(filePath, compressed).finally(() => this.inFlight.delete(p))
    this.inFlight.add(p)
    if (this.inFlight.size >= WRITE_CONCURRENCY) await Promise.race(this.inFlight)
  }

  async flush(): Promise<void> {
    await Promise.all(this.inFlight)
  }
}

/**
 * Writes both orthogonal copies of one level. `size` is [sx, sy, sz] (Level
 * convention); `readBand(z0, nz)` must return slices [z0, z0 + nz) as a flat
 * z-major buffer -- a zero-copy subarray during conversion, or a read from
 * the level's own axial chunks when backfilling an existing upload.
 */
export async function writeOrthogonalCopies(
  levelDir: string,
  size: readonly [number, number, number],
  dtype: string,
  ctor: TypedArrayConstructor,
  readBand: (z0: number, nz: number) => Promise<TypedArray> | TypedArray,
  bandBytes: number = ORTHO_BAND_BYTES
): Promise<void> {
  const [sx, sy, sz] = size
  const bandZ = Math.max(1, Math.min(sz, Math.floor(bandBytes / (sx * sy * ctor.BYTES_PER_ELEMENT))))
  const nBands = Math.ceil(sz / bandZ)
  const coronalDir = orthogonalArrayDir(levelDir, 'coronal')
  const sagittalDir = orthogonalArrayDir(levelDir, 'sagittal')

  // Clear any partial output from an interrupted earlier attempt.
  await rm(coronalDir, { recursive: true, force: true })
  await rm(sagittalDir, { recursive: true, force: true })
  await mkdir(coronalDir, { recursive: true })
  await mkdir(sagittalDir, { recursive: true })

  const writer = new ChunkWriter()
  const chunkVoxelsSag = bandZ * sy
  // One reused buffer per copy; the sagittal one holds all sx chunks of the
  // current band side by side (chunk x at [x * bandZ * sy, (x + 1) * bandZ * sy)).
  const sag = new ctor(sx * chunkVoxelsSag) as TypedArray
  const TILE = 64

  for (let b = 0; b < nBands; b++) {
    const z0 = b * bandZ
    const nz = Math.min(bandZ, sz - z0)
    const band = await readBand(z0, nz)
    // Zarr v2 edge chunks must be full-size, padded with the fill value (0).
    if (nz < bandZ) sag.fill(0)

    for (let y = 0; y < sy; y++) {
      const chunk = new ctor(bandZ * sx) as TypedArray
      for (let z = 0; z < nz; z++) {
        const src = z * sy * sx + y * sx
        chunk.set(band.subarray(src, src + sx), z * sx)
      }
      await writer.write(path.join(coronalDir, `${b}.${y}.0`), chunk)
    }

    // Tiled transpose (x, y) -> per-x chunks: reads stay within a 64-row
    // block of the band, writes are 64 consecutive elements per chunk.
    for (let z = 0; z < nz; z++) {
      const zBase = z * sy * sx
      for (let y0 = 0; y0 < sy; y0 += TILE) {
        const y1 = Math.min(sy, y0 + TILE)
        for (let x0 = 0; x0 < sx; x0 += TILE) {
          const x1 = Math.min(sx, x0 + TILE)
          for (let x = x0; x < x1; x++) {
            const dst = x * chunkVoxelsSag + z * sy
            for (let y = y0; y < y1; y++) sag[dst + y] = band[zBase + y * sx + x]
          }
        }
      }
    }
    for (let x = 0; x < sx; x++) {
      await writer.write(path.join(sagittalDir, `${b}.0.${x}`), sag.subarray(x * chunkVoxelsSag, (x + 1) * chunkVoxelsSag))
    }
  }
  await writer.flush()

  const zarray = (chunks: [number, number, number]) =>
    JSON.stringify({
      zarr_format: 2,
      shape: [sz, sy, sx],
      chunks,
      dtype,
      compressor: ORTHO_BLOSC_CONFIG,
      fill_value: 0,
      order: 'C',
      filters: null
    })
  await writeFile(path.join(coronalDir, '.zarray'), zarray([bandZ, 1, sx]))
  await writeFile(path.join(sagittalDir, '.zarray'), zarray([bandZ, sy, 1]))
}
