const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { startDashboardServer } = require('../../src/dashboard/server')
const {
  atomicWritePrivateJson,
  dashboardInstancePath,
  readDashboardInstance,
} = require('../../src/runtime/local/mcp-instance-registry')
const { configuredNaxClaudeServer, naxClaudeServer, readClaudeConfig, setupClaudeMcp } = require('../../src/mcp/setup')

const REPOSITORY_ROOT = path.resolve(__dirname, '../..')

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {string} projectRoot */
function writeProjectFlow(projectRoot) {
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', 'mcp-e2e')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: mcp-e2e',
    'title: MCP E2E',
    'description: Process-level MCP fixture',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: inspect',
    '    title: Inspect',
    '    prompt: prompts/inspect.md',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'inspect.md'), '---\ntitle: Inspect\n---\n\nInspect this fixture.\n')
}

/** @param {string} projectRoot */
function writeCompletedRun(projectRoot) {
  const runId = 'run_mcp_e2e_fixture'
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  const artifactsDir = path.join(dir, 'artifacts')
  const stepDir = path.join(artifactsDir, 'steps', '01-inspect')
  fs.mkdirSync(path.join(stepDir, 'agent-runners'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'mcp-e2e',
    flowTitle: 'MCP E2E',
    status: 'completed',
    transport: 'netlify-api',
    branch: 'main',
    target: { branch: 'main', sha: '0123456789abcdef0123456789abcdef01234567', sourceType: 'current-branch' },
    options: { branch: 'main', netlifySiteId: 'site_mcp_e2e', transport: 'netlify-api', stepAgents: { inspect: ['codex'] } },
    createdAt: '2026-08-08T12:00:00.000Z',
    updatedAt: '2026-08-08T12:01:00.000Z',
    dir,
    flow: { id: 'mcp-e2e', title: 'MCP E2E', steps: [{ id: 'inspect', title: 'Inspect', agents: ['codex'], submit: 'new-run' }] },
    steps: [{
      id: 'inspect',
      title: 'Inspect',
      status: 'completed',
      agents: ['codex'],
      runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-mcp-e2e', sessionId: 'session-mcp-e2e' }],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'workflow_completed', seq: 1, at: '2026-08-08T12:01:00.000Z', runId, status: 'completed' })}\n`)
  fs.writeFileSync(path.join(artifactsDir, 'summary.md'), '# MCP E2E summary\n\nVerified process-level result.\n')
  fs.writeFileSync(path.join(stepDir, 'step.json'), JSON.stringify({ id: 'inspect', title: 'Inspect', status: 'completed' }))
  fs.writeFileSync(path.join(stepDir, 'summary.md'), '# Inspect\n\nInspection complete.\n')
  fs.writeFileSync(path.join(stepDir, 'agent-runners', 'codex.json'), JSON.stringify({
    stepId: 'inspect', agent: 'codex', status: 'completed', runnerId: 'runner-mcp-e2e', sessionId: 'session-mcp-e2e',
  }))
  fs.writeFileSync(path.join(stepDir, 'agent-runners', 'codex.md'), '# Codex result\n\nVerified fixture result.\n')
  return runId
}

/**
 * Raw stdio client that exercises the same newline-framed JSON-RPC path used by
 * Claude Code while remaining independent from one specific client SDK.
 */
class StdioMcpClient {
  /** @param {string} projectRoot */
  constructor(projectRoot) {
    const env = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, FORCE_COLOR: '0', CLAUDE_PROJECT_DIR: projectRoot })
    delete env.NO_COLOR
    this.child = spawn(process.execPath, ['src/cli/nax.js', 'mcp'], {
      cwd: REPOSITORY_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.nextId = 1
    this.pendingText = ''
    this.stderr = ''
    this.stdoutLines = /** @type {string[]} */ ([])
    /** @type {Map<number, { resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString() })
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk.toString()))
    this.child.on('exit', (code) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error(`MCP child exited with code ${code}. stderr: ${this.stderr}`))
      }
      this.pending.clear()
    })
  }

  /** @param {string} text */
  onStdout(text) {
    this.pendingText += text
    const lines = this.pendingText.split('\n')
    this.pendingText = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      this.stdoutLines.push(line)
      let message
      try {
        message = /** @type {Record<string, unknown>} */ (JSON.parse(line))
      } catch (error) {
        for (const request of this.pending.values()) request.reject(new Error(`Invalid MCP stdout frame: ${String(error)}`))
        this.pending.clear()
        continue
      }
      const id = Number(message.id)
      const request = this.pending.get(id)
      if (!request) continue
      clearTimeout(request.timer)
      this.pending.delete(id)
      request.resolve(message)
    }
  }

  /** @param {string} method @param {Record<string, unknown>} params */
  request(method, params) {
    const id = this.nextId
    this.nextId += 1
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}. stderr: ${this.stderr}`))
      }, 10000)
      this.pending.set(id, {
        resolve: /** @type {(value: Record<string, unknown>) => void} */ (resolve),
        reject,
        timer,
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
    return /** @type {Promise<Record<string, unknown>>} */ (response)
  }

  /** @param {string} protocolVersion */
  async initialize(protocolVersion = '2025-11-25') {
    const response = await this.request('initialize', {
      protocolVersion,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'nax-process-e2e', version: '1.0.0' },
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return response
  }

  /** @param {string} name @param {Record<string, unknown>} args */
  async callToolEnvelope(name, args) {
    const response = await this.request('tools/call', { name, arguments: args })
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    return objectValue(response.result)
  }

  /** @param {string} name @param {Record<string, unknown>} args */
  async callTool(name, args) {
    const result = await this.callToolEnvelope(name, args)
    assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`)
    return objectValue(result.structuredContent)
  }

  async close() {
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM')
        reject(new Error(`Timed out closing MCP child. stderr: ${this.stderr}`))
      }, 5000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
  }
}

/** @param {string} url @param {string} token */
function health(url, token) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'x-nax-token': token } }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    }).once('error', reject)
  })
}

