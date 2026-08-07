// Bounded-concurrency scheduler for agent runs (Arena program nax-2rx6.4.3).
// The worker owns one slot until the remote run reaches a terminal state. As soon as a worker
// settles, the next queued item starts; a slow run therefore does not hold up unrelated slots.

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
  const results = new Array(items.length)
  let nextIndex = 0
  const takeNext = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        const value = await worker(items[index], index)
        results[index] = { status: 'fulfilled', value: /** @type {Awaited<R>} */ (value) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => takeNext()))
  return results
}

module.exports = {
  MAX_PARALLEL_RUNS,
  mapInWaves,
}
