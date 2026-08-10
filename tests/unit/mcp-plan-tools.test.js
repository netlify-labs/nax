const assert = require('node:assert/strict')
const test = require('node:test')

const { registerPlanTools } = require('../../src/mcp/tools')

/**
 * @typedef {{
 *   ok: boolean,
 *   data?: unknown,
 *   error?: { code?: string, details?: Record<string, unknown> },
 *   context?: { runtime: string },
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
    scope: { scopeId: 'scope_test', projectId: 'project_test', accountId: 'account_test', siteId: 'site_test' },
    actor: { actorId: 'actor_test', kind: 'local-session', authenticated: true },
    capabilities: {
      context_get: { available: true }, workflow_list: { available: true }, workflow_get: { available: true }, workflow_plan: { available: true },
      agent_run_plan: { available: true }, run_start: { available: true }, run_list: { available: true }, run_get: { available: true },
      run_wait: { available: true }, run_cancel: { available: true }, agent_run_retry: { available: true }, agent_run_followup: { available: true },
      review_gate_resolve: { available: true }, resource_read: { available: true },
    },
    agentCatalog: { provenance: { source: 'test', commit: 'abc123', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
    target: { accountId: 'account_test', accountSlug: 'team-test', siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] },
    currentBranch: 'main',
    branches: ['main'],
  }
}

/** @param {'workflow' | 'agent-run'} [kind] @returns {import('../../src/contracts').ControlPlanePlan} */
function planFixture(kind = 'workflow') {
  return {
    planId: kind === 'workflow' ? 'plan_workflow_01' : 'plan_agent_01',
    kind,
    status: 'prepared',
    scope: contextFixture().scope,
    target: { accountId: 'account_test', accountSlug: 'team-test', siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] },
    expiresAt: '2026-08-08T12:10:00.000Z',
    ...(kind === 'workflow' ? { workflowId: 'security-review' } : {}),
    steps: [{ stepId: 'analyze', title: 'Analyze', action: 'issue', submit: 'new-run', waitFor: 'agent-results', agents: ['claude'], instances: [{ instanceId: 'claude:opus:high', agent: 'claude', model: 'opus', effort: 'high' }], reviewGate: false }],
    instances: [{ agent: 'claude', model: 'opus', effort: 'high' }],
    expectedAgentRuns: kind === 'workflow' ? 3 : 1,
    warnings: [{ code: 'branch_ahead', message: 'The local branch is ahead of its remote ref.' }],
    summary: 'Prepared remote work.',
  }
}

/** @param {Partial<import('../../src/contracts').NaxControlPlaneClient>} [overrides] @returns {import('../../src/contracts').NaxControlPlaneClient} */
function clientFixture(overrides = {}) {
  return /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
    getContext: async () => contextFixture(),
    listWorkflows: async () => ({ workflows: [{ workflowId: 'security-review', title: 'Security review', description: '', source: 'project', sourceLabel: 'Project', stepCount: 1, agents: ['claude'] }], nextCursor: null }),
    createWorkflowPlan: async () => planFixture('workflow'),
    createAgentRunPlan: async () => planFixture('agent-run'),
    startPlan: async () => ({ run: { runId: 'run_01', title: 'Security review', status: 'running', branch: 'main', agentRuns: [] }, accepted: true, replayed: false }),
    ...overrides,
  })
}

/** @param {import('../../src/contracts').NaxControlPlaneClient} client */
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
  registerPlanTools({ server, client })
  return tools
}

test('plan/start registers entity-first tools with truthful annotations', () => {
  const tools = registeredTools(clientFixture())
  assert.deepEqual(Object.keys(tools), ['workflow_plan', 'agent_run_plan', 'run_start'])
  for (const name of ['workflow_plan', 'agent_run_plan']) {
    const annotations = /** @type {{ readOnlyHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} */ (tools[name].config.annotations)
    assert.deepEqual(annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true })
  }
  assert.deepEqual(tools.run_start.config.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true })
})

test('workflow_plan translates snake case and returns an approval-oriented immutable start action', async () => {
  /** @type {unknown[]} */
  const calls = []
  const client = clientFixture({ createWorkflowPlan: async (input) => { calls.push(input); return planFixture('workflow') } })
  const result = await registeredTools(client).workflow_plan.callback({
    workflow_id: 'security-review',
    branch: 'main',
    instances: [{ agent: 'claude', model: 'opus', effort: 'high' }],
    step_instances: { fix: [{ agent: 'codex', model: 'gpt', effort: 'medium' }] },
    context: 'Review authorization.',
    only_step: 'analyze',
  })

  assert.deepEqual(calls, [{
    workflowId: 'security-review',
    branch: 'main',
    instances: [{ agent: 'claude', model: 'opus', effort: 'high' }],
    stepInstances: { fix: [{ agent: 'codex', model: 'gpt', effort: 'medium' }] },
    context: 'Review authorization.',
    onlyStep: 'analyze',
  }])
  assert.match(result.content[0].text, /Target: Test Site \(site_test\), branch main/)
  assert.match(result.content[0].text, /Remote runners: 3/)
  assert.match(result.content[0].text, /expires 2026-08-08T12:10:00.000Z/)
  assert.match(result.content[0].text, /Warnings \(1\)/)
  assert.deepEqual(result.structuredContent.next_actions, [{
    kind: 'tool', tool: 'run_start', arguments: { plan_id: 'plan_workflow_01', request_id: 'request_plan_workflow_01', scope_id: 'scope_test' },
  }])
})

