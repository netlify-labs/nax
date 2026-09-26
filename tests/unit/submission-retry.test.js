// Verifies nax submission retry semantics end to end through the Agent Runner SDK: transient
// pre-send failures retry with backoff, while permanent and possibly-sent failures never do.
// Only the network boundary (globalThis.fetch) is replaced; nax and the SDK run unmodified.
const test = require('node:test')
const assert = require('node:assert/strict')

const { submitLocalAgentRun } = require('../../src/integrations/netlify/local-runner')

const RUNNER = { id: 'runner-1', state: 'running', site_id: 'site-1', current_session_id: 'session-1' }

/** @param {string} code */
function networkError(code) {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })
}

/**
 * Serves the Agent Runner API; `createOutcomes` scripts successive POST /agent_runners results.
 * @param {Array<Error | number>} createOutcomes
 */
function fakeApi(createOutcomes) {
  const creates = { count: 0 }
  // The SDK finds the initial session by the request marker it embeds in the submitted prompt.
  let session = { id: 'session-1', agent_runner_id: 'runner-1', state: 'running', prompt: '' }
  /** @param {string | URL | Request} input @param {RequestInit} [init] */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = String(init.method || 'GET').toUpperCase()
    if (method === 'POST' && url.pathname.endsWith('/agent_runners')) {
      const outcome = createOutcomes[creates.count]
      creates.count += 1
      if (outcome instanceof Error) throw outcome
      if (typeof outcome === 'number') return new Response(JSON.stringify({ error: `status ${outcome}` }), { status: outcome })
      session = { ...session, prompt: String(JSON.parse(String(init.body || '{}')).prompt || '') }
      return new Response(JSON.stringify(RUNNER), { status: 201 })
    }
    if (url.pathname.endsWith('/sessions')) return new Response(JSON.stringify([session]))
    if (url.pathname.includes('/sessions/')) return new Response(JSON.stringify(session))
    if (url.pathname.endsWith('/agent_runners/runner-1')) return new Response(JSON.stringify(RUNNER))
    return new Response(JSON.stringify({ error: `unexpected ${method} ${url.pathname}` }), { status: 404 })
  }
  return { fetch, creates }
}

/**
 * @param {ReturnType<typeof fakeApi>} api
 * @returns {Promise<{ result: import('../../src/types').AgentRun | null, error: unknown, retries: Array<{ attempt: number, nextAttempt: number, attempts: number, delayMs: number }> }>}
 */
async function submit(api) {
  /** @type {Array<{ attempt: number, nextAttempt: number, attempts: number, delayMs: number }>} */
  const retries = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (api.fetch)
  try {
    const result = await submitLocalAgentRun({
      run: /** @type {import('../../src/types').AgentRun} */ ({ agent: 'codex', instanceId: 'codex:auto:auto', promptText: 'Review it.', raw: { stepId: 'review' } }),
      branch: 'main',
      siteId: 'site-1',
      env: { NETLIFY_AUTH_TOKEN: 'test-token', NAX_PROMPT_BLOB_DISABLE: '1' },
      retryAttempts: 5,
      retryDelayMs: 5000,
      onRetry: ({ attempt, nextAttempt, attempts, delayMs }) => { retries.push({ attempt, nextAttempt, attempts, delayMs }) },
      sleepFn: async () => {},
    })
    return { result, error: null, retries }
  } catch (error) {
    return { result: null, error, retries }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('transient pre-send failures retry with backoff until submission succeeds', async () => {
  const api = fakeApi([networkError('ECONNREFUSED'), networkError('ENOTFOUND'), networkError('EAI_AGAIN')])
  const { result, error, retries } = await submit(api)
  assert.equal(error, null)
  assert.equal(result?.status, 'submitted')
  assert.equal(result?.runnerId, 'runner-1')
  assert.equal(api.creates.count, 4)
  assert.deepEqual(retries.map(({ attempt, nextAttempt, attempts }) => [attempt, nextAttempt, attempts]), [[1, 2, 5], [2, 3, 5], [3, 4, 5]])
  for (const { delayMs } of retries) assert.ok(delayMs > 0 && delayMs <= 5000, `delay ${delayMs}`)
})

test('pre-send failures stop after the attempt budget', async () => {
  const api = fakeApi(Array.from({ length: 6 }, () => networkError('ECONNREFUSED')))
  const { error, retries } = await submit(api)
  assert.ok(error)
  assert.equal(api.creates.count, 5)
  assert.equal(retries.length, 4)
})

test('a permanent auth failure is not retried', async () => {
  const api = fakeApi([401])
  const { error, retries } = await submit(api)
  assert.ok(error)
  assert.equal(api.creates.count, 1)
  assert.equal(retries.length, 0)
})

test('a failure after the request may have been sent is not blindly retried', async () => {
  for (const outcome of [networkError('ECONNRESET'), 503]) {
    const api = fakeApi([outcome])
    const { error, retries } = await submit(api)
    assert.ok(error)
    assert.equal(api.creates.count, 1)
    assert.equal(retries.length, 0)
  }
})
