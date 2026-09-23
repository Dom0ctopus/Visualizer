import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { backfillOrthogonalCopies, storeNeedsOrthogonalBackfill } from './backfill.js'
import { enqueueJob, getJobQueueState, JobPreemptedError } from './jobQueue.js'
import {
  LUXAR_DIR,
  atlasKey,
  getLuxarStatus,
  initLuxarScenes,
  invalidateScenesFor,
  requestAtlas,
  requestMeshScene,
  sceneStatus,
  type AtlasQuality,
  type AtlasSegmentation,
  type LuxarSceneKind,
  type MeshSceneSegment
} from './luxarScenes.js'
import { readNrrdHeader } from './nrrdHeader.js'
import { convertSegmentationMergeToOmeZarr, MergeCancelledError, type MergedSegmentMapping, type MergeProgress } from './segmentationMergeConvert.js'
import { convertSegmentationNrrdToOmeZarr } from './segmentationZarrConvert.js'
import { extractSegments, groupIntoSystems } from './segmentTree.js'
import { generateSegmentationMeshes } from './surfaceMesh.js'
import { FILES_DIR, MESH_DIR, ZARR_DIR, addRecord, getRecord, initStore, listRecords, newId, removeRecord, updateRecord } from './store.js'
import type { LibraryRecord, SegmentationRecord, SegmentInfo, StoredRecord, StoredSegmentationRecord, VolumeRecord } from './types.js'
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
await initLuxarScenes()

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

function meshDirFor(id: string): string {
  return path.join(MESH_DIR, id)
}

// Conversions run through the serial job queue (jobQueue.ts) rather than
// all at once: each holds a whole pyramid level in memory. The upload
// itself still responds immediately; the record stays 'pending' until its
// job runs. A record deleted while its job is queued is skipped.
function jobLabel(action: string, id: string): string {
  return `${action} ${getRecord(id)?.name ?? id}`
}

function convertInBackground(id: string, nrrdPath: string): void {
  enqueueJob('convert', id, jobLabel('convert volume', id), async () => {
    if (!getRecord(id)) return
    try {
      await convertNrrdToOmeZarr(nrrdPath, zarrPathFor(id))
      await updateRecord(id, { zarrStatus: 'ready' })
    } catch (e) {
      // Only e.message is persisted to the record (surfaced in the UI); the
      // full error goes to the server console.
      console.error(`Volume conversion failed for ${id}:`, e)
      await updateRecord(id, { zarrStatus: 'failed', zarrError: e instanceof Error ? e.message : 'Conversion failed' })
    }
  })
}

function convertSegmentationInBackground(id: string, nrrdPath: string): void {
  enqueueJob('convert', id, jobLabel('convert segmentation', id), async () => {
    if (!getRecord(id)) return
    try {
      await convertSegmentationNrrdToOmeZarr(nrrdPath, segZarrPathFor(id))
      await updateRecord(id, { zarrStatus: 'ready' })
    } catch (e) {
      console.error(`Segmentation conversion failed for ${id}:`, e)
      await updateRecord(id, { zarrStatus: 'failed', zarrError: e instanceof Error ? e.message : 'Conversion failed' })
      return
    }
    generateMeshesInBackground(id)
  })
}

// Mesh jobs are the lowest priority and step aside (between slices) for
// any conversion uploaded meanwhile; see jobQueue.ts. `resume` picks up a
// run interrupted by a server restart.
function generateMeshesInBackground(id: string, resume = false): void {
  void updateRecord(id, { meshStatus: 'pending', meshError: undefined })
  enqueueJob('meshes', id, jobLabel('generate meshes for', id), async (ctx) => {
    if (!getRecord(id)) return
    try {
      const manifest = await generateSegmentationMeshes(segZarrPathFor(id), meshDirFor(id), {
        resume: resume || ctx.resumed,
        onProgress: (progress) => {
          ctx.setProgress(progress)
          ctx.checkpoint()
        }
      })
      const triangles = manifest.segments.reduce((n, s) => n + s.triangleCount, 0)
      console.log(`Meshes for ${id}: ${manifest.segments.length} segments, ${triangles.toLocaleString()} triangles`)
      await updateRecord(id, { meshStatus: 'ready' })
    } catch (e) {
      if (e instanceof JobPreemptedError) throw e
      console.error(`Mesh generation failed for ${id}:`, e)
      await updateRecord(id, { meshStatus: 'failed', meshError: e instanceof Error ? e.message : 'Mesh generation failed' })
    }
  })
}

