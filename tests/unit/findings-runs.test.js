// Verifies which saved workflow runs are eligible sources for findings handoff.
// Writes real workflow.json files into a temp project's .nax/workflows directory.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { resolveFindingsRun } = require('../../src/workflows/findings/runs')

const REVIEW_FLOW = { id: 'review', title: 'Review', findings: { step: 'synthesize', adapter: 'review-consensus' }, steps: [{ id: 'synthesize', agents: ['codex'] }] }

/** @param {string} projectRoot @param {string} runId @param {Record<string, unknown>} overrides */
function writeRun(projectRoot, runId, overrides) {
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  const state = {
    runId,
    flowId: 'review',
    flow: REVIEW_FLOW,
    status: 'completed',
    createdAt: runId,
    updatedAt: runId,
    steps: [{ id: 'synthesize', runs: [{ agent: 'codex', status: 'completed', resultText: '## 2. Structured Consensus' }] }],
    ...overrides,
  }
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify(state))
}

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-findings-runs-'))
}

for (const status of ['completed', 'completed_with_failures', 'failed']) {
  test(`a ${status} run with a completed source step is eligible`, () => {
    const root = project()
    writeRun(root, '2026-09-25T10-00-00-000Z-review', { status })
    assert.equal(resolveFindingsRun(root)?.runId, '2026-09-25T10-00-00-000Z-review')
  })
}

test('running, flow-without-declaration, and empty-source runs are skipped for the default pick', () => {
  const root = project()
  writeRun(root, '2026-09-25T09-00-00-000Z-review', {})
  writeRun(root, '2026-09-25T10-00-00-000Z-review', { status: 'running' })
  writeRun(root, '2026-09-25T11-00-00-000Z-ideas', { flowId: 'ideas', flow: { id: 'ideas', findings: null, steps: [] } })
  writeRun(root, '2026-09-25T12-00-00-000Z-review', { steps: [{ id: 'synthesize', runs: [{ agent: 'codex', status: 'failed', resultText: '' }] }] })
  assert.equal(resolveFindingsRun(root)?.runId, '2026-09-25T09-00-00-000Z-review')
})

test('an explicit run id is returned even when it would not be the default pick', () => {
  const root = project()
  writeRun(root, '2026-09-25T09-00-00-000Z-review', {})
  writeRun(root, '2026-09-25T10-00-00-000Z-review', { status: 'running' })
  assert.equal(resolveFindingsRun(root, '2026-09-25T10-00-00-000Z-review')?.runId, '2026-09-25T10-00-00-000Z-review')
  assert.equal(resolveFindingsRun(root, 'missing-run'), null)
})

test('no eligible runs yields null', () => {
  assert.equal(resolveFindingsRun(project()), null)
})
