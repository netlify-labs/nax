import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_BB_API_URL,
  HttpResponseError,
  createHttpTransport,
  isAgentRunnerSdkError,
} from '../src/index.js'
import type {
  TransportTelemetryEvent,
} from '../src/index.js'

interface FetchCall {
  url: string
  options: RequestInit
}

interface FakeResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  error?: Error
  readError?: Error
}

function fakeFetch(responses: FakeResponse[]) {
  const calls: FetchCall[] = []
  const fetch = async (
    input: string | URL | globalThis.Request,
    options: RequestInit = {},
  ): Promise<Response> => {
    calls.push({ url: String(input), options })
    const next = responses.shift()
    assert.ok(next, 'unexpected fetch call')
    if (next.error) throw next.error
    const status = next.status ?? 200
    const response = new Response(
      status === 202
        ? null
        : typeof next.body === 'string'
          ? next.body
          : JSON.stringify(next.body ?? {}),
      { status, headers: next.headers },
    )
    if (next.readError) {
      response.text = async () => {
        throw next.readError
      }
    }
    return response
  }
  return {
    calls,
    fetch: fetch as typeof globalThis.fetch,
  }
}

function runner(id = 'runner-1', state = 'running') {
  return {
    id,
    state,
    site_id: 'site-1',
    branch: 'main',
    code_origin: 'github',
    created_at: '2026-08-02T20:00:00Z',
  }
}

function session(
  id = 'session-1',
  state = 'running',
  createdAt = '2026-08-02T20:00:00Z',
) {
  return {
    id,
    agent_runner_id: 'runner-1',
    state,
    created_at: createdAt,
    agent_config: {
      agent: 'codex',
      model: 'gpt-test',
    },
    usage: {
      total_tokens: 12,
      total_credits_cost: 0.25,
    },
  }
}

function jsonBody(call: FetchCall): unknown {
  assert.equal(typeof call.options.body, 'string')
  return JSON.parse(call.options.body as string) as unknown
}

test('HTTP transport creates and reads snake-case runner resources', async () => {
  const fake = fakeFetch([
    { body: runner() },
    { body: runner('runner/encoded', 'completed') },
  ])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'constructor-token',
    baseUrl: 'https://api.example.test/api/v1',
  })

  const created = await transport.createRunner({
    siteId: 'site/encoded',
    prompt: 'do the work',
    agent: 'codex',
    model: 'gpt-test',
    branch: 'main',
    deployId: 'deploy-1',
    mode: 'normal',
    fileKeys: ['file-1'],
    requestId: 'request-1',
  })
  const fetched = await transport.getRunner('runner/encoded')

  assert.equal(created.runnerId, 'runner-1')
  assert.equal(created.codeOrigin, 'github')
  assert.equal(created.createdAt, Date.parse('2026-08-02T20:00:00Z'))
  assert.equal(fetched.runnerId, 'runner/encoded')
  assert.equal(
    fake.calls[0]?.url,
    'https://api.example.test/api/v1/agent_runners?site_id=site%2Fencoded',
  )
  assert.deepEqual(jsonBody(fake.calls[0] as FetchCall), {
    prompt: 'do the work',
    agent: 'codex',
    model: 'gpt-test',
    branch: 'main',
    deploy_id: 'deploy-1',
    mode: 'normal',
    file_keys: ['file-1'],
  })
  assert.equal(
    fake.calls[1]?.url,
    'https://api.example.test/api/v1/agent_runners/runner%2Fencoded',
  )
})

