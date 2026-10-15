import type { LibraryRecord, SegmentationRecord, VolumeRecord } from '../types'
import type { FocusList, VideoSequence } from './sequence'

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export async function fetchLibrary(): Promise<LibraryRecord[]> {
  const res = await fetch('/api/library')
  const data = await handleJson<{ records: LibraryRecord[] }>(res)
  return data.records
}

export type JobKind = 'convert' | 'backfill' | 'meshes'

export interface JobInfo {
  kind: JobKind
  recordId: string
  label: string
}

export type RunningJob = JobInfo & { startedAt: number; progress?: string }

/** The server's background-job queue (server/src/jobQueue.ts). */
export interface JobQueueState {
  /** The job running now, if any (at most one). */
  running: RunningJob[]
  /** In the order they will run. */
  queued: JobInfo[]
}

export async function fetchJobs(): Promise<JobQueueState> {
  const res = await fetch('/api/jobs')
  return handleJson<JobQueueState>(res)
}

export async function uploadVolume(file: File): Promise<VolumeRecord> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/volumes', { method: 'POST', body: form })
  return handleJson<VolumeRecord>(res)
}

export async function uploadSegmentation(file: File): Promise<SegmentationRecord> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/segmentations', { method: 'POST', body: form })
  return handleJson<SegmentationRecord>(res)
}

export async function deleteLibraryFile(id: string): Promise<void> {
  const res = await fetch(`/api/files/${id}`, { method: 'DELETE' })
  await handleJson(res)
}

export function fileUrl(id: string): string {
  return `/api/files/${id}`
}

/** Root of a volume's converted multiscale OME-Zarr store, for the
 *  itk-vtk-viewer engine -- only valid once the record's zarrStatus is 'ready'. */
export function zarrUrl(id: string): string {
  return `/api/zarr/${id}.ome.zarr`
}

/** Root of a segmentation's converted per-layer OME-Zarr label-map store --
 *  each layer is a full multiscale group at `${segZarrUrl(id)}/layer${n}`,
 *  only valid once the record's zarrStatus is 'ready'. */
export function segZarrUrl(id: string): string {
  return `/api/zarr/${id}.seg.ome.zarr`
}

/** Root of the server's single combined-segmentation ("cumulative 3D view")
 *  OME-Zarr label-map store -- see server/src/segmentationMergeConvert.ts.
 *  Only valid once requestSegmentationMerge's polled status is 'ready'; its
 *  contents change every time a new merge is requested, at this same fixed
 *  path (there's only ever one at a time -- see the server's own comment on
 *  mergeZarrPathFor for why). */
export function mergeZarrUrl(): string {
  return '/api/zarr/_merge.ome.zarr'
}

export interface MergedSegmentMapping {
  globalLabelValue: number
  /** Index into the `layers` array requestSegmentationMerge was called
   *  with, so the caller (which already knows what each index corresponds
   *  to) can map this back to a (segmentation, layer) pair. */
  layerIndex: number
  originalLabelValue: number
}

export interface MergeProgress {
  phase: 'scanning' | 'resampling' | 'writing'
  /** 1-based layer being processed, of layerCount. */
  layer: number
  layerCount: number
  /** 0..1 through the current layer. */
  fraction: number
}

export interface SegmentationMergeStatus {
  status: 'pending' | 'ready' | 'failed' | 'none'
  error?: string
  mapping?: MergedSegmentMapping[]
  progress?: MergeProgress
}

/** Kicks off (fire-and-forget on the server) combining every listed
 *  segmentation layer into one label image at mergeZarrUrl(), for the 3D
 *  pane's "cumulative" view -- poll fetchSegmentationMergeStatus() until
 *  its status is 'ready' or 'failed'. `labelValues` should be every label
 *  value present in that layer (not just currently-visible ones), so later
 *  visibility/opacity edits can be driven live via itk-vtk-viewer's own
 *  per-label weights instead of requiring a re-merge. */
export async function requestSegmentationMerge(
  volumeId: string,
  layers: Array<{ segmentationId: string; layer: number; labelValues: number[] }>
): Promise<SegmentationMergeStatus> {
  const res = await fetch('/api/segmentation-merges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volumeId, layers })
  })
  return handleJson<SegmentationMergeStatus>(res)
}

export async function fetchSegmentationMergeStatus(): Promise<SegmentationMergeStatus> {
  const res = await fetch('/api/segmentation-merges')
  return handleJson<SegmentationMergeStatus>(res)
}

export interface MeshManifestEntry {
  layer: number
  labelValue: number
  file: string
  vertexCount: number
  triangleCount: number
}

/** See server/src/surfaceMesh.ts. Positions are physical [x, y, z] mm. */
export interface MeshManifest {
  version: 1
  segments: MeshManifestEntry[]
  boundsMin: [number, number, number]
  boundsMax: [number, number, number]
}

