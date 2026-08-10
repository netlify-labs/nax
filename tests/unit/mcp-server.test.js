const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const packageJson = require('../../package.json')
const { createMcpControlPlaneClient } = require('../../src/mcp/client')
const {
  SERVER_NAME,
  buildServer,
  pathFromMcpRoot,
  resolveMcpProjectRoot,
  serveMcpStdio,
} = require('../../src/mcp/server')

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-server-'))
}

/**
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child
 * @param {number} id
 * @param {{ messages: Array<Record<string, unknown>> }} state
 */
async function waitForResponse(child, id, state) {
  const existing = state.messages.find((message) => message.id === id)
  if (existing) return existing
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for MCP response ${id}.`))
    }, 5000)
    const onMessage = () => {
      const message = state.messages.find((candidate) => candidate.id === id)
      if (!message) return
      cleanup()
      resolve(message)
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`MCP child exited before response ${id} with code ${code}.`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.removeListener('mcp-message', onMessage)
      child.removeListener('exit', onExit)
    }
    child.on('mcp-message', onMessage)
    child.once('exit', onExit)
  })
}

/**
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child
 */
async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Timed out waiting for MCP child shutdown.'))
    }, 5000)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

test('MCP project root resolution has stable explicit, Claude, roots, and cwd precedence', () => {
  const canonicalize = (value) => `canonical:${value}`
  const options = {
    env: { CLAUDE_PROJECT_DIR: '/claude' },
    clientRoots: [{ uri: 'file:///client%20root' }],
    cwd: '/cwd',
    canonicalize,
  }

  assert.equal(resolveMcpProjectRoot({ ...options, projectRoot: '/explicit' }), 'canonical:/explicit')
  assert.equal(resolveMcpProjectRoot(options), 'canonical:/claude')
  assert.equal(resolveMcpProjectRoot({ ...options, env: {} }), 'canonical:/client root')
  assert.equal(resolveMcpProjectRoot({ ...options, env: {}, clientRoots: [] }), 'canonical:/cwd')
  assert.equal(pathFromMcpRoot({ uri: 'https://example.test/project' }), null)
  assert.equal(pathFromMcpRoot('relative/project'), null)
})

test('MCP server scaffold loads through CommonJS and ESM with the Node 20 SDK floor', async () => {
  const imported = await import(pathToFileURL(require.resolve('../../src/mcp/server')).href)
  const server = buildServer({ projectRoot: tempRoot() })
  const sdkPackagePath = path.resolve(path.dirname(require.resolve('@modelcontextprotocol/server')), '..', 'package.json')
  const sdkPackage = JSON.parse(fs.readFileSync(sdkPackagePath, 'utf8'))

  assert.equal(typeof imported.default.buildServer, 'function')
  assert.equal(SERVER_NAME, 'nax-control-plane')
  assert.equal(typeof server.connect, 'function')
  assert.equal(packageJson.engines.node, '>=20')
  assert.equal(sdkPackage.engines.node, '>=20')
})

test('MCP control-plane client binds scope and actor without exposing a runtime adapter', async () => {
  /** @type {Array<{ operation: string | symbol, args: unknown[] }>} */
  const calls = []
  const controlPlane = /** @type {import('../../src/contracts').NaxControlPlane} */ (new Proxy({}, {
    get(_target, operation) {
      return (...args) => {
        calls.push({ operation, args })
        return Promise.resolve({ ok: true })
      }
    },
  }))
  const scope = { scopeId: 'scope_test', projectId: 'project_test' }
  const actor = { actorId: 'actor_test', kind: /** @type {const} */ ('local-session'), authenticated: true }
  const client = createMcpControlPlaneClient({ controlPlane, scope, actor })
  scope.scopeId = 'scope_mutated_after_binding'
  actor.actorId = 'actor_mutated_after_binding'

  await client.listRuns({ limit: 5 })
  await client.getArtifact('run_test', 'artifact_test')

  assert.equal(Object.isFrozen(client), true)
  assert.deepEqual(calls, [
    {
      operation: 'listRuns',
      args: [
        { scopeId: 'scope_test', projectId: 'project_test' },
        { actorId: 'actor_test', kind: 'local-session', authenticated: true },
        { limit: 5 },
      ],
    },
    {
      operation: 'getArtifact',
      args: [
        { scopeId: 'scope_test', projectId: 'project_test' },
        { actorId: 'actor_test', kind: 'local-session', authenticated: true },
        'run_test',
        'artifact_test',
      ],
    },
  ])
})

test('MCP runtime sends diagnostics to stderr and owns only its stdio handle', async () => {
  const projectRoot = tempRoot()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let stdoutText = ''
  let stderrText = ''
  let adapterCloses = 0
  let dashboardCloses = 0
  stdout.on('data', (chunk) => { stdoutText += chunk.toString() })
  stderr.on('data', (chunk) => { stderrText += chunk.toString() })

  const runtime = serveMcpStdio({
    projectRoot,
    stdin,
    stdout,
    stderr,
    installSignalHandlers: false,
    serveStdioImpl: (factory, options) => {
      factory({ era: 'legacy' })
      options?.onerror?.(new Error('diagnostic test'))
      return {
        close: async () => { adapterCloses += 1 },
      }
    },
  })
  await runtime.close()
  await runtime.close()

  assert.equal(adapterCloses, 1)
  assert.equal(dashboardCloses, 0)
  assert.equal(stdoutText, '')
  assert.match(stderrText, /^\[nax mcp\] diagnostic test\n$/)

  dashboardCloses += 1
  assert.equal(dashboardCloses, 1)
})

test('nax mcp negotiates stdio and lists tools without contaminating stdout', async () => {
  const projectRoot = tempRoot()
  const child = spawn(process.execPath, ['src/cli/nax.js', 'mcp', '--project-root', projectRoot], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  /** @type {{ messages: Array<Record<string, unknown>> }} */
  const state = { messages: [] }
  let stdoutText = ''
  let stderrText = ''
  let pending = ''
  child.stderr.on('data', (chunk) => { stderrText += chunk.toString() })
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdoutText += text
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      state.messages.push(/** @type {Record<string, unknown>} */ (JSON.parse(line)))
      child.emit('mcp-message')
    }
  })

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'nax-test-client', version: '1.0.0' },
    },
  })}\n`)
  const initialized = await waitForResponse(child, 1, state)
  assert.equal(/** @type {{ result?: { serverInfo?: { name?: string } } }} */ (initialized).result?.serverInfo?.name, SERVER_NAME)

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  const listed = await waitForResponse(child, 2, state)
  const tools = /** @type {{ result?: { tools?: Array<{ name?: string, inputSchema?: unknown, outputSchema?: unknown }> } }} */ (listed).result?.tools || []
  assert.deepEqual(tools.map((tool) => tool.name), [
    'context_get',
    'workflow_list',
    'workflow_get',
    'workflow_plan',
    'agent_run_plan',
    'run_start',
    'run_list',
    'run_get',
    'run_wait',
    'run_cancel',
    'agent_run_retry',
    'agent_run_followup',
    'review_gate_resolve',
  ])
  assert.equal(tools.every((tool) => Boolean(tool.inputSchema) && Boolean(tool.outputSchema)), true)

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/templates/list', params: {} })}\n`)
  const templateList = await waitForResponse(child, 3, state)
  const resourceTemplates = /** @type {{ result?: { resourceTemplates?: Array<{ name?: string, uriTemplate?: string }> } }} */ (templateList).result?.resourceTemplates || []
  assert.deepEqual(resourceTemplates.map((template) => template.name), [
    'nax-context',
    'nax-workflow',
    'nax-run',
    'nax-run-details',
    'nax-run-events',
    'nax-run-artifact',
  ])
  assert.equal(resourceTemplates[4].uriTemplate, 'nax://scopes/{scope_id}/runs/{run_id}/events{?since}')

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'prompts/list', params: {} })}\n`)
  const promptList = await waitForResponse(child, 4, state)
  const prompts = /** @type {{ result?: { prompts?: Array<{ name?: string }> } }} */ (promptList).result?.prompts || []
  assert.deepEqual(prompts.map((prompt) => prompt.name), ['run_remote_workflow', 'follow_up_on_run'])

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'context_get', arguments: {} } })}\n`)
  const called = await waitForResponse(child, 5, state)
  const toolResult = /** @type {{ result?: { isError?: boolean, structuredContent?: { ok?: boolean, error?: { code?: string }, next_actions?: Array<{ kind?: string, command?: string }> } } }} */ (called).result
  assert.equal(toolResult?.isError, true)
  assert.equal(toolResult?.structuredContent?.ok, false)
  assert.equal(toolResult?.structuredContent?.error?.code, 'dashboard_not_running')
  assert.equal(toolResult?.structuredContent?.next_actions?.[0]?.kind, 'command')
  assert.match(toolResult?.structuredContent?.next_actions?.[0]?.command || '', /^nax dashboard --project-root '.+' --no-open$/)

  child.stdin.end()
  assert.equal(await waitForExit(child), 0)
  assert.equal(pending, '')
  assert.equal(stderrText, '')
  for (const line of stdoutText.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line))
})
