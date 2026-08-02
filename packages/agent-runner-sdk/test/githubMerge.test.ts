import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  createAgentRunnerSdk,
  createGithubMergeClient,
  isAgentRunnerSdkError,
} from '../src/index.js'
import type {
  Handle,
  MemberAction,
  MemberInput,
  MemberResult,
  RunHandle,
  Runner,
  Session,
  Transport,
} from '../src/index.js'

const REQUEST_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PR_URL = 'https://github.com/netlify-labs/repo/pull/12'
const GITHUB_TOKEN = 'github-secret-token'
const EXPECTED_HEAD = 'target-synced-pr-head'
const SESSION_COMMIT = 'current-session-commit'
const MERGE_SHA = 'github-merge-sha'

interface FetchCall {
  url: string
  options: RequestInit
}

interface FakeResponse {
  status?: number
  body?: unknown
  error?: Error
}

function fakeFetch(
  responses: FakeResponse[],
  before?: (call: FetchCall) => void,
) {
  const calls: FetchCall[] = []
  const fetch = async (
    input: string | URL | globalThis.Request,
    options: RequestInit = {},
  ): Promise<Response> => {
    const call = { url: String(input), options }
    calls.push(call)
    before?.(call)
    const response = responses.shift()
    assert.ok(response, 'unexpected GitHub request')
    if (response.error) throw response.error
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
    })
  }
  return {
    calls,
    fetch: fetch as typeof globalThis.fetch,
  }
}

function githubPull(overrides: Record<string, unknown> = {}) {
  return {
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    head: { sha: EXPECTED_HEAD },
    ...overrides,
  }
}

function runner(overrides: Partial<Runner> = {}): Runner {
  return {
    runnerId: 'runner-1',
    state: 'completed',
    siteId: 'site-1',
    branch: 'feature/base',
    codeOrigin: 'github',
    prUrl: PR_URL,
    prBranch: 'agent/runner-1',
    prState: 'open',
    prIsBeingCreated: false,
    mergeCommitIsBeingCreated: false,
    ...overrides,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    runnerId: 'runner-1',
    sessionId: 'session-1',
    state: 'completed',
    hasResultDiff: true,
    commitSha: SESSION_COMMIT,
    usage: null,
    ...overrides,
  }
}

function fakeTransport(overrides: Partial<Transport> = {}): Transport {
  const unexpected = (operation: string): never => {
    throw new Error(`unexpected transport operation: ${operation}`)
  }
  return {
    createRunner: async () => unexpected('createRunner'),
    createSession: async () => unexpected('createSession'),
    getRunner: async () => runner(),
    listRunners: async () => unexpected('listRunners'),
    listAccountRunners: async () => unexpected('listAccountRunners'),
    getSession: async () => session(),
    listSessions: async () => unexpected('listSessions'),
    cancelRunner: async () => unexpected('cancelRunner'),
    cancelSession: async () => unexpected('cancelSession'),
    member: async <A extends MemberAction>(
      _runnerId: string,
      _action: A,
      _input: MemberInput<A>,
    ): Promise<MemberResult<A>> => unexpected('member'),
    ...overrides,
  }
}

function handle(
  landing: 'merge' | 'auto',
  overrides: Partial<RunHandle> = {},
): RunHandle {
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: 'claude',
    origin: {
      codeOrigin: 'github',
      branch: 'feature/base',
    },
    input: {
      siteId: 'site-1',
      prompt: 'make changes',
      agent: 'claude',
      land: landing,
      deadlineMs: 60_000,
      retryBudget: { capacity: 0 },
      requestId: REQUEST_ID,
    },
    policy: {
      landing,
      deadlineAt: 2_000_000_000_000,
      retryBudget: { capacity: 0 },
    },
    retries: { capacity: 0 },
    landing: {
      prUrl: PR_URL,
      committedSessionIds: ['session-1'],
    },
    currentSessionId: 'session-1',
    ...overrides,
  }
}

function jsonBody(call: FetchCall): Record<string, unknown> {
  assert.equal(typeof call.options.body, 'string')
  return JSON.parse(call.options.body as string) as Record<string, unknown>
}

