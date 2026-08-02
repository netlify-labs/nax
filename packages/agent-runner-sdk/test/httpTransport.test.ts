import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createHttpTransport,
  isAgentRunnerSdkError,
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
    return new Response(
      status === 202
        ? null
        : typeof next.body === 'string'
          ? next.body
          : JSON.stringify(next.body ?? {}),
      { status, headers: next.headers },
    )
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
      assert.equal(isAgentRunnerSdkError(error, 'create-ambiguous'), true)
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
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
