// Tests for the agent-runner failure guidance table: known stderr signatures
// map to actionable messages while preserving the original error detail.
const test = require('node:test')
const assert = require('node:assert/strict')

const { describeTimeout, explainFailure, wrapFailure } = require('../../src/integrations/netlify/failure-guidance')

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
  const wrapped = /** @type {Error} */ (wrapFailure(original, { siteId: 'site-9' }))
  assert.notEqual(wrapped, original)
  assert.match(wrapped.message, /wrong Netlify account/)
  assert.match(wrapped.message, /Not Found \(404\)/)
})

test('wrapFailure returns unknown errors untouched', () => {
  const original = new Error('netlify agents:create failed: something exploded')
  assert.equal(wrapFailure(original, {}), original)
})

test('wrapFailure gives actionable SDK prompt and blob guidance without copying values', () => {
  const promptError = Object.assign(
    new Error('The prompt cannot be delivered within the configured byte ceiling.'),
    { code: 'prompt-too-large' },
  )
  const expiredError = Object.assign(
    new Error('The Agent Runner prompt reference has expired.'),
    { code: 'prompt-ref-expired' },
  )
  const blobError = Object.assign(
    new Error('The prompt blob could not be stored.'),
    { code: 'blob-write-failed' },
  )

  const wrappedPrompt = wrapFailure(promptError)
  const wrappedExpired = wrapFailure(expiredError)
  const wrappedBlob = wrapFailure(blobError)
  assert.ok(wrappedPrompt instanceof Error)
  assert.ok(wrappedExpired instanceof Error)
  assert.ok(wrappedBlob instanceof Error)
  assert.match(wrappedPrompt.message, /inline or blob delivery limits/)
  assert.equal(/** @type {Error & { code?: string }} */ (wrappedPrompt).code, 'prompt_too_large')
  assert.match(wrappedExpired.message, /Start a fresh run/)
  assert.equal(/** @type {Error & { code?: string }} */ (wrappedExpired).code, 'prompt_ref_expired')
  assert.match(wrappedBlob.message, /selected site and NETLIFY_AUTH_TOKEN access/)
  assert.equal(/** @type {Error & { code?: string }} */ (wrappedBlob).code, 'blob_delivery_failed')
})

test('describeRunFailure prepends guidance when matched and passes detail through otherwise', () => {
  const { describeRunFailure } = require('../../src/integrations/netlify/failure-guidance')
  const explained = describeRunFailure('The Codex model is currently at capacity. Retrying automatically...', {})
  assert.match(explained, /at capacity/)
  assert.match(explained, /switch the step's agent/)

  const passthrough = describeRunFailure('agent crashed with a novel error', {})
  assert.equal(passthrough, 'agent crashed with a novel error')

  assert.equal(describeRunFailure('', {}), '')
})

test('describeTimeout says a runner left running is still working and how to resume', () => {
  const run = {
    agent: 'claude',
    runnerId: 'runner-1',
    status: 'timeout',
    links: { agentRunUrl: 'https://app.netlify.com/runs/runner-1' },
    raw: { timeout: { cancelledRunner: false } },
  }
  const message = describeTimeout(run, { timeoutMinutes: 10, resumeCommand: 'nax run --resume run-1' })
  assert.match(message, /runner-1 is still running on Netlify/)
  assert.match(message, /stopped waiting after 10 min \(--timeout-minutes\)/)
  assert.match(message, /https:\/\/app\.netlify\.com\/runs\/runner-1/)
  assert.match(message, /nax run --resume run-1/)
  assert.doesNotMatch(message, /nax salvage/)
})

test('describeTimeout without a resume command points a running runner at salvage', () => {
  const run = { agent: 'claude', runnerId: 'runner-1', status: 'timeout', raw: { timeout: { cancelledRunner: false } } }
  const message = describeTimeout(run, { timeoutMinutes: 10 })
  assert.match(message, /When it finishes, commit its diff to a branch with: nax salvage --runner runner-1/)
  assert.doesNotMatch(message, /Resume waiting/)
})

test('describeTimeout at or past the 25-minute runner max says the run hit the limit', () => {
  const run = {
    agent: 'claude',
    runnerId: 'runner-1',
    status: 'timeout',
    fileChanges: { hasChanges: true },
    links: { agentRunUrl: 'https://app.netlify.com/runs/runner-1' },
    raw: { timeout: { cancelledRunner: false } },
  }
  for (const timeoutMinutes of [25, 60]) {
    const message = describeTimeout(run, { timeoutMinutes, resumeCommand: 'nax run --resume run-1' })
    assert.match(message, /Runner runner-1 hit the 25-minute agent runner limit/)
    assert.match(message, /Its diff is recoverable: nax salvage --runner runner-1/)
    assert.match(message, /Split the remaining work into smaller runs/)
    assert.match(message, /View run: https:\/\/app\.netlify\.com\/runs\/runner-1/)
    assert.doesNotMatch(message, /still running|Resume waiting/)
  }
})

test('describeTimeout on a cancelled runner with a diff points at salvage', () => {
  const run = {
    agent: 'claude',
    runnerId: 'runner-1',
    status: 'timeout',
    fileChanges: { hasChanges: true },
    raw: { timeout: { cancelledRunner: true } },
  }
  const message = describeTimeout(run, { timeoutMinutes: 25 })
  assert.match(message, /nax cancelled runner runner-1 after 25 min \(--cancel-on-timeout\)/)
  assert.match(message, /nax salvage --runner runner-1/)
})

test('describeTimeout is empty for runs that did not time out', () => {
  assert.equal(describeTimeout({ status: 'failed', runnerId: 'runner-1' }, { timeoutMinutes: 25 }), '')
})
