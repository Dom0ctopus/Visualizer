import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, writeFileAtomic } from './store.js'

/**
 * A volume's default look in the voxel render, set by an editor and applied
 * for everyone who opens it: itk-vtk-viewer's opacity curve, intensity
 * range, sample distance and volume scattering, the label blend, and the
 * blend fade's range and duration. One small JSON file per volume.
 */
export interface RenderDefault {
  /** itk-vtk-viewer's opacity curve points, [x, y] in 0-1. */
  opacityPoints: Array<[number, number]>
  /** Intensity range of the color/opacity maps; null for the whole range. */
  colorRange: [number, number] | null
  sampleDistance: number
  scattering: number
  labelBlend: number
  fade: { min: number; max: number; seconds: number }
}

const DIR = path.join(DATA_DIR, 'render-defaults')
const fileFor = (volumeId: string) => path.join(DIR, `${volumeId}.json`)
const num = (v: unknown, lo = -Infinity, hi = Infinity): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

export function parseRenderDefault(body: unknown): RenderDefault | null {
  const b = body as Partial<RenderDefault> | null
  if (!b || !Array.isArray(b.opacityPoints) || b.opacityPoints.length < 1 || b.opacityPoints.length > 64) return null
  if (!b.opacityPoints.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1], 0, 1))) return null
  if (b.colorRange !== null && !(Array.isArray(b.colorRange) && b.colorRange.length === 2 && num(b.colorRange[0]) && num(b.colorRange[1]))) return null
  if (!num(b.sampleDistance, 0, 1) || !num(b.scattering, 0, 1) || !num(b.labelBlend, 0, 1)) return null
  const f = b.fade
  if (!f || !num(f.min, 0, 1) || !num(f.max, 0, 1) || !num(f.seconds, 0.1, 3600)) return null
  return {
    opacityPoints: b.opacityPoints as Array<[number, number]>,
    colorRange: b.colorRange as [number, number] | null,
    sampleDistance: b.sampleDistance,
    scattering: b.scattering,
    labelBlend: b.labelBlend,
    fade: { min: f.min, max: f.max, seconds: f.seconds }
  }
}

export async function readRenderDefault(volumeId: string): Promise<RenderDefault | null> {
  try {
    return parseRenderDefault(JSON.parse(await readFile(fileFor(volumeId), 'utf8')))
  } catch {
    return null
  }
}

export async function writeRenderDefault(volumeId: string, look: RenderDefault): Promise<void> {
  await mkdir(DIR, { recursive: true })
  await writeFileAtomic(fileFor(volumeId), JSON.stringify(look))
}

export async function removeRenderDefault(volumeId: string): Promise<void> {
  await rm(fileFor(volumeId), { force: true })
}
