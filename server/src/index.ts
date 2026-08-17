import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { readNrrdHeader } from './nrrdHeader.js'
import { extractSegments, groupIntoSystems } from './segmentTree.js'
import { FILES_DIR, addRecord, getRecord, initStore, listRecords, newId, removeRecord } from './store.js'
import type { SegmentationRecord, VolumeRecord } from './types.js'

await initStore()

const app = express()
app.use(cors())

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

app.get('/api/library', (_req, res) => {
  res.json({ records: listRecords() })
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
    uploadedAt: new Date().toISOString()
  }
  await addRecord(record)
  res.json(record)
})

app.post('/api/segmentations', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) {
    res.status(400).json({ error: 'Missing file' })
    return
  }
  const filePath = path.join(FILES_DIR, file.filename)
  try {
    const header = await readNrrdHeader(filePath)
    const segments = extractSegments(header)
    if (segments.length === 0) {
      throw new Error(
        'No Slicer-style segment metadata (Segment0_Name, Segment0_LabelValue, ...) found in this NRRD header.'
      )
    }
    const systems = groupIntoSystems(segments)
    const dimension = Number(header.fields['dimension'] ?? '3')
    const layerCount = Math.max(1, ...segments.map((s) => s.layer + 1))

    const record: SegmentationRecord = {
      id: path.parse(file.filename).name,
      kind: 'segmentation',
      name: file.originalname,
      storedFilename: file.filename,
      sizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
      dimension,
      layerCount,
      systems
    }
    await addRecord(record)
    res.json(record)
  } catch (e) {
    await rm(filePath, { force: true })
    res.status(422).json({ error: e instanceof Error ? e.message : 'Failed to parse segmentation' })
  }
})

app.delete('/api/files/:id', async (req, res) => {
  const removed = await removeRecord(req.params.id)
  if (!removed) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  await rm(path.join(FILES_DIR, removed.storedFilename), { force: true })
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT ?? 8787)
app.listen(PORT, () => {
  console.log(`Micro-CT visualizer backend listening on http://localhost:${PORT}`)
})
