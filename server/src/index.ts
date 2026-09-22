import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { readNrrdHeader } from './nrrdHeader.js'
import { convertSegmentationMergeToOmeZarr, type MergedSegmentMapping } from './segmentationMergeConvert.js'
import { convertSegmentationNrrdToOmeZarr } from './segmentationZarrConvert.js'
import { extractSegments, groupIntoSystems } from './segmentTree.js'
import { FILES_DIR, ZARR_DIR, addRecord, getRecord, initStore, listRecords, newId, removeRecord, updateRecord } from './store.js'
import type { LibraryRecord, SegmentationRecord, StoredRecord, StoredSegmentationRecord, VolumeRecord } from './types.js'
import { convertNrrdToOmeZarr } from './zarrConvert.js'

async function enrichSegmentationRecord(stored: StoredSegmentationRecord): Promise<SegmentationRecord> {
  const header = await readNrrdHeader(path.join(FILES_DIR, stored.storedFilename))
  const segments = extractSegments(header)
  const systems = groupIntoSystems(segments)
  const dimension = Number(header.fields['dimension'] ?? '3')
  const layerCount = Math.max(1, ...segments.map((s) => s.layer + 1))
  return { ...stored, dimension, layerCount, systems }
}

async function toLibraryRecord(stored: StoredRecord): Promise<LibraryRecord> {
  return stored.kind === 'volume' ? stored : enrichSegmentationRecord(stored)
}

await initStore()

function zarrPathFor(id: string): string {
  return path.join(ZARR_DIR, `${id}.ome.zarr`)
}

function segZarrPathFor(id: string): string {
  return path.join(ZARR_DIR, `${id}.seg.ome.zarr`)
}

// Fixed (not per-request) path: this app runs single-user/local, so at most
// one merged "cumulative" 3D label image is ever needed at a time. Reusing
// one slot instead of minting a new id per merge (every time the set of
// loaded segmentations changes) avoids accumulating never-cleaned-up merge
// output on disk across a session -- see the git history for why unbounded
// file growth under server/data is worth taking seriously here.
function mergeZarrPathFor(): string {
  return path.join(ZARR_DIR, '_merge.ome.zarr')
}

// Runs in the background after a volume upload responds -- conversion of a
// large scan can take a while, and the point of doing this automatically is
// to keep the upload itself fast rather than making the user wait through it.
// The itk-vtk-viewer engine polls /api/library and only offers itself once
// zarrStatus is 'ready'.
function convertInBackground(id: string, nrrdPath: string): void {
  void (async () => {
    try {
      await convertNrrdToOmeZarr(nrrdPath, zarrPathFor(id))
      await updateRecord(id, { zarrStatus: 'ready' })
    } catch (e) {
      // Only e.message is persisted to the record (surfaced in the UI), which
      // is often too short to diagnose from -- the full error (stack trace
      // included) goes to the server's own console so it's not lost.
      console.error(`Volume conversion failed for ${id}:`, e)
      await updateRecord(id, { zarrStatus: 'failed', zarrError: e instanceof Error ? e.message : 'Conversion failed' })
    }
  })()
}

// Same fire-and-forget pattern as convertInBackground, for a segmentation's
// per-layer label-map conversion (segmentationZarrConvert.ts).
function convertSegmentationInBackground(id: string, nrrdPath: string): void {
  void (async () => {
    try {
      await convertSegmentationNrrdToOmeZarr(nrrdPath, segZarrPathFor(id))
      await updateRecord(id, { zarrStatus: 'ready' })
    } catch (e) {
      console.error(`Segmentation conversion failed for ${id}:`, e)
      await updateRecord(id, { zarrStatus: 'failed', zarrError: e instanceof Error ? e.message : 'Conversion failed' })
    }
  })()
}

interface MergeState {
  status: 'pending' | 'ready' | 'failed'
  error?: string
  mapping?: MergedSegmentMapping[]
}

// In-memory only, not persisted to store.ts's index.json -- a merge is
// fully derived from already-persisted volume/segmentation records, so
// there's nothing here worth surviving a server restart; the client just
// re-requests one if it needs it again. Single slot, matching
// mergeZarrPathFor's single fixed output path.
let currentMerge: MergeState | null = null

// Runs a cumulative-3D-view merge (segmentationMergeConvert.ts) in the
// background, same fire-and-forget pattern as convertInBackground/
// convertSegmentationInBackground above.
function convertMergeInBackground(volumeId: string, layers: Array<{ segmentationId: string; layer: number; labelValues: number[] }>): void {
  void (async () => {
    try {
      await rm(mergeZarrPathFor(), { recursive: true, force: true })
      const layerInputs = layers.map((l) => ({
        segZarrGroupPath: path.join(segZarrPathFor(l.segmentationId), `layer${l.layer}`),
        labelValues: l.labelValues
      }))
      const { mapping } = await convertSegmentationMergeToOmeZarr(zarrPathFor(volumeId), layerInputs, mergeZarrPathFor())
      currentMerge = { status: 'ready', mapping }
    } catch (e) {
      console.error('Segmentation merge failed:', e)
      currentMerge = { status: 'failed', error: e instanceof Error ? e.message : 'Merge failed' }
    }
  })()
}

