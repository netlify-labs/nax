const assert = require('node:assert/strict')
const test = require('node:test')

const { registerRunTools } = require('../../src/mcp/tools')

/**
 * @typedef {{
 *   ok: boolean,
 *   data?: unknown,
 *   error?: { code?: string, details?: Record<string, unknown> },
 *   context?: { runtime: string },
 *   next_actions: Array<{ kind: string, tool?: string, uri?: string, arguments?: Record<string, unknown> }>,
 * }} TestEnvelope
 * @typedef {{
 *   isError?: boolean,
 *   content: Array<{ type: string, text: string }>,
 *   structuredContent: TestEnvelope,
 * }} TestToolResult
 */

/** @param {'local-dashboard' | 'hosted'} [runtime] @returns {import('../../src/contracts').ControlPlaneContext} */
function contextFixture(runtime = /** @type {const} */ ('local-dashboard')) {
  return {
    runtime,
    scope: { scopeId: 'scope_test', projectId: 'project_test', siteId: 'site_test' },
    actor: { actorId: 'actor_test', kind: runtime === 'hosted' ? 'user' : 'local-session', authenticated: true },
    capabilities: {
      context_get: { available: true }, workflow_list: { available: true }, workflow_get: { available: true }, workflow_plan: { available: true },
      agent_run_plan: { available: true }, run_start: { available: true }, run_list: { available: true }, run_get: { available: true },
      run_wait: { available: true }, run_cancel: { available: true }, agent_run_retry: { available: true }, agent_run_followup: { available: true },
      review_gate_resolve: { available: true }, resource_read: { available: true },
    },
    agentCatalog: { provenance: { source: 'test', commit: 'abc123', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
    target: { siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] },
    currentBranch: 'main',
    branches: ['main'],
  }
}

/** @param {string} id @param {string} [status] @returns {import('../../src/contracts').ControlPlaneRunSummary} */
function runFixture(id, status = 'running') {
  return {
    runId: id,
    workflowId: 'security-review',
    title: 'Security review',
    status,
    branch: 'main',
    agentRuns: [{ agentRunId: `${id}_agent`, runId: id, agent: 'claude', status }],
  }
}

/** @param {string} runId @returns {import('../../src/contracts').ControlPlaneEvent} */
function eventFixture(runId) {
  return { cursor: '12', eventId: 'event_12', type: 'agent.completed', at: '2026-08-08T00:00:00.000Z', runId, status: 'completed', message: 'Agent completed.' }
}

/**
 * @param {Partial<import('../../src/contracts').NaxControlPlaneClient>} overrides
 * @returns {import('../../src/contracts').NaxControlPlaneClient}
 */
function clientFixture(overrides = {}) {
  return /** @type {import('../../src/contracts').NaxControlPlaneClient} */ ({
    getContext: async () => contextFixture(),
    listRuns: async () => ({ runs: [runFixture('run_01')], nextCursor: null }),
    getRun: async (id, options) => ({ run: runFixture(id), view: options.view }),
    waitForRun: async (id, cursor) => ({ run: runFixture(id), reason: 'timeout', events: [], nextCursor: cursor || '0', retryAfterMs: 500 }),
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
  registerRunTools({ server, client })
  return tools
}

test('run observation registers entity-first read-only tools', () => {
  const tools = registeredTools(clientFixture())
  assert.deepEqual(Object.keys(tools), ['run_list', 'run_get', 'run_wait'])
  for (const tool of Object.values(tools)) {
    assert.equal(/** @type {{ readOnlyHint?: boolean }} */ (tool.config.annotations).readOnlyHint, true)
    assert.equal(/** @type {{ idempotentHint?: boolean }} */ (tool.config.annotations).idempotentHint, true)
  }
})

test('run_list translates filters, bounds agent summaries, and preserves pagination intent', async () => {
  /** @type {unknown[]} */
  const calls = []
  const first = runFixture('run_01')
  first.agentRuns = Array.from({ length: 10 }, (_value, index) => ({ agentRunId: `agent_run_${index}`, runId: first.runId, agent: 'claude', status: 'running' }))
  const client = clientFixture({
    listRuns: async (query) => {
      calls.push(query)
      return { runs: [first], nextCursor: 'cursor_next', total: 12 }
    },
  })
  const result = await registeredTools(client).run_list.callback({ status: 'running', workflow_id: 'security-review', limit: 1, cursor: 'cursor_old' })
  assert.deepEqual(calls, [{ status: 'running', workflowId: 'security-review', limit: 1, cursor: 'cursor_old' }])
  const data = /** @type {{ runs: Array<{ runId: string, agentRuns: unknown[], agentRunsTruncated: boolean }> }} */ (result.structuredContent.data)
  assert.equal(data.runs[0].runId, 'run_01')
  assert.equal(data.runs[0].agentRuns.length, 8)
  assert.equal(data.runs[0].agentRunsTruncated, true)
  assert.deepEqual(result.structuredContent.next_actions, [
    { kind: 'tool', tool: 'run_get', arguments: { run_id: 'run_01', view: 'summary', scope_id: 'scope_test' } },
    { kind: 'tool', tool: 'run_list', arguments: { status: 'running', workflow_id: 'security-review', limit: 1, cursor: 'cursor_next', scope_id: 'scope_test' } },
  ])
})

test('run_get details defaults to an index and returns only one requested markdown section', async () => {
  const details = {
    summary: 'Summary',
    sections: [
      { sectionId: 'step:analyze', kind: /** @type {const} */ ('step'), title: 'Analyze', status: 'completed', resourceUri: 'nax://scopes/scope_test/runs/run_01/sections/analyze', markdown: '# Secret-sized detail' },
      { sectionId: 'step:review', kind: /** @type {const} */ ('step'), title: 'Review', status: 'running', markdown: '# Review detail' },
    ],
    artifacts: [{ artifactId: 'artifact_01', label: 'Report', kind: 'markdown', sizeBytes: 100, resourceUri: 'nax://scopes/scope_test/runs/run_01/artifacts/artifact_01' }],
  }
  /** @type {unknown[]} */
  const calls = []
  const client = clientFixture({
    getRun: async (id, options) => {
      calls.push({ id, options })
      return { run: runFixture(id, 'completed'), view: /** @type {const} */ ('details'), details }
    },
  })
  const index = await registeredTools(client).run_get.callback({ run_id: 'run_01', view: 'details' })
  const indexData = /** @type {{ details: { sections: Array<{ sectionId: string, markdown?: string }> } }} */ (index.structuredContent.data)
  assert.equal(indexData.details.sections.length, 2)
  assert.equal(indexData.details.sections[0].markdown, undefined)
  assert.deepEqual(index.structuredContent.next_actions[0], { kind: 'tool', tool: 'run_get', arguments: { run_id: 'run_01', view: 'details', section_id: 'step:analyze', scope_id: 'scope_test' } })

  const section = await registeredTools(client).run_get.callback({ run_id: 'run_01', view: 'details', section_id: 'step:review' })
  const sectionData = /** @type {{ details: { sections: Array<{ sectionId: string, markdown?: string }> } }} */ (section.structuredContent.data)
  assert.deepEqual(sectionData.details.sections, [details.sections[1]])
  assert.deepEqual(calls, [
    { id: 'run_01', options: { view: 'details' } },
    { id: 'run_01', options: { view: 'details', sectionId: 'step:review' } },
  ])
})

test('run_get events translates numeric cursors and continues with the returned opaque cursor', async () => {
  /** @type {unknown[]} */
  const calls = []
  const client = clientFixture({
    getRun: async (id, options) => {
      calls.push({ id, options })
      return { run: runFixture(id), view: /** @type {const} */ ('events'), events: { events: [eventFixture(id)], nextCursor: '13', truncated: false } }
    },
  })
  const result = await registeredTools(client).run_get.callback({ run_id: 'run_01', view: 'events', since: 10, limit: 20 })
  assert.deepEqual(calls, [{ id: 'run_01', options: { view: 'events', since: '10', limit: 20 } }])
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: 'run_01', since: '13', timeout_ms: 30000, scope_id: 'scope_test' } }])
})

