import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  BasicAgentRunnerSdkError,
  DEFAULT_AGENT,
  DEFAULT_DEADLINE_MS,
  HttpResponseError,
  classifyFailure,
  createAgentRunnerSdk,
  detectRuntime,
  isAgentRunnerSdkError,
} from '../src/index.js'
import type {
  Handle,
  LandingHandler,
  MemberAction,
  MemberInput,
  MemberResult,
  RunHandle,
  Runner,
  Session,
  SessionHandle,
  Transport,
} from '../src/index.js'

const REQUEST_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_REQUEST_ID = '55555555-5555-4555-8555-555555555555'

function requestMarker(requestId: string): string {
  return `<!-- agent-runner-sdk-request-id:${requestId} -->`
}

function runner(overrides: Partial<Runner> = {}): Runner {
  return {
    runnerId: 'runner-1',
    state: 'running',
    siteId: 'site-1',
    branch: 'feature/sdk',
    codeOrigin: 'github',
    ...overrides,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    runnerId: 'runner-1',
    state: 'running',
    prompt: `do work\n\n${requestMarker(REQUEST_ID)}`,
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
    getRunner: async () => unexpected('getRunner'),
    listRunners: async () => unexpected('listRunners'),
    listAccountRunners: async () => unexpected('listAccountRunners'),
    getSession: async () => unexpected('getSession'),
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

function runHandle(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: DEFAULT_AGENT,
    input: {
      siteId: 'site-1',
      prompt: 'do work',
      agent: DEFAULT_AGENT,
      land: 'none',
      deadlineMs: DEFAULT_DEADLINE_MS,
      retryBudget: { capacity: 0 },
      requestId: REQUEST_ID,
    },
    policy: {
      landing: 'none',
      deadlineAt: DEFAULT_DEADLINE_MS,
      retryBudget: { capacity: 0 },
    },
    retries: { capacity: 0 },
    currentSessionId: 'session-1',
    ...overrides,
  }
}

test('start resolves defaults and the initial session by exact marker', async () => {
  let submittedPrompt = ''
  const transport = fakeTransport({
    createRunner: async (input) => {
      if (typeof input.prompt !== 'string') {
        assert.fail('expected a delivered inline prompt')
      }
      submittedPrompt = input.prompt
      return runner()
    },
    listSessions: async () => [
      session({
        sessionId: 'other-session',
        prompt: `do work\n\n${requestMarker(OTHER_REQUEST_ID)}`,
      }),
      session(),
    ],
  })
  const sdk = createAgentRunnerSdk({
    transport,
    now: () => 1_000,
    generateRequestId: () => REQUEST_ID,
  })

  const handle = await sdk.start({ siteId: 'site-1', prompt: 'do work' })

  assert.equal(handle.agent, DEFAULT_AGENT)
  assert.equal(handle.input.agent, DEFAULT_AGENT)
  assert.equal(handle.input.prompt, 'do work')
  assert.equal(handle.input.requestId, REQUEST_ID)
  assert.equal(handle.policy.landing, 'none')
  assert.equal(handle.policy.deadlineAt, 1_000 + DEFAULT_DEADLINE_MS)
  assert.deepEqual(handle.policy.retryBudget, { capacity: 0 })
  assert.equal(handle.currentSessionId, 'session-1')
  assert.deepEqual(handle.origin, {
    codeOrigin: 'github',
    branch: 'feature/sdk',
  })
  assert.ok(submittedPrompt.endsWith(requestMarker(REQUEST_ID)))
  assert.deepEqual(
    sdk.parseHandle(sdk.serializeHandle(handle)),
    handle,
  )
})

test('start refuses missing or duplicate causal initial sessions', async () => {
  for (const sessions of [
    [session({ prompt: 'no marker' })],
    [session(), session({ sessionId: 'session-2' })],
  ]) {
    const sdk = createAgentRunnerSdk({
      transport: fakeTransport({
        createRunner: async () => runner(),
        listSessions: async () => sessions,
      }),
      generateRequestId: () => REQUEST_ID,
    })
    await assert.rejects(
      () => sdk.start({ siteId: 'site-1', prompt: 'do work' }),
      (error: unknown) => {
        if (!isAgentRunnerSdkError(error, 'invalid-api-shape')) return false
        assert.equal(error.field, 'initial_session_request_marker')
        return true
      },
    )
  }
})

test('snapshots attribute the exact handle session and normalize success', async () => {
  let currentSession = session({ currentTask: 'Inspecting files' })
  const requestedSessions: string[] = []
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      getRunner: async () => runner({ hasResultDiff: true }),
      getSession: async (_runnerId, sessionId) => {
        requestedSessions.push(sessionId)
        return currentSession
      },
    }),
  })
  const handle = sdk.parseHandle(
    sdk.serializeHandle(runHandle()),
  )

  assert.deepEqual(await sdk.getSnapshot(handle), {
    kind: 'running',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    state: 'running',
    latestStep: 'Inspecting files',
    usage: null,
  })
  await assert.rejects(
    () => sdk.getResult(handle),
    (error: unknown) => isAgentRunnerSdkError(error, 'validation-error'),
  )

  currentSession = session({
    state: 'completed',
    resultText: `Done\n\n${requestMarker(REQUEST_ID)}`,
    hasResultDiff: false,
    deployUrl: 'https://deploy.example.test',
    usage: {
      totalTokens: 12,
      totalCreditsCost: 0,
    },
  })
  const result = await sdk.getResult(handle)
  assert.deepEqual(result, {
    status: 'succeeded',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    resultText: 'Done',
    usage: {
      totalTokens: 12,
      totalCreditsCost: 0,
    },
    changes: 'unchanged',
    deployUrl: 'https://deploy.example.test',
    links: {},
  })
  assert.deepEqual(requestedSessions, [
    'session-1',
    'session-1',
    'session-1',
  ])

  const followUp: SessionHandle = {
    ...runHandle(),
    kind: 'session',
    currentSessionId: 'session-2',
    sessionId: 'session-2',
    sessionInput: {
      prompt: 'continue',
      requestId: OTHER_REQUEST_ID,
    },
  }
  currentSession = session({
    sessionId: 'session-2',
    state: 'completed',
    resultText: 'Follow-up done',
  })
  const followUpResult = await sdk.getResult(
    sdk.parseHandle(sdk.serializeHandle(followUp)),
  )
  assert.equal(followUpResult.sessionId, 'session-2')
  assert.equal(requestedSessions.at(-1), 'session-2')
})

