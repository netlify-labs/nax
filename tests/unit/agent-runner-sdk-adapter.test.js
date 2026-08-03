const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createNaxAgentRunnerSdk,
  promptDeliveryArtifact,
} = require('../../src/integrations/netlify/agent-runner-sdk')

/** @returns {{ transport: import('nax-agent-runner-sdk').Transport, submitted: () => string }} */
function transportHarness() {
  let submittedPrompt = ''
  const unexpected = (operation) => {
    throw new Error(`unexpected transport operation: ${operation}`)
  }
  const transport = /** @type {import('nax-agent-runner-sdk').Transport} */ ({
    createRunner: async (input) => {
      if (typeof input.prompt !== 'string') {
        throw new Error('expected delivered prompt text')
      }
      submittedPrompt = input.prompt
      return {
        runnerId: 'runner-1',
        state: 'running',
        siteId: 'site-1',
      }
    },
    createSession: async () => unexpected('createSession'),
    getRunner: async () => unexpected('getRunner'),
    listRunners: async () => unexpected('listRunners'),
    listAccountRunners: async () => unexpected('listAccountRunners'),
    getSession: async () => unexpected('getSession'),
    listSessions: async () => [{
      sessionId: 'session-1',
      runnerId: 'runner-1',
      state: 'running',
      prompt: submittedPrompt,
      usage: null,
    }],
    cancelRunner: async () => unexpected('cancelRunner'),
    cancelSession: async () => unexpected('cancelSession'),
    member: async () => unexpected('member'),
  })
  return {
    transport,
    submitted: () => submittedPrompt,
  }
}

test('nax SDK adapter owns blob delivery and exposes only safe artifact metadata', async () => {
  const writes = []
  const ref = {
    store: 'nax-agent-runner-prompts',
    key: 'tenants/hash/prompt-uuid',
    tenant: 'site-1/workflow-1',
    expiresAt: Date.now() + 60_000,
  }
  const blobStore = /** @type {import('nax-agent-runner-sdk').BlobStore} */ ({
    async put(_key, bytes, options) {
      writes.push({
        text: Buffer.from(bytes).toString('utf8'),
        tenant: options.tenant,
      })
      return ref
    },
    async delete() {},
    runnerFetchInstruction() {
      return {
        shell: "netlify blobs:get 'nax-agent-runner-prompts' 'tenants/hash/prompt-uuid'",
        sentinel: 'sentinel-safe',
      }
    },
  })
  const harness = transportHarness()
  const semanticPrompt = `private semantic prompt ${'A'.repeat(3_000)}`
  const sdk = createNaxAgentRunnerSdk({
    transport: harness.transport,
    blobStore,
    env: {},
    siteId: 'site-1',
    promptTenant: 'site-1/workflow-1',
    safePromptBytes: 1_024,
  })

  const handle = await sdk.start({
    siteId: 'site-1',
    prompt: semanticPrompt,
  })
  const artifact = promptDeliveryArtifact(handle)

  assert.deepEqual(writes, [{
    text: semanticPrompt,
    tenant: 'site-1/workflow-1',
  }])
  assert.equal(handle.promptDelivery?.kind, 'blob')
  assert.deepEqual(handle.input.promptRef, ref)
  assert.equal(harness.submitted().includes(semanticPrompt), false)
  assert.match(harness.submitted(), /netlify blobs:get/)
  assert.deepEqual(artifact?.blobRef, {
    ...ref,
    sentinel: 'sentinel-safe',
    owner: 'nax-agent-runner-sdk',
    status: 'active',
  })
  assert.equal(artifact?.promptBytes, Buffer.byteLength(semanticPrompt, 'utf8'))
  assert.equal(JSON.stringify(artifact).includes('blobs:get'), false)
})

test('nax SDK adapter omits unknown prompt bytes when reusing a blob ref', () => {
  const artifact = promptDeliveryArtifact({
    promptDelivery: {
      kind: 'blob',
      safeBytes: 1_024,
      submittedBytes: 300,
      promptRef: {
        store: 'nax-agent-runner-prompts',
        key: 'tenants/hash/prompt-uuid',
        tenant: 'site-1/workflow-1',
        expiresAt: Date.now() + 60_000,
      },
    },
  })

  assert.equal(Object.hasOwn(artifact || {}, 'promptBytes'), false)
})

test('nax SDK adapter gives deterministic compaction precedence over blob upload', async () => {
  let writes = 0
  const blobStore = /** @type {import('nax-agent-runner-sdk').BlobStore} */ ({
    async put() {
      writes += 1
      throw new Error('compact delivery should not write a blob')
    },
    async delete() {},
    runnerFetchInstruction() {
      throw new Error('compact delivery should not build a fetch instruction')
    },
  })
  const harness = transportHarness()
  const semanticPrompt = `semantic ${'A'.repeat(3_000)} semantic-tail`
  const sdk = createNaxAgentRunnerSdk({
    transport: harness.transport,
    blobStore,
    env: {},
    siteId: 'site-1',
    compactPromptText: 'bounded semantic summary',
    safePromptBytes: 1_024,
  })

  const handle = await sdk.start({
    siteId: 'site-1',
    prompt: semanticPrompt,
  })

  assert.equal(writes, 0)
  assert.equal(handle.promptDelivery?.kind, 'compact')
  assert.equal(handle.input.prompt, semanticPrompt)
  assert.match(harness.submitted(), /bounded semantic summary/)
  assert.equal(harness.submitted().includes('semantic-tail'), false)
})
