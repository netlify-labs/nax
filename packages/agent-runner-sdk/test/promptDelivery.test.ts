import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  DEFAULT_SAFE_PROMPT_BYTES,
  classifySentinelEvidence,
  compactPromptByBytes,
  createAgentRunnerSdk,
  isAgentRunnerSdkError,
  preparePromptDelivery,
  requestMarkerOverheadBytes,
} from '../src/index.js'
import type {
  BlobRef,
  BlobStore,
  MemberAction,
  MemberInput,
  MemberResult,
  Runner,
  Session,
  Transport,
} from '../src/index.js'

const REQUEST_ID = '44444444-4444-4444-8444-444444444444'
const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function marker(requestId = REQUEST_ID): string {
  return `\n\n<!-- agent-runner-sdk-request-id:${requestId} -->`
}

function decorate(value: string): string {
  return `${value}${marker()}`
}

class FakeBlobStore implements BlobStore {
  readonly puts: Array<{
    key: string
    text: string
    ttlSeconds: number
    tenant: string
  }> = []
  readonly deletes: BlobRef[] = []
  instructionShell = 'netlify blobs:get safe-store tenants/hash/prompt'
  instructionSentinel = 'sentinel-123'
  failPut: Error | undefined
  failInstruction: Error | undefined

  async put(
    key: string,
    bytes: Uint8Array,
    options: { ttlSeconds: number; tenant: string },
  ): Promise<BlobRef> {
    if (this.failPut) throw this.failPut
    this.puts.push({
      key,
      text: new TextDecoder().decode(bytes),
      ...options,
    })
    return {
      store: 'safe-store',
      key: `tenants/hash/${key}`,
      tenant: options.tenant,
      expiresAt: 100_000,
    }
  }

  async delete(ref: BlobRef): Promise<void> {
    this.deletes.push(ref)
  }

  runnerFetchInstruction(): { shell: string; sentinel: string } {
    if (this.failInstruction) throw this.failInstruction
    return {
      shell: this.instructionShell,
      sentinel: this.instructionSentinel,
    }
  }
}

function baseOptions(prompt: string) {
  return {
    promptInput: { prompt },
    decoratedPrompt: decorate(prompt),
    decorate,
    context: {
      siteId: 'site-1',
      operation: 'start' as const,
    },
    policy: { env: {} },
    now: () => 1_000,
  }
}

test('inline boundaries measure the final request-marker-decorated UTF-8 prompt', async () => {
  assert.equal(byteLength(marker()), requestMarkerOverheadBytes)
  const semanticLimit =
    DEFAULT_SAFE_PROMPT_BYTES - requestMarkerOverheadBytes

  for (const [offset, expected] of [
    [-1, 'inline'],
    [0, 'inline'],
  ] as const) {
    const prompt = 'a'.repeat(semanticLimit + offset)
    const planned = await preparePromptDelivery(baseOptions(prompt))
    assert.equal(planned.attempt.kind, expected)
    assert.equal(
      planned.attempt.submittedBytes,
      DEFAULT_SAFE_PROMPT_BYTES + offset,
    )
  }

  const above = 'a'.repeat(semanticLimit + 1)
  await assert.rejects(
    () => preparePromptDelivery(baseOptions(above)),
    (error: unknown) => isAgentRunnerSdkError(error, 'prompt-too-large'),
  )
})

test('NAX_SAFE_PROMPT_BYTES applies to the final Unicode prompt', async () => {
  const safeBytes = requestMarkerOverheadBytes + byteLength('🧭')
  const atBoundary = await preparePromptDelivery({
    ...baseOptions('🧭'),
    policy: {
      env: { NAX_SAFE_PROMPT_BYTES: String(safeBytes) },
      hardMaxBytes: safeBytes,
    },
  })
  assert.equal(atBoundary.attempt.kind, 'inline')
  assert.equal(atBoundary.attempt.submittedBytes, safeBytes)

  await assert.rejects(
    () => preparePromptDelivery({
      ...baseOptions('🧭x'),
      policy: {
        env: { NAX_SAFE_PROMPT_BYTES: String(safeBytes) },
        hardMaxBytes: safeBytes,
      },
    }),
    (error: unknown) => isAgentRunnerSdkError(error, 'prompt-too-large'),
  )
})

test('deterministic compaction preserves semantic input and remeasures decoration', async () => {
  const prompt = `begin-${'🧭'.repeat(300)}-end`
  const options = {
    ...baseOptions(prompt),
    policy: {
      env: {},
      safeBytes: 320,
      hardMaxBytes: 10_000,
      compact: compactPromptByBytes,
    },
  }
  const first = await preparePromptDelivery(options)
  const second = await preparePromptDelivery(options)

  assert.equal(first.attempt.kind, 'compact')
  assert.deepEqual(first, second)
  assert.deepEqual(first.effectivePrompt, { prompt })
  assert.notEqual(first.deliveredPrompt, prompt)
  assert.ok((first.deliveredPrompt ?? '').startsWith('begin-'))
  assert.ok((first.deliveredPrompt ?? '').endsWith('-end'))
  assert.ok(first.attempt.submittedBytes <= 320)
})

