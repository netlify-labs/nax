// Tests for stalled-run detection: last event-log activity vs a quiet
// threshold, computed only for runs whose projected status is active.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { livenessFields, stalledThresholdMs } = require('../../src/dashboard/shared/run-liveness')

const MINUTE_MS = 60 * 1000

function runDirWithEvents(ageMs, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-liveness-'))
  const logPath = path.join(dir, 'events.jsonl')
  fs.writeFileSync(logPath, '{"type":"workflow_started","seq":1}\n')
  const eventTime = new Date(now - ageMs)
  fs.utimesSync(logPath, eventTime, eventTime)
  return dir
}

test('livenessFields marks a quiet active run as stalled with lastEventAt', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z')
  const dir = runDirWithEvents(14 * MINUTE_MS, now)
  const fields = livenessFields({ dir, updatedAt: '2026-07-22T10:00:00.000Z' }, 'running', {
    now,
    thresholdMs: 10 * MINUTE_MS,
  })

  assert.equal(fields.stalled, true)
  assert.equal(fields.lastEventAt, new Date(now - 14 * MINUTE_MS).toISOString())
})

test('livenessFields leaves a recently active run alone', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z')
  const dir = runDirWithEvents(2 * MINUTE_MS, now)
  const fields = livenessFields({ dir }, 'running', { now, thresholdMs: 10 * MINUTE_MS })

  assert.equal(fields.stalled, false)
  assert.equal(typeof fields.lastEventAt, 'string')
})

test('livenessFields skips terminal runs without touching the filesystem', () => {
  let statCalls = 0
  const fields = livenessFields({ dir: '/nowhere' }, 'completed', {
    now: Date.now(),
    thresholdMs: 10 * MINUTE_MS,
    stat: () => {
      statCalls += 1
      throw new Error('should not stat')
    },
  })

  assert.deepEqual(fields, {})
  assert.equal(statCalls, 0)
})

test('livenessFields falls back to updatedAt when no event log exists', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-liveness-empty-'))
  const fields = livenessFields({ dir, updatedAt: new Date(now - 30 * MINUTE_MS).toISOString() }, 'running', {
    now,
    thresholdMs: 10 * MINUTE_MS,
  })

  assert.equal(fields.stalled, true)
  assert.equal(fields.lastEventAt, new Date(now - 30 * MINUTE_MS).toISOString())
})

test('threshold zero disables stalled detection', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z')
  const dir = runDirWithEvents(90 * MINUTE_MS, now)
  const fields = livenessFields({ dir }, 'running', { now, thresholdMs: 0 })

  assert.equal(fields.stalled, false)
})

test('stalledThresholdMs reads NAX_STALLED_AFTER_MINUTES with a 10 minute default', () => {
  assert.equal(stalledThresholdMs({}), 10 * MINUTE_MS)
  assert.equal(stalledThresholdMs({ NAX_STALLED_AFTER_MINUTES: '25' }), 25 * MINUTE_MS)
  assert.equal(stalledThresholdMs({ NAX_STALLED_AFTER_MINUTES: '0' }), 0)
  assert.equal(stalledThresholdMs({ NAX_STALLED_AFTER_MINUTES: 'junk' }), 10 * MINUTE_MS)
})
