import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, writeFileAtomic } from './store.js'

/**
 * A volume's saved default crop box (the voxel render's rotatable crop box,
 * src/lib/cropBox.ts): its center, half-size along its own axes, and those
 * axes as unit vectors, all in world mm. One small JSON file per volume.
 */
export interface CropDefault {
  center: [number, number, number]
  half: [number, number, number]
  axes: [[number, number, number], [number, number, number], [number, number, number]]
}

const CROP_DIR = path.join(DATA_DIR, 'crop-defaults')
const fileFor = (volumeId: string) => path.join(CROP_DIR, `${volumeId}.json`)

const isVec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))

/** The body as a CropDefault, or null when it isn't one. */
export function parseCropDefault(body: unknown): CropDefault | null {
  const b = body as Partial<CropDefault> | null
  if (!b || !isVec3(b.center) || !isVec3(b.half) || !Array.isArray(b.axes) || b.axes.length !== 3 || !b.axes.every(isVec3)) return null
  if (b.half.some((h) => h <= 0)) return null
  return { center: b.center, half: b.half, axes: b.axes as CropDefault['axes'] }
}

export async function readCropDefault(volumeId: string): Promise<CropDefault | null> {
  try {
    return parseCropDefault(JSON.parse(await readFile(fileFor(volumeId), 'utf8')))
  } catch {
    return null
  }
}

export async function writeCropDefault(volumeId: string, crop: CropDefault): Promise<void> {
  await mkdir(CROP_DIR, { recursive: true })
  await writeFileAtomic(fileFor(volumeId), JSON.stringify(crop))
}

export async function removeCropDefault(volumeId: string): Promise<void> {
  await rm(fileFor(volumeId), { force: true })
}
