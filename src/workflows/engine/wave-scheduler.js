// Bounded-concurrency wave scheduler for agent runs (Arena program nax-2rx6.4.3).
// The Agent Runner backend caps concurrent runs (~5, not user-tunable); running more than that
// at once risks the API falling over. mapInWaves runs a worker over items in waves of at most
// `concurrency`, awaiting each wave fully before starting the next, so the maximum number of
// simultaneously in-flight workers never exceeds the cap. A step with <= cap runs is one wave,
// identical to the previous fire-all behaviour.

/** Hardcoded backend parallel-run cap (observed default; not auto-detected, not user-tunable). */
const MAX_PARALLEL_RUNS = 5

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R> | R} worker
 * @returns {Promise<Array<PromiseSettledResult<Awaited<R>>>>}
 */
async function mapInWaves(items, concurrency, worker) {
  const size = Math.max(1, Math.floor(concurrency) || 1)
  /** @type {Array<PromiseSettledResult<Awaited<R>>>} */
  const results = []
  for (let start = 0; start < items.length; start += size) {
    const wave = items.slice(start, start + size)
    const waveResults = await Promise.allSettled(
      wave.map((item, offset) => Promise.resolve().then(() => worker(item, start + offset))),
    )
    results.push(...waveResults)
  }
  return results
}

module.exports = {
  MAX_PARALLEL_RUNS,
  mapInWaves,
}
