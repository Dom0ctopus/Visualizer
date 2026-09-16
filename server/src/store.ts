import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nanoid } from 'nanoid'
import type { StoredRecord } from './types.js'

export const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data')
export const FILES_DIR = path.join(DATA_DIR, 'files')
export const ZARR_DIR = path.join(DATA_DIR, 'zarr')
const INDEX_PATH = path.join(DATA_DIR, 'index.json')

let records: StoredRecord[] = []

export async function initStore(): Promise<void> {
  await mkdir(FILES_DIR, { recursive: true })
  await mkdir(ZARR_DIR, { recursive: true })
  if (existsSync(INDEX_PATH)) {
    records = JSON.parse(await readFile(INDEX_PATH, 'utf8'))
  }
}

async function persist(): Promise<void> {
  await writeFile(INDEX_PATH, JSON.stringify(records, null, 2))
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