test('terminal snapshots cover failure, cancellation, timeout, and unknown changes', async () => {
  const cases: Array<{
    state: string
    expectedStatus: 'failed' | 'cancelled' | 'timedOut'
  }> = [
    { state: 'error', expectedStatus: 'failed' },
    { state: 'canceled', expectedStatus: 'cancelled' },
    { state: 'timed_out', expectedStatus: 'timedOut' },
  ]
  for (const entry of cases) {
    const sdk = createAgentRunnerSdk({
      transport: fakeTransport({
        getRunner: async () => runner({ state: entry.state }),
        getSession: async () => session({ state: entry.state }),
      }),
    })
    const snapshot = await sdk.getSnapshot(runHandle())
    assert.equal(snapshot.kind, 'terminal')
    if (snapshot.kind === 'terminal') {
      assert.equal(snapshot.result.status, entry.expectedStatus)
      assert.equal(snapshot.result.usage, null)
    }
  }

  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      getRunner: async () => runner({ state: 'completed' }),
      getSession: async () => session({
        state: 'completed',
        resultText: 'No diff metadata was returned.',
      }),
    }),
  })
  const snapshot = await sdk.getSnapshot(runHandle())
  assert.equal(snapshot.kind, 'terminal')
  if (
    snapshot.kind === 'terminal'
    && snapshot.result.status === 'succeeded'
  ) {
    assert.equal(snapshot.result.changes, 'unknown')
  }
})

