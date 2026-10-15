import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, writeFileAtomic } from './store.js'

/**
 * Named things editors save for making videos, each kind one small JSON
 * file of items by id: focus lists (segments to single out) and video
 * sequences (timed steps played while recording; src/lib/sequence.ts).
 */

export interface FocusList {
  id: string
  name: string
  /** Segments, as the client's focusKey: `${recordId}|${segmentKey}`. */
  keys: string[]
}

type Vec3 = [number, number, number]

export interface CameraState {
  position: Vec3
  focalPoint: Vec3
  viewUp: Vec3
  viewAngle: number
  parallelScale: number
}

export type SequenceStep = { id: string; withPrevious: boolean; seconds: number } & (
  | { kind: 'rotate'; degrees: number }
  | { kind: 'hold' }
  | { kind: 'focus'; listId: string; add: boolean }
  | { kind: 'clearFocus' }
  | { kind: 'wipe'; face: number; direction: 'in' | 'out' }
  | { kind: 'blend'; from: number; to: number }
)

export interface VideoSequence {
  id: string
  name: string
  /** The camera the sequence starts from; null to start from wherever it is. */
  startView: CameraState | null
  steps: SequenceStep[]
}

const num = (v: unknown, lo = -Infinity, hi = Infinity): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((c) => num(c))
const ID = /^[A-Za-z0-9_-]{1,64}$/

export const isItemId = (id: string) => ID.test(id)

export function parseFocusList(id: string, body: unknown): FocusList | null {
  const b = body as Partial<FocusList> | null
  if (!b || !str(b.name, 120) || !Array.isArray(b.keys) || b.keys.length < 1 || b.keys.length > 5000) return null
  if (!b.keys.every((k) => str(k, 400))) return null
  return { id, name: b.name.trim(), keys: [...new Set(b.keys)] }
}

function parseCamera(v: unknown): CameraState | null | undefined {
  if (v === null) return null
  const c = v as Partial<CameraState> | null
  if (!c || !vec3(c.position) || !vec3(c.focalPoint) || !vec3(c.viewUp) || !num(c.viewAngle, 0, 180) || !num(c.parallelScale, 0)) return undefined
  return { position: c.position, focalPoint: c.focalPoint, viewUp: c.viewUp, viewAngle: c.viewAngle, parallelScale: c.parallelScale }
}

function parseStep(v: unknown): SequenceStep | null {
  const s = v as Record<string, unknown> | null
  if (!s || !str(s.id, 64) || typeof s.withPrevious !== 'boolean' || !num(s.seconds, 0, 3600)) return null
  const base = { id: s.id, withPrevious: s.withPrevious, seconds: s.seconds }
  switch (s.kind) {
    case 'rotate':
      return num(s.degrees, -36000, 36000) ? { ...base, kind: 'rotate', degrees: s.degrees } : null
    case 'hold':
      return { ...base, kind: 'hold' }
    case 'focus':
      return str(s.listId, 64) && typeof s.add === 'boolean' ? { ...base, kind: 'focus', listId: s.listId, add: s.add } : null
    case 'clearFocus':
      return { ...base, kind: 'clearFocus' }
    case 'wipe':
      return num(s.face, 0, 5) && Number.isInteger(s.face) && (s.direction === 'in' || s.direction === 'out')
        ? { ...base, kind: 'wipe', face: s.face, direction: s.direction }
        : null
    case 'blend':
      return num(s.from, 0, 1) && num(s.to, 0, 1) ? { ...base, kind: 'blend', from: s.from, to: s.to } : null
    default:
      return null
  }
}

export function parseSequence(id: string, body: unknown): VideoSequence | null {
  const b = body as Partial<VideoSequence> | null
  if (!b || !str(b.name, 120) || !Array.isArray(b.steps) || b.steps.length > 500) return null
  const startView = parseCamera(b.startView ?? null)
  if (startView === undefined) return null
  const steps = b.steps.map(parseStep)
  if (steps.some((s) => s === null)) return null
  return { id, name: b.name.trim(), startView, steps: steps as SequenceStep[] }
}

/** One kind of saved item, kept in `data/<file>`; writes go one at a time. */
function collection<T extends { id: string }>(file: string) {
  const filePath = path.join(DATA_DIR, file)
  let queue: Promise<unknown> = Promise.resolve()
  const read = async (): Promise<T[]> => {
    try {
      const items = JSON.parse(await readFile(filePath, 'utf8'))
      return Array.isArray(items) ? items : []
    } catch {
      return []
    }
  }
  const update = (change: (items: T[]) => T[]) => {
    const next = queue.then(async () => {
      const items = change(await read())
      await writeFileAtomic(filePath, JSON.stringify(items))
      return items
    })
    queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
  return {
    list: read,
    /** Adds the item, or replaces the one with its id (keeping its place). */
    put: (item: T) =>
      update((items) => (items.some((i) => i.id === item.id) ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item])),
    remove: (id: string) => update((items) => items.filter((i) => i.id !== id))
  }
}

export const focusLists = collection<FocusList>('focus-lists.json')
export const sequences = collection<VideoSequence>('sequences.json')
