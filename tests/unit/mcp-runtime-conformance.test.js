const assert = require('node:assert/strict')
const test = require('node:test')

const { InMemoryTransport } = require('@modelcontextprotocol/server')

const { buildServer } = require('../../src/mcp/server')
const { TOOL_SPECS, toolResultOutputSchema } = require('../../src/mcp/schemas')

const TOOL_NAMES = Object.freeze([
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

const TOOL_CALLS = Object.freeze([
  ['context_get', {}],
  ['workflow_list', { limit: 10 }],
  ['workflow_get', { workflow_id: 'workflow_test', include_graph: true }],
  ['workflow_plan', { workflow_id: 'workflow_test', instances: [{ agent: 'codex', model: 'gpt-test', effort: 'high' }] }],
  ['agent_run_plan', { prompt: 'Audit the fixture.', instance: { agent: 'codex', model: 'gpt-test', effort: 'high' } }],
  ['run_start', { plan_id: 'plan_workflow_test', request_id: 'request_start_test' }],
  ['run_list', { limit: 10 }],
  ['run_get', { run_id: 'run_test', view: 'details' }],
  ['run_wait', { run_id: 'run_test', since: '0', timeout_ms: 10 }],
  ['run_cancel', { run_id: 'run_test', agent_run_id: 'agent_run_test' }],
  ['agent_run_retry', { run_id: 'run_test', agent_run_id: 'agent_run_test', request_id: 'request_retry_test' }],
  ['agent_run_followup', { run_id: 'run_test', agent_run_id: 'agent_run_test', request_id: 'request_followup_test', prompt: 'Verify the fix.', artifact_ids: ['artifact_summary'] }],
  ['review_gate_resolve', { run_id: 'run_test', review_gate_id: 'review_gate_test', decision: 'approve' }],
])

/** @typedef {import('../../src/contracts').ControlPlaneRuntime} ControlPlaneRuntime */

/**
 * @typedef {{
 *   starts: Map<string, import('../../src/contracts').ControlPlaneStartResult>,
 *   startCount: number,
 *   runStatus: string,
 *   blockWait: boolean,
 *   largeDetails: boolean,
 *   cancelledWaits: number,
 * }} DurableFixtureState
 */

/** @returns {DurableFixtureState} */
function durableState() {
  return { starts: new Map(), startCount: 0, runStatus: 'awaiting_review', blockWait: false, largeDetails: false, cancelledWaits: 0 }
}

/** @param {ControlPlaneRuntime} runtime */
function capabilities(runtime) {
  return Object.fromEntries([
    ...TOOL_NAMES,
    'resource_read',
  ].map((name) => [name, {
    available: !(runtime === 'hosted' && name === 'run_cancel'),
    ...(runtime === 'hosted' && name === 'run_cancel' ? { reason: 'Fixture policy disables cancellation.' } : {}),
  }]))
}

/** @param {DurableFixtureState} state @returns {import('../../src/contracts').ControlPlaneRunSummary} */
function runSummary(state) {
  return {
    runId: 'run_test',
    workflowId: 'workflow_test',
    title: 'Fixture run',
    source: 'mcp',
    status: state.runStatus,
    branch: 'main',
    target: { siteId: 'site_test', siteName: 'Fixture site', branch: 'main', verified: true, caveats: [] },
    createdAt: '2026-08-08T12:00:00.000Z',
    updatedAt: '2026-08-08T12:00:01.000Z',
    cancellable: true,
    agentRuns: [{
      agentRunId: 'agent_run_test', runId: 'run_test', stepId: 'step_test', instanceId: 'instance_test', agent: 'codex', model: 'gpt-test', effort: 'high', runnerId: 'runner_test', sessionId: 'session_test', status: state.runStatus === 'cancelled' ? 'cancelled' : 'failed',
    }],
    reviewGate: { reviewGateId: 'review_gate_test', runId: 'run_test', stepId: 'review', status: state.runStatus === 'awaiting_review' ? /** @type {const} */ ('awaiting') : /** @type {const} */ ('approved') },
  }
}

/**
 * @param {ControlPlaneRuntime} runtime
 * @param {DurableFixtureState} state
 * @returns {import('../../src/contracts').NaxControlPlaneClient}
 */
function runtimeClient(runtime, state) {
  const scopeId = `scope_${runtime.replaceAll('-', '_')}`
  const context = {
    runtime,
    scope: { scopeId, projectId: 'project_test', ...(runtime === 'hosted' ? { accountId: 'account_test' } : {}) },
    actor: { actorId: 'actor_test', kind: runtime === 'local-dashboard' ? 'local-session' : 'user', authenticated: true },
    capabilities: capabilities(runtime),
    agentCatalog: {
      provenance: { source: 'fixture', commit: 'fixture', syncedAt: '2026-08-08T12:00:00.000Z' },
      providers: [{ id: 'codex', label: 'Codex', defaultModel: 'gpt-test', models: [{ id: 'gpt-test', label: 'GPT test', efforts: [{ id: 'high', label: 'High' }] }] }],
    },
    target: { accountId: 'account_test', accountSlug: 'fixture', siteId: 'site_test', siteName: 'Fixture site', branch: 'main', verified: true, caveats: [] },
    currentBranch: 'main',
    branches: ['main'],
  }
  const workflow = {
    workflowId: 'workflow_test', title: 'Fixture workflow', description: 'Deterministic conformance workflow.', source: 'fixture', sourceLabel: 'Fixture', stepCount: 1, agents: ['codex'], defaults: {}, options: {},
    steps: [{ stepId: 'step_test', title: 'Test', action: 'run', submit: 'new-run', waitFor: 'agent-results', agents: ['codex'], instances: [{ agent: 'codex', model: 'gpt-test', effort: 'high', instanceId: 'instance_test' }], reviewGate: false }],
  }
  /** @type {import('../../src/contracts').NaxControlPlaneClient} */
  const client = {
    async getContext() { return /** @type {never} */ (context) },
    async listWorkflows(query) {
      if (query.cursor === 'cursor_done') return { workflows: [], nextCursor: null }
      return { workflows: [{ workflowId: workflow.workflowId, title: workflow.title, description: workflow.description, source: workflow.source, sourceLabel: workflow.sourceLabel, stepCount: 1, agents: ['codex'] }], nextCursor: 'cursor_done' }
    },
    async getWorkflow(workflowId, options) {
      if (workflowId !== workflow.workflowId) throw Object.assign(new Error(`Unknown workflow "${workflowId}".`), { code: 'workflow_not_found', details: { workflowId, workflowIds: [workflow.workflowId] } })
      return {
        workflow,
        ...(options?.includeGraph ? { graph: { nodes: [{ id: 'step_test', kind: 'workflow-step', data: { title: 'Test' } }], edges: [], metadata: {} } } : {}),
      }
    },
    async createWorkflowPlan(input) { return /** @type {never} */ (plan('plan_workflow_test', 'workflow', context.scope, input.workflowId)) },
    async createAgentRunPlan() { return /** @type {never} */ (plan('plan_agent_test', 'agent-run', context.scope)) },
    async startPlan(planId, requestId) {
      const key = `${planId}:${requestId}`
      const existing = state.starts.get(key)
      if (existing) return { ...existing, accepted: false, replayed: true }
      state.startCount += 1
      state.runStatus = 'running'
      const result = { run: runSummary(state), accepted: true, replayed: false }
      state.starts.set(key, /** @type {never} */ (result))
      return /** @type {never} */ (result)
    },
    async listRuns(query) {
      if (query.cursor === 'cursor_done') return { runs: [], nextCursor: null, total: 1 }
      return { runs: [runSummary(state)], nextCursor: 'cursor_done', total: 1 }
    },
    async getRun(runId, options) {
      if (runId !== 'run_test') throw Object.assign(new Error(`Unknown run "${runId}".`), { code: 'run_not_found', details: { runId, runIds: ['run_test'] } })
      const run = runSummary(state)
      if (options.view === 'details') {
        const markdown = state.largeDetails ? 'x'.repeat(400_000) : '# Verified fixture result\n'
        return {
          run, view: 'details', details: {
            summary: '# Fixture summary\n',
            sections: [{ sectionId: 'section_test', kind: 'agent-run', title: 'Result', status: 'completed', agentRunId: 'agent_run_test', markdown, resourceUri: `nax://scopes/${scopeId}/runs/run_test/details` }],
            artifacts: [{ artifactId: 'artifact_summary', label: 'Summary', kind: 'markdown', sizeBytes: 25, resourceUri: `nax://scopes/${scopeId}/runs/run_test/artifacts/artifact_summary` }],
            truncated: false,
          },
        }
      }
      if (options.view === 'graph') return { run, view: 'graph', graph: { nodes: [], edges: [], metadata: {} } }
      if (options.view === 'events') return { run, view: 'events', events: eventPage() }
      return { run, view: 'summary' }
    },
    async waitForRun(_runId, _cursor, _timeoutMs, signal) {
      if (state.blockWait) {
        await new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(cancelledError())
          const timer = setTimeout(resolve, 5000)
          timer.unref?.()
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            state.cancelledWaits += 1
            reject(cancelledError())
          }, { once: true })
        })
      }
      return { run: runSummary(state), reason: 'events', events: eventPage().events, nextCursor: '1' }
    },
    async cancelRun(target) {
      state.runStatus = 'cancelled'
      return { run: runSummary(state), cancelled: true, ...(target.agentRunId ? { agentRunId: target.agentRunId } : {}), warnings: [] }
    },
    async retryAgentRun(input) {
      return { run: runSummary(state), previousAgentRunId: input.agentRunId, agentRun: { ...runSummary(state).agentRuns[0], agentRunId: 'agent_run_retry', runnerId: 'runner_retry', status: 'running' }, replayed: false }
    },
    async submitFollowup(input) {
      return { sourceRunId: input.runId, run: runSummary(state), agentRuns: [{ ...runSummary(state).agentRuns[0], agentRunId: 'agent_run_followup', runnerId: 'runner_followup', status: 'running' }], replayed: false, warnings: [] }
    },
    async resolveReviewGate(input) {
      state.runStatus = 'running'
      return { run: runSummary(state), reviewGate: { reviewGateId: input.reviewGateId, runId: input.runId, stepId: 'review', status: input.decision === 'approve' ? 'approved' : 'cancelled' }, replayed: false }
    },
    async getArtifact(runId, artifactId) {
      if (runId !== 'run_test' || artifactId !== 'artifact_summary') throw Object.assign(new Error('Unknown artifact.'), { code: 'artifact_not_found' })
      return { runId, artifactId, contentType: 'text/markdown', sizeBytes: 25, content: '# Verified fixture result\n' }
    },
  }
  return client
}

