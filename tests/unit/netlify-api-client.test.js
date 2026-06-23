const assert = require('assert/strict')
const test = require('node:test')

const {
  createNetlifyApiClient,
  errorCodeForStatus,
  normalizeAgentRunner,
  redactToken,
} = require('../../src/netlify/api-client')

/** @param {Array<{ status?: number, body?: unknown, ok?: boolean }>} responses */
function fakeFetch(responses) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const next = responses.shift() || { status: 200, body: {} }
    const status = next.status || 200
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body || {})
    return new Response(body, { status })
  }
  return {
    calls,
    fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl)),
  }
}

test('Netlify API client constructs authenticated create runner requests', async () => {
  const fake = fakeFetch([{ body: { id: 'runner-1', state: 'submitted', latest_session: { id: 'session-1' }, links: { app: 'url' } } }])
  const client = createNetlifyApiClient({
    fetch: fake.fetch,
    token: 'secret-token',
    siteId: 'site-1',
    baseUrl: 'https://api.example.test/api/v1/',
  })

  const run = await client.createAgentRunner({
    promptText: 'Do work',
    agent: 'codex',
    branch: 'main',
  })

  assert.equal(fake.calls[0].url, 'https://api.example.test/api/v1/sites/site-1/agent-runners')
  assert.equal(fake.calls[0].options.method, 'POST')
  assert.equal(fake.calls[0].options.headers.authorization, 'Bearer secret-token')
  assert.deepEqual(JSON.parse(String(fake.calls[0].options.body)), {
    prompt: 'Do work',
    agent: 'codex',
    branch: 'main',
    source: {},
  })
  assert.equal(run.runnerId, 'runner-1')
  assert.equal(run.sessionId, 'session-1')
  assert.equal(run.status, 'submitted')
})

test('Netlify API client normalizes session lists and runner links', async () => {
  const normalized = normalizeAgentRunner({
    runner_id: 'runner-1',
    latest_session_state: 'completed',
    session_id: 'session-1',
    url: 'https://app.netlify.com/runner-1',
  })
  assert.equal(normalized.runnerId, 'runner-1')
  assert.equal(normalized.sessionId, 'session-1')
  assert.equal(normalized.links.url, 'https://app.netlify.com/runner-1')

  const fake = fakeFetch([{ body: { sessions: [{ id: 'session-2', state: 'completed' }] } }])
  const client = createNetlifyApiClient({ fetch: fake.fetch, token: 'token' })
  const sessions = await client.listAgentSessions({ runnerId: 'runner-1' })
  assert.equal(fake.calls[0].url, 'https://api.netlify.com/api/v1/agent-runners/runner-1/sessions')
  assert.equal(sessions[0].sessionId, 'session-2')
})

test('Netlify API client validates token, site id, and runner id', async () => {
  const client = createNetlifyApiClient({ fetch: fakeFetch([]).fetch, token: '' })
  await assert.rejects(() => client.getAgentRunner({ runnerId: 'runner-1' }), /token is required/)

  const authed = createNetlifyApiClient({ fetch: fakeFetch([]).fetch, token: 'token' })
  await assert.rejects(
    () => authed.createAgentRunner({ promptText: 'x' }),
    (error) => {
      const typed = /** @type {{ code?: string }} */ (error)
      assert.equal(typed.code, 'runner_validation_failed')
      return true
    }
  )
  await assert.rejects(() => authed.cancelAgentRunner({}), /Agent Runner ID is required/)
})

test('Netlify API client maps API errors, retries retryable statuses, and redacts tokens', async () => {
  const fake = fakeFetch([
    { status: 429, body: { error: 'rate limit secret-token' } },
    { status: 200, body: { id: 'runner-1', state: 'running' } },
  ])
  const client = createNetlifyApiClient({
    fetch: fake.fetch,
    token: 'secret-token',
    retryAttempts: 2,
    sleep: async () => {},
  })

  const run = await client.getAgentRunner({ runnerId: 'runner-1' })
  assert.equal(run.runnerId, 'runner-1')
  assert.equal(fake.calls.length, 2)

  const failing = createNetlifyApiClient({
    fetch: fakeFetch([{ status: 401, body: { error: 'bad secret-token' } }]).fetch,
    token: 'secret-token',
  })
  await assert.rejects(
    () => failing.getAgentRunner({ runnerId: 'runner-2' }),
    (error) => {
      const typed = /** @type {{ code?: string, message?: string }} */ (error)
      assert.equal(typed.code, 'runner_auth_failed')
      assert.doesNotMatch(String(typed.message), /secret-token/)
      return true
    }
  )
})

test('Netlify API client exposes error code mapping helpers', () => {
  assert.equal(errorCodeForStatus(403), 'runner_permission_denied')
  assert.equal(errorCodeForStatus(404), 'runner_not_found')
  assert.equal(errorCodeForStatus(422), 'runner_validation_failed')
  assert.equal(errorCodeForStatus(429), 'runner_rate_limited')
  assert.equal(errorCodeForStatus(503), 'runner_transport_error')
  assert.equal(redactToken('token-1', 'failed token-1'), 'failed [redacted]')
})