test('HTTP transport paginates sessions and preserves oldest-first order', async () => {
  const fake = fakeFetch([
    {
      body: [session('session-2', 'completed', '2026-08-02T20:02:00Z')],
      headers: {
        Total: '2',
        Link: '<https://api.example.test/api/v1/agent_runners/runner-1/sessions?page=2&per_page=100&order_by=asc>; rel="next"',
      },
    },
    {
      body: [session('session-1', 'completed', '2026-08-02T20:01:00Z')],
      headers: { Total: '2' },
    },
    { body: session() },
    { status: 202 },
    { status: 202 },
  ])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })

  const sessions = await transport.listSessions('runner-1')
  const fetched = await transport.getSession('runner-1', 'session-1')
  await transport.cancelSession('runner-1', 'session-1')
  await transport.cancelRunner('runner-1')

  assert.deepEqual(
    sessions.map((item) => item.sessionId),
    ['session-1', 'session-2'],
  )
  assert.deepEqual(sessions[0]?.usage, {
    totalTokens: 12,
    totalCreditsCost: 0.25,
  })
  assert.equal(fetched.agent, 'codex')
  assert.match(
    fake.calls[0]?.url ?? '',
    /sessions\?page=1&per_page=100&order_by=asc$/,
  )
  assert.match(fake.calls[1]?.url ?? '', /sessions\?page=2&/)
  assert.equal(fake.calls[3]?.options.method, 'DELETE')
  assert.equal(fake.calls[4]?.options.method, 'DELETE')
})

test('empty usage payloads normalize to null without invented values', async () => {
  const fake = fakeFetch([{
    body: {
      ...session(),
      usage: {},
    },
  }])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })

  assert.equal(
    (await transport.getSession('runner-1', 'session-1')).usage,
    null,
  )
})

test('HTTP transport creates sessions with the exact follow-up body', async () => {
  const fake = fakeFetch([{ body: session('session-2') }])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })

  const created = await transport.createSession('runner/one', {
    prompt: 'continue',
    agent: 'codex',
    model: 'gpt-test',
    mode: 'ask',
    fileKeys: ['file-1'],
    requestId: 'request-2',
  })

  assert.equal(created.sessionId, 'session-2')
  assert.equal(
    fake.calls[0]?.url,
    'https://api.example.test/api/v1/agent_runners/runner%2Fone/sessions',
  )
  assert.deepEqual(jsonBody(fake.calls[0] as FetchCall), {
    prompt: 'continue',
    agent: 'codex',
    model: 'gpt-test',
    mode: 'ask',
    file_keys: ['file-1'],
  })
})

test('HTTP transport sends exact member verbs and bodies', async () => {
  const fake = fakeFetch([
    { body: runner() },
    { body: runner() },
    { body: session() },
    { body: runner() },
    { body: 'diff --git a/a b/a' },
    { body: runner() },
    { body: session() },
    { body: runner() },
    { status: 202 },
  ])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })

  await transport.member('runner-1', 'pull_request', {})
  await transport.member('runner-1', 'commit', {
    targetBranch: 'agent-change',
  })
  await transport.member('runner-1', 'merge_target', {})
  await transport.member('runner-1', 'sync_git_origin', {})
  const diff = await transport.member('runner-1', 'diff', {
    page: 2,
    perPage: 10,
    stripBinary: true,
  })
  await transport.member('runner-1', 'revert', {
    sessionId: 'session-1',
  })
  await transport.member('runner-1', 'rebase', {})
  await transport.member('runner-1', 'publish_to_production', {})
  await transport.member('runner-1', 'archive', {})

  assert.deepEqual(diff, {
    diff: { kind: 'inline', text: 'diff --git a/a b/a' },
  })
  assert.deepEqual(jsonBody(fake.calls[1] as FetchCall), {
    target_branch: 'agent-change',
  })
  assert.equal(fake.calls[4]?.options.method, 'GET')
  assert.match(
    fake.calls[4]?.url ?? '',
    /\/diff\?page=2&per_page=10&strip_binary=true$/,
  )
  assert.deepEqual(jsonBody(fake.calls[5] as FetchCall), {
    session_id: 'session-1',
  })
  assert.equal(fake.calls[8]?.options.body, undefined)
})

test('create retries only pre-transmission failures and surfaces ambiguity', async () => {
  const dns = new TypeError('must be redacted', {
    cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
  })
  const reset = new TypeError('must be redacted', {
    cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
  })
  const sleeps: number[] = []
  const fake = fakeFetch([
    { error: dns },
    { body: runner() },
    { error: reset },
  ])
  let tick = 1_000
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
    retryAttempts: 3,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    now: () => {
      tick += 10
      return tick
    },
  })
  const input = {
    siteId: 'site-1',
    prompt: 'sensitive prompt',
    requestId: 'request-1',
  } as const

  assert.equal((await transport.createRunner(input)).runnerId, 'runner-1')
  assert.deepEqual(sleeps, [125])
  await assert.rejects(
    () => transport.createRunner(input),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'create-ambiguous')) return false
      assert.deepEqual(error.window, { sentAt: 1_030, failedAt: 1_040 })
      assert.doesNotMatch(
        error.message,
        /sensitive prompt|reset/,
      )
      return true
    },
  )
  assert.equal(fake.calls.length, 3)
})

