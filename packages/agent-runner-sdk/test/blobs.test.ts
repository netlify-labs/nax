import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  BasicAgentRunnerSdkError,
  createAgentRunnerSdk,
  createNetlifyBlobStore,
  isAgentRunnerSdkError,
} from '../src/index.js'
import type {
  BlobCleanupErrorEvent,
  BlobRef,
  BlobStore,
  MemberAction,
  MemberInput,
  MemberResult,
  NetlifyBlobClient,
  RunHandle,
  Runner,
  Session,
  Transport,
} from '../src/index.js'

const encoder = new TextEncoder()
const REQUEST_ID = '44444444-4444-4444-8444-444444444444'
const TOKEN = 'secret-netlify-token'

class FakeNetlifyBlobClient implements NetlifyBlobClient {
  readonly values = new Map<string, Blob>()
  readonly metadata = new Map<string, Record<string, unknown>>()
  readonly deletes: string[] = []
  failWrite = false
  failDelete = false

  async set(
    key: string,
    bytes: Blob,
    options?: {
      metadata?: Record<string, unknown>
      onlyIfNew?: boolean
    },
  ): Promise<{ modified: boolean }> {
    if (this.failWrite) throw new Error(`write leaked ${TOKEN}`)
    if (options?.onlyIfNew && this.values.has(key)) {
      return { modified: false }
    }
    this.values.set(key, bytes)
    this.metadata.set(key, options?.metadata ?? {})
    return { modified: true }
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete) throw new Error(`delete leaked ${TOKEN}`)
    this.deletes.push(key)
    this.values.delete(key)
  }
}

function runner(state: string): Runner {
  return {
    runnerId: 'runner-1',
    state,
    siteId: 'site-1',
  }
}

function session(state: string): Session {
  return {
    sessionId: 'session-1',
    runnerId: 'runner-1',
    state,
    ...(state === 'completed' ? { resultText: 'done' } : {}),
    usage: null,
  }
}

function fakeTransport(state: string): Transport {
  const unexpected = (operation: string): never => {
    throw new Error(`unexpected transport operation: ${operation}`)
  }
  return {
    createRunner: async () => unexpected('createRunner'),
    createSession: async () => unexpected('createSession'),
    getRunner: async () => runner(state),
    listRunners: async () => unexpected('listRunners'),
    listAccountRunners: async () => unexpected('listAccountRunners'),
    getSession: async () => session(state),
    listSessions: async () => unexpected('listSessions'),
    cancelRunner: async () => undefined,
    cancelSession: async () => unexpected('cancelSession'),
    member: async <A extends MemberAction>(
      _runnerId: string,
      _action: A,
      _input: MemberInput<A>,
    ): Promise<MemberResult<A>> => unexpected('member'),
  }
}

function handle(promptRef: BlobRef): RunHandle {
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: 'codex',
    input: {
      siteId: 'site-1',
      promptRef,
      agent: 'codex',
      land: 'none',
      deadlineMs: 60_000,
      retryBudget: { capacity: 1 },
      requestId: REQUEST_ID,
    },
    policy: {
      landing: 'none',
      deadlineAt: 60_000,
      retryBudget: { capacity: 1 },
    },
    retries: { capacity: 0 },
    currentSessionId: 'session-1',
  }
}

function recordingBlobStore(
  ref: BlobRef,
  deletes: BlobRef[],
  deleteError?: Error,
): BlobStore {
  return {
    async put() {
      return ref
    },
    async delete(value) {
      deletes.push(value)
      if (deleteError) throw deleteError
    },
    runnerFetchInstruction() {
      return {
        shell: 'netlify blobs:get safe-store safe-key',
        sentinel: 'safe-sentinel',
      }
    },
  }
}

