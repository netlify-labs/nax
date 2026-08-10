const assert = require('node:assert/strict')
const test = require('node:test')

const { registerControlTools } = require('../../src/mcp/tools')

/**
 * @typedef {{
 *   ok: boolean,
 *   data?: unknown,
 *   error?: { code?: string, details?: Record<string, unknown> },
 *   next_actions: Array<{ kind: string, tool?: string, arguments?: Record<string, unknown> }>,
 * }} TestEnvelope
 * @typedef {{ isError?: boolean, content: Array<{ type: string, text: string }>, structuredContent: TestEnvelope }} TestToolResult
 */

/** @returns {import('../../src/contracts').ControlPlaneContext} */
function contextFixture() {
  return {
    runtime: 'local-dashboard',
    scope: { scopeId: 'scope_test', projectId: 'project_test', siteId: 'site_test' },
    actor: { actorId: 'actor_test', kind: 'local-session', authenticated: true },
    capabilities: {
      context_get: { available: true }, workflow_list: { available: true }, workflow_get: { available: true }, workflow_plan: { available: true },
      agent_run_plan: { available: true }, run_start: { available: true }, run_list: { available: true }, run_get: { available: true }, run_wait: { available: true },
      run_cancel: { available: true }, agent_run_retry: { available: true }, agent_run_followup: { available: true }, review_gate_resolve: { available: true }, resource_read: { available: true },
    },
    agentCatalog: { provenance: { source: 'test', commit: 'abc', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
    target: { siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] },
    currentBranch: 'main', branches: ['main'],
  }
}

/** @param {string} [status] @returns {import('../../src/contracts').ControlPlaneRunSummary} */
function runFixture(status = 'running') {
  return {
    runId: 'run_01', workflowId: 'review', title: 'Review', status, branch: 'main',
    agentRuns: [{ agentRunId: 'agent_run_old', runId: 'run_01', agent: 'claude', status: 'failed' }],
    reviewGate: { reviewGateId: 'review_gate_01', runId: 'run_01', stepId: 'approve', status: 'awaiting' },
  }
}

/** @param {Partial<import('../../src/contracts').NaxControlPlaneClient>} [overrides] @returns {import('../../src/contracts').NaxControlPlaneClient} */
function clientFixture(overrides = {}) {
  return /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
    getContext: async () => contextFixture(),
    listRuns: async () => ({ runs: [runFixture()], nextCursor: null }),
    cancelRun: async (target) => ({ run: runFixture('cancelled'), cancelled: true, ...(target.agentRunId ? { agentRunId: target.agentRunId } : {}), warnings: [] }),
    retryAgentRun: async () => ({ run: runFixture(), previousAgentRunId: 'agent_run_old', agentRun: { agentRunId: 'agent_run_new', runId: 'run_01', agent: 'claude', status: 'submitted' }, replayed: false }),
    submitFollowup: async () => ({ sourceRunId: 'run_01', run: runFixture(), agentRuns: [{ agentRunId: 'agent_run_followup', runId: 'run_01', agent: 'claude', status: 'submitted' }], replayed: false, warnings: [] }),
    resolveReviewGate: async (input) => ({ run: runFixture(input.decision === 'approve' ? 'running' : 'cancelled'), reviewGate: { reviewGateId: input.reviewGateId, runId: input.runId, stepId: 'approve', status: input.decision === 'approve' ? 'approved' : 'cancelled' }, replayed: false }),
    ...overrides,
  })
}

/** @param {import('../../src/contracts').NaxControlPlaneClient} client */
function registeredTools(client) {
  /** @type {Record<string, { config: Record<string, unknown>, callback: (args: Record<string, unknown>) => Promise<TestToolResult> }>} */
  const tools = {}
  const server = /** @type {import('@modelcontextprotocol/server').McpServer} */ ({
    registerTool(name, config, callback) {
      tools[name] = { config: /** @type {Record<string, unknown>} */ (config), callback: /** @type {(args: Record<string, unknown>) => Promise<TestToolResult>} */ (callback) }
    },
  })
  registerControlTools({ server, client })
  return tools
}

test('control tools use entity-first names and truthful destructive annotations', () => {
  const tools = registeredTools(clientFixture())
  assert.deepEqual(Object.keys(tools), ['run_cancel', 'agent_run_retry', 'agent_run_followup', 'review_gate_resolve'])
  assert.equal(/** @type {{ destructiveHint?: boolean }} */ (tools.run_cancel.config.annotations).destructiveHint, true)
  assert.equal(/** @type {{ destructiveHint?: boolean }} */ (tools.review_gate_resolve.config.annotations).destructiveHint, true)
  for (const name of ['agent_run_retry', 'agent_run_followup']) {
    const annotations = /** @type {{ idempotentHint?: boolean, destructiveHint?: boolean }} */ (tools[name].config.annotations)
    assert.equal(annotations.idempotentHint, true)
    assert.equal(annotations.destructiveHint, false)
  }
})

