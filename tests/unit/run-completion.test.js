// Verifies findings.json is written only at terminal transitions and never affects run outcome.
// Uses real temp run directories with the review synthesize fixture as the source step result.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { completeRun, writeFindingsAtTerminal } = require('../../src/workflows/run-completion')
const { saveRunState } = require('../../src/storage/local/run-state')
const { findingsPath } = require('../../src/workflows/findings')

const synthesizeText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'findings', 'synthesize-3-findings.md'), 'utf8')

function runState() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-completion-'))
  const runId = '2026-09-25T12-00-00-000Z-review'
  return {
    runId,
    flowId: 'review',
    projectRoot,
    dir: path.join(projectRoot, '.nax', 'workflows', runId),
    status: 'running',
    flow: { id: 'review', title: 'Review', findings: { step: 'synthesize', adapter: 'review-consensus' }, steps: [{ id: 'synthesize', agents: ['codex'] }] },
    steps: [{ id: 'synthesize', status: 'completed', runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', status: 'completed', resultText: synthesizeText }] }],
  }
}

test('saveRunState alone never writes findings.json', () => {
  const state = runState()
  saveRunState(state)
  assert.equal(fs.existsSync(findingsPath(state)), false)
})

test('completeRun marks the run completed and writes findings.json', () => {
  const state = runState()
  completeRun(state)
  assert.equal(state.status, 'completed')
  const artifact = JSON.parse(fs.readFileSync(findingsPath(state), 'utf8'))
  assert.equal(artifact.findings.filter((/** @type {{ bucket: string }} */ finding) => finding.bucket === 'consensus').length, 3)
})

test('a failing findings write warns and never throws or changes run status', () => {
  const state = runState()
  state.status = 'failed'
  const warnings = []
  const result = writeFindingsAtTerminal(state, {
    write: () => { throw new Error('disk full') },
    warn: (message) => { warnings.push(message) },
  })
  assert.equal(result, null)
  assert.equal(state.status, 'failed')
  assert.match(warnings.join('\n'), /findings\.json could not be written: disk full/)
})
