import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { enqueueJob, dequeueJob, getJobQueueState } from './jobQueue.js'
import { DATA_DIR, writeFileAtomic } from './store.js'

/**
 * Luxar (https://github.com/royerlab/luxar) scenes for the 3D tabs: a
 * streamed, LOD'd version of the surface meshes, and a Gaussian-splat
 * "atlas" of the CT colored by segment. Both are compiled by
 * server/luxar/build_scene.py in a separate Python environment
 * (`npm run setup:luxar`), run as jobs on the job queue's own 'luxar' lane,
 * and served as static .luxar.zarr archives the browser viewer streams.
 *
 * Scenes are cached on disk by a key hashed from their inputs, each in
 * LUXAR_DIR/<key>/ with a status.json (so a scene survives restarts) and the
 * build's log. Luxar is optional: without its environment the app keeps its
 * three.js mesh viewer and the atlas tab explains how to install it.
 */

export const LUXAR_DIR = path.join(DATA_DIR, 'luxar')
const SCRIPT = path.resolve(import.meta.dirname, '..', 'luxar', 'build_scene.py')
// Identifies the builder that made a scene, so a scene that failed under an
// older builder is retried automatically once the builder changes (e.g. a
// fix for the failure), instead of showing the stale error until Retry.
const BUILDER_VERSION = createHash('sha1').update(readFileSync(SCRIPT)).digest('hex').slice(0, 12)
/** Per-segmentation cache of simplified mesh levels (build_scene.py), so a
 *  rebuild with other colors skips the slow decimation. */
export function ladderDirFor(recordId: string): string {
  return path.join(LUXAR_DIR, 'ladders', recordId)
}
/** Cached atlas fits, keyed by what the fit depends on (not colors), so
 *  recoloring an atlas skips the fitting. Each has an inputs.json listing
 *  its record ids, for invalidation. */
const FITS_DIR = path.join(LUXAR_DIR, 'atlas-fits')
function fitDirFor(fitKey: string): string {
  return path.join(FITS_DIR, fitKey)
}
const VENV_DIR = path.resolve(import.meta.dirname, '..', '.luxar-venv')
const SCENE_DIRNAME = 'scene.luxar.zarr'
export const LUXAR_SETUP_COMMAND = 'npm run setup:luxar'

export type LuxarSceneKind = 'meshes' | 'atlas'
export type AtlasQuality = 'draft' | 'standard' | 'high'

/** Fitting budgets per quality. The fit is the slow part and scales with
 *  grid size x splats x iterations: 'draft' is sized to finish in minutes on
 *  a CPU (and is the CPU default); 'standard' and 'high' are meant for a
 *  CUDA or Apple-silicon GPU ('high' matches Luxar's own CT atlas demo).
 *  `residualMinIters` is the floor for passes after the first, which Luxar
 *  otherwise sets at 500. */
const ATLAS_QUALITY: Record<AtlasQuality, { maxDim: number; maxSplats: number; splatsPerPass: number; itersPerPass: number; residualMinIters: number }> = {
  draft: { maxDim: 128, maxSplats: 30_000, splatsPerPass: 10_000, itersPerPass: 200, residualMinIters: 200 },
  standard: { maxDim: 256, maxSplats: 400_000, splatsPerPass: 100_000, itersPerPass: 1000, residualMinIters: 500 },
  high: { maxDim: 512, maxSplats: 2_500_000, splatsPerPass: 400_000, itersPerPass: 4000, residualMinIters: 500 }
}

export interface LuxarStatus {
  available: boolean
  version?: string
  /** Whether the splat-fitting extra (torch) is installed. */
  gsplats: boolean
  /** torch's device for fitting: 'cuda', 'mps' or 'cpu'. */
  device?: string
  reason?: string
  setupCommand: string
}

export interface SceneStatus {
  key: string
  kind: LuxarSceneKind
  status: 'none' | 'pending' | 'ready' | 'failed'
  error?: string
  /** URL of the .luxar.zarr archive, once ready. */
  url?: string
  progress?: string
  startedAt?: number
  builtAt?: string
  quality?: AtlasQuality
  layers?: SceneLayer[]
}

interface StoredSceneStatus {
  kind: LuxarSceneKind
  status: 'pending' | 'ready' | 'failed'
  error?: string
  builtAt?: string
  quality?: AtlasQuality
  /** Every library record the scene was built from, for invalidation. */
  inputIds: string[]
  /** Mesh scenes: which segment each Luxar layer shows. */
  layers?: SceneLayer[]
  builderVersion?: string
}

