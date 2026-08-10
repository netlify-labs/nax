const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { registerDiscoveryTools } = require('../../src/mcp/tools')

/**
 * @typedef {{
 *   ok: boolean,
 *   data?: unknown,
 *   error?: { code?: string, details?: Record<string, unknown> },
 *   next_actions: Array<{ kind: string, tool?: string, arguments?: Record<string, unknown> }>,
 * }} TestEnvelope
 * @typedef {{
 *   isError?: boolean,
 *   content: Array<{ type: string, text: string }>,
 *   structuredContent: TestEnvelope,
 * }} TestToolResult
 */

/** @returns {import('../../src/contracts').ControlPlaneContext} */
function contextFixture() {
  return {
    runtime: 'local-dashboard',
    scope: { scopeId: 'scope_test', projectId: 'project_test', siteId: 'site_test' },
    actor: { actorId: 'actor_test', kind: 'local-session', displayName: 'Local MCP session', authenticated: true },
    capabilities: {
      context_get: { available: true },
      workflow_list: { available: true },
      workflow_get: { available: true },
      workflow_plan: { available: true },
      agent_run_plan: { available: true },
      run_start: { available: true },
      run_list: { available: true },
      run_get: { available: true },
      run_wait: { available: true },
      run_cancel: { available: true },
      agent_run_retry: { available: true },
      agent_run_followup: { available: true },
      review_gate_resolve: { available: true },
      resource_read: { available: false, reason: 'Not installed' },
    },
    agentCatalog: {
      provenance: { source: 'test', commit: 'abc123', syncedAt: '2026-08-08T00:00:00.000Z' },
      providers: [{ id: 'claude', label: 'Claude', defaultModel: 'claude-opus-5', models: [] }],
    },
    target: { siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] },
    currentBranch: 'main',
    branches: ['main'],
    local: { projectRoot: '/repo', dashboardInstanceId: 'instance_test' },
  }
}

/** @param {string} id */
function workflowSummary(id) {
  return { workflowId: id, title: id.replaceAll('-', ' '), description: 'Test workflow', source: 'project', sourceLabel: 'Project', stepCount: 2, agents: ['claude'] }
}

/** @param {string} id @param {boolean} [graph] */
function workflowRead(id, graph = false) {
  return {
    workflow: {
      ...workflowSummary(id),
      defaults: {},
      options: {},
      steps: [{ stepId: 'analyze', title: 'Analyze', action: 'run', submit: 'new-run', waitFor: 'agent-results', agents: ['claude'], instances: [{ instanceId: 'claude-opus', agent: 'claude', model: 'claude-opus-5' }], reviewGate: false }],
    },
    ...(graph ? { graph: { nodes: [{ id: 'analyze', kind: 'workflow-step', data: {} }], edges: [], metadata: {} } } : {}),
  }
}

/**
 * @param {Partial<import('../../src/contracts').NaxControlPlaneClient>} overrides
 * @returns {import('../../src/contracts').NaxControlPlaneClient}
 */
function clientFixture(overrides = {}) {
  return /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
    getContext: async () => contextFixture(),
    listWorkflows: async () => ({ workflows: [workflowSummary('security-review')], nextCursor: null }),
    getWorkflow: async (id, options) => workflowRead(id, options?.includeGraph),
    ...overrides,
  })
}

/**
 * @param {import('../../src/contracts').NaxControlPlaneClient} client
 */
function registeredTools(client) {
  /** @type {Record<string, { config: Record<string, unknown>, callback: (args: Record<string, unknown>) => Promise<TestToolResult> }>} */
  const tools = {}
  const server = /** @type {import('@modelcontextprotocol/server').McpServer} */ ({
    registerTool(name, config, callback) {
      tools[name] = {
        config: /** @type {Record<string, unknown>} */ (config),
        callback: /** @type {(args: Record<string, unknown>) => Promise<TestToolResult>} */ (callback),
      }
    },
  })
  registerDiscoveryTools({ server, client })
  return tools
}

test('discovery surface registers only entity-first context and workflow tools in this phase', () => {
  const tools = registeredTools(clientFixture())
  assert.deepEqual(Object.keys(tools), ['context_get', 'workflow_list', 'workflow_get'])
  assert.equal(/** @type {{ readOnlyHint?: boolean }} */ (tools.context_get.config.annotations).readOnlyHint, true)
  assert.equal(/** @type {{ idempotentHint?: boolean }} */ (tools.workflow_get.config.annotations).idempotentHint, true)
})

