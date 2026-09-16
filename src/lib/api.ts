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