test('session 409 carries causal input and never creates a blind retry', async () => {
  const fake = fakeFetch([{
    status: 409,
    body: {
      error: 'another session exists',
      error_code: 'active_session_exists',
    },
  }])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })
  const input = {
    prompt: 'follow up',
    requestId: 'request-2',
  } as const

  await assert.rejects(
    () => transport.createSession('runner-1', input),
    (error: unknown) => {
      assert.equal(
        isAgentRunnerSdkError(error, 'session-already-active'),
        true,
      )
      if (!isAgentRunnerSdkError(error, 'session-already-active')) return false
      assert.equal(error.effectiveInput.requestId, 'request-2')
      return true
    },
  )
  assert.equal(fake.calls.length, 1)
})

test('sanitized live evidence pins the transport boundary', () => {
  const evidence = JSON.parse(readFileSync(
    new URL(
      './fixtures/contracts/live-v1-2026-08-02.json',
      import.meta.url,
    ),
    'utf8',
  )) as {
    runnerCreate: {
      request: { method: string; path: string; query: { site_id: string } }
    }
    siteRunnerList: {
      request: { timeUnit: string }
      orderingProof: { fact: string }
    }
    sessionCreate: {
      activeSessionConflict: { status: number; error_code: string }
    }
    githubCompareAndSwap: {
      mismatchedHead: { status: number; mergedAfterRequest: boolean }
    }
  }

  assert.deepEqual(evidence.runnerCreate.request, {
    method: 'POST',
    path: '/api/v1/agent_runners',
    query: { site_id: '{siteId}' },
    bodyFields: ['agent', 'branch', 'prompt'],
  })
  assert.equal(evidence.siteRunnerList.request.timeUnit, 'Unix seconds')
  assert.match(
    evidence.siteRunnerList.orderingProof.fact,
    /last_session_created_at/,
  )
  assert.deepEqual(evidence.sessionCreate.activeSessionConflict, {
    status: 409,
    error_code: 'active_session_exists',
  })
  assert.deepEqual(evidence.githubCompareAndSwap.mismatchedHead, {
    method: 'PUT',
    path: '/repos/netlify-labs/agent-sdk-canary/pulls/1/merge',
    requestFields: ['merge_method', 'sha'],
    status: 409,
    messageCategory: 'head-modified',
    mergedAfterRequest: false,
    headUnchanged: true,
  })
})

test('runner list queries preserve Unix seconds, headers, and backend order', async () => {
  const runnerA = {
    ...runner('runner-a', 'completed'),
    created_at: '2026-08-02T20:00:00Z',
    last_session_created_at: '2026-08-02T20:05:00Z',
  }
  const runnerB = {
    ...runner('runner-b', 'completed'),
    created_at: '2026-08-02T20:01:00Z',
    last_session_created_at: '2026-08-02T20:04:00Z',
  }
  const fake = fakeFetch([
    {
      body: [runnerA, runnerB],
      headers: {
        Total: '3',
        Link: '<https://api.example.test/api/v1/agent_runners?page=2>; rel="next", <https://api.example.test/api/v1/agent_runners?page=2>; rel="last"',
      },
    },
    {
      body: [runnerA],
      headers: {
        Total: '10878',
        Link: '<https://api.example.test/api/v1/team-slug/agent_runners?page=2>; rel="next"',
      },
    },
  ])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })

  const page = await transport.listRunners({
    siteId: 'site/one',
    accountId: 'account-1',
    from: 1_754_165_000,
    to: 1_754_165_120,
    state: 'live',
    title: 'Canary',
    branch: 'main',
    resultBranch: 'agent-change',
    userId: 'user-1',
    page: 1,
    perPage: 2,
  })
  const account = await transport.listAccountRunners({
    accountSlug: 'team/slug',
    perPage: 101,
  })

  assert.deepEqual(page.items.map((item) => item.runnerId), [
    'runner-a',
    'runner-b',
  ])
  assert.equal(page.nextPage, 2)
  assert.equal(page.total, 3)
  const siteUrl = new URL(fake.calls[0]?.url ?? '')
  assert.equal(siteUrl.pathname, '/api/v1/agent_runners')
  assert.deepEqual(Object.fromEntries(siteUrl.searchParams), {
    site_id: 'site/one',
    account_id: 'account-1',
    from: '1754165000',
    to: '1754165120',
    state: 'live',
    title: 'Canary',
    branch: 'main',
    result_branch: 'agent-change',
    user_id: 'user-1',
    page: '1',
    per_page: '2',
  })
  const accountUrl = new URL(fake.calls[1]?.url ?? '')
  assert.equal(
    accountUrl.pathname,
    '/api/v1/team%2Fslug/agent_runners',
  )
  assert.equal(accountUrl.searchParams.get('per_page'), '100')
  assert.equal(account.total, 10878)
  assert.equal(account.nextPage, 2)
})

