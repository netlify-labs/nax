const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { PassThrough, Readable, Writable } = require('stream')

const { createAcpAgentApp, serveAcp } = require('../../src/integrations/acp/server')
const { createNaxAgentRunnerSdk } = require('../../src/integrations/netlify/agent-runner-sdk')
const { appendPatch, clonedRepo, runnerApi } = require('../fixtures/acp/harness')

/**
 * @param {string} cwd
 * @param {ReturnType<typeof runnerApi>} remote
 */
function engineOptions(cwd, remote) {
  return {
    createSdk: () => createNaxAgentRunnerSdk({ transport: remote.transport, promptBlobDisable: true, retryDelayMs: 0 }),
    createApi: () => remote.api,
    resolveSite: () => ({ projectRoot: cwd, siteId: 'site-1' }),
    sleep: async () => {},
    pollIntervalMs: 0,
    newSessionId: () => 'nax-wire',
    version: '0.0.0-test',
    verifySiteRepo: async () => {},
  }
}

test('an ACP client runs a full turn against nax acp over the protocol', async () => {
  const acp = await import('@agentclientprotocol/sdk')
  const cwd = clonedRepo()
  const remote = runnerApi({
    scripts: {
      'session-1': [
        { state: 'running', currentTask: 'Editing readme.md' },
        { state: 'done', resultText: 'Added a world line.', hasResultDiff: true },
      ],
    },
    patches: { 'session-1': appendPatch('world') },
  })
  const updates = []
  const client = acp.client({ name: 'test-client' })
    .onNotification(acp.methods.client.session.update, async ({ params }) => { updates.push(params) })
  const agentApp = await createAcpAgentApp(engineOptions(cwd, remote))

  const outcome = await client.connectWith(agentApp, async (agent) => {
    const init = await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    const configured = await agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: 'model',
      value: 'codex:auto',
    })
    const prompted = await agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Add a world line' }],
    })
    return { init, session, configured, prompted }
  })

  assert.equal(outcome.init.agentInfo.name, 'nax')
  assert.equal(outcome.session.sessionId, 'nax-wire')
  assert.equal(outcome.configured.configOptions[0].currentValue, 'codex:auto')
  assert.equal(outcome.prompted.stopReason, 'end_turn')
  assert.equal(remote.calls.find((call) => call.op === 'createRunner').input.agent, 'codex')
  const kinds = updates.map((update) => update.update.sessionUpdate)
  assert.deepEqual(kinds, ['tool_call', 'tool_call_update', 'tool_call_update', 'agent_message_chunk', 'agent_message_chunk'])
  assert.equal(fs.readFileSync(path.join(cwd, 'readme.md'), 'utf8'), 'hello\nworld\n')
})

test('session/cancel during a prompt ends the turn as cancelled', async () => {
  const acp = await import('@agentclientprotocol/sdk')
  const cwd = clonedRepo()
  const remote = runnerApi({ scripts: { 'session-1': [{ state: 'running', currentTask: 'Thinking' }] } })
  let markRunning
  const running = new Promise((resolve) => { markRunning = resolve })
  const client = acp.client({ name: 'test-client' })
    .onNotification(acp.methods.client.session.update, async ({ params }) => {
      if (params.update.sessionUpdate === 'tool_call') markRunning()
    })
  const agentApp = await createAcpAgentApp({ ...engineOptions(cwd, remote), sleep: () => new Promise((resolve) => setTimeout(resolve, 5)) })

  const stopReason = await client.connectWith(agentApp, async (agent) => {
    await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    const prompted = agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Long task' }] })
    await running
    await agent.notify(acp.methods.agent.session.cancel, { sessionId })
    return (await prompted).stopReason
  })

  assert.equal(stopReason, 'cancelled')
  assert.ok(remote.calls.some((call) => call.op === 'cancelRunner' || call.op === 'cancelSession'))
})

test('serveAcp speaks newline-delimited JSON-RPC on the given streams', async () => {
  const cwd = clonedRepo()
  const input = new PassThrough()
  const output = new PassThrough()
  const served = serveAcp({ input, output, ...engineOptions(cwd, runnerApi({ scripts: {} })) })
  const firstLine = new Promise((resolve) => {
    let buffered = ''
    output.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline !== -1) resolve(JSON.parse(buffered.slice(0, newline)))
    })
  })
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`)
  const response = await firstLine
  assert.equal(response.id, 1)
  assert.equal(response.result.protocolVersion, 1)
  assert.equal(response.result.agentInfo.name, 'nax')
  input.end()
  await served
})

test('the nax acp process answers an ACP client on stdout with protocol frames only', async () => {
  const acp = await import('@agentclientprotocol/sdk')
  const cwd = clonedRepo()
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'cli', 'nax.js'), 'acp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const stream = acp.ndJsonStream(
    /** @type {WritableStream<Uint8Array>} */ (Writable.toWeb(child.stdin)),
    /** @type {ReadableStream<Uint8Array>} */ (Readable.toWeb(child.stdout)),
  )
  const outcome = await acp.client({ name: 'test-client' }).connectWith(stream, async (agent) => {
    const init = await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    return { init, session }
  })
  child.stdin.end()
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))

  assert.equal(outcome.init.agentInfo.name, 'nax')
  assert.match(outcome.session.sessionId, /^nax-[0-9a-f-]{36}$/)
  assert.equal(outcome.session.configOptions[0].id, 'model')
  assert.equal(fs.existsSync(path.join(cwd, '.nax')), false, 'a session is saved on its first prompt, not when a client opens it')
  assert.equal(exitCode, 0)
  assert.equal(stderr, '')
})

test('a failed request reaches the client with its own message', async () => {
  const acp = await import('@agentclientprotocol/sdk')
  const cwd = clonedRepo()
  const agentApp = await createAcpAgentApp({
    ...engineOptions(cwd, runnerApi({ scripts: {} })),
    resolveSite: () => { throw new Error('No Netlify site is linked here.') },
  })
  const message = await acp.client({ name: 'test-client' }).connectWith(agentApp, async (agent) => {
    await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    try {
      await agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'hi' }] })
      return 'no error'
    } catch (error) {
      return error.message
    }
  })
  assert.equal(message, 'No Netlify site is linked here.')
})
