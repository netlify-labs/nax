// Guards the attempt reader contract: step.runs is the only current-state input; step.attempts is history.
// Superseded attempts must never feed prompt chaining, step status, or findings.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { sourceRunsForStep } = require('../../src/workflows/engine/execution-context')
const { buildFindings } = require('../../src/workflows/findings')
const { attemptRecord } = require('../../src/core/runs/attempts')

const STALE = 'STALE-SUPERSEDED-ATTEMPT-OUTPUT'
const synthesizeText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'findings', 'synthesize-3-findings.md'), 'utf8')

function stepWithAttempts() {
  return {
    id: 'review',
    status: 'completed',
    runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a2', status: 'completed', runnerId: 'r2', resultText: synthesizeText }],
    attempts: [{ ...attemptRecord({ attemptId: 'a1', agent: 'codex', instanceId: 'codex:auto:auto', status: 'completed', runnerId: 'r1' }), resultText: STALE }],
  }
}

test('prompt chaining reads only current attempts', () => {
  const completed = new Map([['review', /** @type {import('../../src/workflows/engine/execution-context').ExecutionStepState} */ (/** @type {unknown} */ (stepWithAttempts()))]])
  const sources = sourceRunsForStep({ id: 'next', input: [{ step: 'review', results: 'all' }] }, completed)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].attemptId, 'a2')
  assert.equal(JSON.stringify(sources).includes(STALE), false)
})

test('findings are built from current attempts only', () => {
  const runState = /** @type {import('../../src/types').WorkflowRunState} */ ({ runId: 'contract-run', flowId: 'review', steps: [stepWithAttempts()] })
  const artifact = buildFindings(runState, { id: 'review', findings: { step: 'review', adapter: 'review-consensus' }, steps: [{ id: 'review', agents: ['codex'] }] })
  assert.equal(artifact?.source.runnerId, 'r2')
  assert.equal(JSON.stringify(artifact).includes(STALE), false)
})
