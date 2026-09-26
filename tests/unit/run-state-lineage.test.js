// Verifies saveRunState merges whole-state snapshots by attempt lineage, never regressing newer disk state.
// Writes real workflow.json files through saveRunState in temp directories.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { saveRunState, workflowStatePath } = require('../../src/storage/local/run-state')

/** @param {Array<Record<string, unknown>>} runs */
function state(runs, extra = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-lineage-'))
  return {
    runId: 'lineage-run',
    projectRoot,
    dir: path.join(projectRoot, '.nax', 'workflows', 'lineage-run'),
    status: 'running',
    steps: [{ id: 'review', status: 'running', runs }],
    ...extra,
  }
}

/** @param {{ dir: string }} runState */
function saved(runState) {
  return JSON.parse(fs.readFileSync(workflowStatePath(runState.dir), 'utf8'))
}

/** @param {Record<string, unknown>} base @param {Array<Record<string, unknown>>} runs */
function withRuns(base, runs) {
  return { ...base, steps: [{ id: 'review', status: 'running', runs }] }
}

test('same attempt: a stale non-terminal snapshot never regresses a terminal record', () => {
  const current = saveRunState(state([{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a1', status: 'completed', runnerId: 'r1', resultText: 'done' }]))
  saveRunState(withRuns(current, [{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a1', status: 'running', runnerId: 'r1' }]))
  const [run] = saved(current).steps[0].runs
  assert.equal(run.status, 'completed')
  assert.equal(run.resultText, 'done')
})

test('different attempts: an incoming attempt that supersedes disk replaces it and archives the old one', () => {
  const current = saveRunState(state([{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a1', status: 'failed', runnerId: 'r1' }]))
  saveRunState(withRuns(current, [{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a2', supersedesAttemptId: 'a1', status: 'submitted', runnerId: 'r2' }]))
  const step = saved(current).steps[0]
  assert.equal(step.runs[0].attemptId, 'a2')
  assert.equal(step.runs[0].runnerId, 'r2')
  assert.deepEqual(step.attempts.map((attempt) => attempt.attemptId), ['a1'])
})

test('different attempts: a stale writer holding the superseded attempt keeps the newer disk attempt current', () => {
  const current = saveRunState(state([{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a2', supersedesAttemptId: 'a1', status: 'submitted', runnerId: 'r2' }]))
  saveRunState(withRuns(current, [{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a1', status: 'failed', runnerId: 'r1', resultText: 'old' }]))
  const step = saved(current).steps[0]
  assert.equal(step.runs[0].attemptId, 'a2')
  assert.equal(step.runs[0].runnerId, 'r2')
  assert.deepEqual(step.attempts.map((attempt) => attempt.attemptId), ['a1'])
})

test('two same-provider instances with a replaced attempt never bleed durable fields across attempts', () => {
  const current = saveRunState(state([
    { agent: 'codex', instanceId: 'codex:gpt-5:high', attemptId: 'h1', status: 'completed', runnerId: 'rh', sessionId: 'sh', resultText: 'high' },
    { agent: 'codex', instanceId: 'codex:gpt-5:low', attemptId: 'l1', status: 'failed', runnerId: 'rl', sessionId: 'sl' },
  ]))
  saveRunState(withRuns(current, [
    { agent: 'codex', instanceId: 'codex:gpt-5:high', attemptId: 'h1', status: 'completed', runnerId: 'rh', sessionId: 'sh', resultText: 'high' },
    { agent: 'codex', instanceId: 'codex:gpt-5:low', attemptId: 'l2', supersedesAttemptId: 'l1', status: 'pending', runnerId: '', sessionId: '' },
  ]))
  const runs = saved(current).steps[0].runs
  assert.equal(runs[1].attemptId, 'l2')
  assert.equal(runs[1].runnerId, '')
  assert.equal(runs[1].sessionId, '')
  assert.equal(runs[0].resultText, 'high')
})

test('a live poller save after a dashboard replacement keeps the replacement current', () => {
  const current = saveRunState(state([{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a1', status: 'running', runnerId: 'r1' }]))
  const pollerSnapshot = structuredClone(current)
  saveRunState(withRuns(current, [{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a2', supersedesAttemptId: 'a1', status: 'retrying', runnerId: 'pending-retry' }]))
  pollerSnapshot.steps[0].runs[0].status = 'failed'
  saveRunState(pollerSnapshot)
  const step = saved(current).steps[0]
  assert.equal(step.runs[0].attemptId, 'a2')
  assert.ok(step.attempts.some((attempt) => attempt.attemptId === 'a1' && attempt.status === 'failed'))
})

test('a stale snapshot cannot mark a step or run finished while the kept newer attempt is still active', () => {
  const current = saveRunState(state(
    [{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a2', supersedesAttemptId: 'a1', status: 'submitted', runnerId: 'r2' }],
    { status: 'running' },
  ))
  for (const staleStatus of ['failed', 'completed_with_failures']) {
    const stale = withRuns(current, [{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a1', status: 'failed', runnerId: 'r1' }])
    stale.steps[0].status = staleStatus
    saveRunState({ ...stale, status: 'failed' })
    const disk = saved(current)
    assert.equal(disk.steps[0].runs[0].attemptId, 'a2')
    assert.equal(disk.steps[0].status, 'running', staleStatus)
    assert.equal(disk.status, 'running')
  }
})