/** @param {string} planId @param {'workflow' | 'agent-run'} kind @param {import('../../src/contracts').ControlPlaneScope} scope @param {string} [workflowId] */
function plan(planId, kind, scope, workflowId) {
  return {
    planId, kind, status: 'prepared', scope, target: { siteId: 'site_test', siteName: 'Fixture site', branch: 'main', verified: true, caveats: [] }, expiresAt: '2026-08-08T12:10:00.000Z', ...(workflowId ? { workflowId } : {}), steps: [], instances: [{ agent: 'codex', model: 'gpt-test', effort: 'high', instanceId: 'instance_test' }], expectedAgentRuns: 1, warnings: [], summary: 'One remote Agent Runner on Fixture site/main.',
  }
}

function eventPage() {
  return { events: [{ cursor: '1', eventId: 'event_test', type: 'agent_completed', at: '2026-08-08T12:00:01.000Z', runId: 'run_test', agentRunId: 'agent_run_test', status: 'completed' }], nextCursor: '1', truncated: false }
}

function cancelledError() {
  return Object.assign(new Error('The request was cancelled.'), { code: 'request_cancelled', recoverable: true })
}

class ProtocolHarness {
  /** @param {import('../../src/contracts').NaxControlPlaneClient} client */
  constructor(client) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    this.clientTransport = clientTransport
    this.serverTransport = serverTransport
    this.server = buildServer({ projectRoot: process.cwd(), client })
    /** @type {Map<number, { resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    this.nextId = 1
    clientTransport.onmessage = (message) => {
      const record = /** @type {Record<string, unknown>} */ (message)
      const id = Number(record.id)
      const pending = this.pending.get(id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.resolve(record)
    }
  }

  async start() {
    await this.server.connect(this.serverTransport)
    await this.clientTransport.start()
    const initialized = await this.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'nax-conformance', version: '1.0.0' },
    })
    assert.equal(objectValue(initialized.result).protocolVersion, '2025-11-25')
    await this.notify('notifications/initialized', {})
    return initialized
  }

  /** @param {string} method @param {Record<string, unknown>} params */
  request(method, params) {
    const id = this.nextId
    this.nextId += 1
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method} (${id}).`))
      }, 3000)
      this.pending.set(id, { resolve, reject, timer })
    })
    void this.clientTransport.send({ jsonrpc: '2.0', id, method, params })
    return /** @type {Promise<Record<string, unknown>> & { requestId?: number }} */ (Object.assign(response, { requestId: id }))
  }

  /** @param {string} method @param {Record<string, unknown>} params */
  async notify(method, params) {
    await this.clientTransport.send({ jsonrpc: '2.0', method, params })
  }

  async close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Protocol harness closed.'))
    }
    this.pending.clear()
    await this.clientTransport.close()
    await this.server.close()
  }

  /** @param {number | undefined} id */
  discard(id) {
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.reject(new Error('Cancelled request intentionally produced no response.'))
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
}

/** @param {Record<string, unknown>} response */
function toolResult(response) {
  const result = objectValue(response.result)
  assert.equal(response.error, undefined, JSON.stringify(response.error))
  assert.equal(toolResultOutputSchema.safeParse(result.structuredContent).success, true, JSON.stringify(result.structuredContent))
  return result
}

for (const runtime of /** @type {const} */ (['local-dashboard', 'desktop', 'hosted'])) {
  test(`complete MCP protocol surface conforms for ${runtime}`, async (t) => {
    const state = durableState()
    const harness = new ProtocolHarness(runtimeClient(runtime, state))
    t.after(() => harness.close())
    const initialized = await harness.start()
    const initializeResult = objectValue(initialized.result)
    assert.deepEqual(Object.keys(objectValue(initializeResult.capabilities)).sort(), ['prompts', 'resources', 'tools'])

    const listed = await harness.request('tools/list', {})
    const tools = /** @type {Array<Record<string, unknown>>} */ (objectValue(listed.result).tools)
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES)
    assert.equal(tools.every((tool) => objectValue(tool.annotations).idempotentHint === true), true)
    assert.equal(tools.some((tool) => String(tool.name).startsWith('get_') || String(tool.name).startsWith('list_')), false)

    /** @type {Array<unknown>} */
    const toolOutputs = []
    for (const [name, args] of TOOL_CALLS) {
      const response = await harness.request('tools/call', { name, arguments: args })
      const result = toolResult(response)
      assert.equal(result.isError, undefined, `${runtime}:${name}:${JSON.stringify(result)}`)
      toolOutputs.push(result.structuredContent)
    }

    const replay = toolResult(await harness.request('tools/call', { name: 'run_start', arguments: { plan_id: 'plan_workflow_test', request_id: 'request_start_test' } }))
    assert.equal(objectValue(objectValue(replay.structuredContent).data).replayed, true)
    assert.equal(state.startCount, 1)

    const templateResponse = await harness.request('resources/templates/list', {})
    const templates = /** @type {Array<Record<string, unknown>>} */ (objectValue(templateResponse.result).resourceTemplates)
    assert.deepEqual(templates.map((template) => template.name), ['nax-context', 'nax-workflow', 'nax-run', 'nax-run-details', 'nax-run-events', 'nax-run-artifact'])
    const scopeId = `scope_${runtime.replaceAll('-', '_')}`
    const resource = await harness.request('resources/read', { uri: `nax://scopes/${scopeId}/runs/run_test/artifacts/artifact_summary` })
    assert.match(String(/** @type {Array<Record<string, unknown>>} */ (objectValue(resource.result).contents)[0].text), /Verified fixture result/)

    const promptResponse = await harness.request('prompts/list', {})
    const prompts = /** @type {Array<Record<string, unknown>>} */ (objectValue(promptResponse.result).prompts)
    assert.deepEqual(prompts.map((prompt) => prompt.name), ['run_remote_workflow', 'follow_up_on_run'])
    const rendered = await harness.request('prompts/get', { name: 'run_remote_workflow', arguments: { workflow_id: 'workflow_test' } })
    assert.match(JSON.stringify(rendered.result), /workflow_plan/)

    const missing = toolResult(await harness.request('tools/call', { name: 'run_get', arguments: { run_id: 'run_missing', view: 'summary' } }))
    assert.equal(missing.isError, true)
    assert.equal(objectValue(objectValue(missing.structuredContent).error).code, 'run_not_found')
    assert.match(JSON.stringify(missing), /run_list/)

    state.largeDetails = true
    const bounded = toolResult(await harness.request('tools/call', { name: 'run_get', arguments: { run_id: 'run_test', view: 'details' } }))
    assert.equal(Buffer.byteLength(JSON.stringify(bounded.structuredContent)) < 300_000, true)
    const boundedData = objectValue(objectValue(bounded.structuredContent).data)
    assert.equal(JSON.stringify(boundedData).includes('x'.repeat(1000)), false)
    assert.equal(objectValue(objectValue(boundedData.detailsLimits).sections).total, 1)

    if (runtime !== 'local-dashboard') {
      assert.doesNotMatch(JSON.stringify([toolOutputs, resource, rendered]), /127\.0\.0\.1|\/tmp\/|projectRoot|dashboardInstanceId/)
    }
  })
}