test('GitHub merge checkpoints and sends the exact live PR head, not the session SHA', async () => {
  const events: string[] = []
  const fake = fakeFetch([
    { body: githubPull() },
    { body: { merged: true, sha: MERGE_SHA } },
  ], (call) => {
    if (call.options.method === 'PUT') events.push('merge')
  })
  const checkpoints: Handle[] = []
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    fetch: fake.fetch,
    githubToken: GITHUB_TOKEN,
    onLandingCheckpoint: (checkpoint) => {
      checkpoints.push(checkpoint)
      events.push(
        checkpoint.landing?.mergedSha === undefined
          ? 'expected-head-checkpoint'
          : 'merged-checkpoint',
      )
    },
  })

  const landed = await sdk.land(handle('merge'))

  assert.deepEqual(events, [
    'expected-head-checkpoint',
    'merge',
    'merged-checkpoint',
  ])
  assert.equal(fake.calls.length, 2)
  assert.equal(
    fake.calls[0]?.url,
    'https://api.github.com/repos/netlify-labs/repo/pulls/12',
  )
  assert.equal(
    fake.calls[1]?.url,
    'https://api.github.com/repos/netlify-labs/repo/pulls/12/merge',
  )
  assert.deepEqual(jsonBody(fake.calls[1] as FetchCall), {
    merge_method: 'squash',
    sha: EXPECTED_HEAD,
  })
  assert.notEqual(EXPECTED_HEAD, SESSION_COMMIT)
  assert.equal(
    new Headers(fake.calls[1]?.options.headers).get('authorization'),
    `Bearer ${GITHUB_TOKEN}`,
  )
  assert.equal(
    checkpoints[0]?.landing?.expectedPrHeadSha,
    EXPECTED_HEAD,
  )
  assert.equal(checkpoints[1]?.landing?.mergedSha, MERGE_SHA)
  assert.deepEqual(landed.landing, {
    kind: 'merged',
    prUrl: PR_URL,
    mergeSha: MERGE_SHA,
  })
  assert.equal(landed.handle.landing?.expectedPrHeadSha, EXPECTED_HEAD)
  assert.equal(landed.handle.landing?.mergedSha, MERGE_SHA)
  assert.doesNotMatch(JSON.stringify(landed.handle), /github-secret-token/)
})

test('a GitHub 409 fails closed without observing or merging a newer head', async () => {
  const fake = fakeFetch([
    { body: githubPull() },
    { status: 409, body: { message: 'Head branch was modified' } },
  ])
  const checkpoints: Handle[] = []
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    fetch: fake.fetch,
    githubToken: GITHUB_TOKEN,
    onLandingCheckpoint: (checkpoint) => {
      checkpoints.push(checkpoint)
    },
  })

  const landed = await sdk.land(handle('merge'))

  assert.equal(fake.calls.length, 2)
  assert.equal(checkpoints.length, 1)
  assert.equal(
    landed.handle.landing?.expectedPrHeadSha,
    EXPECTED_HEAD,
  )
  assert.deepEqual(landed.landing, {
    kind: 'failed',
    step: 'merge',
    failure: {
      category: 'github',
      code: 'pr-head-changed',
      message: 'The pull request head changed before merge; refusing to merge a different revision.',
      retryable: false,
    },
  })
})

test('a failed expected-head checkpoint prevents the merge mutation', async () => {
  const fake = fakeFetch([{ body: githubPull() }])
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    fetch: fake.fetch,
    githubToken: GITHUB_TOKEN,
    onLandingCheckpoint: () => {
      throw Object.assign(new Error('durable store unavailable'), {
        code: 'storage-unavailable',
      })
    },
  })

  const landed = await sdk.land(handle('merge'))

  assert.equal(fake.calls.length, 1)
  assert.equal(
    landed.handle.landing?.expectedPrHeadSha,
    EXPECTED_HEAD,
  )
  assert.equal(landed.landing.kind, 'failed')
  if (landed.landing.kind === 'failed') {
    assert.equal(landed.landing.failure.code, 'unknown-error')
  }
})

test('a persisted expected head refuses live drift before the merge call', async () => {
  const fake = fakeFetch([{
    body: githubPull({ head: { sha: 'new-unapproved-head' } }),
  }])
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    fetch: fake.fetch,
    githubToken: GITHUB_TOKEN,
  })
  const resumed = handle('merge', {
    landing: {
      prUrl: PR_URL,
      committedSessionIds: ['session-1'],
      expectedPrHeadSha: EXPECTED_HEAD,
    },
  })

  const landed = await sdk.land(resumed)

  assert.equal(fake.calls.length, 1)
  assert.equal(landed.landing.kind, 'failed')
  if (landed.landing.kind === 'failed') {
    assert.equal(landed.landing.failure.code, 'pr-head-changed')
  }
})

