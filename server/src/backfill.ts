import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { hasOrthogonalCopies, writeOrthogonalCopies } from './orthogonalCopies.js'
import { readZarrArrayInfo, readZarrLevels, readZRange } from './zarrReader.js'
import { SLICE_OPTIMIZED_LEVEL_COUNT } from './zarrWriter.js'

/** Every multiscale group in a converted store: the store itself for a
 *  volume, or each `layerN` subgroup for a segmentation. */
export async function multiscaleGroupsIn(storePath: string, kind: 'volume' | 'segmentation'): Promise<string[]> {
  if (kind === 'volume') return [storePath]
  const entries = await readdir(storePath, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && /^layer\d+$/.test(e.name))
    .map((e) => path.join(storePath, e.name))
}

async function levelsMissingCopies(groupPath: string): Promise<string[]> {
  const levels = await readZarrLevels(groupPath)
  const missing: string[] = []
  for (const level of levels) {
    if (level.index >= SLICE_OPTIMIZED_LEVEL_COUNT) continue
    const levelDir = path.join(groupPath, level.levelPath)
    if (!(await hasOrthogonalCopies(levelDir))) missing.push(levelDir)
  }
  return missing
}

export async function storeNeedsOrthogonalBackfill(storePath: string, kind: 'volume' | 'segmentation'): Promise<boolean> {
  for (const group of await multiscaleGroupsIn(storePath, kind)) {
    if ((await levelsMissingCopies(group)).length > 0) return true
  }
  return false
}

/**
 * Adds coronal/sagittal-chunked copies (see orthogonalCopies.ts) to a store
 * converted before they existed, reading each level back a Z band at a time
 * from its own axial chunks -- no need to re-read or re-convert the NRRD.
 */
export async function backfillOrthogonalCopies(storePath: string, kind: 'volume' | 'segmentation'): Promise<void> {
  for (const group of await multiscaleGroupsIn(storePath, kind)) {
    for (const levelDir of await levelsMissingCopies(group)) {
      const info = await readZarrArrayInfo(levelDir)
      const [sz, sy, sx] = info.shape
      await writeOrthogonalCopies(levelDir, [sx, sy, sz], info.dtype, info.ctor, (z0, nz) => readZRange(levelDir, z0, nz))
    }
  }
}