test('blob fallback stores semantic bytes and submits only the fetch wrapper', async () => {
  const blobStore = new FakeBlobStore()
  const semanticPrompt = `private prompt ${'x'.repeat(2_000)}`
  const planned = await preparePromptDelivery({
    ...baseOptions(semanticPrompt),
    blobStore,
    policy: {
      env: {},
      safeBytes: 1_024,
      hardMaxBytes: 10_000,
      blobTtlSeconds: 600,
      inlineInstructions: 'Fix the confirmed issues first.',
      tenant: ({ siteId }) => `${siteId}/artifact-1`,
      key: 'artifact-1-prompt',
    },
  })

  assert.equal(planned.attempt.kind, 'blob')
  assert.deepEqual(blobStore.puts, [{
    key: 'artifact-1-prompt',
    text: semanticPrompt,
    ttlSeconds: 600,
    tenant: 'site-1/artifact-1',
  }])
  assert.equal(planned.deliveredPrompt?.includes(semanticPrompt), false)
  assert.match(
    planned.deliveredPrompt ?? '',
    /## Request instructions\n\nFix the confirmed issues first\./,
  )
  assert.match(
    planned.deliveredPrompt ?? '',
    /netlify blobs:get safe-store tenants\/hash\/prompt/,
  )
  assert.equal(
    planned.deliveredPrompt?.includes(blobStore.instructionSentinel),
    false,
  )
  assert.equal(planned.attempt.sentinel, blobStore.instructionSentinel)
  assert.deepEqual(
    planned.effectivePrompt,
    { promptRef: planned.attempt.promptRef },
  )
  assert.ok(planned.attempt.submittedBytes <= 1_024)
})

test('blob wrappers keep oversized request instructions visible and bounded', async () => {
  const blobStore = new FakeBlobStore()
  const semanticPrompt = `complete prompt ${'x'.repeat(2_000)}`
  const inlineInstructions = `Fix the confirmed issues. ${'detail '.repeat(500)}instruction-tail`
  const planned = await preparePromptDelivery({
    ...baseOptions(semanticPrompt),
    blobStore,
    policy: {
      env: {},
      safeBytes: 1_024,
      hardMaxBytes: 10_000,
      inlineInstructions,
    },
  })

  assert.equal(planned.attempt.kind, 'blob')
  assert.match(planned.deliveredPrompt ?? '', /Fix the confirmed issues\./)
  assert.match(
    planned.deliveredPrompt ?? '',
    /remaining instructions are in the offloaded full prompt/,
  )
  assert.doesNotMatch(planned.deliveredPrompt ?? '', /instruction-tail/)
  assert.equal(blobStore.puts[0]?.text, semanticPrompt)
  assert.ok(planned.attempt.submittedBytes <= 1_024)
})

test('unavailable storage, hard ceilings, and provider faults are typed and value-free', async () => {
  const prompt = 'sensitive semantic prompt '.repeat(100)
  await assert.rejects(
    () => preparePromptDelivery({
      ...baseOptions(prompt),
      policy: {
        env: {},
        safeBytes: 256,
        hardMaxBytes: 10_000,
      },
    }),
    (error: unknown) => isAgentRunnerSdkError(error, 'prompt-too-large'),
  )

  const tooLargeStore = new FakeBlobStore()
  await assert.rejects(
    () => preparePromptDelivery({
      ...baseOptions(prompt),
      blobStore: tooLargeStore,
      policy: {
        env: {},
        safeBytes: 256,
        hardMaxBytes: 300,
      },
    }),
    (error: unknown) => isAgentRunnerSdkError(error, 'prompt-too-large'),
  )
  assert.equal(tooLargeStore.puts.length, 0)

  const failingStore = new FakeBlobStore()
  failingStore.failPut = new Error(`provider echoed: ${prompt}`)
  await assert.rejects(
    () => preparePromptDelivery({
      ...baseOptions(prompt),
      blobStore: failingStore,
      policy: {
        env: {},
        safeBytes: 256,
        hardMaxBytes: 10_000,
      },
    }),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'blob-write-failed')) return false
      assert.equal(error.message.includes(prompt), false)
      assert.equal(error.cause, undefined)
      return true
    },
  )

  await assert.rejects(
    () => preparePromptDelivery({
      ...baseOptions(prompt),
      policy: {
        env: {},
        safeBytes: 256,
        hardMaxBytes: 10_000,
        compact: () => {
          throw new Error(prompt)
        },
      },
    }),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(
        error,
        'prompt-compaction-failed',
      )) return false
      assert.equal(error.message.includes(prompt), false)
      return true
    },
  )
})

