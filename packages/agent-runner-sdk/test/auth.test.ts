import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_USER_AGENT,
  createAuthenticatedNetlifyClient,
  isAgentRunnerSdkError,
  netlifyCliConfigCandidates,
  preflightNetlifyAccess,
  readNetlifyCliToken,
  redactSensitiveText,
  resolveNetlifyToken,
} from '../src/index.js'
import type {
  AuthTelemetryEvent,
} from '../src/index.js'

interface FetchCall {
  url: string
  options: RequestInit
}

interface FakeResponse {
  status?: number
  body?: unknown
  statusText?: string
  error?: Error
}

function fakeFetch(responses: FakeResponse[]) {
  const calls: FetchCall[] = []
  const implementation = async (
    input: string | URL | globalThis.Request,
    options: RequestInit = {},
  ): Promise<Response> => {
    calls.push({ url: String(input), options })
    const next = responses.shift() ?? { body: {} }
    if (next.error) throw next.error
    const status = next.status ?? 200
    const body = status === 204
      ? null
      : typeof next.body === 'string'
        ? next.body
        : JSON.stringify(next.body ?? {})
    return new Response(body, {
      status,
      statusText: next.statusText,
    })
  }
  return {
    calls,
    fetch: implementation as typeof globalThis.fetch,
  }
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeConfig(filePath: string, token: string): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, JSON.stringify({
    userId: 'user-1',
    users: {
      'user-1': {
        auth: { token },
      },
    },
  }))
}

test('CLI token candidates preserve compatibility order on every platform', () => {
  const home = '/test/home'
  const env = {
    XDG_CONFIG_HOME: '/test/xdg',
    APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
  }
  const historic = [
    join(home, 'Library', 'Preferences', 'netlify', 'config.json'),
    join('/test/xdg', 'netlify', 'config.json'),
    join(home, '.netlify', 'config.json'),
  ]

  assert.deepEqual(
    netlifyCliConfigCandidates({ home, env, platform: 'darwin' }),
    historic,
  )
  assert.deepEqual(
    netlifyCliConfigCandidates({ home, env, platform: 'linux' }),
    historic,
  )
  assert.deepEqual(
    netlifyCliConfigCandidates({ home, env, platform: 'win32' }),
    [
      join(env.APPDATA, 'netlify', 'Config', 'config.json'),
      ...historic,
    ],
  )
})

test('CLI token discovery supports env, macOS, XDG, Windows, and legacy paths', () => {
  assert.deepEqual(
    readNetlifyCliToken({
      env: { NETLIFY_AUTH_TOKEN: 'from-env' },
      home: '/does/not/exist',
    }),
    { token: 'from-env', source: 'NETLIFY_AUTH_TOKEN' },
  )

  const cases: Array<{
    platform: NodeJS.Platform
    env: NodeJS.ProcessEnv
    configPath: (home: string) => string
  }> = [
    {
      platform: 'darwin',
      env: {},
      configPath: (home) => join(
        home,
        'Library',
        'Preferences',
        'netlify',
        'config.json',
      ),
    },
    {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/placeholder' },
      configPath: () => '',
    },
    {
      platform: 'win32',
      env: { APPDATA: '/placeholder' },
      configPath: () => '',
    },
    {
      platform: 'linux',
      env: {},
      configPath: (home) => join(home, '.netlify', 'config.json'),
    },
  ]

  for (const [index, candidate] of cases.entries()) {
    const home = tempRoot(`agent-sdk-auth-${index}-`)
    const env = { ...candidate.env }
    let configPath = candidate.configPath(home)
    if (candidate.platform === 'linux' && env.XDG_CONFIG_HOME) {
      env.XDG_CONFIG_HOME = join(home, 'xdg')
      configPath = join(env.XDG_CONFIG_HOME, 'netlify', 'config.json')
    }
    if (candidate.platform === 'win32') {
      env.APPDATA = join(home, 'appdata')
      configPath = join(env.APPDATA, 'netlify', 'Config', 'config.json')
    }
    writeConfig(configPath, `from-config-${index}`)

    assert.deepEqual(
      readNetlifyCliToken({ home, env, platform: candidate.platform }),
      { token: `from-config-${index}`, source: configPath },
    )
  }
})