test('context_get identifies cost-bearing target, safe actor, capabilities, and discovery actions', async () => {
  const result = await registeredTools(clientFixture()).context_get.callback({})
  assert.equal(result.structuredContent.ok, true)
  assert.match(/** @type {{ content: Array<{ text: string }> }} */ (result).content[0].text, /Test Site \(site_test\).*branch main/)
  const data = /** @type {{ actor: Record<string, unknown>, target: { siteId: string } }} */ (result.structuredContent.data)
  assert.equal(data.target.siteId, 'site_test')
  assert.deepEqual(Object.keys(data.actor).sort(), ['actorId', 'authenticated', 'displayName', 'kind'])
  assert.deepEqual(result.structuredContent.next_actions.map((action) => action.tool), ['workflow_list', 'run_list'])
})

test('workflow_list translates bounded filters and returns exact IDs plus pagination actions', async () => {
  /** @type {unknown[]} */
  const calls = []
  const client = clientFixture({
    listWorkflows: async (query) => {
      calls.push(query)
      return { workflows: [workflowSummary('security-review'), workflowSummary('performance-review')], nextCursor: 'cursor_next' }
    },
  })
  const result = await registeredTools(client).workflow_list.callback({ source: 'project', limit: 2, cursor: 'cursor_old' })
  assert.deepEqual(calls, [{ source: 'project', limit: 2, cursor: 'cursor_old' }])
  const data = /** @type {{ workflows: Array<{ workflowId: string }> }} */ (result.structuredContent.data)
  assert.deepEqual(data.workflows.map((workflow) => workflow.workflowId), ['security-review', 'performance-review'])
  assert.deepEqual(result.structuredContent.next_actions, [
    { kind: 'tool', tool: 'workflow_get', arguments: { workflow_id: 'security-review', scope_id: 'scope_test' } },
    { kind: 'tool', tool: 'workflow_list', arguments: { source: 'project', limit: 2, cursor: 'cursor_next', scope_id: 'scope_test' } },
  ])
})

test('workflow_get opts into graph and suggests planning only when capability exists', async () => {
  const client = clientFixture()
  const result = await registeredTools(client).workflow_get.callback({ workflow_id: 'security-review', include_graph: true })
  const data = /** @type {{ graph: { nodes: Array<{ id: string }> } }} */ (result.structuredContent.data)
  assert.equal(data.graph.nodes[0].id, 'analyze')
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'workflow_plan', arguments: { workflow_id: 'security-review', scope_id: 'scope_test' } }])

  const unavailableContext = contextFixture()
  unavailableContext.capabilities.workflow_plan = { available: false, reason: 'Not installed' }
  const unavailable = await registeredTools(clientFixture({ getContext: async () => unavailableContext })).workflow_get.callback({ workflow_id: 'security-review', include_graph: false })
  assert.deepEqual(unavailable.structuredContent.next_actions, [{ kind: 'tool', tool: 'workflow_get', arguments: { workflow_id: 'security-review', include_graph: true, scope_id: 'scope_test' } }])
})

test('unknown workflow errors add conservative suggestions from the live catalog', async () => {
  const client = clientFixture({
    getWorkflow: async () => {
      throw Object.assign(new Error('Unknown workflow "security-reveiw".'), {
        code: 'workflow_not_found',
        statusCode: 404,
        details: { workflowId: 'security-reveiw' },
      })
    },
    listWorkflows: async () => ({ workflows: [workflowSummary('security-review'), workflowSummary('performance-review')], nextCursor: null }),
  })
  const result = await registeredTools(client).workflow_get.callback({ workflow_id: 'security-reveiw', include_graph: false })
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent.error?.details?.suggestions, ['security-review'])
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'workflow_list', arguments: { limit: 50, scope_id: 'scope_test' } }])
})

test('large workflow catalogs remain within the shared structured result budget', async () => {
  const workflows = Array.from({ length: 100 }, (_value, index) => ({
    ...workflowSummary(`workflow-${String(index).padStart(3, '0')}`),
    description: 'x'.repeat(1000),
  }))
  const client = clientFixture({ listWorkflows: async () => ({ workflows, nextCursor: null }) })
  const result = await registeredTools(client).workflow_list.callback({ limit: 100 })
  assert.equal(Buffer.byteLength(JSON.stringify(result.structuredContent)) < 256 * 1024, true)
  assert.equal(/** @type {{ workflows: unknown[] }} */ (result.structuredContent.data).workflows.length, 100)
})

test('MCP tool handlers stay isolated from dashboard, filesystem, and runtime adapters', () => {
  for (const file of ['context.js', 'runs.js', 'workflows.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'mcp', 'tools', file), 'utf8')
    assert.doesNotMatch(source, /dashboard|node:fs|runtime\/local|adapters\/local/)
  }
})
