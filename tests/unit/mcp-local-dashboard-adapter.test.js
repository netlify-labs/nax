const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { PACKAGE_VERSION } = require('../../src/core/artifact-metadata')
const {
  LocalDashboardAdapterError,
  composeLocalDashboardControlPlane,
  createLocalDashboardClient,
} = require('../../src/mcp/adapters/local-dashboard')
const {
  ensureStableProjectIdentity,
  writeDashboardInstance,
} = require('../../src/runtime/local/mcp-instance-registry')

const TEST_TOKEN = 'adapter-test-token-at-least-24-characters'

/** @returns {string} */
function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mcp-adapter-'))
}

/**
 * @param {http.IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { text += chunk })
    request.on('end', () => {
      try {
        const parsed = text ? JSON.parse(text) : {}
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

/** @param {http.ServerResponse} response @param {number} status @param {unknown} body */
function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

/**
 * @param {(request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>} handler
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>}
 */
function startLoopbackServer(handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) json(response, 500, { error: { statusCode: 500, code: 'fixture_error', message: error instanceof Error ? error.message : String(error) } })
      else response.destroy(error instanceof Error ? error : undefined)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('fixture did not bind a TCP port'))
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve, closeReject) => {
          if (!server.listening) return closeResolve()
          server.close((error) => error ? closeReject(error) : closeResolve())
        }),
      })
    })
  })
}

/** @param {string} projectId @param {string} projectRoot @param {{ canPlanRuns?: boolean, canReadRunArtifacts?: boolean }} [options] */
function health(projectId, projectRoot, options = {}) {
  return {
    ok: true,
    version: PACKAGE_VERSION,
    projectId,
    projectRoot,
    currentBranch: 'main',
    branches: ['main', 'feature/mcp'],
    capabilities: {
      deploymentMode: 'local',
      canListWorkflows: true,
      canReadRuns: true,
      canReadRunDetails: true,
      canReadEventsJson: true,
      canPlanRuns: options.canPlanRuns === true,
      canReadRunArtifacts: options.canReadRunArtifacts === true,
      canStartRuns: true,
      canDryRun: true,
      canCancelRuns: true,
      canSubmitFollowups: true,
      canReviewGates: true,
      canOpenLocalFiles: true,
      canStreamRunEvents: true,
      canServeStaticAssets: true,
      requiresAuth: true,
      agentConfiguration: {
        catalog: {
          provenance: { source: 'fixture', commit: 'abc123', syncedAt: '2026-08-08T00:00:00.000Z' },
          providers: [{ id: 'claude', label: 'Claude', defaultModel: 'sonnet', models: [{ id: 'sonnet', label: 'Sonnet', efforts: [] }] }],
        },
        transports: { auto: { models: true, efforts: true } },
      },
    },
    netlifyContext: {
      account: { email: 'must-not-leak@example.com' },
      target: { siteId: 'site_test', name: 'Test site', accessible: true, reason: 'Linked project site' },
      targetError: '',
    },
    netlifyAccess: {
      ok: true,
      code: 'ok',
      message: 'Accessible.',
      account: { email: 'must-not-leak@example.com' },
      site: { id: 'site_test', name: 'Test site', accountSlug: 'team-test' },
    },
  }
}

/** @param {string} status @param {string} [runnerId] */
function runFixture(status = 'awaiting_review', runnerId = 'runner_old') {
  return {
    runId: 'run_test',
    flowId: 'review-flow',
    flowTitle: 'Review flow',
    status,
    transport: 'netlify-api',
    branch: 'main',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:01:00.000Z',
    target: { branch: 'main', ref: 'refs/heads/main', sha: 'abc123', verified: true, caveats: [] },
    cancellable: true,
    dir: '/private/project/.nax/runs/run_test',
    steps: [
      {
        id: 'execute',
        title: 'Execute',
        status: status === 'cancelled' ? 'cancelled' : 'running',
        runs: [{
          agent: 'claude',
          model: 'sonnet',
          effort: 'high',
          instanceId: 'claude-sonnet-high',
          runnerId,
          sessionId: runnerId === 'runner_old' ? 'session_old' : 'session_new',
          status: runnerId === 'runner_old' ? 'failed' : 'running',
          token: TEST_TOKEN,
        }],
      },
      {
        id: 'human-review',
        title: 'Human review',
        action: 'human-review',
        status,
        review: { status, instructions: 'Check it' },
        runs: [],
      },
    ],
  }
}

