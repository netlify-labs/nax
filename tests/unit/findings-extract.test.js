// Verifies structured findings blocks are located and parsed from real agent result texts.
// Uses the redacted golden fixtures in tests/fixtures/findings.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { findStructuredBlocks } = require('../../src/workflows/findings/extract')
const { extractStructuredSection } = require('../../src/workflows/round-results')

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'findings')
/** @param {string} name */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

for (const count of [3, 7, 10]) {
  test(`synthesize fixture with ${count} findings parses into one consensus block`, () => {
    const blocks = findStructuredBlocks(fixture(`synthesize-${count}-findings.md`))
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].kind, 'consensus')
    assert.equal(blocks[0].parseError, undefined)
    const json = /** @type {{ consensus_findings: unknown[] }} */ (blocks[0].json)
    assert.equal(json.consensus_findings.length, count)
  })
}

for (const agent of ['claude', 'gemini', 'codex']) {
  test(`round-1 ${agent} review parses into a findings array`, () => {
    const blocks = findStructuredBlocks(fixture(`review-${agent}.md`))
    assert.equal(blocks[0].kind, 'findings')
    assert.ok(Array.isArray(blocks[0].json))
  })
}

test('an output without a structured heading yields no blocks', () => {
  assert.deepEqual(findStructuredBlocks(fixture('review-codex-no-heading.md')), [])
})

test('malformed JSON is reported as a parseError with raw text kept', () => {
  const [block] = findStructuredBlocks(fixture('synthesize-malformed.md'))
  assert.equal(block.json, null)
  assert.match(String(block.parseError), /JSON/)
  assert.ok(block.raw.includes('consensus_findings'))
})

test('unnumbered audit headings match only in widened mode', () => {
  const text = fixture('security-synthesize.md')
  const widened = findStructuredBlocks(text)
  assert.ok(widened.some((block) => block.kind === 'consensus' && Array.isArray(block.json)))
  assert.deepEqual(findStructuredBlocks(text, { numberedOnly: true }), [])
})

test('extractStructuredSection keeps its numbered-heading behavior for prompt shrinking', () => {
  const synth = extractStructuredSection(fixture('synthesize-7-findings.md'))
  assert.match(String(synth?.heading), /^## 2\. Structured Consensus/)
  assert.ok(String(synth?.json).startsWith('{'))
  assert.equal(extractStructuredSection(fixture('security-synthesize.md')), null)
  assert.equal(extractStructuredSection(fixture('review-codex-no-heading.md')), null)
})

test('a block without a fenced payload falls back to the first balanced JSON span', () => {
  const [block] = findStructuredBlocks('## Structured Findings\n\n[{"id": "F1", "claim": "x"}]\n\n## Next\n')
  assert.deepEqual(block.json, [{ id: 'F1', claim: 'x' }])
})

test('numberedOnly reads only the first numbered heading, whose section runs until "## 3."', () => {
  const text = '## 2. Structured Findings\n\nNo JSON here.\n\n## 2. Structured Consensus\n\n```json\n{"consensus_findings": []}\n```\n'
  const blocks = findStructuredBlocks(text, { numberedOnly: true })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].heading, '## 2. Structured Findings')
  assert.deepEqual(extractStructuredSection(text), { heading: '## 2. Structured Findings', json: '{"consensus_findings": []}' })
})
