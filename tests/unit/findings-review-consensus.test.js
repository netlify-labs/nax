// Verifies the review-consensus adapter maps synthesize output onto the stable Finding contract.
// Exercises real fixtures plus targeted edge cases for each field normalization rule.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { findStructuredBlocks } = require('../../src/workflows/findings/extract')
const { reviewConsensusAdapter } = require('../../src/workflows/findings/adapters/review-consensus')
const { FINDINGS_ADAPTERS } = require('../../src/workflows/findings')
const { FINDINGS_ADAPTER_IDS } = require('../../src/core/constants')

const KNOWN = { knownAgents: ['claude', 'gemini', 'codex', 'opencode'] }

/** @param {Record<string, unknown>} json */
function adapt(json) {
  return reviewConsensusAdapter([{ heading: '## 2. Structured Consensus', kind: 'consensus', raw: JSON.stringify(json), json }], KNOWN)
}

test('FINDINGS_ADAPTER_IDS matches the registered findings adapters', () => {
  assert.deepEqual([...FINDINGS_ADAPTER_IDS].sort(), Object.keys(FINDINGS_ADAPTERS).sort())
})

test('real synthesize fixture maps every consensus finding with rank order', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'findings', 'synthesize-7-findings.md'), 'utf8')
  const result = reviewConsensusAdapter(findStructuredBlocks(text), KNOWN)
  const consensus = result.findings.filter((finding) => finding.bucket === 'consensus')
  assert.equal(consensus.length, 7)
  assert.deepEqual(consensus.map((finding) => finding.rank), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(consensus[0].localId, 'S1')
  assert.ok(consensus.every((finding) => typeof finding.title === 'string' && finding.title.length > 0 && finding.title.length <= 100))
})

test('contested and merge-dependent findings get their bucket and no rank', () => {
  const { findings } = adapt({
    consensus_findings: [{ id: 'S1', claim: 'A.', severity: 'high' }],
    contested_findings: [{ id: 'C1', claim: 'B.', severity: 'low' }],
    merge_dependent_findings: [{ id: 'M1', claim: 'C.', severity: 'medium' }],
  })
  assert.deepEqual(findings.map((finding) => [finding.localId, finding.bucket, finding.rank]), [
    ['S1', 'consensus', 1],
    ['C1', 'contested', null],
    ['M1', 'merge_dependent', null],
  ])
})

test('title uses the agent title, else the first sentence of claim cut to 100 chars on a word boundary', () => {
  const long = `${'word '.repeat(40)}end. Second sentence.`
  const { findings } = adapt({
    consensus_findings: [
      { id: 'S1', title: 'Given title', claim: 'Ignored. Claim.' },
      { id: 'S2', claim: 'Token refresh races with logout. More detail follows.' },
      { id: 'S3', claim: long },
    ],
  })
  assert.equal(findings[0].title, 'Given title')
  assert.equal(findings[1].title, 'Token refresh races with logout.')
  assert.ok(findings[2].title.length <= 100)
  assert.ok(!findings[2].title.endsWith(' '))
  assert.ok(findings[2].title.startsWith('word word'))
})

test('severity normalizes words and P-levels; unknown keeps severityRaw with a diagnostic', () => {
  const { findings, diagnostics } = adapt({
    consensus_findings: [
      { id: 'S1', claim: 'a', severity: 'HIGH' },
      { id: 'S2', claim: 'b', severity: 'P0' },
      { id: 'S3', claim: 'c', severity: 'P3' },
      { id: 'S4', claim: 'd', severity: 'spicy' },
    ],
  })
  assert.deepEqual(findings.map((finding) => finding.severity), ['high', 'critical', 'low', 'info'])
  assert.equal(findings[3].severityRaw, 'spicy')
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'unknown_severity'))
})

test('line accepts integers and ranges; other values become null', () => {
  const { findings } = adapt({
    consensus_findings: [
      { id: 'S1', claim: 'a', line: 88 },
      { id: 'S2', claim: 'b', line: '88-94' },
      { id: 'S3', claim: 'c', line: 'n/a' },
    ],
  })
  assert.deepEqual(findings.map((finding) => [finding.line, finding.lineEnd]), [[88, null], [88, 94], [null, null]])
})

test('agents attribution is kept, unknown agents produce a diagnostic, absence yields []', () => {
  const { findings, diagnostics } = adapt({
    consensus_findings: [
      { id: 'S1', claim: 'a', agents: ['claude', 'gemini'] },
      { id: 'S2', claim: 'b', agents: ['claude', 'watson'] },
      { id: 'S3', claim: 'c' },
    ],
  })
  assert.deepEqual(findings[0].agents, ['claude', 'gemini'])
  assert.deepEqual(findings[1].agents, ['claude', 'watson'])
  assert.deepEqual(findings[2].agents, [])
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'unknown_agent_attribution' && /watson/.test(diagnostic.message)))
})

test('snake_case fields map to camelCase and status passes through', () => {
  const { findings } = adapt({
    consensus_findings: [{ id: 'S1', claim: 'a', suggested_fix: 'do x', status: 'dropped', category: 'defect', file: 'src/a.js', evidence: 'e', confidence: 'high' }],
  })
  assert.equal(findings[0].suggestedFix, 'do x')
  assert.equal(findings[0].status, 'dropped')
  assert.equal(findings[0].category, 'defect')
  assert.equal(findings[0].file, 'src/a.js')
})

test('no consensus block or an unrecognized shape yields a diagnostic, not a throw', () => {
  assert.deepEqual(reviewConsensusAdapter([], KNOWN).findings, [])
  assert.equal(reviewConsensusAdapter([], KNOWN).diagnostics[0].code, 'no_structured_block')
  const shaped = reviewConsensusAdapter([{ heading: '## Structured Consensus', kind: 'consensus', raw: '[]', json: [] }], KNOWN)
  assert.equal(shaped.diagnostics[0].code, 'unrecognized_shape')
  const broken = reviewConsensusAdapter([{ heading: '## 2. Structured Consensus', kind: 'consensus', raw: '{', json: null, parseError: 'Unexpected end of JSON input' }], KNOWN)
  assert.equal(broken.diagnostics[0].code, 'structured_block_parse_error')
})