test('a lost merge response reconciles merged state without replay', async () => {
  const fake = fakeFetch([
    { body: githubPull() },
    { error: new TypeError('socket closed after write') },
    {
      body: githubPull({
        state: 'closed',
        merged: true,
        merge_commit_sha: MERGE_SHA,
      }),
    },
  ])
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    fetch: fake.fetch,
    githubToken: GITHUB_TOKEN,
  })

  const landed = await sdk.land(handle('merge'))

  assert.equal(fake.calls.length, 3)
  assert.equal(
    fake.calls.filter((call) => call.options.method === 'PUT').length,
    1,
  )
  assert.deepEqual(landed.landing, {
    kind: 'merged',
    prUrl: PR_URL,
    mergeSha: MERGE_SHA,
  })
  assert.equal(landed.handle.landing?.expectedPrHeadSha, EXPECTED_HEAD)
})

test('restart reconciles an already merged PR from the persisted handle', async () => {
  const fake = fakeFetch([{
    body: githubPull({
      state: 'closed',
      merged: true,
      merge_commit_sha: MERGE_SHA,
    }),
  }])
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    fetch: fake.fetch,
    githubToken: GITHUB_TOKEN,
  })
  const resumed = handle('merge', {
    landing: {
      prUrl: PR_URL,
      committedSessionIds: ['session-1'],
      expectedPrHeadSha: EXPECTED_HEAD,
    },
  })

  const landed = await sdk.land(
    sdk.parseHandle(sdk.serializeHandle(resumed)) as RunHandle,
  )

  assert.equal(fake.calls.length, 1)
  assert.equal(landed.landing.kind, 'merged')
  assert.equal(landed.handle.landing?.mergedSha, MERGE_SHA)
})

test('merge requires an explicit GitHub token while auto remains PR-only', async () => {
  let githubCalls = 0
  const noGithubFetch = async (): Promise<Response> => {
    githubCalls += 1
    throw new Error('unexpected GitHub request')
  }
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    fetch: noGithubFetch,
  })

  const merge = await sdk.land(handle('merge'))
  assert.deepEqual(merge.landing, {
    kind: 'failed',
    step: 'merge',
    failure: {
      category: 'github',
      code: 'github-token-required',
      message: 'A GitHub token is required to merge the pull request.',
      retryable: false,
    },
  })

  const auto = await sdk.land(handle('auto'))
  assert.deepEqual(auto.landing, {
    kind: 'prOpen',
    prUrl: PR_URL,
    merged: false,
  })
  assert.equal(githubCalls, 0)
})

test('GitHub client maps closed/protected/auth/timeout failures without leaking tokens', async () => {
  const cases: Array<{
    response: FakeResponse
    expectedCode: string
  }> = [
    { response: { status: 401 }, expectedCode: 'auth-invalid' },
    { response: { status: 403 }, expectedCode: 'auth-permission' },
    { response: { status: 405 }, expectedCode: 'validation-error' },
    {
      response: {
        error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
      },
      expectedCode: 'request-timeout',
    },
  ]
  for (const { response, expectedCode } of cases) {
    const fake = fakeFetch([response])
    const client = createGithubMergeClient({ fetch: fake.fetch })
    await assert.rejects(
      () => client.mergePullRequest(
        PR_URL,
        EXPECTED_HEAD,
        GITHUB_TOKEN,
      ),
      (error: unknown) => {
        assert.equal(isAgentRunnerSdkError(error), true)
        if (!isAgentRunnerSdkError(error)) return false
        assert.equal(error.code, expectedCode)
        assert.doesNotMatch(error.message, /github-secret-token/)
        return true
      },
    )
  }

  const closed = fakeFetch([{
    body: githubPull({ state: 'closed' }),
  }])
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    fetch: closed.fetch,
    githubToken: GITHUB_TOKEN,
  })
  const landed = await sdk.land(handle('merge'))
  assert.equal(landed.landing.kind, 'failed')
  if (landed.landing.kind === 'failed') {
    assert.equal(landed.landing.failure.code, 'validation-error')
  }
})
