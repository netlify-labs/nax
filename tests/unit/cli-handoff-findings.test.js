// Verifies `nax handoff --findings` prints a findings table or the findings.json artifact.
// Runs the real CLI as a subprocess against a temp project with a saved review run.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const NAX_BIN = path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js')
const RUN_ID = '2026-09-25T12-00-00-000Z-review'
const synthesizeText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'findings', 'synthesize-3-findings.md'), 'utf8')

/** @param {{ findings?: unknown }} [options] */
function project({ findings = { step: 'synthesize', adapter: 'review-consensus' } } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-handoff-findings-'))
  const dir = path.join(projectRoot, '.nax', 'workflows', RUN_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId: RUN_ID,
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:30:00.000Z',
    flow: { id: 'review', title: 'Review', findings, steps: [{ id: 'synthesize', agents: ['codex'] }] },
    steps: [{ id: 'synthesize', runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', status: 'completed', resultText: synthesizeText }] }],
  }))
  return projectRoot
}

/** @param {string} projectRoot @param {string[]} args */
function handoff(projectRoot, args) {
  return spawnSync(process.execPath, [NAX_BIN, 'handoff', ...args, '--findings', '--project-root', projectRoot], { cwd: projectRoot, encoding: 'utf8' })
}

test('--findings --json prints the findings artifact for the latest eligible run', () => {
  const result = handoff(project(), ['--json'])
  assert.equal(result.status, 0, result.stderr)
  const artifact = JSON.parse(result.stdout)
  assert.equal(artifact.runId, RUN_ID)
  assert.equal(artifact.findings.filter((/** @type {{ bucket: string }} */ finding) => finding.bucket === 'consensus').length, 3)
})

test('--findings prints a ranked table with severity, title and location', () => {
  const result = handoff(project(), [RUN_ID])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Findings for .*2026-09-25T12-00-00-000Z-review/)
  assert.match(result.stdout, /^\s*1\s+(critical|high|medium|low|info)\s+/m)
  assert.match(result.stdout, /3 consensus findings/)
})

test('--findings explains when no saved run declares findings', () => {
  const result = handoff(project({ findings: null }), [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /No saved workflow run has findings/)
})