test('waitFor enforces the absolute deadline and reports cancellation', async () => {
  let clock = 0
  let cancels = 0
  const events: string[] = []
  const handle = runHandle({
    policy: {
      landing: 'none',
      deadlineAt: 20,
      retryBudget: { capacity: 0 },
    },
  })
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      getRunner: async () => runner(),
      getSession: async () => session({ usage: { totalTokens: 8 } }),
      cancelRunner: async () => {
        cancels += 1
      },
    }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    pollIntervalMs: 10,
  })

  const result = await sdk.waitFor(handle, {
    onProgress: (event) => events.push(event.kind),
  })

  assert.deepEqual(result, {
    status: 'timedOut',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    usage: { totalTokens: 8 },
    cancelledRunner: true,
  })
  assert.equal(cancels, 1)
  assert.deepEqual(events, ['stateChanged', 'finished'])
  assert.equal(handle.policy.deadlineAt, 20)
})

test('stop is kind-aware and treats missing targets as already stopped', async () => {
  let runnerCancels = 0
  const sessionCancels: string[] = []
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      cancelRunner: async () => {
        runnerCancels += 1
        if (runnerCancels > 1) {
          throw new HttpResponseError(
            'not-found',
            404,
            '/agent_runners/runner-1',
          )
        }
      },
      cancelSession: async (_runnerId, sessionId) => {
        sessionCancels.push(sessionId)
      },
    }),
  })
  const run = runHandle()
  const followUp: SessionHandle = {
    ...run,
    kind: 'session',
    currentSessionId: 'session-2',
    sessionId: 'session-2',
    sessionInput: {
      prompt: 'continue',
      requestId: OTHER_REQUEST_ID,
    },
  }

  await sdk.stop(run)
  await sdk.stop(run)
  await sdk.stop(followUp)

  assert.equal(runnerCancels, 2)
  assert.deepEqual(sessionCancels, ['session-2'])
})

test('run keeps execution success separate from landing outcomes', async () => {
  const updatedLanding = { prUrl: 'https://github.com/o/r/pull/1' }
  const landingHandler: LandingHandler = async <H extends Handle>(
    handle: H,
  ) => ({
    handle: { ...handle, landing: updatedLanding },
    landing: {
      kind: 'prOpen',
      prUrl: updatedLanding.prUrl,
      merged: false,
    },
  })
  const transport = fakeTransport({
    createRunner: async () => runner({ state: 'completed' }),
    listSessions: async () => [session({ state: 'completed' })],
    getRunner: async () => runner({ state: 'completed' }),
    getSession: async () => session({
      state: 'completed',
      resultText: 'Implemented',
      hasResultDiff: true,
    }),
  })
  const sdk = createAgentRunnerSdk({
    transport,
    generateRequestId: () => REQUEST_ID,
    landingHandler,
  })

  const outcome = await sdk.run({
    siteId: 'site-1',
    prompt: 'do work',
    land: 'pr',
  })

  assert.equal(outcome.result.status, 'succeeded')
  if (outcome.result.status === 'succeeded') {
    assert.equal(outcome.result.changes, 'changed')
  }
  assert.deepEqual(outcome.landing, {
    kind: 'prOpen',
    prUrl: updatedLanding.prUrl,
    merged: false,
  })
  assert.deepEqual(outcome.handle.landing, updatedLanding)

  const failing = createAgentRunnerSdk({
    transport,
    generateRequestId: () => REQUEST_ID,
    landingHandler: async () => {
      throw new Error('sensitive landing internals')
    },
  })
  const failedLanding = await failing.run({
    siteId: 'site-1',
    prompt: 'do work',
    land: 'pr',
  })
  assert.equal(failedLanding.result.status, 'succeeded')
  assert.equal(failedLanding.landing?.kind, 'failed')
  if (failedLanding.landing?.kind === 'failed') {
    assert.equal(failedLanding.landing.step, 'pr')
    assert.doesNotMatch(
      failedLanding.landing.failure.message,
      /sensitive landing/,
    )
  }
})