test('CLI token discovery skips corrupt and unknown config shapes', () => {
  const home = tempRoot('agent-sdk-auth-corrupt-')
  const corrupt = join(
    home,
    'Library',
    'Preferences',
    'netlify',
    'config.json',
  )
  const valid = join(home, '.config', 'netlify', 'config.json')
  mkdirSync(join(corrupt, '..'), { recursive: true })
  writeFileSync(corrupt, '{')
  writeConfig(valid, 'later-token')

  assert.deepEqual(
    readNetlifyCliToken({ home, env: {}, platform: 'linux' }),
    { token: 'later-token', source: valid },
  )

  writeFileSync(valid, JSON.stringify({
    userId: 'missing-user',
    users: {
      other: { auth: { token: 'must-not-adopt' } },
    },
  }))
  assert.deepEqual(
    readNetlifyCliToken({ home, env: {}, platform: 'linux' }),
    { token: '', source: '' },
  )
})

test('token resolution enforces operation, constructor, env, then CLI precedence', () => {
  const home = tempRoot('agent-sdk-auth-precedence-')
  const configPath = join(home, '.config', 'netlify', 'config.json')
  writeConfig(configPath, 'cli-token')

  assert.equal(resolveNetlifyToken({
    token: 'operation-token',
    constructorToken: 'constructor-token',
    env: { NETLIFY_AUTH_TOKEN: 'env-token' },
    home,
  }).token, 'operation-token')
  assert.equal(resolveNetlifyToken({
    constructorToken: 'constructor-token',
    env: { NETLIFY_AUTH_TOKEN: 'env-token' },
    home,
  }).token, 'constructor-token')
  assert.equal(resolveNetlifyToken({
    env: { NETLIFY_AUTH_TOKEN: 'env-token' },
    home,
  }).token, 'env-token')
  assert.equal(resolveNetlifyToken({ env: {}, home }).token, 'cli-token')
  assert.equal(resolveNetlifyToken({
    env: { NETLIFY_AGENT_RUNNER_TOKEN: 'unsupported' },
    home: tempRoot('agent-sdk-auth-alias-'),
  }).token, '')
})

test('redaction removes tokens, request values, markers, and bearer headers', () => {
  const marker =
    '<!-- agent-runner-sdk-request-id:44444444-4444-4444-8444-444444444444 -->'
  const redacted = redactSensitiveText(
    `Bearer token-secret prompt-secret ${marker}`,
    ['token-secret', { prompt: 'prompt-secret' }],
  )
  assert.doesNotMatch(
    redacted,
    /token-secret|prompt-secret|agent-runner-sdk-request-id/,
  )
  assert.match(redacted, /Bearer \[redacted\]/)
})

test('authenticated requests add metadata, normalize bodies, and constrain URLs', async () => {
  const fake = fakeFetch([
    { body: { ok: true } },
    { body: 'plain text' },
    { status: 204 },
  ])
  const client = createAuthenticatedNetlifyClient({
    fetch: fake.fetch,
    token: 'constructor-token',
    baseUrl: 'https://api.example.test/api/v1/',
  })

  const json = await client.requestResponse(
    'post',
    '/things?query=query-secret',
    {
      token: 'operation-token',
      body: { prompt: 'body-secret' },
    },
  )
  const text = await client.request('GET', 'https://attacker.invalid/path')
  const empty = await client.request('DELETE', '/empty')

  assert.deepEqual(json.payload, { ok: true })
  assert.deepEqual(text, { text: 'plain text' })
  assert.equal(empty, null)
  assert.equal(fake.calls[0]?.url, 'https://api.example.test/api/v1/things?query=query-secret')
  assert.equal(
    fake.calls[1]?.url,
    'https://api.example.test/api/v1/https://attacker.invalid/path',
  )
  assert.equal(fake.calls[0]?.options.method, 'POST')
  const headers = fake.calls[0]?.options.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer operation-token')
  assert.equal(headers['user-agent'], DEFAULT_USER_AGENT)
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(fake.calls[1]?.options.headers instanceof Headers, false)
})