const app = express()
app.use(cors())
// dotfiles: 'allow' is required here -- OME-Zarr v2's own metadata files
// (.zattrs, .zgroup, .zarray) are dotfiles, which express.static ignores
// (404s) by default.
app.use('/api/zarr', express.static(ZARR_DIR, { dotfiles: 'allow' }))

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.nrrd'
      cb(null, `${newId()}${ext}`)
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/library', async (_req, res) => {
  const records = await Promise.all(listRecords().map(toLibraryRecord))
  res.json({ records })
})

app.get('/api/files/:id', (req, res) => {
  const record = getRecord(req.params.id)
  if (!record) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.sendFile(path.join(FILES_DIR, record.storedFilename))
})

app.post('/api/volumes', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) {
    res.status(400).json({ error: 'Missing file' })
    return
  }
  const record: VolumeRecord = {
    id: path.parse(file.filename).name,
    kind: 'volume',
    name: file.originalname,
    storedFilename: file.filename,
    sizeBytes: file.size,
    uploadedAt: new Date().toISOString(),
    zarrStatus: 'pending'
  }
  await addRecord(record)
  res.json(record)
  convertInBackground(record.id, path.join(FILES_DIR, file.filename))
})

app.post('/api/segmentations', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) {
    res.status(400).json({ error: 'Missing file' })
    return
  }
  const filePath = path.join(FILES_DIR, file.filename)
  const stored: StoredSegmentationRecord = {
    id: path.parse(file.filename).name,
    kind: 'segmentation',
    name: file.originalname,
    storedFilename: file.filename,
    sizeBytes: file.size,
    uploadedAt: new Date().toISOString(),
    zarrStatus: 'pending'
  }
  try {
    const header = await readNrrdHeader(filePath)
    const segments = extractSegments(header)
    if (segments.length === 0) {
      throw new Error(
        'No Slicer-style segment metadata (Segment0_Name, Segment0_LabelValue, ...) found in this NRRD header.'
      )
    }
    await addRecord(stored)
    res.json(await enrichSegmentationRecord(stored))
    convertSegmentationInBackground(stored.id, filePath)
  } catch (e) {
    await rm(filePath, { force: true })
    res.status(422).json({ error: e instanceof Error ? e.message : 'Failed to parse segmentation' })
  }
})

app.post('/api/segmentation-merges', express.json(), (req, res) => {
  const { volumeId, layers } = (req.body ?? {}) as {
    volumeId?: string
    layers?: Array<{ segmentationId?: string; layer?: number; labelValues?: number[] }>
  }
  if (!volumeId || !Array.isArray(layers) || layers.length === 0) {
    res.status(400).json({ error: 'Missing volumeId or layers' })
    return
  }
  const validLayers = layers.filter(
    (l): l is { segmentationId: string; layer: number; labelValues: number[] } =>
      typeof l.segmentationId === 'string' && typeof l.layer === 'number' && Array.isArray(l.labelValues)
  )
  if (validLayers.length !== layers.length) {
    res.status(400).json({ error: 'Malformed layers entry' })
    return
  }
  currentMerge = { status: 'pending' }
  res.json(currentMerge)
  convertMergeInBackground(volumeId, validLayers)
})

app.get('/api/segmentation-merges', (_req, res) => {
  res.json(currentMerge ?? { status: 'none' })
})

app.delete('/api/files/:id', async (req, res) => {
  const removed = await removeRecord(req.params.id)
  if (!removed) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  await rm(path.join(FILES_DIR, removed.storedFilename), { force: true })
  // Removing a record whose background conversion is still writing chunk
  // files into this same directory (convertInBackground/
  // convertSegmentationInBackground) is a real race: fs.rm's recursive
  // delete lists a directory's contents, removes each entry, then rmdir's
  // it -- if a new chunk file lands in between, that last rmdir fails with
  // ENOTEMPTY. maxRetries/retryDelay make it re-list and retry instead of
  // failing outright, which is enough to ride out a conversion's last few
  // writes.
  const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const
  if (removed.kind === 'volume') {
    await rm(zarrPathFor(removed.id), rmOptions)
  } else {
    await rm(segZarrPathFor(removed.id), rmOptions)
  }
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT ?? 8787)
app.listen(PORT, () => {
  console.log(`Micro-CT visualizer backend listening on http://localhost:${PORT}`)
})