test('agent_run_plan preserves one structured instance without echoing the prompt in approval text', async () => {
  /** @type {unknown[]} */
  const calls = []
  const prompt = 'Audit the secret authorization boundary.'
  const client = clientFixture({ createAgentRunPlan: async (input) => { calls.push(input); return planFixture('agent-run') } })
  const result = await registeredTools(client).agent_run_plan.callback({ prompt, instance: { agent: 'claude', model: 'opus', label: 'deep' }, branch: 'main' })
  assert.deepEqual(calls, [{ prompt, instance: { agent: 'claude', model: 'opus', label: 'deep' }, branch: 'main' }])
  assert.doesNotMatch(result.content[0].text, /secret authorization boundary/)
  assert.match(result.content[0].text, /Single Agent Runner is planned but has not started/)
  assert.deepEqual(result.structuredContent.next_actions[0].arguments, { plan_id: 'plan_agent_01', request_id: 'request_plan_agent_01', scope_id: 'scope_test' })
})

test('run_start passes only immutable IDs and points active and replayed runs to observation', async () => {
  /** @type {unknown[]} */
  const calls = []
  const client = clientFixture({
    startPlan: async (planId, requestId) => {
      calls.push({ planId, requestId })
      return { run: { runId: 'run_01', status: 'running', branch: 'main', agentRuns: [] }, accepted: false, replayed: true }
    },
  })
  const result = await registeredTools(client).run_start.callback({ plan_id: 'plan_workflow_01', request_id: 'request_stable_01' })
  assert.deepEqual(calls, [{ planId: 'plan_workflow_01', requestId: 'request_stable_01' }])
  assert.match(result.content[0].text, /replayed the original idempotent start/)
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: 'run_01', since: '0', timeout_ms: 30000, scope_id: 'scope_test' } }])
})

test('workflow planning and expired starts return precise rediscovery and replan actions', async () => {
  const missingWorkflow = clientFixture({
    createWorkflowPlan: async () => { throw Object.assign(new Error('Unknown workflow.'), { code: 'workflow_not_found', statusCode: 404, details: { workflowId: 'security-reveiw' } }) },
  })
  const missing = await registeredTools(missingWorkflow).workflow_plan.callback({ workflow_id: 'security-reveiw' })
  assert.equal(missing.isError, true)
  assert.deepEqual(missing.structuredContent.error?.details?.suggestions, ['security-review'])
  assert.deepEqual(missing.structuredContent.next_actions, [{ kind: 'tool', tool: 'workflow_list', arguments: { limit: 50, scope_id: 'scope_test' } }])

  const expiredClient = clientFixture({
    startPlan: async () => {
      throw Object.assign(new Error('Plan expired.'), {
        code: 'run_plan_expired', statusCode: 409,
        details: { planId: 'plan_workflow_01', planKind: 'workflow', workflowId: 'security-review', expiresAt: '2026-08-08T12:10:00.000Z' },
      })
    },
  })
  const expired = await registeredTools(expiredClient).run_start.callback({ plan_id: 'plan_workflow_01', request_id: 'request_01' })
  assert.equal(expired.isError, true)
  assert.deepEqual(expired.structuredContent.next_actions, [{ kind: 'tool', tool: 'workflow_plan', arguments: { workflow_id: 'security-review', scope_id: 'scope_test' } }])
})

test('duplicate start errors target the existing durable run', async () => {
  const client = clientFixture({
    startPlan: async () => {
      throw Object.assign(new Error('Already active.'), { code: 'duplicate_run', statusCode: 409, details: { existingRunId: 'run_existing' } })
    },
  })
  const result = await registeredTools(client).run_start.callback({ plan_id: 'plan_workflow_01', request_id: 'request_01' })
  assert.deepEqual(result.structuredContent.next_actions, [
    { kind: 'tool', tool: 'run_get', arguments: { run_id: 'run_existing', view: 'summary', scope_id: 'scope_test' } },
    { kind: 'tool', tool: 'run_wait', arguments: { run_id: 'run_existing', timeout_ms: 30000, scope_id: 'scope_test' } },
  ])
})
