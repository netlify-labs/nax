import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  SessionAlreadyActiveError,
  createAgentRunnerSdk,
  isAgentRunnerSdkError,
} from '../src/index.js'
import type {
  EffectiveFollowUpInput,
  EffectiveStartInput,
  MemberAction,
  MemberInput,
  MemberResult,
  RunHandle,
  Runner,
  RunnerListQuery,
  RunnerPage,
  Session,
  Transport,
} from '../src/index.js'

const CREATE_ID = '66666666-6666-4666-8666-666666666666'
const OTHER_ID = '77777777-7777-4777-8777-777777777777'
const SESSION_ID = '88888888-8888-4888-8888-888888888888'

function marker(requestId: string): string {
  return `<!-- agent-runner-sdk-request-id:${requestId} -->`
}

function runner(
  runnerId: string,
  createdAt: number,
  overrides: Partial<Runner> = {},
): Runner {
  return {
    runnerId,
    state: 'running',
    siteId: 'site-1',
    branch: 'feature/sdk',
    codeOrigin: 'github',
    createdAt,
    ...overrides,
  }
}

function session(
  runnerId: string,
  sessionId: string,
  requestId: string,
  createdAt: number,
  overrides: Partial<Session> = {},
): Session {
  return {
    runnerId,
    sessionId,
    state: 'running',
    prompt: `same prompt\n\n${marker(requestId)}`,
    agent: 'claude',
    model: 'model-1',
    mode: 'normal',
    fileKeys: ['context.md'],
    createdAt,
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

const startInput: EffectiveStartInput = {
  siteId: 'site-1',
  prompt: 'same prompt',
  agent: 'claude',
  model: 'model-1',
  branch: 'feature/sdk',
  mode: 'normal',
  fileKeys: ['context.md'],
  land: 'merge',
  deadlineMs: 60_000,
  retryBudget: { capacity: 2 },
  requestId: CREATE_ID,
}

const requestWindow = {
  sentAt: 10_500,
  failedAt: 11_500,
}

function baseHandle(): RunHandle {
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner-existing',
    siteId: 'site-1',
    agent: 'claude',
    origin: {
      codeOrigin: 'github',
      branch: 'feature/sdk',
    },
    input: startInput,
    policy: {
      landing: 'merge',
      deadlineAt: 70_500,
      retryBudget: { capacity: 2 },
    },
    retries: { capacity: 1 },
    landing: {
      prUrl: 'https://github.com/o/r/pull/1',
      committedSessionIds: ['session-old'],
    },
    currentSessionId: 'session-initial',
  }
}

test('runner reconciliation traverses every bounded page and preserves origin policy', async () => {
  const queries: RunnerListQuery[] = []
  const transport = fakeTransport({
    listRunners: async (query): Promise<RunnerPage> => {
      queries.push(query)
      return query.page === 1
        ? {
            items: [runner('runner-other', 10_700)],
            nextPage: 2,
            total: 2,
          }
        : {
            items: [runner('runner-match', 11_000)],
            total: 2,
          }
    },
    listSessions: async (runnerId) => runnerId === 'runner-match'
      ? [session(runnerId, 'session-match', CREATE_ID, 11_001)]
      : [session(runnerId, 'session-other', OTHER_ID, 10_701)],
  })
  const sdk = createAgentRunnerSdk({
    transport,
    clockSkewAllowanceMs: 1_500,
  })

  const result = await sdk.reconcileCreate(startInput, requestWindow)

  assert.equal(result.kind, 'matched')
  assert.deepEqual(queries, [
    {
      siteId: 'site-1',
      from: 9,
      to: 13,
      page: 1,
      perPage: 100,
    },
    {
      siteId: 'site-1',
      from: 9,
      to: 13,
      page: 2,
      perPage: 100,
    },
  ])
  if (result.kind === 'matched') {
    assert.equal(result.handle.runnerId, 'runner-match')
    assert.equal(result.handle.currentSessionId, 'session-match')
    assert.equal(result.handle.input, startInput)
    assert.deepEqual(result.handle.policy, {
      landing: 'merge',
      deadlineAt: 70_500,
      retryBudget: { capacity: 2 },
    })
    assert.deepEqual(result.handle.origin, {
      codeOrigin: 'github',
      branch: 'feature/sdk',
    })
  }
})

test('prompt similarity and list order never replace the exact marker', async () => {
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      listRunners: async () => ({
        items: [
          runner('runner-later', 11_499),
          runner('runner-earlier', 10_501),
        ],
      }),
      listSessions: async (runnerId) => [
        session(runnerId, `${runnerId}-session`, OTHER_ID, 11_000),
      ],
    }),
    clockSkewAllowanceMs: 0,
  })

  assert.deepEqual(
    await sdk.reconcileCreate(startInput, requestWindow),
    { kind: 'none' },
  )
})