test('existing prompt refs are reused exactly until expiry', async () => {
  const blobStore = new FakeBlobStore()
  const promptRef: BlobRef = {
    store: 'safe-store',
    key: 'tenants/hash/existing',
    tenant: 'site-1/artifact-1',
    expiresAt: 2_000,
  }
  const planned = await preparePromptDelivery({
    promptInput: { promptRef },
    decoratedPrompt: marker(),
    decorate,
    context: { siteId: 'site-1', operation: 'start' },
    blobStore,
    policy: { env: {}, safeBytes: 1_024 },
    now: () => 1_000,
  })
  assert.deepEqual(planned.effectivePrompt, { promptRef })
  assert.deepEqual(planned.attempt.promptRef, promptRef)
  assert.equal(blobStore.puts.length, 0)

  await assert.rejects(
    () => preparePromptDelivery({
      promptInput: { promptRef },
      decoratedPrompt: marker(),
      decorate,
      context: { siteId: 'site-1', operation: 'start' },
      blobStore,
      policy: { env: {}, safeBytes: 1_024 },
      now: () => 2_000,
    }),
    (error: unknown) => isAgentRunnerSdkError(error, 'prompt-ref-expired'),
  )
})

test('an unsafe blob wrapper is rolled back before prompt-too-large', async () => {
  const blobStore = new FakeBlobStore()
  blobStore.instructionShell = 'x'.repeat(2_000)
  await assert.rejects(
    () => preparePromptDelivery({
      ...baseOptions('semantic '.repeat(200)),
      blobStore,
      policy: {
        env: {},
        safeBytes: 512,
        hardMaxBytes: 10_000,
      },
    }),
    (error: unknown) => isAgentRunnerSdkError(error, 'prompt-too-large'),
  )
  assert.equal(blobStore.puts.length, 1)
  assert.deepEqual(blobStore.deletes, [{
    store: 'safe-store',
    key: 'tenants/hash/runner-prompt',
    tenant: 'site-1',
    expiresAt: 100_000,
  }])
})

test('sentinel evidence normalizes all four verdicts', () => {
  assert.deepEqual(
    classifySentinelEvidence({
      expectedSentinel: 'abc',
      transcript: 'NAX-BLOB-SENTINEL abc',
    }),
    {
      verdict: 'confirmed',
      confirmed: true,
      signals: ['sentinel'],
    },
  )
  assert.equal(
    classifySentinelEvidence({
      expectedSentinel: 'abc',
      fetchExitCode: 1,
    }).verdict,
    'failed',
  )
  assert.equal(
    classifySentinelEvidence({
      expectedSentinel: 'abc',
      commandOutput: '',
      transcript: 'netlify blobs:get store key\nError: blob not found',
    }).verdict,
    'failed',
  )
  assert.equal(
    classifySentinelEvidence({
      expectedSentinel: 'abc',
      resultText: 'loaded private fact',
      blobOnlyNeedles: ['private fact'],
    }).verdict,
    'probable',
  )
  assert.equal(
    classifySentinelEvidence({
      expectedSentinel: 'abc',
      resultText: 'not enough context',
    }).verdict,
    'suspect',
  )
  assert.equal(
    classifySentinelEvidence({
      expectedSentinel: 'abc',
      resultText: 'x'.repeat(1_200),
    }).verdict,
    'probable',
  )
})

test('engine serializes blob delivery metadata while submitting only the wrapper', async () => {
  const blobStore = new FakeBlobStore()
  let submittedPrompt = ''
  const runner: Runner = {
    runnerId: 'runner-1',
    siteId: 'site-1',
    state: 'running',
  }
  const transport: Transport = {
    createRunner: async (input) => {
      if (input.prompt === undefined) assert.fail('expected wire prompt')
      submittedPrompt = input.prompt
      return runner
    },
    createSession: async () => {
      throw new Error('unexpected createSession')
    },
    getRunner: async () => {
      throw new Error('unexpected getRunner')
    },
    listRunners: async () => {
      throw new Error('unexpected listRunners')
    },
    listAccountRunners: async () => {
      throw new Error('unexpected listAccountRunners')
    },
    getSession: async () => {
      throw new Error('unexpected getSession')
    },
    listSessions: async () => [{
      sessionId: 'session-1',
      runnerId: 'runner-1',
      state: 'running',
      prompt: submittedPrompt,
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
  const semanticPrompt = 'private '.repeat(500)
  const sdk = createAgentRunnerSdk({
    transport,
    blobStore,
    generateRequestId: () => REQUEST_ID,
    promptDelivery: {
      env: {},
      safeBytes: 1_024,
      hardMaxBytes: 10_000,
      tenant: 'site-1/artifact-1',
    },
  })

  const handle = await sdk.start({
    siteId: 'site-1',
    prompt: semanticPrompt,
  })

  assert.equal(handle.v, AGENT_RUNNER_SDK_HANDLE_VERSION)
  assert.equal(handle.input.prompt, undefined)
  assert.ok(handle.input.promptRef)
  assert.equal(handle.promptDelivery?.kind, 'blob')
  assert.deepEqual(
    handle.promptDelivery?.promptRef,
    handle.input.promptRef,
  )
  assert.equal(submittedPrompt.includes(semanticPrompt), false)
  assert.match(
    submittedPrompt,
    /<!-- agent-runner-sdk-request-id:44444444-/,
  )
  assert.deepEqual(
    sdk.parseHandle(sdk.serializeHandle(handle)),
    handle,
  )
})