test('Netlify BlobStore writes tenant-scoped collision-resistant refs with TTL', async () => {
  const client = new FakeNetlifyBlobClient()
  const nonces = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]
  const store = createNetlifyBlobStore({
    siteId: 'site-1',
    token: TOKEN,
    client,
    now: () => 1_000,
    randomUUID: () => nonces.shift() ?? 'fallback-nonce',
  })

  const first = await store.put(
    'artifact prompt',
    encoder.encode('semantic prompt'),
    { ttlSeconds: 60, tenant: 'site-1/artifact-1' },
  )
  const second = await store.put(
    'artifact prompt',
    encoder.encode('semantic prompt'),
    { ttlSeconds: 60, tenant: 'site-1/artifact-1' },
  )
  const otherTenant = await store.put(
    'artifact prompt',
    encoder.encode('semantic prompt'),
    { ttlSeconds: 60, tenant: 'site-2/artifact-1' },
  )

  assert.equal(first.store, 'nax-agent-runner-prompts')
  assert.equal(first.tenant, 'site-1/artifact-1')
  assert.equal(first.expiresAt, 61_000)
  assert.notEqual(first.key, second.key)
  assert.notEqual(
    first.key.split('/')[1],
    otherTenant.key.split('/')[1],
  )
  assert.match(first.key, /^tenants\/[a-f0-9]{32}\//)

  const instruction = store.runnerFetchInstruction(first)
  const stored = await client.values.get(first.key)?.text()
  assert.equal(
    stored,
    `NAX-BLOB-SENTINEL ${instruction.sentinel}\n\nsemantic prompt`,
  )
  assert.match(
    instruction.shell,
    /^NETLIFY_SITE_ID="\$\{NETLIFY_SITE_ID:-\$SITE_ID\}" netlify blobs:get /,
  )
  assert.equal(instruction.shell.includes(TOKEN), false)
  assert.equal(instruction.shell.includes(first.tenant), false)
  assert.deepEqual(client.metadata.get(first.key), {
    naxExpiresAt: 61_000,
    naxTenantHash: first.key.split('/')[1],
  })
})

test('Netlify BlobStore enforces size, lifetime, and full ref identity', async () => {
  const client = new FakeNetlifyBlobClient()
  const store = createNetlifyBlobStore({
    siteId: 'site-1',
    token: TOKEN,
    client,
    maxBytes: 4,
    maxTtlSeconds: 10,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
  })

  await assert.rejects(
    () => store.put('large', encoder.encode('12345'), {
      ttlSeconds: 10,
      tenant: 'tenant-1',
    }),
    (error: unknown) => isAgentRunnerSdkError(error, 'prompt-too-large'),
  )
  await assert.rejects(
    () => store.put('long-lived', encoder.encode('1234'), {
      ttlSeconds: 11,
      tenant: 'tenant-1',
    }),
    (error: unknown) => isAgentRunnerSdkError(error, 'blob-ttl-too-long'),
  )

  const ref = await store.put('safe', encoder.encode('1234'), {
    ttlSeconds: 10,
    tenant: 'tenant-1',
  })
  await assert.rejects(
    () => store.delete({ ...ref, tenant: 'tenant-2' }),
    (error: unknown) => isAgentRunnerSdkError(error, 'blob-ref-invalid'),
  )
  await assert.rejects(
    () => store.delete({ ...ref, store: 'other-store' }),
    (error: unknown) => isAgentRunnerSdkError(error, 'blob-ref-invalid'),
  )
  assert.deepEqual(client.deletes, [])

  await store.delete(ref)
  await store.delete(ref)
  assert.deepEqual(client.deletes, [ref.key, ref.key])
})

test('Netlify BlobStore normalizes provider faults without leaking values', async () => {
  const client = new FakeNetlifyBlobClient()
  const store = createNetlifyBlobStore({
    siteId: 'site-1',
    token: TOKEN,
    client,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
  })
  client.failWrite = true
  await assert.rejects(
    () => store.put('safe', encoder.encode('prompt'), {
      ttlSeconds: 10,
      tenant: 'tenant-1',
    }),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'blob-write-failed')) return false
      assert.equal(JSON.stringify(error).includes(TOKEN), false)
      assert.equal(error.message.includes(TOKEN), false)
      assert.equal(error.cause, undefined)
      return true
    },
  )

  client.failWrite = false
  const ref = await store.put('safe', encoder.encode('prompt'), {
    ttlSeconds: 10,
    tenant: 'tenant-1',
  })
  client.failDelete = true
  await assert.rejects(
    () => store.delete(ref),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'blob-delete-failed')) return false
      assert.equal(JSON.stringify(error).includes(TOKEN), false)
      assert.equal(error.cause, undefined)
      return true
    },
  )
})