test('prompt-reference reconciliation uses the wire marker as causal proof', async () => {
  const blobInput: EffectiveStartInput = {
    ...startInput,
    prompt: undefined,
    promptRef: {
      store: 'netlify-blobs',
      key: 'prompts/create',
      tenant: 'site-1',
      expiresAt: 100_000,
    },
  }
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      listRunners: async () => ({
        items: [runner('runner-blob', 11_000)],
      }),
      listSessions: async () => [
        session('runner-blob', 'session-blob', CREATE_ID, 11_001, {
          prompt: `Fetch the stored prompt.\n\n${marker(CREATE_ID)}`,
        }),
      ],
    }),
    clockSkewAllowanceMs: 0,
  })

  const result = await sdk.reconcileCreate(blobInput, requestWindow)

  assert.equal(result.kind, 'matched')
  if (result.kind === 'matched') {
    assert.deepEqual(result.handle.input.promptRef, blobInput.promptRef)
    assert.equal(result.handle.currentSessionId, 'session-blob')
  }
})

test('runner reconciliation returns only safe ambiguous candidates', async () => {
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      listRunners: async () => ({
        items: [
          runner('runner-a', 10_600),
          runner('runner-b', 11_400),
        ],
      }),
      listSessions: async (runnerId) => [
        session(runnerId, `${runnerId}-session`, CREATE_ID, 11_000),
      ],
    }),
    clockSkewAllowanceMs: 0,
  })

  const result = await sdk.reconcileCreate(startInput, requestWindow)

  assert.deepEqual(result, {
    kind: 'ambiguous',
    candidates: [
      {
        runnerId: 'runner-a',
        sessionId: 'runner-a-session',
        createdAt: 10_600,
      },
      {
        runnerId: 'runner-b',
        sessionId: 'runner-b-session',
        createdAt: 11_400,
      },
    ],
  })
  assert.doesNotMatch(JSON.stringify(result), /same prompt|model-1|feature\/sdk/)
})

test('defensive fingerprint mismatch rejects an exact marker', async () => {
  for (const mismatched of [
    session('runner-1', 'session-1', CREATE_ID, 11_000, {
      agent: 'codex',
    }),
    session('runner-1', 'session-1', CREATE_ID, 11_000, {
      model: 'other-model',
    }),
    session('runner-1', 'session-1', CREATE_ID, 11_000, {
      fileKeys: ['other.md'],
    }),
  ]) {
    const sdk = createAgentRunnerSdk({
      transport: fakeTransport({
        listRunners: async () => ({
          items: [runner('runner-1', 11_000)],
        }),
        listSessions: async () => [mismatched],
      }),
      clockSkewAllowanceMs: 0,
    })
    assert.deepEqual(
      await sdk.reconcileCreate(startInput, requestWindow),
      { kind: 'none' },
    )
  }

  const branchMismatch = createAgentRunnerSdk({
    transport: fakeTransport({
      listRunners: async () => ({
        items: [runner('runner-1', 11_000, { branch: 'someone-else' })],
      }),
      listSessions: async () => [
        session('runner-1', 'session-1', CREATE_ID, 11_000),
      ],
    }),
    clockSkewAllowanceMs: 0,
  })
  assert.deepEqual(
    await branchMismatch.reconcileCreate(startInput, requestWindow),
    { kind: 'none' },
  )
})

