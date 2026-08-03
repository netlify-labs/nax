const assert = require('assert/strict')
const test = require('node:test')
const os = require('os')
const path = require('path')

const {
  DEFAULT_USER_AGENT,
  createNetlifyApiClient,
  errorCodeForStatus,
  normalizeAgentRunner,
  redactToken,
} = require('../../src/integrations/netlify/api-client')

/**
 * @param {Array<{
 *   status?: number,
 *   body?: unknown | ((call: { url: string, options: RequestInit, calls: Array<{ url: string, options: RequestInit }> }) => unknown),
 * }>} responses
 */
function fakeFetch(responses) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), options }
    calls.push(call)
    const next = responses.shift() || { status: 200, body: {} }
    const status = next.status ?? 200
    const responseBody = typeof next.body === 'function'
      ? next.body({ ...call, calls })
      : next.body
    const body = status === 204
      ? null
      : (typeof responseBody === 'string'
          ? responseBody
          : JSON.stringify(responseBody ?? {}))
    return new Response(body, { status })
  }
  return {
    calls,
    fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl)),
  }
}

test('Netlify API client constructs authenticated create runner requests', async () => {
  const fake = fakeFetch([
    { body: { id: 'runner-1', state: 'submitted' } },
    {
      body: ({ calls }) => {
        const request = JSON.parse(String(calls[0].options.body))
        return [{
          id: 'session-1',
          agent_runner_id: 'runner-1',
          state: 'submitted',
          prompt: request.prompt,
          usage: null,
        }]
      },
    },
    { body: { id: 'runner-1', state: 'submitted' } },
    {
      body: {
        id: 'session-1',
        agent_runner_id: 'runner-1',
        state: 'submitted',
        prompt: 'Do work',
        usage: null,
      },
    },
  ])
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

  assert.equal(fake.calls[0].url, 'https://api.example.test/api/v1/agent_runners?site_id=site-1')
  assert.equal(fake.calls[0].options.method, 'POST')
  assert.equal(fake.calls[0].options.headers.authorization, 'Bearer secret-token')
  assert.equal(fake.calls[0].options.headers['user-agent'], DEFAULT_USER_AGENT)
  const body = JSON.parse(String(fake.calls[0].options.body))
  assert.match(body.prompt, /^Do work\n\n<!-- agent-runner-sdk-request-id:/)
  assert.deepEqual(body, {
    prompt: body.prompt,
    agent: 'codex',
    branch: 'main',
  })
  assert.equal(
    fake.calls[1].url,
    'https://api.example.test/api/v1/agent_runners/runner-1/sessions?page=1&per_page=100&order_by=asc',
  )
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

  const fake = fakeFetch([{
    body: [{
      id: 'session-2',
      agent_runner_id: 'runner-1',
      state: 'completed',
      usage: null,
    }],
  }])
  const client = createNetlifyApiClient({ fetch: fake.fetch, token: 'token' })
  const sessions = await client.listAgentSessions({ runnerId: 'runner-1' })
  assert.equal(
    fake.calls[0].url,
    'https://api.netlify.com/api/v1/agent_runners/runner-1/sessions?page=1&per_page=100&order_by=asc',
  )
  assert.equal(sessions[0].sessionId, 'session-2')
})