test('per-call token wins without entering telemetry', async () => {
  const telemetry: TransportTelemetryEvent[] = []
  const fake = fakeFetch([{ body: runner() }])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'constructor-token',
    baseUrl: 'https://api.example.test/api/v1',
    onTelemetry: (event) => telemetry.push(event),
  })

  await transport.getRunner('runner-1', { token: 'operation-token' })

  const headers = fake.calls[0]?.options.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer operation-token')
  assert.doesNotMatch(
    JSON.stringify(telemetry),
    /constructor-token|operation-token/,
  )
})

test('bb-api style uses its gateway and camel-case fallback only explicitly', async () => {
  const fake = fakeFetch([
    {
      body: {
        runnerId: 'runner-camel',
        state: 'completed',
        siteId: 'site-1',
        codeOrigin: 'github',
        createdAt: '2026-08-02T20:00:00Z',
      },
    },
  ])
  const transport = createHttpTransport({
    apiStyle: 'bb-api',
    fetch: fake.fetch,
    token: 'token',
  })

  const result = await transport.getRunner('runner-camel')
  assert.equal(result.runnerId, 'runner-camel')
  assert.equal(result.codeOrigin, 'github')
  assert.equal(
    fake.calls[0]?.url,
    `${DEFAULT_BB_API_URL}/agent_runners/runner-camel`,
  )

  const v1Fake = fakeFetch([{
    body: { runnerId: 'must-not-fallback', state: 'completed' },
  }])
  const v1 = createHttpTransport({
    fetch: v1Fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })
  await assert.rejects(
    () => v1.getRunner('runner-camel'),
    (error: unknown) => isAgentRunnerSdkError(error, 'invalid-api-shape'),
  )
})

test('safe operations retry every documented status and network failure', async () => {
  for (const status of [408, 409, 425, 429, 500]) {
    const sleeps: number[] = []
    const fake = fakeFetch([
      {
        status,
        headers: status === 429 ? { 'Retry-After': '2' } : undefined,
      },
      { body: runner() },
    ])
    const transport = createHttpTransport({
      fetch: fake.fetch,
      token: 'token',
      baseUrl: 'https://api.example.test/api/v1',
      retryAttempts: 2,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    assert.equal((await transport.getRunner('runner-1')).runnerId, 'runner-1')
    assert.deepEqual(sleeps, [status === 429 ? 2_000 : 125])
  }

  const reset = new TypeError('socket reset', {
    cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
  })
  const network = fakeFetch([{ error: reset }, { status: 202 }])
  const transport = createHttpTransport({
    fetch: network.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
    retryAttempts: 2,
    sleep: async () => {},
  })
  await transport.cancelRunner('runner-1')
  assert.equal(network.calls.length, 2)
})

test('create ambiguity includes HTTP and response-read uncertainty', async () => {
  const input = {
    siteId: 'site-1',
    prompt: 'sensitive create body',
    requestId: 'request-1',
  } as const

  for (const response of [
    { status: 500 },
    { readError: new Error('sensitive response failure'), body: runner() },
  ]) {
    const fake = fakeFetch([response])
    const transport = createHttpTransport({
      fetch: fake.fetch,
      token: 'token',
      baseUrl: 'https://api.example.test/api/v1',
      retryAttempts: 3,
    })
    await assert.rejects(
      () => transport.createRunner(input),
      (error: unknown) => {
        assert.equal(isAgentRunnerSdkError(error, 'create-ambiguous'), true)
        assert.doesNotMatch(
          error instanceof Error ? error.message : String(error),
          /sensitive create body|sensitive response failure/,
        )
        return true
      },
    )
    assert.equal(fake.calls.length, 1)
  }

  const limited = fakeFetch([{ status: 429 }])
  const transport = createHttpTransport({
    fetch: limited.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
  })
  await assert.rejects(
    () => transport.createRunner(input),
    (error: unknown) => isAgentRunnerSdkError(error, 'rate-limited'),
  )
  assert.equal(limited.calls.length, 1)
})

test('non-create member POSTs are not replayed after failure', async () => {
  const fake = fakeFetch([{ status: 500 }])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
    retryAttempts: 3,
  })

  await assert.rejects(
    () => transport.member('runner-1', 'pull_request', {}),
    (error: unknown) => {
      assert.equal(error instanceof HttpResponseError, true)
      return isAgentRunnerSdkError(error, 'http-error')
    },
  )
  assert.equal(fake.calls.length, 1)
})