test('run automatically applies bounded capacity retry with persisted metadata', async () => {
  let clock = 100
  let creates = 0
  let latestRequestId = REQUEST_ID
  const requestIds = [REQUEST_ID, OTHER_REQUEST_ID]
  const events: string[] = []
  const checkpoints: RunHandle[] = []
  const transport = fakeTransport({
    createRunner: async (input) => {
      latestRequestId = input.requestId
      creates += 1
      return runner({
        runnerId: `runner-${creates}`,
        state: creates === 1 ? 'failed' : 'completed',
      })
    },
    listSessions: async (runnerId) => [
      session({
        runnerId,
        sessionId: `session-${creates}`,
        state: creates === 1 ? 'failed' : 'completed',
        prompt: `do work\n\n${requestMarker(latestRequestId)}`,
      }),
    ],
    getRunner: async (runnerId) => runner({
      runnerId,
      state: runnerId === 'runner-1' ? 'failed' : 'completed',
    }),
    getSession: async (runnerId, sessionId) => session({
      runnerId,
      sessionId,
      state: runnerId === 'runner-1' ? 'failed' : 'completed',
      resultText: runnerId === 'runner-1'
        ? 'The selected model is currently at capacity'
        : 'Completed after retry',
    }),
  })
  const sdk = createAgentRunnerSdk({
    transport,
    generateRequestId: () => requestIds.shift() ?? OTHER_REQUEST_ID,
    now: () => clock,
    random: () => 0,
    sleep: async (ms) => {
      clock += ms
    },
    onRetryCheckpoint: (handle) => {
      checkpoints.push(handle as RunHandle)
    },
  })

  const outcome = await sdk.run({
    siteId: 'site-1',
    prompt: 'do work',
    retryBudget: { capacity: 1 },
  }, {
    onProgress: (event) => events.push(event.kind),
  })

  assert.equal(outcome.result.status, 'succeeded')
  assert.equal(outcome.handle.runnerId, 'runner-2')
  assert.equal(outcome.handle.retries.capacity, 1)
  assert.deepEqual(outcome.handle.retries.lastAttempt, {
    attempt: 1,
    category: 'capacity',
    code: 'model-capacity',
    scheduledAt: 100,
    delayMs: 125,
  })
  assert.equal(checkpoints.length, 1)
  assert.deepEqual(
    sdk.parseHandle(sdk.serializeHandle(checkpoints[0] as RunHandle)),
    checkpoints[0],
  )
  assert.deepEqual(events, ['started', 'retrying', 'finished'])
  assert.equal(creates, 2)
})

test('failure classification, retry budget, and runtime detection are explicit', () => {
  const limited = classifyFailure(
    new HttpResponseError('rate-limited', 429, '/agent_runners'),
  )
  assert.equal(limited.category, 'rate-limit')
  assert.equal(limited.code, 'rate-limited')
  assert.equal(limited.stage, 'transport')
  assert.equal(limited.retryable, true)
  assert.equal(limited.status, 429)
  assert.ok(limited.title.length > 0)
  assert.ok(limited.remediation.length > 0)
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport(),
    now: () => 0,
  })
  const handle = runHandle({
    policy: {
      landing: 'none',
      deadlineAt: DEFAULT_DEADLINE_MS,
      retryBudget: { capacity: 1 },
    },
  })
  assert.equal(sdk.shouldRetry(handle, limited), true)
  assert.equal(
    sdk.shouldRetry({
      ...handle,
      retries: { capacity: 1 },
    }, limited),
    false,
  )
  assert.equal(detectRuntime({}), 'local')
  assert.equal(
    detectRuntime({ NETLIFY: 'true', CONTEXT: 'dev-server' }),
    'agent-runner',
  )
  assert.equal(
    detectRuntime({
      NETLIFY: '1',
      CONTEXT: 'dev-server',
      BUILD_ID: 'build-1',
    }),
    'netlify-build',
  )
  assert.equal(
    classifyFailure(
      new BasicAgentRunnerSdkError(
        'network-error',
        'Agent Runner API request failed.',
      ),
    ).retryable,
    false,
  )
})