test('run_wait covers events, terminal, review, stalled, and hosted timeout states', async () => {
  const cases = [
    { reason: 'events', status: 'running', events: [eventFixture('run_01')], tool: 'run_wait' },
    { reason: 'terminal', status: 'completed', events: [], tool: 'run_get' },
    { reason: 'review', status: 'awaiting_review', events: [], tool: 'run_get' },
    { reason: 'stalled', status: 'running', stalled: true, events: [], tool: 'run_get' },
    { reason: 'timeout', status: 'running', events: [], tool: 'run_wait', hosted: true },
  ]
  for (const entry of cases) {
    const run = runFixture('run_01', entry.status)
    if (entry.stalled) run.stalled = true
    const client = clientFixture({
      getContext: async () => contextFixture(entry.hosted ? 'hosted' : 'local-dashboard'),
      waitForRun: async () => ({ run, reason: /** @type {import('../../src/contracts').ControlPlaneWaitReason} */ (entry.reason), events: entry.events, nextCursor: '12', ...(entry.hosted ? { retryAfterMs: 1000 } : {}) }),
    })
    const result = await registeredTools(client).run_wait.callback({ run_id: 'run_01', since: '11', timeout_ms: 30000 })
    assert.equal(result.structuredContent.next_actions[0].tool, entry.tool, entry.reason)
    if (entry.hosted) assert.equal(result.structuredContent.context?.runtime, 'hosted')
  }
})

test('unknown run IDs get bounded fuzzy suggestions and rediscovery guidance', async () => {
  const client = clientFixture({
    getRun: async () => {
      throw Object.assign(new Error('Unknown run.'), { code: 'run_not_found', statusCode: 404, details: { runId: 'run_002' } })
    },
    listRuns: async () => ({ runs: [runFixture('run_001'), runFixture('run_010')], nextCursor: null }),
  })
  const result = await registeredTools(client).run_get.callback({ run_id: 'run_002', view: 'summary' })
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent.error?.details?.suggestions, ['run_001', 'run_010'])
  assert.deepEqual(result.structuredContent.next_actions, [{ kind: 'tool', tool: 'run_list', arguments: { limit: 50, scope_id: 'scope_test' } }])
})

test('large bounded event pages retain cursors under the shared result budget', async () => {
  const events = Array.from({ length: 200 }, (_value, index) => ({
    ...eventFixture('run_01'), cursor: String(index + 1), eventId: `event_${index + 1}`, message: 'x'.repeat(5000), data: { detail: 'y'.repeat(5000) },
  }))
  const client = clientFixture({
    getRun: async (id) => ({ run: runFixture(id), view: /** @type {const} */ ('events'), events: { events, nextCursor: '200', truncated: false } }),
  })
  const result = await registeredTools(client).run_get.callback({ run_id: 'run_01', view: 'events', since: '0', limit: 200 })
  const data = /** @type {{ events: { events: unknown[], nextCursor: string } }} */ (result.structuredContent.data)
  assert.equal(data.events.events.length, 200)
  assert.equal(data.events.nextCursor, '200')
  assert.equal(Buffer.byteLength(JSON.stringify(result.structuredContent)) < 256 * 1024, true)
})
