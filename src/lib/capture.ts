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
  return recordStream(canvas.captureStream(fps))
}

/** Records a canvas stream; stopping ends its tracks too. `beforeStop`
 *  runs just before the recorder stops (e.g. to emit a last frame). */
function recordStream(stream: MediaStream, onStop?: () => void, beforeStop?: () => void): CanvasRecording {
  const mimeType = recordingMimeType()
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
          onStop?.()
          for (const track of stream.getTracks()) track.stop()
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' }))
        }
        if (beforeStop) {
          // Let the encoder take the last frame before stopping.
          beforeStop()
          setTimeout(() => recorder.stop(), 200)
        } else {
          recorder.stop()
        }
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

/** Draws a render (PNG blob) onto a canvas, adds `overlay` on top, and
 *  returns the result as a PNG. */
export async function composeSnapshot(render: Blob, overlay: (ctx: CanvasRenderingContext2D, width: number, height: number) => void): Promise<Blob> {
  const image = await createImageBitmap(render)
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return render
  ctx.drawImage(image, 0, 0)
  image.close()
  overlay(ctx, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? render), 'image/png'))
}

/**
 * Records a WebGL view with `overlay` drawn on every frame (e.g. a scale bar
 * that follows the zoom).
 *
 * A WebGL canvas's pixels can only be read in the task that drew them, so
 * `onFrame` must call back right after each render; the frame is copied then
 * into a staging canvas. The recorded canvas is redrawn from it, with the
 * overlay, once per animation frame, and each of those is explicitly
 * requested as a video frame: canvas streams otherwise only pick up draws the
 * page's paint loop notices, which misses views rendered from timers (vtk.js)
 * -- and this gives the video a steady frame rate while the view is still.
 * `requestRender` draws the first frame.
 */
export function startCompositeRecording(
  source: HTMLCanvasElement,
  onFrame: (draw: (canvas: HTMLCanvasElement) => void) => () => void,
  requestRender: () => void,
  overlay: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  /** Records only this part of the canvas (canvas pixels); the whole canvas
   *  when omitted. */
  crop?: { x: number; y: number; width: number; height: number } | null
): CanvasRecording {
  // Fixed for the whole recording (encoders don't take size changes); even
  // dimensions, which H.264 needs.
  const region = crop ?? { x: 0, y: 0, width: source.width, height: source.height }
  const width = Math.max(2, Math.round(region.width) & ~1)
  const height = Math.max(2, Math.round(region.height) & ~1)
  const fullWidth = source.width
  const fullHeight = source.height
  const makeCanvas = () => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D unavailable')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    return { canvas: c, ctx }
  }
  const staging = makeCanvas()
  staging.canvas.width = fullWidth
  staging.canvas.height = fullHeight
  const output = makeCanvas()
  const stream = output.canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
  const emit = () => {
    output.ctx.drawImage(staging.canvas, Math.round(region.x), Math.round(region.y), width, height, 0, 0, width, height)
    overlay(output.ctx, width, height)
    track.requestFrame?.()
  }
  let loop = 0
  let unsubscribe = () => {}
  const recording = recordStream(
    stream,
    () => {
      cancelAnimationFrame(loop)
      unsubscribe()
    },
    emit // the last frame, so even a view that never re-rendered records one
  )
  // Every rendered frame is emitted as it's drawn; the animation-frame loop
  // adds frames while the view is still (and keeps the overlay current).
  unsubscribe = onFrame((frame) => {
    staging.ctx.fillStyle = '#000'
    staging.ctx.fillRect(0, 0, fullWidth, fullHeight)
    staging.ctx.drawImage(frame, 0, 0, fullWidth, fullHeight)
    emit()
  })
  const tick = () => {
    loop = requestAnimationFrame(tick)
    emit()
  }
  tick()
  requestRender()
  return recording
}