/** Ties a Luxar layer (by name) to the app's segment, so the segment tree
 *  can drive the layer's visibility and opacity. */
export interface SceneLayer {
  name: string
  recordId: string
  /** SegmentState.key: `${layer}:${labelValue}`. */
  segmentKey: string
}

export interface MeshSceneSegment {
  /** A server/src/surfaceMesh.ts .bin file. */
  file: string
  /** Where build_scene.py caches this segment's simplified levels. */
  ladderDir: string
  name: string
  layerName: string
  recordId: string
  segmentKey: string
  /** RGB in [0, 1]. */
  color: [number, number, number]
}

export interface AtlasSegmentation {
  name: string
  /** The segmentation's OME-Zarr store (one multiscale group per layer). */
  store: string
  layers: Array<{ layer: number; segments: Array<{ labelValue: number; name: string; system: string; color: [number, number, number] }> }>
}

export function luxarPython(): string {
  if (process.env.LUXAR_PYTHON) return process.env.LUXAR_PYTHON
  return process.platform === 'win32' ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python')
}

// ---------------------------------------------------------------------------
// Environment check
// ---------------------------------------------------------------------------

const CHECK_SCRIPT = `
import json
out = {}
import luxar
out["version"] = getattr(luxar, "__version__", "unknown")
try:
    import torch
    out["gsplats"] = True
    out["device"] = "cuda" if torch.cuda.is_available() else ("mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
except Exception:
    out["gsplats"] = False
print(json.dumps(out))
`

let statusCache: { at: number; status: LuxarStatus } | null = null
// A missing install is re-checked every so often, so running the setup
// command takes effect without restarting the server.
const UNAVAILABLE_RECHECK_MS = 15_000

export async function getLuxarStatus(): Promise<LuxarStatus> {
  if (statusCache && (statusCache.status.available || Date.now() - statusCache.at < UNAVAILABLE_RECHECK_MS)) return statusCache.status
  const python = luxarPython()
  let status: LuxarStatus
  if (!process.env.LUXAR_PYTHON && !existsSync(python)) {
    status = { available: false, gsplats: false, reason: `Luxar's Python environment isn't set up (expected ${python}).`, setupCommand: LUXAR_SETUP_COMMAND }
  } else {
    const result = await runCapture(python, ['-c', CHECK_SCRIPT])
    if (result.code === 0) {
      const info = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as { version: string; gsplats: boolean; device?: string }
      status = { available: true, version: info.version, gsplats: info.gsplats, device: info.device, setupCommand: LUXAR_SETUP_COMMAND }
    } else {
      status = { available: false, gsplats: false, reason: `Couldn't import luxar with ${python}: ${lastLines(result.stderr, 2)}`, setupCommand: LUXAR_SETUP_COMMAND }
    }
  }
  statusCache = { at: Date.now(), status }
  return status
}

function runCapture(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join(' ').trim()
}

// ---------------------------------------------------------------------------
// Scene cache
// ---------------------------------------------------------------------------

function sceneDir(key: string): string {
  return path.join(LUXAR_DIR, key)
}

export function sceneKey(kind: LuxarSceneKind, parts: string[]): string {
  return `${kind}-${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)}`
}

const statuses = new Map<string, StoredSceneStatus>()
const children = new Map<string, ChildProcess>()

async function persistStatus(key: string, status: StoredSceneStatus): Promise<void> {
  statuses.set(key, status)
  await mkdir(sceneDir(key), { recursive: true })
  await writeFileAtomic(path.join(sceneDir(key), 'status.json'), JSON.stringify(status, null, 2))
}

/** Loads cached scene statuses; builds a restart interrupted are marked failed. */
export async function initLuxarScenes(): Promise<void> {
  await mkdir(LUXAR_DIR, { recursive: true })
  for (const key of await readdir(LUXAR_DIR)) {
    try {
      const status = JSON.parse(await readFile(path.join(sceneDir(key), 'status.json'), 'utf8')) as StoredSceneStatus
      if (status.status === 'pending') {
        status.status = 'failed'
        status.error = 'Interrupted by a server restart; rebuild to try again.'
        await persistStatus(key, status)
      } else {
        statuses.set(key, status)
      }
    } catch {
      // Not a scene directory (or a half-created one): ignore.
    }
  }
}