/**
 * @param {{
 *   projectRoot: string,
 *   projectId: string,
 *   instanceId: string,
 *   origin: string,
 *   registry: { tempDir: string, userId: string, env: NodeJS.ProcessEnv },
 * }} input
 */
function advertise(input) {
  writeDashboardInstance({
    v: 1,
    instanceId: input.instanceId,
    pid: process.pid,
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    origin: input.origin,
    token: TEST_TOKEN,
    startedAt: '2026-08-08T00:00:00.000Z',
    version: PACKAGE_VERSION,
  }, { ...input.registry, isProcessAlive: () => false })
}

/**
 * @param {string} projectRoot
 * @param {string} projectId
 * @param {{ requests: Array<{ method: string, path: string, token: string, body: Record<string, unknown> }> }} observed
 * @param {{ canPlanRuns?: boolean, canReadRunArtifacts?: boolean }} [options]
 */
function dashboardHandler(projectRoot, projectId, observed, options = {}) {
  let currentRun = runFixture()
  return async (request, response) => {
    const url = new URL(request.url || '/', 'http://fixture.local')
    const body = request.method === 'POST' ? await readJsonBody(request) : {}
    observed.requests.push({
      method: request.method || 'GET',
      path: `${url.pathname}${url.search}`,
      token: stringHeader(request.headers['x-nax-token']),
      body,
    })
    if (request.headers['x-nax-token'] !== TEST_TOKEN) return json(response, 401, { error: { statusCode: 401, code: 'unauthorized', message: 'Missing token' } })
    if (url.pathname === '/api/health') return json(response, 200, health(projectId, projectRoot, options))
    if (url.pathname === '/api/run-plans/workflows/review-flow') {
      return json(response, 201, {
        plan: {
          planId: 'plan_workflow_test', kind: 'workflow', status: 'prepared', scope: { scopeId: 'scope_test', projectId },
          target: { siteId: 'site_test', siteName: 'Test site', branch: 'main', verified: true, caveats: [] },
          expiresAt: '2026-08-08T00:10:00.000Z', workflowId: 'review-flow', steps: [], instances: [], expectedAgentRuns: 1, warnings: [], summary: 'Prepared.',
        },
      })
    }
    if (url.pathname === '/api/run-plans/agents') {
      return json(response, 201, {
        plan: {
          planId: 'plan_agent_test', kind: 'agent-run', status: 'prepared', scope: { scopeId: 'scope_test', projectId },
          target: { siteId: 'site_test', siteName: 'Test site', branch: 'main', verified: true, caveats: [] },
          expiresAt: '2026-08-08T00:10:00.000Z', steps: [], instances: [], expectedAgentRuns: 1, warnings: [], summary: 'Prepared.',
        },
      })
    }
    if (url.pathname === '/api/run-plans/plan_workflow_test/start') {
      return json(response, 202, { run: { runId: 'run_planned', workflowId: 'review-flow', status: 'running', source: 'mcp' }, accepted: true, replayed: false })
    }
    if (url.pathname === '/api/workflows') {
      return json(response, 200, {
        count: 1,
        items: [{
          id: 'review-flow',
          title: 'Review flow',
          description: 'Run and review',
          source: 'project',
          sourceLabel: 'Project',
          sourceDir: '/private/project/workflows',
          file: '/private/project/workflows/review.yml',
          defaults: { token: TEST_TOKEN, models: { claude: 'sonnet' } },
          options: {},
          steps: [{ id: 'execute', title: 'Execute', description: 'Do work', action: 'run', submit: 'new-run', waitFor: 'agent-results', agents: ['claude'], instances: [{ id: 'claude-sonnet', agent: 'claude', model: 'sonnet' }] }],
        }],
      })
    }
    if (url.pathname === '/api/workflows/review-flow') {
      return json(response, 200, {
        id: 'review-flow', title: 'Review flow', description: 'Run and review', source: 'project', sourceLabel: 'Project', defaults: {}, options: {},
        steps: [{ id: 'execute', title: 'Execute', description: 'Do work', action: 'run', submit: 'new-run', waitFor: 'agent-results', agents: ['claude'], instances: [{ id: 'claude-sonnet', agent: 'claude', model: 'sonnet' }] }],
      })
    }
    if (url.pathname === '/api/workflows/review-flow/graph') {
      return json(response, 200, {
        workflow: { id: 'review-flow', title: 'Review flow', description: '', source: 'project', sourceLabel: 'Project', defaults: {}, options: {}, steps: [] },
        graph: {
          nodes: [{ id: 'execute', type: 'workflow-step', data: { kind: 'workflow-step', title: 'Execute', promptMarkdown: 'Do work', promptPath: '/private/prompt.md', token: TEST_TOKEN } }],
          edges: [],
          metadata: { flowId: 'review-flow', sourceDir: '/private/project/workflows' },
        },
      })
    }
    if (url.pathname === '/api/runs') return json(response, 200, { runs: [currentRun], pagination: { total: 1, nextCursor: null } })
    if (url.pathname === '/api/runs/run_test') return json(response, 200, { run: currentRun })
    if (url.pathname === '/api/runs/run_test/graph') {
      return json(response, 200, { run: currentRun, graph: { nodes: [], edges: [], metadata: { path: '/private/graph.json', status: currentRun.status } } })
    }
    if (url.pathname === '/api/runs/run_test/details') {
      return json(response, 200, {
        run: currentRun,
        details: {
          summaryMarkdown: '# Summary',
          sections: [{ id: 'session:old', kind: 'session', title: 'Execute · claude', status: 'failed', runnerId: 'runner_old', sessionId: 'session_old', instanceId: 'claude-sonnet-high', markdown: 'Agent result', absolutePath: '/private/result.md' }],
          followupTargets: [{ id: 'target_old', kind: 'agent-result', stepId: 'execute', runnerId: 'runner_old', sessionId: 'session_old', defaultMode: 'follow-up-thread' }],
          followupArtifacts: [{ id: 'artifact_summary', kind: 'workflow-summary', label: 'Workflow summary', sizeBytes: 9, absolutePath: '/private/summary.md' }],
        },
      })
    }
    if (url.pathname === '/api/runs/run_test/artifacts/artifact_summary') {
      return json(response, 200, {
        artifact: { runId: 'run_test', artifactId: 'artifact_summary', contentType: 'image/png', sizeBytes: 3, encoding: 'base64', content: 'AQID' },
      })
    }
    if (url.pathname === '/api/runs/run_test/events.json') {
      return json(response, 200, {
        run: currentRun,
        events: Number(url.searchParams.get('since') || 0) < 1
          ? [{ seq: 1, eventId: 'run_test:1', type: 'agent_failed', at: '2026-08-08T00:01:00.000Z', runId: 'run_test', stepId: 'execute', agent: 'claude', runnerId: 'runner_old', sessionId: 'session_old', status: 'failed', path: '/private/result.md', token: TEST_TOKEN }]
          : [],
        errors: [],
      })
    }
    if (url.pathname === '/api/runs/run_test/cancel') {
      currentRun = runFixture('cancelled')
      return json(response, 200, { run: currentRun, cancelled: true, warnings: [] })
    }
    if (url.pathname === '/api/runs/run_test/agents/cancel') {
      currentRun = runFixture('cancelled')
      return json(response, 200, { run: currentRun, cancelled: true, warnings: [] })
    }
    if (url.pathname === '/api/runs/run_test/retry') {
      currentRun = runFixture('running', 'runner_new')
      return json(response, 202, { run: currentRun, retried: true, previousRunnerId: 'runner_old', runnerId: 'runner_new', sessionId: 'session_new' })
    }
    if (url.pathname === '/api/runs/run_test/followups') {
      return json(response, 202, {
        sourceWorkflow: currentRun,
        submissions: [{ agent: 'claude', model: 'sonnet', effort: 'high', runnerId: 'runner_followup', sessionId: 'session_followup', status: 'submitted' }],
        warnings: [],
      })
    }
    if (url.pathname === '/api/runs/run_test/review/approve') {
      currentRun = runFixture('running')
      return json(response, 202, { run: currentRun, approved: true, stepId: 'human-review' })
    }
    return json(response, 404, { error: { statusCode: 404, code: 'not_found', message: 'Not found' } })
  }
}

