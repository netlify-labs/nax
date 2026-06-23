const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MARKER_PREFIX,
  bodyHasPromptMarker,
  bodyHasRunnerResultMarker,
  parsePromptMarker,
  parseRunnerResultMarker,
  renderPromptMarker,
} = require('../../src/integrations/github/comment-markers')

test('renderPromptMarker emits the canonical shape for valid segments', () => {
  const out = renderPromptMarker({
    promptName: 'cross-review',
    model: 'claude',
    date: '2026-05-07',
  })
  assert.equal(out, '<!-- netlify-workflow-prompt:cross-review:claude:2026-05-07 -->')
  assert.match(out, new RegExp(`^${MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')}`))
})

test('renderPromptMarker rejects segments that violate the id format', () => {
  assert.throws(
    () => renderPromptMarker({ promptName: 'cross review', model: 'claude', date: '2026-05-07' }),
    /Invalid promptName/,
  )
  assert.throws(
    () => renderPromptMarker({ promptName: 'cross-review', model: 'claude!', date: '2026-05-07' }),
    /Invalid model/,
  )
  assert.throws(
    () => renderPromptMarker({ promptName: 'cross-review', model: 'claude', date: '' }),
    /Invalid date/,
  )
})

test('parsePromptMarker round-trips with renderPromptMarker', () => {
  const marker = renderPromptMarker({
    promptName: 'summarize-consensus',
    model: 'gemini',
    date: '2026-05-07',
  })
  const body = `Some prefix\n\n${marker}\n\nSome suffix`
  assert.deepEqual(parsePromptMarker(body), {
    promptName: 'summarize-consensus',
    model: 'gemini',
    date: '2026-05-07',
  })
})

test('parsePromptMarker returns null for bodies without the marker', () => {
  assert.equal(parsePromptMarker('## Findings\n- nothing here'), null)
  assert.equal(parsePromptMarker(''), null)
  assert.equal(parsePromptMarker(null), null)
})

test('bodyHasPromptMarker is true only when the marker is present', () => {
  const marker = renderPromptMarker({ promptName: 'review', model: 'codex', date: '2026-05-07' })
  assert.equal(bodyHasPromptMarker(`anything ${marker}`), true)
  assert.equal(bodyHasPromptMarker('## A reply with no marker'), false)
})

test('parseRunnerResultMarker reads legacy result markers', () => {
  const body = '<!-- netlify-agent-run-result:runner-1:session-1 -->'
  assert.equal(bodyHasRunnerResultMarker(body), true)
  assert.deepEqual(parseRunnerResultMarker(body), {
    runnerId: 'runner-1',
    sessionId: 'session-1',
    usage: null,
  })
})

test('parseRunnerResultMarker reads attribute markers with compact usage', () => {
  const body = '<!-- netlify-agent-run-result runnerId="runner-1" sessionId="session-1" totalTokens=85131 totalCreditsCost=18.06858 stepsCount=10 creditLimitExceeded=false -->'
  assert.equal(bodyHasRunnerResultMarker(body), true)
  assert.deepEqual(parseRunnerResultMarker(body), {
    runnerId: 'runner-1',
    sessionId: 'session-1',
    usage: {
      totalTokens: 85131,
      totalCreditsCost: 18.06858,
      stepsCount: 10,
      creditLimitExceeded: false,
    },
  })
})