test('response retry and telemetry share one value-free decision point', async () => {
  const telemetry: AuthTelemetryEvent[] = []
  const sleeps: number[] = []
  const fake = fakeFetch([
    { status: 429, body: { error: 'response-secret' } },
    { status: 503, body: { error: 'response-secret' } },
    { body: { ok: true } },
  ])
  const client = createAuthenticatedNetlifyClient({
    fetch: fake.fetch,
    token: 'token-secret',
    baseUrl: 'https://api.example.test/api/v1',
    retryAttempts: 3,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    onTelemetry: (event) => {
      telemetry.push(event)
      if (event.attempt === 1) throw new Error('observer-secret')
    },
  })

  const result = await client.requestResponse(
    'GET',
    '/runs?query=query-secret',
    {
      body: { prompt: 'body-secret' },
      operation: 'get-run',
    },
  )

  assert.equal(result.ok, true)
  assert.deepEqual(sleeps, [1_000, 2_000])
  assert.equal(telemetry.length, 2)
  assert.deepEqual(
    telemetry.map((event) => ({
      kind: event.kind,
      pathname: event.pathname,
      attempt: event.attempt,
      retrying: event.retrying,
    })),
    [
      {
        kind: 'httpFailure',
        pathname: '/api/v1/runs',
        attempt: 1,
        retrying: true,
      },
      {
        kind: 'httpFailure',
        pathname: '/api/v1/runs',
        attempt: 2,
        retrying: true,
      },
    ],
  )
  const serialized = JSON.stringify(telemetry)
  for (const secret of [
    'token-secret',
    'query-secret',
    'body-secret',
    'response-secret',
    'observer-secret',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret))
  }
})

test('authenticated requests retry only the documented HTTP statuses', async () => {
  for (const status of [408, 409, 425, 429, 500]) {
    const sleeps: number[] = []
    const fake = fakeFetch([
      { status },
      { body: { recovered: true } },
    ])
    const client = createAuthenticatedNetlifyClient({
      fetch: fake.fetch,
      token: 'token',
      retryAttempts: 2,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    assert.deepEqual(await client.request('GET', '/retry'), {
      recovered: true,
    })
    assert.deepEqual(sleeps, [1_000])
  }

  const fake = fakeFetch([{ status: 403 }, { body: { unexpected: true } }])
  const client = createAuthenticatedNetlifyClient({
    fetch: fake.fetch,
    token: 'token',
    retryAttempts: 2,
  })
  await assert.rejects(
    () => client.request('GET', '/no-retry'),
    (error: unknown) => isAgentRunnerSdkError(error, 'auth-permission'),
  )
  assert.equal(fake.calls.length, 1)
})

test('authenticated requests preserve an injected abort signal', async () => {
  const fake = fakeFetch([{ body: {} }])
  const signal = AbortSignal.abort()
  const client = createAuthenticatedNetlifyClient({
    fetch: fake.fetch,
    token: 'token',
  })

  await client.request('GET', '/signal', { signal })
  assert.equal(fake.calls[0]?.options.signal, signal)
})

test('network failures are immediate, redacted, and telemetry-safe', async () => {
  const telemetry: AuthTelemetryEvent[] = []
  const fake = fakeFetch([
    { error: new TypeError('network token-secret error-secret') },
  ])
  const client = createAuthenticatedNetlifyClient({
    fetch: fake.fetch,
    token: 'token-secret',
    retryAttempts: 3,
    onTelemetry: (event) => telemetry.push(event),
  })

  await assert.rejects(
    () => client.request('GET', '/user?query-secret'),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.name, 'TypeError')
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
        /token-secret|error-secret/,
      )
      return true
    },
  )
  assert.equal(fake.calls.length, 1)
  assert.equal(telemetry.length, 1)
  assert.doesNotMatch(
    JSON.stringify(telemetry),
    /token-secret|error-secret|query-secret/,
  )
})

