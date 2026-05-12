const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  findLatestUnfinishedLocalRun,
  isUnfinishedLocalRun,
  listRunStates,
  saveRunState,
} = require('../lib/run-state')

function runState(tmp, overrides = {}) {
  const runId = overrides.runId || `run-${Math.random().toString(16).slice(2)}`
  return {
    schemaVersion: 1,
    runId,
    flowId: 'review-cycle',
    flowTitle: 'Review Cycle',
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
  assert.equal(findLatestUnfinishedLocalRun(tmp, { flowId: 'review-cycle' }).runId, 'new')
})
