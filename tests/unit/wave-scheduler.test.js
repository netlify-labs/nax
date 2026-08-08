// Lifecycle-slot scheduler tests (nax-2rx6.4.3): bounds non-terminal workers to the cap,
// refills a slot immediately, preserves order, and returns Promise.allSettled-shaped results.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mapInWaves, MAX_PARALLEL_RUNS } = require('../../src/workflows/engine/wave-scheduler')

test('never exceeds the concurrency cap (max simultaneous in-flight)', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const items = Array.from({ length: 13 }, (_, i) => i)
  await mapInWaves(items, MAX_PARALLEL_RUNS, async (item) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 3))
    inFlight -= 1
    return item
  })
  assert.ok(maxInFlight <= MAX_PARALLEL_RUNS, `max in-flight was ${maxInFlight}, expected <= ${MAX_PARALLEL_RUNS}`)
  assert.ok(maxInFlight >= 1)
})

test('preserves input order regardless of completion order', async () => {
  const items = [0, 1, 2, 3, 4, 5, 6]
  const results = await mapInWaves(items, 3, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, (7 - item) * 2)) // later items finish first
    return item * 10
  })
  assert.deepEqual(results.map((r) => (r.status === 'fulfilled' ? r.value : null)), [0, 10, 20, 30, 40, 50, 60])
})

test('returns Promise.allSettled-shaped results incl. rejections', async () => {
  const results = await mapInWaves([1, 2, 3], 2, async (item) => {
    if (item === 2) throw new Error('boom-2')
    return item
  })
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(results[2].status, 'fulfilled')
})

test('a step within the cap starts every lifecycle worker immediately', async () => {
  let starts = 0
  let inFlight = 0
  const items = [1, 2, 3, 4]
  const scheduled = mapInWaves(items, MAX_PARALLEL_RUNS, async (item) => {
    starts += 1
    inFlight += 1
    await new Promise((resolve) => setTimeout(resolve, 2))
    inFlight -= 1
    return item
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(starts, 4)
  await scheduled
})

test('starts the fifth lifecycle as soon as one of the first four becomes terminal', async () => {
  /** @type {Array<() => void>} */
  const finish = []
  const started = []
  const scheduled = mapInWaves(Array.from({ length: 8 }, (_, index) => index), MAX_PARALLEL_RUNS, async (item) => {
    started.push(item)
    await new Promise((resolve) => { finish[item] = () => resolve() })
    return item
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [0, 1, 2, 3])
  finish[2]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [0, 1, 2, 3, 4])
  for (const item of started) finish[item]()
  await new Promise((resolve) => setImmediate(resolve))
  for (let item = 5; item < 8; item += 1) finish[item]()
  await scheduled
})