test('HTTP statuses have stable typed mappings', async () => {
  const cases = [
    [401, 'auth-invalid'],
    [403, 'auth-permission'],
    [404, 'not-found'],
    [400, 'validation-error'],
    [422, 'validation-error'],
    [429, 'rate-limited'],
    [500, 'http-error'],
  ] as const

  for (const [status, code] of cases) {
    const fake = fakeFetch([{
      status,
      body: { error: 'sensitive server body' },
    }])
    const transport = createHttpTransport({
      fetch: fake.fetch,
      token: 'token',
      baseUrl: 'https://api.example.test/api/v1',
      retryAttempts: 1,
    })
    await assert.rejects(
      () => transport.getRunner('runner-1'),
      (error: unknown) => {
        assert.equal(isAgentRunnerSdkError(error, code), true)
        assert.equal(error instanceof HttpResponseError && error.status, status)
        assert.doesNotMatch(
          error instanceof Error ? error.message : String(error),
          /sensitive server body/,
        )
        return true
      },
    )
  }
})

test('additive fields log once while required fields fail closed', async () => {
  const telemetry: TransportTelemetryEvent[] = []
  const fake = fakeFetch([
    { body: { ...runner(), future_field: 'value-1' } },
    { body: { ...runner(), future_field: 'value-2' } },
    { body: { state: 'completed' } },
    { body: { id: 'runner-1' } },
    { body: { id: 42, state: 'completed' } },
    {
      body: {
        id: 'session-1',
        state: 'completed',
      },
    },
    {
      body: {
        agent_runner_id: 'runner-1',
        state: 'completed',
      },
    },
    {
      body: {
        id: 'session-1',
        agent_runner_id: 'runner-1',
      },
    },
  ])
  const transport = createHttpTransport({
    fetch: fake.fetch,
    token: 'token',
    baseUrl: 'https://api.example.test/api/v1',
    onTelemetry: (event) => telemetry.push(event),
  })

  await transport.getRunner('runner-1')
  await transport.getRunner('runner-1')
  assert.deepEqual(telemetry.filter((event) => event.kind === 'apiDrift'), [{
    kind: 'apiDrift',
    entity: 'runner',
    field: 'future_field',
  }])

  for (const field of ['id', 'state', 'id']) {
    await assert.rejects(
      () => transport.getRunner('runner-1'),
      (error: unknown) => {
        if (!isAgentRunnerSdkError(error, 'invalid-api-shape')) return false
        assert.equal(error.field, field)
        return true
      },
    )
  }
  await assert.rejects(
    () => transport.getSession('runner-1', 'session-1'),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'invalid-api-shape')) return false
      assert.equal(error.field, 'agent_runner_id')
      return true
    },
  )
  for (const field of ['id', 'state']) {
    await assert.rejects(
      () => transport.getSession('runner-1', 'session-1'),
      (error: unknown) => {
        if (!isAgentRunnerSdkError(error, 'invalid-api-shape')) return false
        assert.equal(error.field, field)
        return true
      },
    )
  }
})
