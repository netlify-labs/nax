import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  CreateAmbiguousError,
  SessionAlreadyActiveError,
  createAgentRunnerSdk,
  isAgentRunnerSdkError,
} from '../src/index.js'
import type {
  BlobRef,
  EffectiveStartInput,
  FollowUpInput,
  MemberAction,
  MemberInput,
  MemberResult,
  RunHandle,
  Runner,
  Session,
  SessionHandle,
  Transport,
} from '../src/index.js'

const RUN_REQUEST_ID = '99999999-9999-4999-8999-999999999999'
const FOLLOW_UP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RETRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function marker(requestId: string): string {
  return `<!-- agent-runner-sdk-request-id:${requestId} -->`
}

function runner(
  runnerId = 'runner-1',
  overrides: Partial<Runner> = {},
): Runner {
  return {
    runnerId,
    state: 'running',
    siteId: 'site-1',
    branch: 'feature/sdk',
    codeOrigin: 'github',
    ...overrides,
  }
}

function session(
  sessionId: string,
  requestId: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    runnerId: 'runner-1',
    sessionId,
    state: 'running',
    prompt: `follow up\n\n${marker(requestId)}`,
    createdAt: 110,
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

const originalInput: EffectiveStartInput = {
  siteId: 'site-1',
  prompt: 'original prompt',
  agent: 'claude',
  model: 'model-1',
  branch: 'feature/sdk',
  deployId: 'deploy-1',
  mode: 'create',
  fileKeys: ['context.md'],
  land: 'merge',
  deadlineMs: 60_000,
  retryBudget: { capacity: 2 },
  requestId: RUN_REQUEST_ID,
}

function runHandle(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: 'claude',
    origin: {
      codeOrigin: 'github',
      repository: { owner: 'netlify-labs', name: 'repo' },
      branch: 'feature/sdk',
    },
    input: originalInput,
    policy: {
      landing: 'merge',
      deadlineAt: 70_000,
      retryBudget: { capacity: 2 },
    },
    retries: { capacity: 0 },
    landing: {
      prUrl: 'https://github.com/netlify-labs/repo/pull/1',
      committedSessionIds: ['session-1'],
    },
    currentSessionId: 'session-1',
    ...overrides,
  }
}

test('followUp preserves the complete base handle and exact follow-up fields', async () => {
  let wirePrompt = ''
  let generated = false
  const transport = fakeTransport({
    createSession: async (runnerId, input) => {
      assert.equal(runnerId, 'runner-1')
      if (typeof input.prompt !== 'string') {
        assert.fail('expected an inline delivered prompt')
      }
      wirePrompt = input.prompt
      return session('session-2', FOLLOW_UP_ID)
    },
  })
  const sdk = createAgentRunnerSdk({
    transport,
    generateRequestId: () => {
      generated = true
      return RETRY_ID
    },
  })
  const base = runHandle()
  const input: FollowUpInput = {
    prompt: 'follow up',
    agent: 'codex',
    model: 'model-2',
    mode: 'ask',
    fileKeys: ['follow-up.md'],
    requestId: FOLLOW_UP_ID,
  }

  const handle = await sdk.followUp(base, input)

  assert.equal(generated, false)
  assert.equal(handle.kind, 'session')
  assert.equal(handle.runnerId, base.runnerId)
  assert.deepEqual(handle.input, base.input)
  assert.deepEqual(handle.policy, base.policy)
  assert.deepEqual(handle.retries, base.retries)
  assert.deepEqual(handle.origin, base.origin)
  assert.deepEqual(handle.landing, base.landing)
  assert.equal(handle.currentSessionId, 'session-2')
  assert.equal(handle.sessionId, 'session-2')
  assert.deepEqual(handle.sessionInput, input)
  assert.ok(wirePrompt.endsWith(marker(FOLLOW_UP_ID)))
  assert.doesNotMatch(handle.sessionInput.prompt, /agent-runner-sdk-request-id/)
})

test('followUp reconciles a 409 only to the exact active session', async () => {
  let creates = 0
  const transport = fakeTransport({
    createSession: async (_runnerId, input) => {
      creates += 1
      throw new SessionAlreadyActiveError(
        input,
        { sentAt: 100, failedAt: 120 },
        'session-active',
      )
    },
    listSessions: async () => [
      session('session-other', RUN_REQUEST_ID, {
        prompt: `follow up\n\n${marker(RUN_REQUEST_ID)}`,
      }),
      session('session-active', FOLLOW_UP_ID),
    ],
  })
  const sdk = createAgentRunnerSdk({ transport })

  const adopted = await sdk.followUp(runHandle(), {
    prompt: 'follow up',
    requestId: FOLLOW_UP_ID,
  })

  assert.equal(adopted.sessionId, 'session-active')
  assert.equal(creates, 1)

  const unrelated = createAgentRunnerSdk({
    transport: fakeTransport({
      createSession: async (_runnerId, input) => {
        throw new SessionAlreadyActiveError(
          input,
          { sentAt: 100, failedAt: 120 },
          'someone-elses-session',
        )
      },
      listSessions: async () => [
        session('session-active', FOLLOW_UP_ID),
      ],
    }),
  })
  await assert.rejects(
    () => unrelated.followUp(runHandle(), {
      prompt: 'follow up',
      requestId: FOLLOW_UP_ID,
    }),
    (error: unknown) => (
      isAgentRunnerSdkError(error, 'session-already-active')
      && error.activeSessionId === 'someone-elses-session'
    ),
  )
})