/** @param {string | string[] | undefined} value */
function stringHeader(value) {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

/**
 * @param {import('node:test').TestContext} t
 * @param {(request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>} handler
 */
async function adapterFixture(t, handler) {
  const projectRoot = tempRoot()
  const registry = { tempDir: tempRoot(), userId: 'adapter-test-user', env: {} }
  const identity = ensureStableProjectIdentity(projectRoot, { projectId: 'project_adapter_test' })
  const server = await startLoopbackServer(handler)
  t.after(server.close)
  advertise({ projectRoot, projectId: identity.projectId, instanceId: 'instance_adapter_test', origin: server.origin, registry })
  return {
    projectRoot,
    projectId: identity.projectId,
    registry,
    server,
    client: createLocalDashboardClient({ projectRoot, registry, userId: 'runtime-user-test' }),
  }
}

test('local dashboard client authenticates reads and strips secrets and local paths', async (t) => {
  const observed = { requests: [] }
  const projectRoot = tempRoot()
  const identity = ensureStableProjectIdentity(projectRoot, { projectId: 'project_adapter_test' })
  const fixture = await adapterFixture(t, dashboardHandler(projectRoot, identity.projectId, observed, { canReadRunArtifacts: true }))
  // The fixture owns a different temporary root, so replace the first server with
  // a project-aware handler using the actual identity before making requests.
  await fixture.server.close()
  const server = await startLoopbackServer(dashboardHandler(fixture.projectRoot, fixture.projectId, observed, { canReadRunArtifacts: true }))
  t.after(server.close)
  advertise({ projectRoot: fixture.projectRoot, projectId: fixture.projectId, instanceId: 'instance_adapter_rebound', origin: server.origin, registry: fixture.registry })

  const context = await fixture.client.getContext()
  assert.equal(context.runtime, 'local-dashboard')
  assert.equal(context.scope.projectId, fixture.projectId)
  assert.equal(context.target?.siteId, 'site_test')
  assert.equal(context.target?.accountSlug, 'team-test')
  assert.equal(context.agentCatalog.providers[0]?.id, 'claude')
  assert.equal(context.capabilities.workflow_plan.available, false)
  assert.equal(context.capabilities.resource_read.available, true)
  assert.equal(JSON.stringify(context).includes('must-not-leak@example.com'), false)

  const workflows = await fixture.client.listWorkflows({ limit: 10 })
  assert.deepEqual(workflows.workflows.map((workflow) => workflow.workflowId), ['review-flow'])
  const workflow = await fixture.client.getWorkflow('review-flow', { includeGraph: true })
  assert.equal(workflow.graph?.nodes[0]?.data.promptPath, undefined)
  assert.equal(workflow.graph?.nodes[0]?.data.token, undefined)
  assert.equal(workflow.graph?.nodes[0]?.data.promptMarkdown, 'Do work')
  assert.equal(JSON.stringify(workflow).includes('/private/'), false)

  const details = await fixture.client.getRun('run_test', { view: 'details' })
  assert.equal(details.details?.summary, '# Summary')
  assert.match(details.details?.artifacts[0]?.resourceUri || '', /^nax:\/\/scopes\//)
  assert.equal(JSON.stringify(details).includes('/private/'), false)
  const artifact = await fixture.client.getArtifact('run_test', 'artifact_summary')
  assert.equal(artifact.contentType, 'image/png')
  assert.deepEqual([.../** @type {Uint8Array} */ (artifact.content)], [1, 2, 3])
  const events = await fixture.client.getRun('run_test', { view: 'events', since: '0', limit: 10 })
  assert.equal(events.events?.events[0]?.data?.path, undefined)
  assert.equal(events.events?.events[0]?.data?.token, undefined)
  assert.equal(observed.requests.every((request) => request.token === TEST_TOKEN), true)

  await assert.rejects(
    fixture.client.createWorkflowPlan({ workflowId: 'review-flow' }),
    /** @param {unknown} error */ (error) => error instanceof LocalDashboardAdapterError && error.code === 'unsupported_capability',
  )
})

test('local dashboard mutations resolve exact opaque targets before posting', async (t) => {
  const observed = { requests: [] }
  const projectRoot = tempRoot()
  const identity = ensureStableProjectIdentity(projectRoot, { projectId: 'project_mutation_test' })
  const registry = { tempDir: tempRoot(), userId: 'adapter-test-user', env: {} }
  const server = await startLoopbackServer(dashboardHandler(projectRoot, identity.projectId, observed))
  t.after(server.close)
  advertise({ projectRoot, projectId: identity.projectId, instanceId: 'instance_mutation_test', origin: server.origin, registry })
  const client = createLocalDashboardClient({ projectRoot, registry, userId: 'runtime-user-test' })

  const read = await client.getRun('run_test', { view: 'summary' })
  const agentRunId = read.run.agentRuns?.[0]?.agentRunId || ''
  const reviewGateId = read.run.reviewGate?.reviewGateId || ''
  assert.match(agentRunId, /^agent_run_/)
  assert.match(reviewGateId, /^review_gate_/)

  const retry = await client.retryAgentRun({ runId: 'run_test', agentRunId, requestId: 'request_retry_test' })
  assert.equal(retry.previousAgentRunId, agentRunId)
  assert.equal(retry.agentRun.runnerId, 'runner_new')
  const retryRequest = observed.requests.find((request) => request.path === '/api/runs/run_test/retry')
  assert.deepEqual(retryRequest?.body, {
    agentRunId,
    stepId: 'execute',
    agent: 'claude',
    runnerId: 'runner_old',
    sessionId: 'session_old',
    requestId: 'request_retry_test',
    reason: 'MCP agent_run_retry',
  })

  // Use a fresh fixture state for follow-up and review targeting because retry
  // intentionally replaced the old opaque agent-run identity.
  await server.close()
  const freshServer = await startLoopbackServer(dashboardHandler(projectRoot, identity.projectId, observed))
  t.after(freshServer.close)
  advertise({ projectRoot, projectId: identity.projectId, instanceId: 'instance_mutation_fresh', origin: freshServer.origin, registry })
  const freshRead = await client.getRun('run_test', { view: 'summary' })
  const freshAgentRunId = freshRead.run.agentRuns?.[0]?.agentRunId || ''
  const followup = await client.submitFollowup({
    runId: 'run_test',
    agentRunId: freshAgentRunId,
    requestId: 'request_followup_test',
    prompt: 'Continue the review',
    artifactIds: ['artifact_summary'],
  })
  assert.equal(followup.agentRuns[0]?.runnerId, 'runner_followup')
  const followupRequest = observed.requests.find((request) => request.path === '/api/runs/run_test/followups')
  assert.equal(followupRequest?.body.targetId, 'target_old')
  assert.deepEqual(followupRequest?.body.artifacts, [{ id: 'artifact_summary', kind: 'workflow-summary' }])
  assert.equal(followupRequest?.body.agentRunId, freshAgentRunId)
  assert.deepEqual(followupRequest?.body.artifactIds, ['artifact_summary'])
  assert.deepEqual(followupRequest?.body.instances, [{ agent: 'claude', model: 'sonnet', effort: 'high' }])

  const review = await client.resolveReviewGate({ runId: 'run_test', reviewGateId: freshRead.run.reviewGate?.reviewGateId || '', decision: 'approve' })
  assert.equal(review.reviewGate.status, 'approved')
  assert.equal(observed.requests.find((request) => request.path === '/api/runs/run_test/review/approve')?.body.stepId, 'human-review')
})

test('local dashboard adapter forwards planning and idempotent start application requests', async (t) => {
  const observed = { requests: [] }
  const projectRoot = tempRoot()
  const identity = ensureStableProjectIdentity(projectRoot, { projectId: 'project_planning_test' })
  const registry = { tempDir: tempRoot(), userId: 'adapter-test-user', env: {} }
  const server = await startLoopbackServer(dashboardHandler(projectRoot, identity.projectId, observed, { canPlanRuns: true }))
  t.after(server.close)
  advertise({ projectRoot, projectId: identity.projectId, instanceId: 'instance_planning_test', origin: server.origin, registry })
  const client = createLocalDashboardClient({ projectRoot, registry, userId: 'runtime-user-test' })

  const workflow = await client.createWorkflowPlan({
    workflowId: 'review-flow',
    branch: 'main',
    instances: [{ agent: 'claude', model: 'sonnet', effort: 'high' }],
    context: 'Focus.',
  })
  const agent = await client.createAgentRunPlan({ prompt: 'Audit.', instance: { agent: 'claude' }, branch: 'main' })
  const started = await client.startPlan(workflow.planId, 'request_planning_test')

  assert.equal(workflow.planId, 'plan_workflow_test')
  assert.equal(agent.planId, 'plan_agent_test')
  assert.equal(started.run.runId, 'run_planned')
  assert.deepEqual(observed.requests.find((request) => request.path === '/api/run-plans/workflows/review-flow')?.body, {
    branch: 'main',
    instances: [{ agent: 'claude', model: 'sonnet', effort: 'high' }],
    context: 'Focus.',
  })
  assert.deepEqual(observed.requests.find((request) => request.path === '/api/run-plans/agents')?.body, {
    prompt: 'Audit.',
    instance: { agent: 'claude' },
    branch: 'main',
  })
  assert.deepEqual(observed.requests.find((request) => request.path === '/api/run-plans/plan_workflow_test/start')?.body, {
    requestId: 'request_planning_test',
  })
})

test('client rediscovers a restarted dashboard before the next operation', async (t) => {
  const projectRoot = tempRoot()
  const registry = { tempDir: tempRoot(), userId: 'adapter-test-user', env: {} }
  const identity = ensureStableProjectIdentity(projectRoot, { projectId: 'project_restart_test' })
  let firstHits = 0
  let secondHits = 0
  const first = await startLoopbackServer((request, response) => {
    firstHits += 1
    if (request.url === '/api/health') return json(response, 200, health(identity.projectId, projectRoot))
    return json(response, 200, { count: 0, items: [] })
  })
  t.after(first.close)
  advertise({ projectRoot, projectId: identity.projectId, instanceId: 'instance_restart_first', origin: first.origin, registry })
  const client = createLocalDashboardClient({ projectRoot, registry, userId: 'runtime-user-test' })
  await client.listWorkflows({})

  await first.close()
  const second = await startLoopbackServer((request, response) => {
    secondHits += 1
    if (request.url === '/api/health') return json(response, 200, health(identity.projectId, projectRoot))
    return json(response, 200, { count: 0, items: [] })
  })
  t.after(second.close)
  advertise({ projectRoot, projectId: identity.projectId, instanceId: 'instance_restart_second', origin: second.origin, registry })
  await client.listWorkflows({})

  assert.equal(firstHits, 2)
  assert.equal(secondHits, 2)
})

test('adapter returns bounded structured failures without leaking its token', async (t) => {
  let mode = 'error'
  const fixture = await adapterFixture(t, async (request, response) => {
    if (request.url === '/api/health') {
      const projectRoot = fixture.projectRoot
      return json(response, 200, health(fixture.projectId, projectRoot))
    }
    if (mode === 'error') return json(response, 409, { error: { statusCode: 409, code: 'fixture_conflict', message: `Conflict ${TEST_TOKEN}` } })
    if (mode === 'malformed') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{')
      return
    }
    if (mode === 'large') {
      const body = JSON.stringify({ items: [{ description: 'x'.repeat(4096) }] })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    return json(response, 200, { count: 0, items: [] })
  })

  await assert.rejects(fixture.client.listWorkflows({}), /** @param {unknown} error */ (error) => {
    assert.equal(error instanceof LocalDashboardAdapterError && error.code === 'fixture_conflict', true)
    assert.doesNotMatch(String(error), new RegExp(TEST_TOKEN))
    return true
  })
  mode = 'malformed'
  await assert.rejects(fixture.client.listWorkflows({}), /** @param {unknown} error */ (error) => error instanceof LocalDashboardAdapterError && error.code === 'dashboard_malformed_response')

  const largeClient = createLocalDashboardClient({ projectRoot: fixture.projectRoot, registry: fixture.registry, userId: 'runtime-user-test', maxResponseBytes: 512 })
  mode = 'large'
  await assert.rejects(largeClient.listWorkflows({}), /** @param {unknown} error */ (error) => error instanceof LocalDashboardAdapterError && error.code === 'dashboard_response_too_large')

  const timeoutClient = createLocalDashboardClient({ projectRoot: fixture.projectRoot, registry: fixture.registry, userId: 'runtime-user-test', requestTimeoutMs: 10 })
  mode = 'timeout'
  await assert.rejects(timeoutClient.listWorkflows({}), /** @param {unknown} error */ (error) => error instanceof LocalDashboardAdapterError && error.code === 'dashboard_timeout')
})

test('control plane rejects a caller-supplied actor or project scope', async () => {
  const projectRoot = tempRoot()
  const binding = composeLocalDashboardControlPlane({ projectRoot, registry: { tempDir: tempRoot(), userId: 'adapter-test-user', env: {} }, userId: 'runtime-user-test' })
  await assert.rejects(
    binding.controlPlane.getContext({ ...binding.scope, projectId: 'project_wrong' }, binding.actor),
    /** @param {unknown} error */ (error) => error instanceof LocalDashboardAdapterError && error.code === 'scope_forbidden',
  )
  await assert.rejects(
    binding.controlPlane.getContext(binding.scope, { ...binding.actor, actorId: 'actor_wrong' }),
    /** @param {unknown} error */ (error) => error instanceof LocalDashboardAdapterError && error.code === 'scope_forbidden',
  )
})