test('run_cancel targets only the exact optional agent run and preserves reason', async () => {
  /** @type {unknown[]} */
  const calls = []
  const client = clientFixture({ cancelRun: async (target) => { calls.push(target); return { run: runFixture('cancelled'), cancelled: true, agentRunId: target.agentRunId, warnings: ['Remote stop lagged.'] } } })
  const result = await registeredTools(client).run_cancel.callback({ run_id: 'run_01', agent_run_id: 'agent_run_old', reason: 'Superseded' })
  assert.deepEqual(calls, [{ runId: 'run_01', agentRunId: 'agent_run_old', reason: 'Superseded' }])
  assert.match(result.content[0].text, /Cancelled agent run agent_run_old/)
  assert.match(result.content[0].text, /1 warning returned/)
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'run_get', arguments: { run_id: 'run_01', view: 'summary', scope_id: 'scope_test' } }])
})

test('agent_run_retry passes the durable request identity and returns wait guidance', async () => {
  /** @type {unknown[]} */
  const calls = []
  const client = clientFixture({ retryAgentRun: async (input) => { calls.push(input); return { run: runFixture(), previousAgentRunId: input.agentRunId, agentRun: { agentRunId: 'agent_run_new', runId: input.runId, agent: 'claude', status: 'submitted' }, replayed: true } } })
  const result = await registeredTools(client).agent_run_retry.callback({ run_id: 'run_01', agent_run_id: 'agent_run_old', request_id: 'request_retry_01' })
  assert.deepEqual(calls, [{ runId: 'run_01', agentRunId: 'agent_run_old', requestId: 'request_retry_01' }])
  assert.match(result.content[0].text, /Replayed retry request_retry_01/)
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: 'run_01', since: '0', timeout_ms: 30000, scope_id: 'scope_test' } }])
})

test('agent_run_followup translates structured snake case without exposing the prompt in summary', async () => {
  /** @type {unknown[]} */
  const calls = []
  const prompt = 'Verify the private auth fix.'
  const client = clientFixture({ submitFollowup: async (input) => { calls.push(input); return { sourceRunId: input.runId, run: runFixture('completed'), agentRuns: [], replayed: false, warnings: [] } } })
  const result = await registeredTools(client).agent_run_followup.callback({
    run_id: 'run_01', agent_run_id: 'agent_run_old', request_id: 'request_followup_01', prompt,
    mode: 'fresh-runner', artifact_ids: ['artifact_summary'], instances: [{ agent: 'codex', model: 'gpt', effort: 'high' }],
  })
  assert.deepEqual(calls, [{
    runId: 'run_01', agentRunId: 'agent_run_old', requestId: 'request_followup_01', prompt,
    mode: 'fresh-runner', artifactIds: ['artifact_summary'], instances: [{ agent: 'codex', model: 'gpt', effort: 'high' }],
  }])
  assert.doesNotMatch(result.content[0].text, /private auth fix/)
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'run_get', arguments: { run_id: 'run_01', view: 'details', scope_id: 'scope_test' } }])
})

test('review_gate_resolve preserves one gate and decision', async () => {
  /** @type {unknown[]} */
  const calls = []
  const client = clientFixture({ resolveReviewGate: async (input) => { calls.push(input); return { run: runFixture('cancelled'), reviewGate: { reviewGateId: input.reviewGateId, runId: input.runId, stepId: 'approve', status: 'cancelled', reason: input.reason }, replayed: false } } })
  const result = await registeredTools(client).review_gate_resolve.callback({ run_id: 'run_01', review_gate_id: 'review_gate_01', decision: 'cancel', reason: 'Unsafe' })
  assert.deepEqual(calls, [{ runId: 'run_01', reviewGateId: 'review_gate_01', decision: 'cancel', reason: 'Unsafe' }])
  assert.match(result.content[0].text, /Applied cancel for review gate review_gate_01/)
})

test('ambiguous or missing target errors return exact candidates and a run refresh action', async () => {
  const client = clientFixture({
    retryAgentRun: async () => { throw Object.assign(new Error('Ambiguous.'), { code: 'ambiguous_agent_run', statusCode: 409, details: { runId: 'run_01', agentRunId: 'agent_run_bad', agentRunIds: ['agent_run_old', 'agent_run_other'] } }) },
  })
  const result = await registeredTools(client).agent_run_retry.callback({ run_id: 'run_01', agent_run_id: 'agent_run_bad', request_id: 'request_retry_01' })
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent.error?.details?.candidates, ['agent_run_old', 'agent_run_other'])
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'run_get', arguments: { run_id: 'run_01', view: 'details', scope_id: 'scope_test' } }])
})
