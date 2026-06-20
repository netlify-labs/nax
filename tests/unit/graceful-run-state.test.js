const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  _private,
  clearTrackedRunState,
  trackRunState,
} = require('../../src/graceful-run-state')

function runState(tmp, overrides = {}) {
  const runId = overrides.runId || 'run-1'
  return {
    schemaVersion: 1,
    runId,
    flowId: 'ideas',
    flowTitle: 'Ideas',
    transport: 'netlify-api',
    projectRoot: tmp,
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    options: {},
    steps: overrides.steps || [
      { id: 'ideate', status: 'running', runs: [{ runnerId: 'runner-1', status: 'submitted' }] },
    ],
    dir: path.join(tmp, '.nax', 'workflows', runId),
  }
}

function readSaved(state) {
  return JSON.parse(fs.readFileSync(path.join(state.dir, 'workflow.json'), 'utf8'))
}

test('persistActiveRunState marks an active run interrupted and preserves step status', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-graceful-state-test-'))
  const state = runState(tmp)

  trackRunState(state)
  _private.persistActiveRunState('test-interrupt', new Date('2026-05-12T01:00:00.000Z'))
  clearTrackedRunState(state)

  const saved = readSaved(state)
  assert.equal(saved.status, 'interrupted')
  assert.equal(saved.interruptReason, 'test-interrupt')
  assert.equal(saved.interruptedAt, '2026-05-12T01:00:00.000Z')
  assert.equal(saved.steps[0].status, 'running')
  assert.equal(saved.steps[0].runs[0].status, 'submitted')
})

test('clearTrackedRunState can mark a completed run complete', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-graceful-state-complete-test-'))
  const state = runState(tmp, {
    steps: [{ id: 'ideate', status: 'completed', runs: [{ runnerId: 'runner-1', status: 'completed', resultText: 'done' }] }],
  })

  trackRunState(state)
  clearTrackedRunState(state, { completed: true })

  const saved = readSaved(state)
  assert.equal(saved.status, 'completed')
  assert.equal(saved.interruptedAt, undefined)
})

test('persistActiveRunState records stack and warns when interrupt cleanup throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-graceful-state-throw-test-'))
  const state = runState(tmp)
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args)

  try {
    trackRunState(state, {
      onInterrupt() {
        throw new Error('blob cleanup boom')
      },
    })
    _private.persistActiveRunState('test-interrupt', new Date('2026-05-12T01:00:00.000Z'))
    clearTrackedRunState(state)
  } finally {
    console.warn = originalWarn
  }

  const saved = readSaved(state)
  // persistence still completes despite the cleanup failure
  assert.equal(saved.status, 'interrupted')
  assert.equal(saved.interruptCleanupWarning, 'blob cleanup boom')
  assert.match(saved.interruptCleanupStack, /blob cleanup boom/)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][0], 'interrupt cleanup failed')
})

test('persistActiveRunState invokes interrupt cleanup hook before saving', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-graceful-state-hook-test-'))
  const state = runState(tmp)
  const calls = []

  trackRunState(state, {
    onInterrupt({ runState: active, reason }) {
      calls.push({ runId: active.runId, reason })
      active.blobCleanupWarning = 'cleanup attempted'
    },
  })
  _private.persistActiveRunState('test-interrupt', new Date('2026-05-12T01:00:00.000Z'))
  clearTrackedRunState(state)

  const saved = readSaved(state)
  assert.deepEqual(calls, [{ runId: 'run-1', reason: 'test-interrupt' }])
  assert.equal(saved.blobCleanupWarning, 'cleanup attempted')
  assert.equal(saved.status, 'interrupted')
})