test('MCP conformance preserves idempotency across stateless hosted re-instantiation', async (t) => {
  const state = durableState()
  const first = new ProtocolHarness(runtimeClient('hosted', state))
  await first.start()
  toolResult(await first.request('tools/call', { name: 'run_start', arguments: { plan_id: 'plan_workflow_test', request_id: 'request_restart_test' } }))
  await first.close()

  const second = new ProtocolHarness(runtimeClient('hosted', state))
  t.after(() => second.close())
  await second.start()
  const replay = toolResult(await second.request('tools/call', { name: 'run_start', arguments: { plan_id: 'plan_workflow_test', request_id: 'request_restart_test' } }))
  assert.equal(objectValue(objectValue(replay.structuredContent).data).replayed, true)
  assert.equal(state.startCount, 1)
})

test('MCP conformance rejects malformed calls and propagates cancellation', async (t) => {
  const state = durableState()
  const harness = new ProtocolHarness(runtimeClient('desktop', state))
  t.after(() => harness.close())
  await harness.start()

  const invalid = await harness.request('tools/call', { name: 'run_get', arguments: { run_id: 'YOUR_RUN_ID', view: 'summary' } })
  assert.equal(objectValue(invalid.result).isError, true, JSON.stringify(invalid))
  assert.match(JSON.stringify(invalid.result), /Input validation error/)
  const unknown = await harness.request('tools/call', { name: 'get_run', arguments: {} })
  assert.equal(Number(objectValue(unknown.error).code), -32602, JSON.stringify(unknown))

  state.blockWait = true
  const waiting = harness.request('tools/call', { name: 'run_wait', arguments: { run_id: 'run_test', since: '0', timeout_ms: 30000 } })
  void waiting.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  await harness.notify('notifications/cancelled', { requestId: waiting.requestId, reason: 'test cancellation' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(state.cancelledWaits, 1)
  harness.discard(waiting.requestId)
})

test('tool specs and protocol catalog remain in exact entity-first lockstep', () => {
  assert.deepEqual(Object.keys(TOOL_SPECS), TOOL_NAMES)
  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    assert.equal(typeof spec.title, 'string', name)
    assert.equal(typeof spec.description, 'string', name)
    assert.ok(spec.inputSchema, name)
    assert.ok(spec.outputSchema, name)
  }
})