export function sceneStatus(key: string, kind: LuxarSceneKind): SceneStatus {
  const stored = statuses.get(key)
  if (!stored) return { key, kind, status: 'none' }
  const out: SceneStatus = { key, kind, status: stored.status, error: stored.error, builtAt: stored.builtAt, quality: stored.quality, layers: stored.layers }
  if (stored.status === 'ready') out.url = `/api/luxar/files/${key}/${SCENE_DIRNAME}`
  if (stored.status === 'pending') {
    const running = getJobQueueState().running.find((j) => j.kind === 'luxar' && j.recordId === key)
    if (running) {
      out.progress = running.progress
      out.startedAt = running.startedAt
    } else {
      out.progress = 'queued'
    }
  }
  return out
}

/** Removes every scene (of `kind`, if given) built from this library record
 *  -- on delete, or when its meshes are regenerated -- stopping its build if
 *  one is running. */
/** A failed build from an older builder: worth retrying without being asked. */
function staleFailure(status: StoredSceneStatus | undefined): boolean {
  return status?.status === 'failed' && status.builderVersion !== BUILDER_VERSION
}

export async function invalidateScenesFor(recordId: string, kind?: LuxarSceneKind): Promise<void> {
  if (!kind || kind === 'meshes') await rm(ladderDirFor(recordId), { recursive: true, force: true })
  if (!kind || kind === 'atlas') {
    for (const fitKey of await readdir(FITS_DIR).catch(() => [] as string[])) {
      const inputs = await readFile(path.join(fitDirFor(fitKey), 'inputs.json'), 'utf8')
        .then((t) => JSON.parse(t) as string[])
        .catch(() => null)
      if (!inputs || inputs.includes(recordId)) await rm(fitDirFor(fitKey), { recursive: true, force: true })
    }
  }
  for (const [key, status] of statuses) {
    if (!status.inputIds.includes(recordId) || (kind && status.kind !== kind)) continue
    statuses.delete(key)
    dequeueJob('luxar', key)
    children.get(key)?.kill()
    await rm(sceneDir(key), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

function startBuild(key: string, kind: LuxarSceneKind, label: string, spec: object, inputIds: string[], quality?: AtlasQuality, layers?: SceneLayer[]): void {
  const builderVersion = BUILDER_VERSION
  void persistStatus(key, { kind, status: 'pending', inputIds, quality, layers, builderVersion })
  enqueueJob('luxar', key, label, async (ctx) => {
    if (!statuses.has(key)) return // invalidated while queued
    const dir = sceneDir(key)
    const specPath = path.join(dir, 'spec.json')
    const logPath = path.join(dir, 'build.log')
    await writeFile(specPath, JSON.stringify({ ...spec, output: path.join(dir, SCENE_DIRNAME) }, null, 2))
    const t0 = Date.now()
    try {
      await runBuilder(key, kind, specPath, logPath, (p) => ctx.setProgress(p))
      if (!statuses.has(key)) return
      await persistStatus(key, { kind, status: 'ready', inputIds, quality, layers, builderVersion, builtAt: new Date().toISOString() })
      console.log(`[luxar] ${label}: built in ${Math.round((Date.now() - t0) / 1000)}s`)
    } catch (e) {
      if (!statuses.has(key)) return
      const error = e instanceof Error ? e.message : String(e)
      console.error(`[luxar] ${label} failed: ${error} (full log: ${logPath})`)
      await persistStatus(key, { kind, status: 'failed', inputIds, quality, layers, builderVersion, error })
    }
  })
}

function runBuilder(key: string, kind: LuxarSceneKind, specPath: string, logPath: string, onProgress: (p: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(luxarPython(), [SCRIPT, kind, specPath], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } })
    children.set(key, child)
    const log: string[] = []
    let stderrTail = ''
    let pending = ''
    child.stdout.on('data', (d: Buffer) => {
      pending += d.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('PROGRESS ')) onProgress(line.slice('PROGRESS '.length))
        log.push(line)
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      log.push(text)
      stderrTail = (stderrTail + text).slice(-4000)
    })
    const finish = async (error: Error | null) => {
      children.delete(key)
      await writeFile(logPath, log.join('\n')).catch(() => {})
      if (error) reject(error)
      else resolve()
    }
    child.on('error', (e) => void finish(e))
    child.on('close', (code, signal) => {
      if (code === 0) void finish(null)
      else if (signal) void finish(new Error(`Build stopped (${signal})`))
      else void finish(new Error(lastErrorLine(stderrTail) || `Builder exited with status ${code}`))
    })
  })
}

