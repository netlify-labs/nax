// Tests for the agent-runner failure guidance table: known stderr signatures
// map to actionable messages while preserving the original error detail.
const test = require('node:test')
const assert = require('node:assert/strict')

const { explainFailure, wrapFailure } = require('../../src/integrations/netlify/failure-guidance')

test('explainFailure maps wrong-account access signatures', () => {
  for (const detail of [
    'netlify agents:create --json failed: Not Found (404)',
    'netlify agents:create --json failed: Unauthorized',
    'netlify agents:create --json failed: access denied',
  ]) {
    const explained = explainFailure(detail, { siteId: 'site-1', email: 'david@example.com' })
    assert.equal(explained?.code, 'wrong_account', detail)
    assert.match(explained.message, /wrong Netlify account/)
    assert.match(explained.message, /site-1/)
  }
})

test('explainFailure maps the argv-limit fan-in failure as non-retryable', () => {
  const detail = 'netlify agents:create --json failed: fork/exec /opt/build-bin/agent-runner: argument list too long'
  const explained = explainFailure(detail, {})
  assert.equal(explained?.code, 'prompt_too_large')
  assert.match(explained.message, /prompt/i)
  assert.match(explained.message, /retrying will not help/i)
})

test('explainFailure maps capacity, rate-limit, and 5xx signatures with attempt counts', () => {
  const capacity = explainFailure('The Codex model is currently at capacity. Retrying automatically...', { attempts: 5 })
  assert.equal(capacity?.code, 'model_capacity')

  const rateLimited = explainFailure('netlify agents:create failed: 429 too many requests', { attempts: 5 })
  assert.equal(rateLimited?.code, 'rate_limited')
  assert.match(rateLimited.message, /5 automatic retries/)

  const serverError = explainFailure('netlify agents:create failed: 502 bad gateway', { attempts: 3 })
  assert.equal(serverError?.code, 'netlify_5xx')
  assert.match(serverError.message, /status\.netlify\.com/)
})

test('explainFailure maps expired token wording', () => {
  const explained = explainFailure('netlify agents:create failed: Access token has expired', {})
  assert.equal(explained?.code, 'token_expired')
  assert.match(explained.message, /netlify login/)
})

test('explainFailure returns null for unknown detail', () => {
  assert.equal(explainFailure('netlify agents:create failed: something exploded', {}), null)
  assert.equal(explainFailure('', {}), null)
})

test('wrapFailure prepends guidance and preserves the original detail', () => {
  const original = new Error('netlify agents:create --json failed: Not Found (404)')
  const wrapped = wrapFailure(original, { siteId: 'site-9' })
  assert.notEqual(wrapped, original)
  assert.match(wrapped.message, /wrong Netlify account/)
  assert.match(wrapped.message, /Not Found \(404\)/)
})

test('wrapFailure returns unknown errors untouched', () => {
  const original = new Error('netlify agents:create failed: something exploded')
  assert.equal(wrapFailure(original, {}), original)
})
