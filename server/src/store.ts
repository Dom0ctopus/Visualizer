import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { readNrrdHeader } from './nrrdHeader.js'
import type { StoredRecord } from './types.js'

export const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data')
export const FILES_DIR = path.join(DATA_DIR, 'files')
export const ZARR_DIR = path.join(DATA_DIR, 'zarr')
export const MESH_DIR = path.join(DATA_DIR, 'meshes')
const INDEX_PATH = path.join(DATA_DIR, 'index.json')

let records: StoredRecord[] = []

/**
 * Replaces a file's contents all-or-nothing: writes a sibling temp file and
 * renames it over the target, so a reader (or a crash) never sees a partial
 * write. Writes to the same path are serialized: two plain writeFile calls
 * racing on one file can interleave, leaving a shorter write's JSON followed
 * by the tail of a longer one -- which is how index.json got corrupted.
 */
const writeChains = new Map<string, Promise<void>>()
export function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const previous = writeChains.get(filePath) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      const tmp = `${filePath}.${process.pid}.tmp`
      await writeFile(tmp, contents)
      await rename(tmp, filePath)
    })
  writeChains.set(filePath, next)
  void next.finally(() => {
    if (writeChains.get(filePath) === next) writeChains.delete(filePath)
  })
  return next
}

/** The first complete JSON value in `text` (a corrupted file's valid
 *  prefix), or null. */
function firstJsonValue(text: string): unknown {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(0, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Rebuilds records for uploads on disk that the index doesn't list (after
 * recovering a corrupted index). The original filename isn't stored
 * anywhere else, so those come back named "recovered <file>".
 */
async function recoverOrphanedUploads(): Promise<StoredRecord[]> {
  const known = new Set(records.map((r) => r.storedFilename))
  const recovered: StoredRecord[] = []
  for (const file of await readdir(FILES_DIR)) {
    if (known.has(file) || file.startsWith('.')) continue
    const id = path.parse(file).name
    const { size, mtime } = await stat(path.join(FILES_DIR, file))
    const segStore = path.join(ZARR_DIR, `${id}.seg.ome.zarr`)
    const volStore = path.join(ZARR_DIR, `${id}.ome.zarr`)
    let isSegmentation = existsSync(segStore)
    if (!isSegmentation && !existsSync(volStore)) {
      try {
        const header = await readNrrdHeader(path.join(FILES_DIR, file))
        isSegmentation = Object.keys(header.keyValuePairs).some((k) => /^Segment\d+_/.test(k))
      } catch {
        continue // not a readable NRRD
      }
    }
    const common = { id, name: `recovered ${file}`, storedFilename: file, sizeBytes: size, uploadedAt: mtime.toISOString() }
    if (isSegmentation) {
      const converted = existsSync(path.join(segStore, 'layer0', '.zattrs'))
      recovered.push({
        ...common,
        kind: 'segmentation',
        zarrStatus: converted ? 'ready' : 'pending',
        meshStatus: existsSync(path.join(MESH_DIR, id, 'manifest.json')) ? 'ready' : undefined
      })
    } else {
      recovered.push({ ...common, kind: 'volume', zarrStatus: existsSync(path.join(volStore, '.zattrs')) ? 'ready' : 'pending' })
    }
  }
  return recovered
}

export async function initStore(): Promise<void> {
  await mkdir(FILES_DIR, { recursive: true })
  await mkdir(ZARR_DIR, { recursive: true })
  await mkdir(MESH_DIR, { recursive: true })
  if (!existsSync(INDEX_PATH)) return
  const text = await readFile(INDEX_PATH, 'utf8')
  try {
    records = JSON.parse(text)
    return
  } catch (e) {
    const backup = `${INDEX_PATH}.corrupt-${Date.now()}`
    await copyFile(INDEX_PATH, backup)
    const prefix = firstJsonValue(text)
    records = Array.isArray(prefix) ? (prefix as StoredRecord[]) : []
    const orphans = await recoverOrphanedUploads()
    records.push(...orphans)
    console.warn(
      `[store] index.json was corrupted (${e instanceof Error ? e.message : e}); recovered ${records.length - orphans.length} record(s) from it` +
        ` and ${orphans.length} more from the files on disk. The damaged file was kept as ${path.basename(backup)}.`
    )
    await persist()
  }
}

function persist(): Promise<void> {
  return writeFileAtomic(INDEX_PATH, JSON.stringify(records, null, 2))
}

export function listRecords(): StoredRecord[] {
  return records
}

export function getRecord(id: string): StoredRecord | undefined {
  return records.find((r) => r.id === id)
}

export async function addRecord(record: StoredRecord): Promise<void> {
  records.push(record)
  await persist()
}

export async function updateRecord(id: string, patch: Partial<StoredRecord>): Promise<void> {
  const idx = records.findIndex((r) => r.id === id)
  if (idx < 0) return
  records[idx] = { ...records[idx], ...patch } as StoredRecord
  await persist()
}

export async function removeRecord(id: string): Promise<StoredRecord | undefined> {
  const idx = records.findIndex((r) => r.id === id)
  if (idx < 0) return undefined
  const [removed] = records.splice(idx, 1)
  await persist()
  return removed
}

export function newId(): string {
  return nanoid(12)
}