/** @param {number} port */
function occupyPort(port) {
  const server = http.createServer((_request, response) => response.end('occupied'))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/** @param {Record<string, unknown>} options */
function startFixtureDashboard(options) {
  return startDashboardServer(/** @type {Parameters<typeof startDashboardServer>[0]} */ ({
    ...options,
    advertiseMcp: true,
    netlifyAccess: {
      ok: true,
      code: 'ok',
      message: 'Accessible.',
      account: { email: 'mcp-e2e@example.test' },
      site: { id: 'site_mcp_e2e', name: 'mcp-e2e-site', accountSlug: 'mcp-e2e-team' },
    },
    netlifyContext: {
      account: { email: 'mcp-e2e@example.test' },
      linkedSites: [],
      target: {
        siteId: 'site_mcp_e2e', name: 'mcp-e2e-site', adminUrl: '', source: 'test', configSource: '',
        filter: '', accessible: true, accessCode: 'ok', reason: 'Process-level fixture.',
      },
      targetError: '',
    },
    resolveControlPlaneGitTarget: ({ options: planOptions }) => ({
      branch: String(planOptions.branch || 'main'),
      ref: `origin/${String(planOptions.branch || 'main')}`,
      sha: '0123456789abcdef0123456789abcdef01234567',
      sourceType: 'explicit-branch',
      verified: true,
      caveats: [],
    }),
  }))
}

test('real dashboard and stdio MCP compose, rediscover after restart, and shut down independently', { timeout: 30000 }, async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-process-e2e-'))
  writeProjectFlow(projectRoot)
  const fixtureRunId = writeCompletedRun(projectRoot)
  let starts = 0
  const dashboardOptions = {
    projectRoot,
    workflowExecutionBackend: {
      async startPlan(plan) {
        starts += 1
        return {
          run: { runId: 'run_mcp_started', workflowId: plan.workflowId, status: 'running', branch: plan.target.branch, source: 'mcp', agentRuns: [] },
          accepted: true,
          replayed: false,
        }
      },
      async reconcilePlan(plan) {
        return plan.runId
          ? { run: { runId: plan.runId, workflowId: plan.workflowId, status: 'running', branch: plan.target.branch, source: 'mcp', agentRuns: [] }, accepted: false, replayed: true }
          : null
      },
    },
  }
  let dashboard = await startFixtureDashboard(dashboardOptions)
  const firstPort = dashboard.port
  const firstInstanceId = dashboard.mcpInstanceId
  const client = new StdioMcpClient(projectRoot)
  let blocker = null
  try {
    const initialized = await client.initialize()
    assert.equal(objectValue(objectValue(initialized.result).serverInfo).name, 'nax-control-plane')

    const context = await client.callTool('context_get', {})
    const contextData = objectValue(context.data)
    assert.equal(objectValue(contextData.target).siteId, 'site_mcp_e2e')
    assert.equal(objectValue(objectValue(context.context).local).dashboardInstanceId, firstInstanceId)
    const scopeId = String(objectValue(objectValue(context.context).scope).scopeId)

    const workflows = await client.callTool('workflow_list', { source: 'project', limit: 20 })
    assert.equal(/** @type {unknown[]} */ (objectValue(workflows.data).workflows).some((workflow) => objectValue(workflow).workflowId === 'mcp-e2e'), true)
    const workflow = await client.callTool('workflow_get', { workflow_id: 'mcp-e2e', include_graph: true })
    assert.equal(objectValue(objectValue(workflow.data).workflow).workflowId, 'mcp-e2e')

    const runs = await client.callTool('run_list', { limit: 20 })
    assert.equal(/** @type {unknown[]} */ (objectValue(runs.data).runs).some((run) => objectValue(run).runId === fixtureRunId), true)
    const run = await client.callTool('run_get', { run_id: fixtureRunId, view: 'details' })
    const details = objectValue(objectValue(run.data).details)
    const artifact = /** @type {Record<string, unknown>} */ (/** @type {unknown[]} */ (details.artifacts)[0])
    assert.match(String(artifact.resourceUri), /^nax:\/\/scopes\//)
    const waited = await client.callTool('run_wait', { run_id: fixtureRunId, since: '0', timeout_ms: 100 })
    assert.equal(objectValue(objectValue(waited.data).run).status, 'completed')

    const templates = await client.request('resources/templates/list', {})
    assert.equal(/** @type {unknown[]} */ (objectValue(templates.result).resourceTemplates).length, 6)
    const artifactResource = await client.request('resources/read', { uri: artifact.resourceUri })
    assert.match(JSON.stringify(artifactResource.result), /Verified process-level result/)
    const prompts = await client.request('prompts/list', {})
    assert.equal(/** @type {unknown[]} */ (objectValue(prompts.result).prompts).length, 2)
    const prompt = await client.request('prompts/get', { name: 'run_remote_workflow', arguments: { workflow_id: 'mcp-e2e' } })
    assert.match(JSON.stringify(prompt.result), /workflow_plan/)

    const planned = await client.callTool('workflow_plan', { workflow_id: 'mcp-e2e', branch: 'main', instances: [{ agent: 'codex' }] })
    assert.equal(starts, 0)
    const startAction = /** @type {Record<string, unknown>} */ (/** @type {unknown[]} */ (planned.next_actions)[0])
    const startArguments = objectValue(startAction.arguments)
    const started = await client.callTool('run_start', startArguments)
    const replay = await client.callTool('run_start', startArguments)
    assert.equal(objectValue(started.data).replayed, false)
    assert.equal(objectValue(replay.data).replayed, true)
    assert.equal(starts, 1)

    await dashboard.close()
    blocker = await occupyPort(firstPort)
    dashboard = await startFixtureDashboard(dashboardOptions)
    assert.notEqual(dashboard.port, firstPort)
    assert.notEqual(dashboard.mcpInstanceId, firstInstanceId)
    const rediscovered = await client.callTool('context_get', {})
    assert.equal(objectValue(objectValue(rediscovered.context).local).dashboardInstanceId, dashboard.mcpInstanceId)
    assert.equal(objectValue(objectValue(rediscovered.context).scope).scopeId, scopeId)

    const legacyClient = new StdioMcpClient(projectRoot)
    try {
      const legacy = await legacyClient.initialize('2024-11-05')
      assert.equal(objectValue(objectValue(legacy.result).serverInfo).name, 'nax-control-plane')
      const legacyContext = await legacyClient.callTool('context_get', {})
      assert.equal(objectValue(objectValue(legacyContext.context).local).dashboardInstanceId, dashboard.mcpInstanceId)
    } finally {
      await legacyClient.close()
    }

    setupClaudeMcp({ projectRoot, scope: 'project', probe: () => ({ ok: true, executable: '/tools/claude', message: 'supported' }) })
    const claudeConfig = /** @type {Record<string, unknown>} */ (readClaudeConfig(path.join(projectRoot, '.mcp.json')))
    assert.deepEqual(configuredNaxClaudeServer(claudeConfig, 'project', projectRoot), naxClaudeServer())

    await client.close()
    assert.equal(await health(`http://127.0.0.1:${dashboard.port}/api/health`, dashboard.token), 200)
    assert.notEqual(readDashboardInstance(projectRoot), null)
    assert.equal(client.pendingText, '')
    for (const line of client.stdoutLines) assert.doesNotThrow(() => JSON.parse(line))
    assert.doesNotMatch(client.stderr, /private-token|Bearer|secret/i)
  } finally {
    if (client.child.exitCode === null) await client.close().catch(() => {})
    if (blocker) await new Promise((resolve) => blocker.close(() => resolve(undefined)))
    await dashboard.close().catch(() => {})
  }
  assert.equal(readDashboardInstance(projectRoot), null)
})

test('stdio MCP reports registry, scope, auth, version, stale, and missing-dashboard failures without secrets', { timeout: 30000 }, async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-process-errors-'))
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-wrong-project-'))
  const dashboard = await startFixtureDashboard({ projectRoot })
  const record = /** @type {import('../../src/runtime/local/mcp-instance-registry').DashboardInstanceRecord} */ (readDashboardInstance(projectRoot))
  const registryPath = dashboardInstancePath(projectRoot)
  const client = new StdioMcpClient(projectRoot)

  /** @param {string} expectedCode */
  async function expectContextError(expectedCode) {
    const result = await client.callToolEnvelope('context_get', {})
    assert.equal(result.isError, true)
    const structured = objectValue(result.structuredContent)
    assert.equal(objectValue(structured.error).code, expectedCode, JSON.stringify(structured))
    const serialized = JSON.stringify(result)
    assert.doesNotMatch(serialized, new RegExp(record.token))
    assert.doesNotMatch(serialized, /Bearer\s+[A-Za-z0-9._-]+/)
    return structured
  }

  try {
    await client.initialize()

    if (process.platform !== 'win32') {
      fs.chmodSync(registryPath, 0o644)
      await expectContextError('dashboard_registry_permissions')
      fs.chmodSync(registryPath, 0o600)
    }

    atomicWritePrivateJson(registryPath, { ...record, token: 'wrong-private-token-value-that-is-long-enough' })
    await expectContextError('dashboard_auth_failed')

    atomicWritePrivateJson(registryPath, { ...record, version: '0.0.0-mismatch' })
    await expectContextError('dashboard_version_mismatch')

    atomicWritePrivateJson(registryPath, { ...record, projectRoot: otherRoot })
    await expectContextError('project_scope_mismatch')

    atomicWritePrivateJson(registryPath, { ...record, pid: 2147483647 })
    const stale = await expectContextError('dashboard_not_running')
    assert.match(JSON.stringify(stale), /nax dashboard --no-open/)
    assert.equal(fs.existsSync(registryPath), false)

    const missing = await expectContextError('dashboard_not_running')
    assert.match(JSON.stringify(missing), /nax dashboard --no-open/)
    assert.doesNotMatch(client.stderr, new RegExp(record.token))
  } finally {
    await client.close().catch(() => {})
    await dashboard.close().catch(() => {})
  }
})