test('retry replaces a runner while preserving semantic input and policy', async () => {
  let wireInput: EffectiveStartInput | undefined
  const transport = fakeTransport({
    createRunner: async (input) => {
      wireInput = input
      return runner('runner-replacement')
    },
    listSessions: async (runnerId) => [
      session('session-replacement', RETRY_ID, {
        runnerId,
        prompt: `original prompt\n\n${marker(RETRY_ID)}`,
      }),
    ],
  })
  const sdk = createAgentRunnerSdk({
    transport,
    generateRequestId: () => RETRY_ID,
  })
  const base = runHandle()

  const retried = await sdk.retry(base)

  assert.equal(retried.kind, 'run')
  assert.equal(retried.runnerId, 'runner-replacement')
  assert.equal(retried.currentSessionId, 'session-replacement')
  assert.equal(retried.input.requestId, RETRY_ID)
  assert.equal(retried.input.prompt, originalInput.prompt)
  assert.deepEqual({
    ...retried.input,
    requestId: RUN_REQUEST_ID,
  }, originalInput)
  assert.deepEqual(retried.policy, base.policy)
  assert.deepEqual(retried.landing, base.landing)
  assert.equal(retried.retries.capacity, 1)
  assert.equal(wireInput?.requestId, RETRY_ID)
  assert.ok(wireInput?.prompt?.endsWith(marker(RETRY_ID)))
})

test('session retry preserves an unexpired prompt reference and same runner', async () => {
  const promptRef: BlobRef = {
    store: 'netlify-blobs',
    key: 'prompts/follow-up',
    tenant: 'site-1',
    expiresAt: 1_000,
  }
  const base: SessionHandle = {
    ...runHandle(),
    kind: 'session',
    currentSessionId: 'session-2',
    sessionId: 'session-2',
    sessionInput: {
      promptRef,
      agent: 'codex',
      model: 'model-2',
      mode: 'ask',
      fileKeys: ['follow-up.md'],
      requestId: FOLLOW_UP_ID,
    },
  }
  let deliveredRef: BlobRef | undefined
  let wirePrompt = ''
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      createSession: async (runnerId, input) => {
        assert.equal(runnerId, 'runner-1')
        if (typeof input.prompt !== 'string') {
          assert.fail('expected a delivered prompt-reference wrapper')
        }
        wirePrompt = input.prompt
        return session('session-3', RETRY_ID)
      },
    }),
    now: () => 100,
    generateRequestId: () => RETRY_ID,
    promptRefDelivery: (ref) => {
      deliveredRef = ref
      return 'Fetch and verify the stored prompt.'
    },
  })

  const retried = await sdk.retry(base)

  assert.equal(retried.runnerId, base.runnerId)
  assert.equal(retried.sessionId, 'session-3')
  assert.equal(retried.currentSessionId, 'session-3')
  assert.deepEqual(retried.sessionInput.promptRef, promptRef)
  assert.equal(retried.sessionInput.requestId, RETRY_ID)
  assert.deepEqual(retried.policy, base.policy)
  assert.deepEqual(retried.landing, base.landing)
  assert.equal(retried.retries.capacity, 1)
  assert.deepEqual(deliveredRef, promptRef)
  assert.ok(wirePrompt.endsWith(marker(RETRY_ID)))
})

test('retry rejects expired prompt references and exhausted budgets before I/O', async () => {
  let creates = 0
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      createSession: async () => {
        creates += 1
        return session('unexpected', RETRY_ID)
      },
    }),
    now: () => 2_000,
    generateRequestId: () => RETRY_ID,
    promptRefDelivery: () => 'should not resolve',
  })
  const expired: SessionHandle = {
    ...runHandle(),
    kind: 'session',
    currentSessionId: 'session-2',
    sessionId: 'session-2',
    sessionInput: {
      promptRef: {
        store: 'netlify-blobs',
        key: 'expired',
        tenant: 'site-1',
        expiresAt: 1_000,
      },
      requestId: FOLLOW_UP_ID,
    },
  }
  await assert.rejects(
    () => sdk.retry(expired),
    (error: unknown) => isAgentRunnerSdkError(error, 'prompt-ref-expired'),
  )

  await assert.rejects(
    () => sdk.retry(runHandle({
      retries: { capacity: 2 },
    })),
    (error: unknown) => isAgentRunnerSdkError(error, 'capacity-exhausted'),
  )
  assert.equal(creates, 0)
})

test('retry never blind-replays an ambiguous new logical create', async () => {
  let creates = 0
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      createRunner: async (input) => {
        creates += 1
        throw new CreateAmbiguousError(
          input,
          { sentAt: 200, failedAt: 220 },
        )
      },
    }),
    generateRequestId: () => RETRY_ID,
  })

  await assert.rejects(
    () => sdk.retry(runHandle()),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'create-ambiguous')) return false
      assert.equal(error.effectiveInput.requestId, RETRY_ID)
      assert.equal(error.effectiveInput.prompt, 'original prompt')
      return true
    },
  )
  assert.equal(creates, 1)
})
