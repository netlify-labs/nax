import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAgentRunnerSdk,
  isAgentRunnerSdkError,
} from '../src/index.js'
import type {
  BlobCleanupErrorEvent,
  BlobRef,
  BlobStore,
  Handle,
  MemberAction,
  MemberInput,
  MemberResult,
  Runner,
  Session,
  Transport,
} from '../src/index.js'

const FIRST_REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'private-netlify-token'
const SEMANTIC_PROMPT = `private semantic prompt ${'🧭'.repeat(1_000)}`
const FETCH_INSTRUCTION =
  'netlify blobs:get safe-store tenants/hash/full-prompt'
const RESULT_TEXT = 'private terminal result'

class ConformanceBlobStore implements BlobStore {
  readonly puts: string[] = []
  readonly deletes: BlobRef[] = []
  failDelete = false

  async put(
    _key: string,
    bytes: Uint8Array,
    options: { ttlSeconds: number; tenant: string },
  ): Promise<BlobRef> {
    this.puts.push(new TextDecoder().decode(bytes))
    return {
      store: 'safe-store',
      key: 'tenants/hash/full-prompt',
      tenant: options.tenant,
      expiresAt: 50_000,
    }
  }

  async delete(ref: BlobRef): Promise<void> {
    this.deletes.push(ref)
    if (this.failDelete) {
      throw new Error(
        `${TOKEN} ${SEMANTIC_PROMPT} ${FETCH_INSTRUCTION} ${RESULT_TEXT}`,
      )
    }
  }

  runnerFetchInstruction(): { shell: string; sentinel: string } {
    return {
      shell: FETCH_INSTRUCTION,
      sentinel: 'safe-sentinel',
    }
  }
}

test('serialized capacity retry retains then reuses and cleans one exact prompt ref', async () => {
  let clock = 100
  let creates = 0
  const requestIds = [FIRST_REQUEST_ID, SECOND_REQUEST_ID]
  const submittedPrompts = new Map<string, string>()
  const retryCheckpoints: Handle[] = []
  const blobStore = new ConformanceBlobStore()

  const stateFor = (runnerId: string): string => (
    runnerId === 'runner-1' ? 'failed' : 'completed'
  )
  const transport: Transport = {
    createRunner: async (input) => {
      creates += 1
      const runnerId = `runner-${creates}`
      if (input.prompt === undefined) assert.fail('wire prompt required')
      submittedPrompts.set(runnerId, input.prompt)
      return {
        runnerId,
        siteId: 'site-1',
        state: stateFor(runnerId),
      }
    },
    createSession: async () => {
      throw new Error('unexpected createSession')
    },
    getRunner: async (runnerId) => ({
      runnerId,
      siteId: 'site-1',
      state: stateFor(runnerId),
    } satisfies Runner),
    listRunners: async () => {
      throw new Error('unexpected listRunners')
    },
    listAccountRunners: async () => {
      throw new Error('unexpected listAccountRunners')
    },
    getSession: async (runnerId, sessionId) => ({
      runnerId,
      sessionId,
      state: stateFor(runnerId),
      resultText: runnerId === 'runner-1'
        ? 'The selected model is currently at capacity'
        : RESULT_TEXT,
      usage: null,
    } satisfies Session),
    listSessions: async (runnerId) => [{
      runnerId,
      sessionId: `session-${runnerId}`,
      state: stateFor(runnerId),
      prompt: submittedPrompts.get(runnerId),
      usage: null,
    } satisfies Session],
    cancelRunner: async () => undefined,
    cancelSession: async () => undefined,
    member: async <A extends MemberAction>(
      _runnerId: string,
      _action: A,
      _input: MemberInput<A>,
    ): Promise<MemberResult<A>> => {
      throw new Error('unexpected member')
    },
  }
  const sdk = createAgentRunnerSdk({
    transport,
    blobStore,
    generateRequestId: () => requestIds.shift() ?? SECOND_REQUEST_ID,
    now: () => clock,
    random: () => 0,
    sleep: async (milliseconds) => {
      clock += milliseconds
    },
    promptDelivery: {
      env: {},
      safeBytes: 1_024,
      hardMaxBytes: 10_000,
      tenant: 'site-1/artifact-1',
    },
    onRetryCheckpoint: (handle) => {
      retryCheckpoints.push(
        sdk.parseHandle(sdk.serializeHandle(handle)),
      )
    },
  })

  const first = await sdk.start({
    siteId: 'site-1',
    prompt: SEMANTIC_PROMPT,
    deadlineMs: 10_000,
    retryBudget: { capacity: 1 },
  })
  const restored = sdk.parseHandle(sdk.serializeHandle(first))
  if (restored.kind !== 'run') {
    assert.fail('expected restored run handle')
  }
  const firstResult = await sdk.getResult(restored)

  assert.equal(firstResult.status, 'failed')
  assert.equal(blobStore.puts.length, 1)
  assert.deepEqual(blobStore.puts, [SEMANTIC_PROMPT])
  assert.equal(blobStore.deletes.length, 0)
  assert.ok(restored.input.promptRef)
  assert.equal(restored.promptDelivery?.kind, 'blob')
  assert.equal(
    sdk.serializeHandle(restored).includes(SEMANTIC_PROMPT),
    false,
  )
  assert.equal(
    sdk.serializeHandle(restored).includes(FETCH_INSTRUCTION),
    false,
  )

  if (firstResult.status !== 'failed') {
    assert.fail('expected failed capacity attempt')
  }
  assert.equal(sdk.shouldRetry(restored, firstResult.failure), true)
  const retried = await sdk.retry(restored, {
    failure: firstResult.failure,
  })
  const restoredRetry = sdk.parseHandle(sdk.serializeHandle(retried))

  assert.equal(blobStore.puts.length, 1)
  assert.deepEqual(restoredRetry.input.promptRef, restored.input.promptRef)
  assert.deepEqual(
    restoredRetry.promptDelivery?.promptRef,
    restored.input.promptRef,
  )
  assert.equal(restoredRetry.retries.capacity, 1)
  assert.equal(retryCheckpoints.length, 1)
  assert.equal(retryCheckpoints[0]?.retries.capacity, 1)
  assert.equal(
    submittedPrompts.get('runner-1')?.includes(FIRST_REQUEST_ID),
    true,
  )
  assert.equal(
    submittedPrompts.get('runner-2')?.includes(SECOND_REQUEST_ID),
    true,
  )

  const finalResult = await sdk.getResult(restoredRetry)
  assert.equal(finalResult.status, 'succeeded')
  assert.deepEqual(blobStore.deletes, [restored.input.promptRef])
})