test('response-body read failures use the same safe network boundary', async () => {
  const telemetry: AuthTelemetryEvent[] = []
  const fetchImpl: typeof globalThis.fetch = async () => {
    const response = new Response('{}', { status: 200 })
    response.text = async () => {
      throw new Error('body-read-secret')
    }
    return response
  }
  const client = createAuthenticatedNetlifyClient({
    fetch: fetchImpl,
    token: 'token',
    onTelemetry: (event) => telemetry.push(event),
  })

  await assert.rejects(
    () => client.request('GET', '/body'),
    (error: unknown) => {
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
        /body-read-secret/,
      )
      return true
    },
  )
  assert.equal(telemetry[0]?.kind, 'networkError')
  assert.doesNotMatch(JSON.stringify(telemetry), /body-read-secret/)
})

test('authenticated requests distinguish missing and rejected credentials', async () => {
  const missing = createAuthenticatedNetlifyClient({
    fetch: fakeFetch([]).fetch,
    env: { NETLIFY_AGENT_RUNNER_TOKEN: 'unsupported' },
    home: tempRoot('agent-sdk-auth-missing-'),
  })
  await assert.rejects(
    () => missing.request('GET', '/user'),
    (error: unknown) => isAgentRunnerSdkError(error, 'auth-missing'),
  )

  const rejected = createAuthenticatedNetlifyClient({
    fetch: fakeFetch([{ status: 401 }]).fetch,
    token: 'bad-token',
  })
  await assert.rejects(
    () => rejected.request('GET', '/user'),
    (error: unknown) => isAgentRunnerSdkError(error, 'auth-invalid'),
  )
})

test('typed request errors never include prompt or request-marker values', async () => {
  const prompt = 'sensitive prompt body'
  const marker =
    '<!-- agent-runner-sdk-request-id:44444444-4444-4444-8444-444444444444 -->'
  const client = createAuthenticatedNetlifyClient({
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
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.doesNotMatch(message, /sensitive prompt|agent-runner-sdk-request-id/)
      return isAgentRunnerSdkError(error, 'validation-error')
    },
  )
})

test('preflight distinguishes invalid, expired, and under-scoped credentials', async () => {
  const invalid = await preflightNetlifyAccess({
    siteId: 'site-1',
    token: 'bad',
    fetch: fakeFetch([{ status: 401, body: { error: 'invalid' } }]).fetch,
  })
  assert.equal(invalid.code, 'invalid-token')

  const expired = await preflightNetlifyAccess({
    siteId: 'site-1',
    token: 'old',
    fetch: fakeFetch([{ status: 401, body: { error: 'token expired' } }]).fetch,
  })
  assert.equal(expired.code, 'expired-token')

  const scoped = await preflightNetlifyAccess({
    siteId: 'site-1',
    token: 'limited',
    fetch: fakeFetch([
      { body: { email: 'user@example.com' } },
      { status: 403 },
    ]).fetch,
  })
  assert.deepEqual(scoped, {
    ok: false,
    code: 'under-scoped',
    status: 403,
    accountEmail: 'user@example.com',
  })
})

test('preflight preserves tolerant user lookup and guarded payload behavior', async () => {
  const fake = fakeFetch([
    { status: 500, body: 'not json' },
    { body: null },
  ])
  const result = await preflightNetlifyAccess({
    siteId: 'site/encoded',
    token: 'token',
    fetch: fake.fetch,
    baseUrl: 'https://api.example.test/api/v1',
  })

  assert.deepEqual(result, {
    ok: true,
    code: 'ok',
    accountEmail: '',
    site: {
      id: 'site/encoded',
      name: '',
      accountSlug: '',
    },
  })
  assert.equal(
    fake.calls[1]?.url,
    'https://api.example.test/api/v1/sites/site%2Fencoded',
  )
})