// Stores converted before the coronal/sagittal-chunked copies existed (see
// orthogonalCopies.ts) get them added in the background, and segmentations
// that never had meshes get them generated. Existing uploads stay usable
// meanwhile: the 2D readers fall back to the axial-chunked arrays until a
// copy's .zarray appears.
async function scheduleStartupBackfill(): Promise<void> {
  // Conversions interrupted by a server restart would otherwise sit at
  // 'pending' forever.
  for (const record of listRecords().filter((r) => r.zarrStatus === 'pending')) {
    const nrrdPath = path.join(FILES_DIR, record.storedFilename)
    if (record.kind === 'volume') convertInBackground(record.id, nrrdPath)
    else convertSegmentationInBackground(record.id, nrrdPath)
  }
  const ready = listRecords().filter((r) => r.zarrStatus === 'ready')
  for (const record of ready) {
    const storePath = record.kind === 'volume' ? zarrPathFor(record.id) : segZarrPathFor(record.id)
    try {
      if (!(await storeNeedsOrthogonalBackfill(storePath, record.kind))) continue
    } catch (e) {
      console.warn(`Skipping orthogonal backfill check for ${record.id}:`, e instanceof Error ? e.message : e)
      continue
    }
    enqueueJob('backfill', record.id, jobLabel('backfill orthogonal copies for', record.id), async () => {
      if (!getRecord(record.id)) return
      await backfillOrthogonalCopies(storePath, record.kind)
    })
  }
  for (const record of ready) {
    if (record.kind === 'segmentation' && (record.meshStatus === undefined || record.meshStatus === 'pending')) {
      generateMeshesInBackground(record.id, true)
    }
  }
}

interface MergeState {
  status: 'pending' | 'ready' | 'failed'
  error?: string
  mapping?: MergedSegmentMapping[]
  /** While pending: what the merge is doing, and since when (epoch ms). */
  progress?: MergeProgress
  startedAt?: number
}

// In-memory only, not persisted to store.ts's index.json -- a merge is
// fully derived from already-persisted volume/segmentation records, so
// there's nothing here worth surviving a server restart; the client just
// re-requests one if it needs it again. Single slot, matching
// mergeZarrPathFor's single fixed output path.
let currentMerge: MergeState | null = null

// Every merge request bumps this; a background conversion only commits its
// result if it's still the latest one when it finishes. The client
// (useSegmentationMerge3D.ts) fires a brand new merge automatically every
// time the set of loaded segmentations changes -- load one segmentation
// while a previous merge is still converting (a real, potentially slow
// operation) and, without this guard, whichever one happened to finish
// LAST would silently win, regardless of which was actually requested
// last: an older, smaller merge finishing after a newer, more complete one
// would clobber it, showing only some of what's actually loaded with no
// error at all -- confirmed as the actual cause of a "both say loaded but
// only one renders" report.
let mergeGeneration = 0

