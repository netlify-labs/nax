// Verifies findings.json is built purely from run state, read without writing, and written on demand.
// Builds temp run states from the real synthesize fixtures.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { buildFindings, findingsPath, readFindings, writeFindings } = require('../../src/workflows/findings')

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'findings')
const NOW = new Date('2026-09-25T12:00:00.000Z')
/** @param {string} name */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

const flow = {
  id: 'review',
  title: 'Review',
  findings: { step: 'synthesize', adapter: 'review-consensus' },
  steps: [
    { id: 'review', agents: ['claude', 'gemini', 'codex'] },
    { id: 'synthesize', agents: ['codex'] },
  ],
}

/** @param {Array<Record<string, unknown>>} synthesizeRuns @param {Record<string, unknown>} [extra] */
function runStateWith(synthesizeRuns, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-findings-artifact-'))
  return {
    runId: '2026-09-25T12-00-00-000Z-review',
    flowId: 'review',
    flow,
    dir,
    target: { branch: 'fix/auth', sha: 'a'.repeat(40), pullRequest: { number: 12, url: 'https://github.com/o/r/pull/12', isCrossRepository: false } },
    steps: [
      { id: 'review', runs: [] },
      { id: 'synthesize', runs: synthesizeRuns },
    ],
    ...extra,
  }
}

const codexRun = (resultText, extra = {}) => ({
  agent: 'codex',
  instanceId: 'codex:auto:auto',
  status: 'completed',
  runnerId: 'runner-1',
  sessionId: 'session-1',
  resultText,
  ...extra,
})

test('buildFindings produces schema v1 with stable keys, source, target and ranked findings', () => {
  const state = runStateWith([codexRun(fixture('synthesize-3-findings.md'))])
  const artifact = buildFindings(state, flow, { now: NOW })
  assert.equal(artifact?.schemaVersion, 1)
  assert.equal(artifact?.runId, state.runId)
  assert.equal(artifact?.adapter, 'review-consensus')
  assert.equal(artifact?.generatedAt, NOW.toISOString())
  assert.deepEqual(artifact?.source, { stepId: 'synthesize', instanceId: 'codex:auto:auto', runnerId: 'runner-1', sessionId: 'session-1', resultUrl: null })
  assert.equal(artifact?.target.pullRequest?.number, 12)
  const consensus = (artifact?.findings || []).filter((finding) => finding.bucket === 'consensus')
  assert.equal(consensus.length, 3)
  assert.equal(consensus[0].key, `${state.runId}/synthesize/S1`)
  assert.deepEqual(artifact?.diagnostics, [])
})

test('a flow without a findings declaration yields null', () => {
  const state = runStateWith([codexRun(fixture('synthesize-3-findings.md'))])
  assert.equal(buildFindings(state, { ...flow, findings: null }), null)
})

test('malformed output becomes a diagnostic naming the step and instance', () => {
  const state = runStateWith([codexRun(fixture('synthesize-malformed.md'))])
  const artifact = buildFindings(state, flow, { now: NOW })
  assert.deepEqual(artifact?.findings, [])
  assert.equal(artifact?.diagnostics[0].stepId, 'synthesize')
  assert.equal(artifact?.diagnostics[0].instanceId, 'codex:auto:auto')
  assert.equal(artifact?.diagnostics[0].code, 'structured_block_parse_error')
})

test('a source step with no completed run reports no_completed_source_run', () => {
  const state = runStateWith([codexRun('', { status: 'failed' })])
  const artifact = buildFindings(state, flow, { now: NOW })
  assert.equal(artifact?.diagnostics[0].code, 'no_completed_source_run')
})

test('fan-out source steps merge per run with encoded instance-prefixed localIds and no rank', () => {
  const text = fixture('synthesize-3-findings.md')
  const state = runStateWith([
    codexRun(text, { instanceId: 'codex:gpt-5/x:high' }),
    codexRun(text, { agent: 'claude', instanceId: 'claude:auto:auto', runnerId: 'runner-2', sessionId: 'session-2' }),
  ])
  const artifact = buildFindings(state, flow, { now: NOW })
  const ids = (artifact?.findings || []).filter((finding) => finding.bucket === 'consensus').map((finding) => finding.localId)
  assert.ok(ids.includes('codex%3Agpt-5%2Fx%3Ahigh:S1'))
  assert.ok(ids.includes('claude%3Aauto%3Aauto:S1'))
  const first = artifact?.findings.find((finding) => finding.localId === 'codex%3Agpt-5%2Fx%3Ahigh:S1')
  assert.equal(first?.sourceLocalId, 'S1')
  assert.equal(first?.rank, null)
  assert.equal(first?.key, `${state.runId}/synthesize/codex%3Agpt-5%2Fx%3Ahigh:S1`)
})

test('buildFindings reads only current runs, never superseded attempts', () => {
  const state = runStateWith([codexRun(fixture('synthesize-3-findings.md'))])
  const synthesize = /** @type {Record<string, unknown>} */ (state.steps[1])
  synthesize.attempts = [codexRun(fixture('synthesize-10-findings.md'), { attemptId: 'old' })]
  const artifact = buildFindings(state, flow, { now: NOW })
  assert.equal((artifact?.findings || []).filter((finding) => finding.bucket === 'consensus').length, 3)
})

test('readFindings computes in memory without writing; writeFindings persists findings.json', () => {
  const state = runStateWith([codexRun(fixture('synthesize-3-findings.md'))])
  const target = findingsPath(state)
  const read = readFindings(state, flow)
  assert.equal(read?.findings.filter((finding) => finding.bucket === 'consensus').length, 3)
  assert.equal(fs.existsSync(target), false)
  const written = writeFindings(state, flow, { now: NOW })
  assert.ok(fs.existsSync(target))
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), written)
  assert.deepEqual(readFindings(state, flow), written)
})
