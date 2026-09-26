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

export type JobKind = 'convert' | 'backfill' | 'meshes'

const PRIORITY: Record<JobKind, number> = { convert: 0, backfill: 1, meshes: 2 }

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
  /** The running job, if any (at most one). */
  running: RunningJobInfo[]
  queued: JobInfo[]
}

const queue: Job[] = []
let runningJob: (RunningJobInfo & { job: Job }) | null = null

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

async function drain(): Promise<void> {
  if (runningJob) return
  for (let job = takeNext(queue); job; job = takeNext(queue)) {
    const current: RunningJobInfo & { job: Job } = { kind: job.kind, recordId: job.recordId, label: job.label, startedAt: Date.now(), job }
    runningJob = current
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
      runningJob = null
    }
  }
}

export function enqueueJob(kind: JobKind, recordId: string, label: string, run: (ctx: JobContext) => Promise<void>): void {
  queue.push({ kind, recordId, label, run, resumed: false, enqueuedAt: Date.now() })
  if (runningJob) console.log(`[jobs] queued: ${label} (running: ${runningJob.label})`)
  void drain()
}

/** Whether a job for this record and kind is queued or running. */
export function hasJob(kind: JobKind, recordId: string): boolean {
  return (runningJob?.kind === kind && runningJob.recordId === recordId) || queue.some((j) => j.kind === kind && j.recordId === recordId)
}

/** Drops a queued (not yet running) job; returns whether one was removed. */
export function dequeueJob(kind: JobKind, recordId: string): boolean {
  const index = queue.findIndex((j) => j.kind === kind && j.recordId === recordId)
  if (index < 0) return false
  queue.splice(index, 1)
  return true
}

export function getJobQueueState(): JobQueueState {
  const r = runningJob
  const running: RunningJobInfo[] = r ? [{ kind: r.kind, recordId: r.recordId, label: r.label, startedAt: r.startedAt, progress: r.progress }] : []
  const queued = [...queue].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]).map(({ kind, recordId, label }): JobInfo => ({ kind, recordId, label }))
  return { running, queued }
}