test('failure and cleanup observations never contain values or fetch instructions', async () => {
  const events: BlobCleanupErrorEvent[] = []
  const blobStore = new ConformanceBlobStore()
  blobStore.failDelete = true
  const ref: BlobRef = {
    store: 'safe-store',
    key: 'tenants/hash/full-prompt',
    tenant: 'site-1/artifact-1',
    expiresAt: 50_000,
  }
  const transport: Transport = {
    createRunner: async () => {
      throw new Error('unexpected createRunner')
    },
    createSession: async () => {
      throw new Error('unexpected createSession')
    },
    getRunner: async () => ({
      runnerId: 'runner-1',
      state: 'completed',
    }),
    listRunners: async () => {
      throw new Error('unexpected listRunners')
    },
    listAccountRunners: async () => {
      throw new Error('unexpected listAccountRunners')
    },
    getSession: async () => ({
      runnerId: 'runner-1',
      sessionId: 'session-1',
      state: 'completed',
      resultText: RESULT_TEXT,
      usage: null,
    }),
    listSessions: async () => {
      throw new Error('unexpected listSessions')
    },
    cancelRunner: async () => undefined,
    cancelSession: async () => undefined,
    member: async <A extends MemberAction>(
      _runnerId: string,
      _action: A,
      _input: MemberInput<A>,
    ): Promise<MemberResult<A>> => {
      throw new Error('unexpected member')
    },
  }
  const sdk = createAgentRunnerSdk({
    transport,
    blobStore,
    onBlobCleanupError: (event) => events.push(event),
  })
  const handle = sdk.parseHandle({
    v: 1,
    kind: 'run',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: 'codex',
    input: {
      siteId: 'site-1',
      promptRef: ref,
      agent: 'codex',
      land: 'none',
      deadlineMs: 10_000,
      retryBudget: { capacity: 0 },
      requestId: FIRST_REQUEST_ID,
    },
    policy: {
      landing: 'none',
      deadlineAt: 10_000,
      retryBudget: { capacity: 0 },
    },
    retries: { capacity: 0 },
    promptDelivery: {
      kind: 'blob',
      safeBytes: 1_024,
      submittedBytes: 512,
      promptRef: ref,
      sentinel: 'safe-sentinel',
    },
    currentSessionId: 'session-1',
  })

  const result = await sdk.getResult(handle)
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(events, [{
    kind: 'blobCleanupFailed',
    code: 'blob-delete-failed',
    terminalStatus: 'succeeded',
  }])

  const classification = sdk.classifyFailure(
    new Error(
      `${TOKEN} ${SEMANTIC_PROMPT} ${FETCH_INSTRUCTION} ${RESULT_TEXT}`,
    ),
  )
  const snapshots = JSON.stringify({ events, classification })
  for (const secretValue of [
    TOKEN,
    SEMANTIC_PROMPT,
    FETCH_INSTRUCTION,
    RESULT_TEXT,
    FIRST_REQUEST_ID,
  ]) {
    assert.equal(snapshots.includes(secretValue), false)
  }

  await assert.rejects(
    () => createAgentRunnerSdk({
      transport,
      promptDelivery: {
        env: { NAX_SAFE_PROMPT_BYTES: 'invalid' },
      },
    }).start({
      siteId: 'site-1',
      prompt: SEMANTIC_PROMPT,
    }),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'validation-error')) return false
      const serialized = JSON.stringify(error)
      return !serialized.includes(SEMANTIC_PROMPT)
        && !serialized.includes(FIRST_REQUEST_ID)
    },
  )
})