test('one MCP routes concurrent project dashboards by project_ref and scope without cross-project bleed', { timeout: 30000 }, async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-project-a-'))
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-project-b-'))
  const [firstDashboard, secondDashboard] = await Promise.all([
    startFixtureDashboard({ projectRoot: firstRoot }),
    startFixtureDashboard({ projectRoot: secondRoot }),
  ])
  const firstClient = new StdioMcpClient(firstRoot)
  const secondClient = new StdioMcpClient(secondRoot)
  try {
    await Promise.all([firstClient.initialize(), secondClient.initialize()])
    const [firstContext, secondContext] = await Promise.all([
      firstClient.callTool('context_get', {}),
      secondClient.callTool('context_get', {}),
    ])
    assert.notEqual(
      objectValue(objectValue(firstContext.context).scope).projectId,
      objectValue(objectValue(secondContext.context).scope).projectId,
    )
    assert.equal(objectValue(objectValue(firstContext.context).local).dashboardInstanceId, firstDashboard.mcpInstanceId)
    assert.equal(objectValue(objectValue(secondContext.context).local).dashboardInstanceId, secondDashboard.mcpInstanceId)

    const routedContext = await firstClient.callTool('context_get', { project_ref: secondRoot })
    const routedScopeId = String(objectValue(objectValue(routedContext.context).scope).scopeId)
    assert.equal(objectValue(objectValue(routedContext.context).local).dashboardInstanceId, secondDashboard.mcpInstanceId)
    assert.equal(objectValue(objectValue(routedContext.context).scope).projectId, objectValue(objectValue(secondContext.context).scope).projectId)
    const routedRuns = await firstClient.callTool('run_list', { scope_id: routedScopeId, limit: 5 })
    assert.equal(objectValue(objectValue(routedRuns.context).scope).scopeId, routedScopeId)
    const defaultAgain = await firstClient.callTool('context_get', {})
    assert.equal(objectValue(objectValue(defaultAgain.context).local).dashboardInstanceId, firstDashboard.mcpInstanceId)

    await assert.rejects(
      startFixtureDashboard({ projectRoot: firstRoot }),
      /** @param {unknown} error */ (error) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'dashboard_already_advertised'),
    )
  } finally {
    await Promise.all([firstClient.close().catch(() => {}), secondClient.close().catch(() => {})])
    await Promise.all([firstDashboard.close(), secondDashboard.close()])
  }
})