test('Netlify API client validates token, site id, and runner id', async () => {
  const client = createNetlifyApiClient({
    fetch: fakeFetch([]).fetch,
    token: '',
    env: {},
    home: path.join(os.tmpdir(), 'nax-api-client-no-auth'),
  })
  await assert.rejects(() => client.getAgentRunner({ runnerId: 'runner-1' }), /token is required/)

  const authed = createNetlifyApiClient({
    fetch: fakeFetch([]).fetch,
    token: 'token',
    env: {},
  })
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

test('Netlify API client preserves token/site precedence and response normalization', async () => {
  const fake = fakeFetch([
    { body: { id: 'runner-1', state: 'running' } },
    {
      body: ({ calls }) => {
        const request = JSON.parse(String(calls[0].options.body))
        return [{
          id: 'session-1',
          agent_runner_id: 'runner-1',
          state: 'running',
          prompt: request.prompt,
          usage: null,
        }]
      },
    },
    { body: { id: 'runner-1', state: 'running' } },
    {
      body: {
        id: 'session-1',
        agent_runner_id: 'runner-1',
        state: 'running',
        usage: null,
      },
    },
    { body: 'plain response' },
    { status: 204 },
  ])
  const client = createNetlifyApiClient({
    fetch: fake.fetch,
    token: 'constructor-token',
    env: {
      NETLIFY_AUTH_TOKEN: 'env-token',
      NETLIFY_SITE_ID: 'env-site',
    },
    siteId: 'constructor-site',
    baseUrl: 'https://api.example.test/api/v1/',
  })

  await client.createAgentRunner({ promptText: 'work' })
  const text = await client.request('GET', '/text', {
    token: 'operation-token',
  })
  const empty = await client.request('DELETE', '/empty')

  assert.match(fake.calls[0].url, /constructor-site/)
  assert.equal(
    fake.calls[0].options.headers.authorization,
    'Bearer constructor-token',
  )
  assert.equal(
    fake.calls[4].options.headers.authorization,
    'Bearer operation-token',
  )
  assert.deepEqual(text, { text: 'plain response' })
  assert.equal(empty, null)
})

test('Netlify API client exposes non-throwing responses and safe request metadata', async () => {
  const events = []
  const fake = fakeFetch([
    { status: 403, body: { error: 'response-secret' } },
    { status: 403, body: { error: 'response-secret' } },
  ])
  const client = createNetlifyApiClient({
    fetch: fake.fetch,
    token: 'token-secret',
    baseUrl: 'https://api.example.test/api/v1',
    onRequestFailure: (event) => events.push(event),
  })

  const response = await client.requestResponse(
    'get',
    '/sites/site-1?query=query-secret',
  )
  assert.equal(response.ok, false)
  assert.equal(response.apiPath, '/api/v1/sites/site-1')
  assert.equal(response.method, 'GET')

  await assert.rejects(
    () => client.request('GET', '/sites/site-1?query=query-secret'),
    (error) => {
      const typed = /** @type {{
       *   statusCode?: number,
       *   code?: string,
       *   requestMeta?: { method: string, apiPath: string, attempts: number },
       * }} */ (error)
      assert.equal(typed.statusCode, 403)
      assert.equal(typed.code, 'runner_permission_denied')
      assert.deepEqual(typed.requestMeta, {
        method: 'GET',
        apiPath: '/api/v1/sites/site-1',
        attempts: 1,
      })
      return true
    },
  )

  const serialized = JSON.stringify(events)
  assert.doesNotMatch(
    serialized,
    /token-secret|query-secret|response-secret/,
  )
})

test('Netlify API client constrains authenticated destinations to its API base', async () => {
  const fake = fakeFetch([{ body: {} }])
  const client = createNetlifyApiClient({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })

  await client.request('GET', 'https://attacker.invalid/collect')
  assert.equal(
    fake.calls[0].url,
    'https://api.example.test/api/v1/https://attacker.invalid/collect',
  )
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

  const run = await client.request('GET', '/runner')
  assert.equal(/** @type {{ id?: string }} */ (run).id, 'runner-1')
  assert.equal(fake.calls.length, 2)

  const failing = createNetlifyApiClient({
    fetch: fakeFetch([{ status: 401, body: { error: 'bad secret-token' } }]).fetch,
    token: 'secret-token',
  })
  await assert.rejects(
    () => failing.request('GET', '/runner-2'),
    (error) => {
      const typed = /** @type {{ code?: string, message?: string }} */ (error)
      assert.equal(typed.code, 'runner_auth_failed')
      assert.doesNotMatch(String(typed.message), /secret-token/)
      return true
    }
  )
})

test('Netlify API client redacts prompt and request markers from error messages', async () => {
  const prompt = 'sensitive prompt body'
  const marker = '<!-- agent-runner-sdk-request-id:44444444-4444-4444-8444-444444444444 -->'
  const client = createNetlifyApiClient({
    fetch: fakeFetch([{
      status: 422,
      body: { error: `${prompt}\n${marker}` },
    }]).fetch,
    token: 'token',
  })

  await assert.rejects(
    () => client.request('POST', '/runs', {
      body: { prompt: `${prompt}\n${marker}` },
    }),
    (error) => {
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
        /sensitive prompt|agent-runner-sdk-request-id/,
      )
      return true
    },
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
