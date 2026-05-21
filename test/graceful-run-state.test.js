const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  _private,
  clearTrackedRunState,
  trackRunState,
} = require('../lib/graceful-run-state')

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
