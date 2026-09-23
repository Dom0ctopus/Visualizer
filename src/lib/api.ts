import type { LibraryRecord, SegmentationRecord, VolumeRecord } from '../types'

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

/** The server's serial background-job queue (server/src/jobQueue.ts). */
export interface JobQueueState {
  running: (JobInfo & { startedAt: number; progress?: string }) | null
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