test('terminal cleanup deletes success, cancellation, and timeout but retains failure', async () => {
  const ref: BlobRef = {
    store: 'safe-store',
    key: 'tenants/hash/safe-key',
    tenant: 'tenant-1',
    expiresAt: 100_000,
  }
  const cases = [
    { state: 'completed', expectedDeletes: 1 },
    { state: 'cancelled', expectedDeletes: 1 },
    { state: 'timed_out', expectedDeletes: 1 },
    { state: 'failed', expectedDeletes: 0 },
  ]

  for (const entry of cases) {
    const deletes: BlobRef[] = []
    const sdk = createAgentRunnerSdk({
      transport: fakeTransport(entry.state),
      blobStore: recordingBlobStore(ref, deletes),
    })
    const restored = sdk.parseHandle(sdk.serializeHandle(handle(ref)))
    const snapshot = await sdk.getSnapshot(restored)
    assert.equal(snapshot.kind, 'terminal')
    assert.equal(deletes.length, entry.expectedDeletes)
    if (deletes[0]) assert.deepEqual(deletes[0], ref)
  }
})

test('explicit stop and deadline timeout clean refs without failing the run', async () => {
  const ref: BlobRef = {
    store: 'safe-store',
    key: 'tenants/hash/safe-key',
    tenant: 'tenant-1',
    expiresAt: 100_000,
  }
  const stoppedDeletes: BlobRef[] = []
  const stopped = createAgentRunnerSdk({
    transport: fakeTransport('running'),
    blobStore: recordingBlobStore(ref, stoppedDeletes),
  })
  await stopped.stop(handle(ref))
  assert.deepEqual(stoppedDeletes, [ref])

  let clock = 0
  const timedOutDeletes: BlobRef[] = []
  const cleanupEvents: BlobCleanupErrorEvent[] = []
  const timedOut = createAgentRunnerSdk({
    transport: fakeTransport('running'),
    blobStore: recordingBlobStore(
      ref,
      timedOutDeletes,
      new Error(`cleanup leaked ${TOKEN}`),
    ),
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds
    },
    pollIntervalMs: 5,
    onBlobCleanupError: (event) => cleanupEvents.push(event),
  })
  const result = await timedOut.waitFor(handle(ref))
  assert.equal(result.status, 'timedOut')
  assert.deepEqual(timedOutDeletes, [ref])
  assert.deepEqual(cleanupEvents, [{
    kind: 'blobCleanupFailed',
    code: 'blob-delete-failed',
    terminalStatus: 'timedOut',
  }])
  assert.equal(JSON.stringify(cleanupEvents).includes(TOKEN), false)
})

test('cleanup failures remain best-effort for successful terminal reads', async () => {
  const ref: BlobRef = {
    store: 'safe-store',
    key: 'tenants/hash/safe-key',
    tenant: 'tenant-1',
    expiresAt: 100_000,
  }
  const deletes: BlobRef[] = []
  const events: BlobCleanupErrorEvent[] = []
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport('completed'),
    blobStore: recordingBlobStore(
      ref,
      deletes,
      new Error(`cleanup leaked ${TOKEN}`),
    ),
    onBlobCleanupError: (event) => events.push(event),
  })

  const result = await sdk.getResult(handle(ref))
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(deletes, [ref])
  assert.deepEqual(events, [{
    kind: 'blobCleanupFailed',
    code: 'blob-delete-failed',
    terminalStatus: 'succeeded',
  }])
})

test('blob error codes classify into the stable blob failure profile', () => {
  const sdk = createAgentRunnerSdk({ transport: fakeTransport('running') })
  const failure = sdk.classifyFailure(
    new BasicAgentRunnerSdkError(
      'blob-write-failed',
      'The prompt blob could not be stored.',
    ),
  )
  assert.equal(failure.category, 'blob')
  assert.equal(failure.code, 'blob-write-failed')
  assert.equal(failure.stage, 'blob')
})
