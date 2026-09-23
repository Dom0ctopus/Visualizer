/**
 * Runs heavy background jobs (NRRD -> OME-Zarr conversion, orthogonal-copy
 * backfill, mesh generation) one at a time. Each of these can hold a whole
 * pyramid level in memory, so running several at once -- e.g. uploading a
 * volume and a few segmentations back to back -- risks exhausting the Node
 * heap. Jobs are responsible for their own error handling/status updates;
 * a failing job never blocks the ones queued after it.
 *
 * Jobs run in priority order (conversions first: an upload is unusable until
 * converted, while backfill and meshes only add to something already
 * usable), FIFO within a priority. A long low-priority job can also step
 * aside mid-run: it calls ctx.checkpoint() periodically, which throws
 * JobPreemptedError when a higher-priority job is waiting; the job is then
 * re-queued (its run() is called again, with ctx.resumed set) behind it.
 */

export type JobKind = 'convert' | 'backfill' | 'meshes' | 'luxar'

const PRIORITY: Record<JobKind, number> = { convert: 0, backfill: 1, meshes: 2, luxar: 0 }

// Luxar scene builds run in a separate Python process (luxarScenes.ts), so
// they don't compete for this process's heap: they get their own lane,
// serial within itself but concurrent with the main one. That keeps an
// hour-long splat fit from holding up an upload's conversion.
type Lane = 'main' | 'luxar'
const LANE: Record<JobKind, Lane> = { convert: 'main', backfill: 'main', meshes: 'main', luxar: 'luxar' }
const HEARTBEAT_MS = 30_000

export class JobPreemptedError extends Error {
  constructor() {
    super('Job preempted by a higher-priority job')
    this.name = 'JobPreemptedError'
  }
}

export interface JobContext {
  /** Short description of where the job is, for the UI and heartbeat logs. */
  setProgress(progress: string): void
  /** Throws JobPreemptedError if a higher-priority job is waiting. */
  checkpoint(): void
  /** True when this run continues a job that was preempted earlier. */
  resumed: boolean
}

interface Job {
  kind: JobKind
  recordId: string
  label: string
  run: (ctx: JobContext) => Promise<void>
  resumed: boolean
  enqueuedAt: number
}

export interface JobInfo {
  kind: JobKind
  recordId: string
  label: string
}

export interface RunningJobInfo extends JobInfo {
  startedAt: number
  progress?: string
}

export interface JobQueueState {
  /** At most one per lane. */
  running: RunningJobInfo[]
  queued: JobInfo[]
}

const queues: Record<Lane, Job[]> = { main: [], luxar: [] }
const runningJobs: Record<Lane, (RunningJobInfo & { job: Job }) | null> = { main: null, luxar: null }

function elapsed(since: number): string {
  const s = Math.round((Date.now() - since) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function takeNext(queue: Job[]): Job | undefined {
  let best = -1
  for (let i = 0; i < queue.length; i++) {
    if (best < 0 || PRIORITY[queue[i].kind] < PRIORITY[queue[best].kind]) best = i
  }
  return best < 0 ? undefined : queue.splice(best, 1)[0]
}

async function drain(lane: Lane): Promise<void> {
  if (runningJobs[lane]) return
  const queue = queues[lane]
  for (let job = takeNext(queue); job; job = takeNext(queue)) {
    const current: RunningJobInfo & { job: Job } = { kind: job.kind, recordId: job.recordId, label: job.label, startedAt: Date.now(), job }
    runningJobs[lane] = current
    const waited = Date.now() - job.enqueuedAt > 1000 ? `, waited ${elapsed(job.enqueuedAt)}` : ''
    console.log(`[jobs] ${job.resumed ? 'resume' : 'start'}: ${job.label} (${queue.length} queued behind it${waited})`)
    const heartbeat = setInterval(() => {
      const behind = queue.length ? `; ${queue.length} queued: ${queue.map((j) => j.label).join(', ')}` : ''
      console.log(`[jobs] still running: ${job.label} (${elapsed(current.startedAt)}${current.progress ? `, ${current.progress}` : ''})${behind}`)
    }, HEARTBEAT_MS)
    const ctx: JobContext = {
      resumed: job.resumed,
      setProgress: (p) => {
        current.progress = p
      },
      checkpoint: () => {
        if (queue.some((q) => PRIORITY[q.kind] < PRIORITY[job.kind])) throw new JobPreemptedError()
      }
    }
    try {
      await job.run(ctx)
      console.log(`[jobs] done: ${job.label} in ${elapsed(current.startedAt)}`)
    } catch (e) {
      if (e instanceof JobPreemptedError) {
        console.log(`[jobs] paused: ${job.label} after ${elapsed(current.startedAt)}, to run higher-priority jobs first; it will resume after them`)
        queue.push({ ...job, resumed: true })
      } else {
        console.error(`[jobs] failed: ${job.label}:`, e)
      }
    } finally {
      clearInterval(heartbeat)
      runningJobs[lane] = null
    }
  }
}

export function enqueueJob(kind: JobKind, recordId: string, label: string, run: (ctx: JobContext) => Promise<void>): void {
  const lane = LANE[kind]
  queues[lane].push({ kind, recordId, label, run, resumed: false, enqueuedAt: Date.now() })
  const running = runningJobs[lane]
  if (running) console.log(`[jobs] queued: ${label} (running: ${running.label})`)
  void drain(lane)
}

/** Whether a job for this record and kind is queued or running. */
export function hasJob(kind: JobKind, recordId: string): boolean {
  const lane = LANE[kind]
  const running = runningJobs[lane]
  return (running?.kind === kind && running.recordId === recordId) || queues[lane].some((j) => j.kind === kind && j.recordId === recordId)
}

/** Drops a queued (not yet running) job; returns whether one was removed. */
export function dequeueJob(kind: JobKind, recordId: string): boolean {
  const queue = queues[LANE[kind]]
  const index = queue.findIndex((j) => j.kind === kind && j.recordId === recordId)
  if (index < 0) return false
  queue.splice(index, 1)
  return true
}

export function getJobQueueState(): JobQueueState {
  const running: RunningJobInfo[] = []
  const queued: JobInfo[] = []
  for (const lane of ['main', 'luxar'] as const) {
    const r = runningJobs[lane]
    if (r) running.push({ kind: r.kind, recordId: r.recordId, label: r.label, startedAt: r.startedAt, progress: r.progress })
    const ordered = [...queues[lane]].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind])
    queued.push(...ordered.map(({ kind, recordId, label }) => ({ kind, recordId, label })))
  }
  return { running, queued }
}