// Runs a cumulative-3D-view merge (segmentationMergeConvert.ts) in the
// background, same fire-and-forget pattern as convertInBackground/
// convertSegmentationInBackground above. Writes to its own generation-
// specific temp path and only swaps it into the canonical location (an
// atomic rename, so a client mid-read of the old content never sees a
// half-written new one) if it's still the latest request by the time it
// finishes -- a superseded generation's output is discarded instead of
// ever touching the canonical path or `currentMerge` at all.
function convertMergeInBackground(generation: number, volumeId: string, layers: Array<{ segmentationId: string; layer: number; labelValues: number[] }>): void {
  const tempPath = path.join(ZARR_DIR, `_merge.tmp-${generation}.ome.zarr`)
  const startedAt = Date.now()
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  const isCurrent = () => generation === mergeGeneration
  let lastLogged = ''
  console.log(`[merge ${generation}] start: ${layers.length} layer(s)`)
  void (async () => {
    try {
      const layerInputs = layers.map((l) => ({
        segZarrGroupPath: path.join(segZarrPathFor(l.segmentationId), `layer${l.layer}`),
        labelValues: l.labelValues
      }))
      const { mapping } = await convertSegmentationMergeToOmeZarr(zarrPathFor(volumeId), layerInputs, tempPath, {
        // A newer request supersedes this one: stop instead of finishing
        // work that would only be discarded (each merge streams every
        // layer at native resolution, twice).
        isCancelled: () => !isCurrent(),
        onProgress: (progress) => {
          if (isCurrent()) currentMerge = { status: 'pending', progress, startedAt }
          // Log each phase/layer transition once, not every band.
          const key = `${progress.phase} ${progress.layer}/${progress.layerCount}`
          if (key !== lastLogged) {
            lastLogged = key
            console.log(`[merge ${generation}] ${progress.phase === 'writing' ? 'writing output' : `${progress.phase} layer ${key.split(' ')[1]}`} (${elapsed()})`)
          }
        }
      })
      if (!isCurrent()) {
        await rm(tempPath, { recursive: true, force: true })
        console.log(`[merge ${generation}] superseded after finishing; discarded (${elapsed()})`)
        return
      }
      await rm(mergeZarrPathFor(), { recursive: true, force: true })
      await rename(tempPath, mergeZarrPathFor())
      currentMerge = { status: 'ready', mapping }
      console.log(`[merge ${generation}] done (${elapsed()})`)
    } catch (e) {
      await rm(tempPath, { recursive: true, force: true }).catch(() => {})
      if (e instanceof MergeCancelledError) {
        console.log(`[merge ${generation}] stopped: superseded by a newer request (${elapsed()})`)
        return
      }
      if (!isCurrent()) return
      console.error(`[merge ${generation}] failed (${elapsed()}):`, e)
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
app.use('/api/meshes', express.static(MESH_DIR))

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
  const generation = ++mergeGeneration
  currentMerge = { status: 'pending', startedAt: Date.now() }
  res.json(currentMerge)
  convertMergeInBackground(generation, volumeId, validLayers)
})

app.get('/api/jobs', (_req, res) => {
  res.json(getJobQueueState())
})

app.post('/api/segmentations/:id/meshes', async (req, res) => {
  const record = getRecord(req.params.id)
  if (!record || record.kind !== 'segmentation' || record.zarrStatus !== 'ready') {
    res.status(404).json({ error: 'No converted segmentation with that id' })
    return
  }
  if (record.meshStatus === 'pending') {
    res.json({ meshStatus: 'pending' })
    return
  }
  await invalidateScenesFor(record.id, 'meshes')
  generateMeshesInBackground(record.id)
  res.json({ meshStatus: 'pending' })
})

// ---------------------------------------------------------------------------
// Luxar scenes (luxarScenes.ts): streamed surface meshes and the splat atlas.
// ---------------------------------------------------------------------------

app.use('/api/luxar/files', express.static(LUXAR_DIR))

app.get('/api/luxar', async (_req, res) => {
  res.json(await getLuxarStatus())
})

app.get('/api/luxar/scenes/:key', (req, res) => {
  const kind: LuxarSceneKind = req.params.key.startsWith('atlas-') ? 'atlas' : 'meshes'
  res.json(sceneStatus(req.params.key, kind))
})

interface ReadySegmentation {
  record: SegmentationRecord
  /** Flattened with each segment's system name. */
  segments: Array<SegmentInfo & { system: string }>
}

/** Looks up and enriches the given segmentation records, or returns an error
 *  message if any is missing or unconverted. */
async function readySegmentations(ids: unknown): Promise<ReadySegmentation[] | string> {
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) return 'segmentationIds must be a non-empty array of ids'
  const out: ReadySegmentation[] = []
  for (const id of ids as string[]) {
    const stored = getRecord(id)
    if (!stored || stored.kind !== 'segmentation') return `No segmentation with id ${id}`
    if (stored.zarrStatus !== 'ready') return `${stored.name} hasn't finished converting`
    const record = await enrichSegmentationRecord(stored)
    out.push({ record, segments: record.systems.flatMap((sys) => sys.segments.map((seg) => ({ ...seg, system: sys.name }))) })
  }
  return out
}

function segmentDisplayName(seg: { name: string; system: string }): string {
  return seg.system === 'Ungrouped' ? seg.name : `${seg.system} · ${seg.name}`
}

function rgb01(color: [number, number, number]): [number, number, number] {
  return [color[0] / 255, color[1] / 255, color[2] / 255]
}

function setTitle(segs: ReadySegmentation[]): string {
  return segs.map((s) => s.record.name).join(', ')
}

app.post('/api/luxar/meshes', express.json(), async (req, res) => {
  const segs = await readySegmentations(req.body?.segmentationIds)
  if (typeof segs === 'string') {
    res.status(400).json({ error: segs })
    return
  }
  const notReady = segs.find((s) => s.record.meshStatus !== 'ready')
  if (notReady) {
    res.status(409).json({ error: `Surface meshes for ${notReady.record.name} aren't ready yet` })
    return
  }
  const segments: MeshSceneSegment[] = []
  const usedNames = new Set<string>()
  for (const { record, segments: infos } of segs) {
    const manifest = JSON.parse(await readFile(path.join(meshDirFor(record.id), 'manifest.json'), 'utf8')) as {
      segments: Array<{ layer: number; labelValue: number; file: string }>
    }
    for (const entry of manifest.segments) {
      const info = infos.find((i) => i.layer === entry.layer && i.labelValue === entry.labelValue)
      const name = info ? segmentDisplayName(info) : `Layer ${entry.layer} label ${entry.labelValue}`
      // Layer names are node names in the archive: unique, and no '/'.
      let layerName = name.replaceAll('/', '-')
      if (usedNames.has(layerName)) layerName = `${layerName} (${record.name.replaceAll('/', '-')})`
      for (let n = 2; usedNames.has(layerName); n++) layerName = `${name.replaceAll('/', '-')} (${n})`
      usedNames.add(layerName)
      segments.push({
        file: path.join(meshDirFor(record.id), entry.file),
        name,
        layerName,
        recordId: record.id,
        segmentKey: `${entry.layer}:${entry.labelValue}`,
        color: info ? rgb01(info.color) : [0.8, 0.8, 0.8]
      })
    }
  }
  res.json(requestMeshScene({ segmentationIds: segs.map((s) => s.record.id), segments, title: setTitle(segs), rebuild: req.body?.rebuild === true }))
})

const ATLAS_QUALITIES: AtlasQuality[] = ['draft', 'standard', 'high']

app.post('/api/luxar/atlas', express.json(), async (req, res) => {
  const volumeId = req.body?.volumeId
  const volume = typeof volumeId === 'string' ? getRecord(volumeId) : undefined
  if (!volume || volume.kind !== 'volume' || volume.zarrStatus !== 'ready') {
    res.status(400).json({ error: 'volumeId must name a converted volume' })
    return
  }
  const quality = req.body?.quality as AtlasQuality
  if (!ATLAS_QUALITIES.includes(quality)) {
    res.status(400).json({ error: `quality must be one of ${ATLAS_QUALITIES.join(', ')}` })
    return
  }
  const segs = await readySegmentations(req.body?.segmentationIds)
  if (typeof segs === 'string') {
    res.status(400).json({ error: segs })
    return
  }
  const segmentations: AtlasSegmentation[] = segs.map(({ record, segments }) => {
    const layers = new Map<number, AtlasSegmentation['layers'][number]>()
    for (const seg of segments) {
      const layer = layers.get(seg.layer) ?? { layer: seg.layer, segments: [] }
      layer.segments.push({ labelValue: seg.labelValue, name: segmentDisplayName(seg), system: seg.system === 'Ungrouped' ? record.name : seg.system, color: rgb01(seg.color) })
      layers.set(seg.layer, layer)
    }
    return { name: record.name, store: segZarrPathFor(record.id), layers: [...layers.values()] }
  })
  const status = requestAtlas({
    volumeId: volume.id,
    volumeStore: zarrPathFor(volume.id),
    segmentationIds: segs.map((s) => s.record.id),
    segmentations,
    quality,
    title: `${volume.name} + ${setTitle(segs)}`,
    build: req.body?.build === true,
    rebuild: req.body?.rebuild === true
  })
  res.json({ ...status, key: atlasKey(volume.id, segs.map((s) => s.record.id), quality) })
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
  await invalidateScenesFor(removed.id)
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
    await rm(meshDirFor(removed.id), rmOptions)
  }
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT ?? 8787)
app.listen(PORT, () => {
  console.log(`Micro-CT visualizer backend listening on http://localhost:${PORT}`)
  void scheduleStartupBackfill()
})
