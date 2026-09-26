// Verifies onSubmitCheckpoint: the exact effective input is handed to the caller before every
// create request (start, follow-up, capacity retry), and a failing checkpoint sends nothing.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentRunnerSdk } from '../src/index.js'
import type {
  BlobRef,
  BlobStore,
  MemberAction,
  MemberInput,
  MemberResult,
  RunHandle,
  Runner,
  Session,
  SubmitCheckpoint,
  Transport,
} from '../src/index.js'

const REQUEST_ID = '44444444-4444-4444-8444-444444444444'
const RETRY_REQUEST_ID = '55555555-5555-4555-8555-555555555555'

function marker(requestId: string): string {
  return `<!-- agent-runner-sdk-request-id:${requestId} -->`
}

function runner(overrides: Partial<Runner> = {}): Runner {
  return { runnerId: 'runner-1', state: 'running', siteId: 'site-1', ...overrides }
}

function session(overrides: Partial<Session> = {}): Session {
  return { sessionId: 'session-1', runnerId: 'runner-1', state: 'running', prompt: `do work\n\n${marker(REQUEST_ID)}`, usage: null, ...overrides }
}

/** Records every create request next to the checkpoints seen so far, to prove ordering. */
function recordingTransport(events: string[], overrides: Partial<Transport> = {}): Transport {
  const unexpected = (operation: string): never => {
    throw new Error(`unexpected transport operation: ${operation}`)
  }
  return {
    createRunner: async (input) => {
      events.push(`createRunner:${input.requestId}`)
      return runner()
    },
    createSession: async (runnerId, input) => {
      events.push(`createSession:${runnerId}:${input.requestId}`)
      return session({ sessionId: 'session-2', prompt: `${input.prompt ?? ''}` })
    },
    getRunner: async () => runner(),
    listRunners: async () => unexpected('listRunners'),
    listAccountRunners: async () => unexpected('listAccountRunners'),
    getSession: async () => session(),
    listSessions: async () => [session()],
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

class FakeBlobStore implements BlobStore {
  async put(key: string, _bytes: Uint8Array, options: { ttlSeconds: number; tenant: string }): Promise<BlobRef> {
    return { store: 'safe-store', key: `tenants/hash/${key}`, tenant: options.tenant, expiresAt: 100_000 }
  }

  async delete(): Promise<void> {}

  runnerFetchInstruction(): { shell: string; sentinel: string } {
    return { shell: 'netlify blobs:get safe-store tenants/hash/prompt', sentinel: 'sentinel-123' }
  }
}

test('start hands over the exact effective input before the create request', async () => {
  const events: string[] = []
  const checkpoints: SubmitCheckpoint[] = []
  const sdk = createAgentRunnerSdk({
    transport: recordingTransport(events),
    generateRequestId: () => REQUEST_ID,
    now: () => 1_000,
    onSubmitCheckpoint: (checkpoint) => {
      events.push(`checkpoint:${checkpoint.effectiveInput.requestId}`)
      checkpoints.push(checkpoint)
    },
  })
  const handle = await sdk.start({ siteId: 'site-1', prompt: 'do work' })
  assert.deepEqual(events, [`checkpoint:${REQUEST_ID}`, `createRunner:${REQUEST_ID}`])
  assert.equal(checkpoints.length, 1)
  const [checkpoint] = checkpoints as [SubmitCheckpoint]
  assert.equal(checkpoint.v, 1)
  assert.equal(checkpoint.kind, 'create')
  assert.equal(checkpoint.sentAt, 1_000)
  assert.equal(checkpoint.runnerId, undefined)
  assert.deepEqual(checkpoint.effectiveInput, handle.input)
  assert.equal(checkpoint.promptDelivery?.kind, 'inline')
})

test('blob delivery checkpoints the promptRef that is actually sent', async () => {
  const checkpoints: SubmitCheckpoint[] = []
  const sdk = createAgentRunnerSdk({
    transport: recordingTransport([]),
    generateRequestId: () => REQUEST_ID,
    now: () => 1_000,
    blobStore: new FakeBlobStore(),
    promptDelivery: { env: {}, safeBytes: 1_024 },
    onSubmitCheckpoint: (checkpoint) => { checkpoints.push(checkpoint) },
  })
  const handle = await sdk.start({ siteId: 'site-1', prompt: `private ${'x'.repeat(3_000)}` })
  const [checkpoint] = checkpoints as [SubmitCheckpoint]
  assert.equal(checkpoint.promptDelivery?.kind, 'blob')
  assert.ok(checkpoint.effectiveInput.promptRef)
  assert.equal(checkpoint.effectiveInput.prompt, undefined)
  assert.deepEqual(checkpoint.effectiveInput, handle.input)
})

test('a checkpoint that throws sends nothing', async () => {
  const events: string[] = []
  const sdk = createAgentRunnerSdk({
    transport: recordingTransport(events),
    generateRequestId: () => REQUEST_ID,
    onSubmitCheckpoint: () => {
      throw new Error('disk full')
    },
  })
  await assert.rejects(sdk.start({ siteId: 'site-1', prompt: 'do work' }), /disk full/)
  assert.deepEqual(events, [])
})

test('follow-ups checkpoint a session create with the followed runner id', async () => {
  const events: string[] = []
  const checkpoints: SubmitCheckpoint[] = []
  const sdk = createAgentRunnerSdk({
    transport: recordingTransport(events),
    generateRequestId: () => REQUEST_ID,
    now: () => 2_000,
    onSubmitCheckpoint: (checkpoint) => {
      events.push('checkpoint')
      checkpoints.push(checkpoint)
    },
  })
  const started = await sdk.start({ siteId: 'site-1', prompt: 'do work' })
  events.length = 0
  checkpoints.length = 0
  const followed = await sdk.followUp(started, { prompt: 'continue' })
  assert.deepEqual(events, ['checkpoint', `createSession:runner-1:${REQUEST_ID}`])
  const [checkpoint] = checkpoints as [SubmitCheckpoint]
  assert.equal(checkpoint.kind, 'session')
  assert.equal(checkpoint.runnerId, 'runner-1')
  assert.deepEqual(checkpoint.effectiveInput, followed.sessionInput)
})

test('a capacity retry checkpoints its new create request', async () => {
  const events: string[] = []
  const checkpoints: SubmitCheckpoint[] = []
  const requestIds = [REQUEST_ID, RETRY_REQUEST_ID]
  let creates = 0
  let clock = 0
  const transport = recordingTransport(events, {
    createRunner: async (input) => {
      creates += 1
      events.push(`createRunner:${input.requestId}`)
      return runner({ runnerId: `runner-${creates}` })
    },
    listSessions: async (runnerId) => [session({
      runnerId,
      prompt: `do work\n\n${marker(runnerId === 'runner-1' ? REQUEST_ID : RETRY_REQUEST_ID)}`,
    })],
    getRunner: async (runnerId) => runner({ runnerId, state: runnerId === 'runner-1' ? 'failed' : 'completed' }),
    getSession: async (runnerId, sessionId) => session({
      runnerId,
      sessionId,
      state: runnerId === 'runner-1' ? 'failed' : 'completed',
      resultText: runnerId === 'runner-1' ? 'The selected model is currently at capacity' : 'Completed after retry',
    }),
  })
  const sdk = createAgentRunnerSdk({
    transport,
    generateRequestId: () => requestIds.shift() ?? RETRY_REQUEST_ID,
    now: () => clock,
    random: () => 0,
    sleep: async (ms) => { clock += ms },
    onSubmitCheckpoint: (checkpoint) => {
      events.push(`checkpoint:${checkpoint.effectiveInput.requestId}`)
      checkpoints.push(checkpoint)
    },
  })
  const outcome = await sdk.run({ siteId: 'site-1', prompt: 'do work', retryBudget: { capacity: 1 } })
  assert.equal((outcome.handle as RunHandle).runnerId, 'runner-2')
  assert.deepEqual(events, [
    `checkpoint:${REQUEST_ID}`,
    `createRunner:${REQUEST_ID}`,
    `checkpoint:${RETRY_REQUEST_ID}`,
    `createRunner:${RETRY_REQUEST_ID}`,
  ])
  assert.equal(checkpoints[1]?.kind, 'create')
})