export async function fetchMeshManifest(segmentationId: string): Promise<MeshManifest> {
  return handleJson<MeshManifest>(await fetch(`/api/meshes/${segmentationId}/manifest.json`))
}

export function meshFileUrl(segmentationId: string, file: string): string {
  return `/api/meshes/${segmentationId}/${file}`
}

export async function regenerateMeshes(segmentationId: string): Promise<void> {
  await handleJson(await fetch(`/api/segmentations/${segmentationId}/meshes`, { method: 'POST' }))
}

/** Per-segment statistics (server/src/segmentStats.ts), [z, y, x] order. */
export interface AxisHistogram {
  start: number
  counts: number[]
}

export interface LabelStats {
  voxels: number
  centroid: [number, number, number]
  histograms: { z: AxisHistogram; y: AxisHistogram; x: AxisHistogram }
}

export interface LayerStats {
  origin: [number, number, number]
  spacing: [number, number, number]
  size: [number, number, number]
  labels: Record<string, LabelStats>
}

const statsCache = new Map<string, Promise<LayerStats>>()

/** One segmentation layer's segment statistics (computed on the server the
 *  first time, cached here for the session). */
export function fetchLayerStats(segmentationId: string, layer: number): Promise<LayerStats> {
  const key = `${segmentationId}#${layer}`
  let pending = statsCache.get(key)
  if (!pending) {
    pending = fetch(`/api/segmentations/${segmentationId}/segment-stats/${layer}`).then((res) => handleJson<LayerStats>(res))
    pending.catch(() => statsCache.delete(key))
    statsCache.set(key, pending)
  }
  return pending
}

/** A volume's saved default crop box (server/src/cropDefaults.ts): world
 *  mm, the same shape as lib/cropBox.ts's CropBox. */
export interface CropDefault {
  center: [number, number, number]
  half: [number, number, number]
  axes: [[number, number, number], [number, number, number], [number, number, number]]
}

export async function fetchCropDefault(volumeId: string): Promise<CropDefault | null> {
  const data = await handleJson<{ crop: CropDefault | null }>(await fetch(`/api/volumes/${volumeId}/crop-default`))
  return data.crop
}

export async function saveCropDefault(volumeId: string, crop: CropDefault): Promise<void> {
  await handleJson(
    await fetch(`/api/volumes/${volumeId}/crop-default`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crop) })
  )
}

export async function clearCropDefault(volumeId: string): Promise<void> {
  await handleJson(await fetch(`/api/volumes/${volumeId}/crop-default`, { method: 'DELETE' }))
}

/** Whether this browser may change things (server/src/editors.ts). */
export async function fetchConfig(): Promise<{ editor: boolean }> {
  return handleJson<{ editor: boolean }>(await fetch('/api/config'))
}

/** A volume's default look (server/src/renderDefaults.ts). */
export interface RenderDefault {
  opacityPoints: Array<[number, number]>
  colorRange: [number, number] | null
  sampleDistance: number
  scattering: number
  labelBlend: number
  fade: { min: number; max: number; seconds: number }
}

export async function fetchRenderDefault(volumeId: string): Promise<RenderDefault | null> {
  const data = await handleJson<{ look: RenderDefault | null }>(await fetch(`/api/volumes/${volumeId}/render-default`))
  return data.look
}

export async function saveRenderDefault(volumeId: string, look: RenderDefault): Promise<void> {
  await handleJson(
    await fetch(`/api/volumes/${volumeId}/render-default`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(look) })
  )
}

export async function clearRenderDefault(volumeId: string): Promise<void> {
  await handleJson(await fetch(`/api/volumes/${volumeId}/render-default`, { method: 'DELETE' }))
}

// Named focus lists and video sequences (server/src/savedItems.ts): anyone
// can load them, editors save them.
export async function fetchFocusLists(): Promise<FocusList[]> {
  return (await handleJson<{ lists: FocusList[] }>(await fetch('/api/focus-lists'))).lists
}

export async function saveFocusList(list: FocusList): Promise<FocusList[]> {
  const res = await fetch(`/api/focus-lists/${list.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) })
  return (await handleJson<{ lists: FocusList[] }>(res)).lists
}

export async function deleteFocusList(id: string): Promise<FocusList[]> {
  return (await handleJson<{ lists: FocusList[] }>(await fetch(`/api/focus-lists/${id}`, { method: 'DELETE' }))).lists
}

export async function fetchSequences(): Promise<VideoSequence[]> {
  return (await handleJson<{ sequences: VideoSequence[] }>(await fetch('/api/sequences'))).sequences
}

export async function saveSequence(sequence: VideoSequence): Promise<VideoSequence[]> {
  const res = await fetch(`/api/sequences/${sequence.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sequence) })
  return (await handleJson<{ sequences: VideoSequence[] }>(res)).sequences
}

export async function deleteSequence(id: string): Promise<VideoSequence[]> {
  return (await handleJson<{ sequences: VideoSequence[] }>(await fetch(`/api/sequences/${id}`, { method: 'DELETE' }))).sequences
}
