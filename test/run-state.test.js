const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  dismissRunState,
  findLatestUnfinishedLocalRun,
  hasRepairableRuns,
  isUnfinishedLocalRun,
  listRunStates,
  saveRunState,
} = require('../lib/run-state')

function runState(tmp, overrides = {}) {
  const runId = overrides.runId || `run-${Math.random().toString(16).slice(2)}`
  return {
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    transport: 'local',
    projectRoot: tmp,
    createdAt: overrides.createdAt || '2026-05-12T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-05-12T00:00:00.000Z',
    options: {},
    steps: overrides.steps || [],
    dir: path.join(tmp, '.nax', 'runs', runId),
  }
}

test('isUnfinishedLocalRun detects submitted local runner ids', () => {
  assert.equal(isUnfinishedLocalRun(runState('/tmp/x', {
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'runner-1', status: 'submitted' }] }],
  })), true)

  assert.equal(isUnfinishedLocalRun(runState('/tmp/x', {
    steps: [{ id: 'review', status: 'completed', runs: [{ runnerId: 'runner-1', status: 'completed' }] }],
  })), false)
})

test('hasRepairableRuns ignores terminal failed and timeout runs', () => {
  const failedStep = {
    id: 'review',
    status: 'failed',
    runs: [{ runnerId: 'runner-1', status: 'failed', resultText: '' }],
  }
  const timeoutStep = {
    id: 'review',
    status: 'failed',
    runs: [{ runnerId: 'runner-1', status: 'timeout', resultText: '' }],
  }

  assert.equal(hasRepairableRuns(failedStep), false)
  assert.equal(hasRepairableRuns(timeoutStep), false)
  assert.equal(isUnfinishedLocalRun(runState('/tmp/x', { steps: [failedStep] })), false)
})

test('hasRepairableRuns still flags in-flight submitted and running runs', () => {
  assert.equal(hasRepairableRuns({
    runs: [{ runnerId: 'runner-1', status: 'submitted' }],
  }), true)
  assert.equal(hasRepairableRuns({
    runs: [{ runnerId: 'runner-1', status: 'running' }],
  }), true)
})

test('findLatestUnfinishedLocalRun returns newest unfinished local run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-test-'))
  saveRunState(runState(tmp, {
    runId: 'old',
    updatedAt: '2026-05-12T00:00:00.000Z',
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'old-runner', status: 'submitted' }] }],
  }))
  saveRunState(runState(tmp, {
    runId: 'new',
    updatedAt: '2026-05-12T01:00:00.000Z',
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'new-runner', status: 'submitted' }] }],
  }))

  assert.deepEqual(listRunStates(tmp).map((state) => state.runId), ['new', 'old'])
  assert.equal(findLatestUnfinishedLocalRun(tmp, { flowId: 'review' }).runId, 'new')
})

test('dismissRunState marks unfinished runs ignored by resume detection', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-dismiss-test-'))
  const state = saveRunState(runState(tmp, {
    runId: 'dismiss-me',
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'runner-1', status: 'submitted' }] }],
  }))

  const dismissed = dismissRunState(state, {
    now: new Date('2026-05-12T02:00:00.000Z'),
  })

  assert.equal(dismissed.status, 'dismissed')
  assert.equal(dismissed.dismissedAt, '2026-05-12T02:00:00.000Z')
  assert.equal(dismissed.dismissReason, 'user-declined-resume')
  assert.equal(isUnfinishedLocalRun(dismissed), false)
  assert.equal(findLatestUnfinishedLocalRun(tmp, { flowId: 'review' }), null)
})