// The most useful line of a Python failure is its last "SomethingError: ..."
// (or SystemExit message), not the traceback frames above it or the hint
// lines Luxar prints after it. Terminal color codes are stripped.
function lastErrorLine(stderr: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = stderr.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /\b[A-Za-z_.]*(?:Error|Exception): .*/.exec(lines[i])
    if (match) return match[0]
  }
  return lines[lines.length - 1] ?? ''
}

export interface MeshSceneRequest {
  segmentationIds: string[]
  /** Set when segment colors differ from the files' (e.g. a color scheme):
   *  identifies them, so each coloring is its own cached scene. */
  colorsKey?: string
  /** Per segmentation, in request order. */
  segments: MeshSceneSegment[]
  title: string
  rebuild?: boolean
}

/** Drops queued (not yet started) builds of `kind` other than `keepKey`:
 *  only one scene per kind is on screen, so a queued build for a set the
 *  user has since changed is wasted work. It's rebuilt if asked for again. */
function dropStaleQueuedBuilds(kind: LuxarSceneKind, keepKey: string): void {
  for (const [key, status] of statuses) {
    if (key === keepKey || status.kind !== kind || status.status !== 'pending') continue
    if (dequeueJob('luxar', key)) {
      statuses.delete(key)
      void rm(sceneDir(key), { recursive: true, force: true })
    }
  }
}

export function requestMeshScene(req: MeshSceneRequest): SceneStatus {
  const ids = [...req.segmentationIds].sort()
  const key = sceneKey('meshes', req.colorsKey ? [...ids, `colors:${req.colorsKey}`] : ids)
  dropStaleQueuedBuilds('meshes', key)
  const existing = statuses.get(key)
  if (existing && (!req.rebuild || existing.status === 'pending') && !staleFailure(existing)) return sceneStatus(key, 'meshes')
  const layers = req.segments.map((s) => ({ name: s.layerName, recordId: s.recordId, segmentKey: s.segmentKey }))
  startBuild(key, 'meshes', `build Luxar meshes for ${req.title}`, { title: req.title, segments: req.segments }, ids, undefined, layers)
  return sceneStatus(key, 'meshes')
}

export interface AtlasRequest {
  volumeId: string
  volumeStore: string
  segmentationIds: string[]
  segmentations: AtlasSegmentation[]
  quality: AtlasQuality
  /** As in MeshSceneRequest: identifies colors that differ from the files'. */
  colorsKey?: string
  title: string
  /** Start a build if none exists (otherwise only report status). */
  build: boolean
  rebuild?: boolean
}

export function atlasKey(volumeId: string, segmentationIds: string[], quality: AtlasQuality, colorsKey?: string): string {
  const inputs = [volumeId, ...[...segmentationIds].sort(), quality]
  return sceneKey('atlas', colorsKey ? [...inputs, `colors:${colorsKey}`] : inputs)
}

export function requestAtlas(req: AtlasRequest): SceneStatus {
  const key = atlasKey(req.volumeId, req.segmentationIds, req.quality, req.colorsKey)
  if (req.build) dropStaleQueuedBuilds('atlas', key)
  const existing = statuses.get(key)
  // The fit is shared by every coloring of the same inputs, so once one
  // coloring is built, another (e.g. switching color scheme) builds without
  // being asked: it only recolors. An explicit rebuild refits.
  const fitDir = fitDirFor(atlasKey(req.volumeId, req.segmentationIds, req.quality))
  const fitCache = path.join(fitDir, 'fit.npz')
  const recolorOnly = !existing && existsSync(fitCache)
  const wantsBuild = (req.build && (!existing || (req.rebuild && existing.status !== 'pending'))) || recolorOnly || staleFailure(existing)
  if (!wantsBuild) return sceneStatus(key, 'atlas')
  if (recolorOnly) dropStaleQueuedBuilds('atlas', key)
  const inputIds = [req.volumeId, ...req.segmentationIds]
  if (req.rebuild) rmSync(fitCache, { force: true })
  mkdirSync(fitDir, { recursive: true })
  writeFileSync(path.join(fitDir, 'inputs.json'), JSON.stringify(inputIds))
  startBuild(
    key,
    'atlas',
    `build Luxar splat atlas (${req.quality}) for ${req.title}`,
    { title: req.title, volume: { store: req.volumeStore }, segmentations: req.segmentations, quality: ATLAS_QUALITY[req.quality], context: true, fitCache },
    [req.volumeId, ...req.segmentationIds],
    req.quality
  )
  return sceneStatus(key, 'atlas')
}
