/**
 * Snapshots and screen recordings of the 3D views. Recording uses the
 * canvas's own stream (canvas.captureStream + MediaRecorder), so it captures
 * the render at its full device-pixel resolution, without the page chrome.
 */

/** Best container/codec this browser can record, preferring MP4 (plays
 *  everywhere, including slides and phones) over WebM. */
function recordingMimeType(): string | undefined {
  const candidates = ['video/mp4;codecs=avc1.640033', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  return candidates.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t))
}

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && recordingMimeType() !== undefined
}

export interface CanvasRecording {
  /** Stops recording; resolves with the video. */
  stop: () => Promise<Blob>
  extension: 'mp4' | 'webm'
}

export function startCanvasRecording(canvas: HTMLCanvasElement, fps = 60): CanvasRecording {
  const mimeType = recordingMimeType()
  const stream = canvas.captureStream(fps)
  // A high bitrate: renders are full of fine detail that compression smears.
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 25_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.start(1000)
  return {
    extension: mimeType?.startsWith('video/mp4') ? 'mp4' : 'webm',
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          for (const track of stream.getTracks()) track.stop()
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' }))
        }
        recorder.stop()
      })
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'image/png'
  const bytes = atob(data)
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i)
  return new Blob([out], { type: mime })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** A filesystem-safe timestamped name, e.g. "voxel-render-2026-09-25-1432-07". */
export function captureFilename(prefix: string, extension: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  return `${prefix.replace(/[^\w.-]+/g, '-')}-${stamp}.${extension}`
}
