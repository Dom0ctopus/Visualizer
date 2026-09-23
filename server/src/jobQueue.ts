/**
 * Runs heavy background jobs (NRRD -> OME-Zarr conversion, orthogonal-copy
 * backfill, mesh generation) one at a time. Each of these can hold a whole
 * pyramid level in memory, so running several at once -- e.g. uploading a
 * volume and a few segmentations back to back -- risks exhausting the Node
 * heap. Jobs are responsible for their own error handling/status updates;
 * a failing job never blocks the ones queued after it.
 */
let tail: Promise<void> = Promise.resolve()
let pending = 0

export function enqueueJob(label: string, run: () => Promise<void>): Promise<void> {
  pending++
  const job = tail.then(async () => {
    const t0 = Date.now()
    console.log(`[jobs] start: ${label} (${pending - 1} queued behind it)`)
    try {
      await run()
      console.log(`[jobs] done: ${label} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (e) {
      console.error(`[jobs] failed: ${label}:`, e)
    } finally {
      pending--
    }
  })
  tail = job
  return job
}