test('session reconciliation preserves the complete base handle', async () => {
  const followUp: EffectiveFollowUpInput = {
    prompt: 'follow up',
    agent: 'codex',
    model: 'model-2',
    mode: 'ask',
    fileKeys: ['follow-up.md'],
    requestId: SESSION_ID,
  }
  const matching = session(
    'runner-existing',
    'session-follow-up',
    SESSION_ID,
    11_000,
    {
      prompt: `follow up\n\n${marker(SESSION_ID)}`,
      agent: 'codex',
      model: 'model-2',
      mode: 'ask',
      fileKeys: ['follow-up.md'],
    },
  )
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      listSessions: async () => [
        session(
          'runner-existing',
          'session-other',
          OTHER_ID,
          10_700,
          { prompt: `follow up\n\n${marker(OTHER_ID)}` },
        ),
        matching,
      ],
    }),
    clockSkewAllowanceMs: 0,
  })
  const base = baseHandle()

  const result = await sdk.reconcileSession(
    base,
    followUp,
    requestWindow,
  )

  assert.equal(result.kind, 'matched')
  if (result.kind === 'matched') {
    assert.equal(result.handle.kind, 'session')
    assert.equal(result.handle.runnerId, base.runnerId)
    assert.deepEqual(result.handle.input, base.input)
    assert.deepEqual(result.handle.policy, base.policy)
    assert.deepEqual(result.handle.retries, base.retries)
    assert.deepEqual(result.handle.landing, base.landing)
    assert.equal(result.handle.currentSessionId, 'session-follow-up')
    assert.equal(result.handle.sessionId, 'session-follow-up')
    assert.deepEqual(result.handle.sessionInput, followUp)
  }
})

test('active-session conflicts adopt only the exact active marker', async () => {
  const followUp: EffectiveFollowUpInput = {
    prompt: 'follow up',
    requestId: SESSION_ID,
  }
  const conflict = new SessionAlreadyActiveError(
    followUp,
    requestWindow,
    'session-active',
  )
  const matching = session(
    'runner-existing',
    'session-active',
    SESSION_ID,
    11_000,
    {
      prompt: `follow up\n\n${marker(SESSION_ID)}`,
    },
  )
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      listSessions: async () => [matching],
    }),
    clockSkewAllowanceMs: 0,
  })

  const result = await sdk.reconcileSession(
    baseHandle(),
    followUp,
    requestWindow,
    { conflict },
  )
  assert.equal(result.kind, 'matched')

  const wrongActive = new SessionAlreadyActiveError(
    followUp,
    requestWindow,
    'someone-elses-session',
  )
  await assert.rejects(
    () => sdk.reconcileSession(
      baseHandle(),
      followUp,
      requestWindow,
      { conflict: wrongActive },
    ),
    (error: unknown) => error === wrongActive,
  )
})

test('session bounds, ambiguity, and malformed windows fail safely', async () => {
  const followUp: EffectiveFollowUpInput = {
    prompt: 'follow up',
    requestId: SESSION_ID,
  }
  const sessions = [
    session('runner-existing', 'session-a', SESSION_ID, 10_600, {
      prompt: `follow up\n\n${marker(SESSION_ID)}`,
    }),
    session('runner-existing', 'session-b', SESSION_ID, 11_400, {
      prompt: `follow up\n\n${marker(SESSION_ID)}`,
    }),
  ]
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      listSessions: async () => sessions,
    }),
    clockSkewAllowanceMs: 0,
  })

  const ambiguous = await sdk.reconcileSession(
    baseHandle(),
    followUp,
    requestWindow,
  )
  assert.equal(ambiguous.kind, 'ambiguous')
  if (ambiguous.kind === 'ambiguous') {
    assert.deepEqual(
      ambiguous.candidates.map((candidate) => candidate.sessionId),
      ['session-a', 'session-b'],
    )
  }

  const outside = createAgentRunnerSdk({
    transport: fakeTransport({
      listSessions: async () => [
        session('runner-existing', 'session-too-late', SESSION_ID, 11_501, {
          prompt: `follow up\n\n${marker(SESSION_ID)}`,
        }),
      ],
    }),
    clockSkewAllowanceMs: 0,
  })
  assert.deepEqual(
    await outside.reconcileSession(
      baseHandle(),
      followUp,
      requestWindow,
    ),
    { kind: 'none' },
  )

  await assert.rejects(
    () => sdk.reconcileSession(
      baseHandle(),
      followUp,
      { sentAt: 2, failedAt: 1 },
    ),
    (error: unknown) => isAgentRunnerSdkError(error, 'validation-error'),
  )
})
