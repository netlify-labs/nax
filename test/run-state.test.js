const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  dismissRunState,
  findLatestUnfinishedRun,
  findLatestUnfinishedLocalRun,
  hasRepairableRuns,
  isUnfinishedRun,
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
    transport: overrides.transport || 'local',
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

test('isUnfinishedRun detects submitted GitHub issue runs', () => {
  const state = runState('/tmp/x', {
    transport: 'github',
    steps: [{ id: 'review', status: 'running', runs: [{ issueNumber: 123, status: 'submitted' }] }],
  })

  assert.equal(isUnfinishedRun(state), true)
  assert.equal(isUnfinishedLocalRun(state), false)
})

test('findLatestUnfinishedRun can filter by transport', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-generic-test-'))
  saveRunState(runState(tmp, {
    runId: 'github-run',
    transport: 'github',
    updatedAt: '2026-05-12T02:00:00.000Z',
    steps: [{ id: 'review', status: 'running', runs: [{ issueNumber: 99, status: 'submitted' }] }],
  }))
  saveRunState(runState(tmp, {
    runId: 'local-run',
    transport: 'local',
    updatedAt: '2026-05-12T01:00:00.000Z',
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'runner-1', status: 'submitted' }] }],
  }))

  assert.equal(findLatestUnfinishedRun(tmp, { flowId: 'review' }).runId, 'github-run')
  assert.equal(findLatestUnfinishedRun(tmp, { flowId: 'review', transport: 'local' }).runId, 'local-run')
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
