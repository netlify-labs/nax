const assert = require('node:assert/strict')
const test = require('node:test')

const { ACTIVITY_FOR_OPERATION, createNaxControlPlane } = require('../../src/control-plane/service')

/** @typedef {import('../../src/contracts').ControlPlaneAuthorizationRequest} ControlPlaneAuthorizationRequest */
/** @typedef {import('../../src/contracts').NaxControlPlanePorts} NaxControlPlanePorts */

const scope = {
  scopeId: 'scope_test',
  projectId: 'project_test',
  accountId: 'account_test',
  siteId: 'site_test',
}

const actor = {
  actorId: 'actor_test',
  kind: /** @type {const} */ ('local-session'),
  authenticated: true,
}

/**
 * @param {ControlPlaneAuthorizationRequest[]} authorizations
 * @returns {NaxControlPlanePorts}
 */
function testPorts(authorizations) {
  return {
    authorize(request) {
      authorizations.push(request)
    },
    async getContext(requestScope, requestActor) {
      return {
        runtime: 'local-dashboard',
        scope: requestScope,
        actor: requestActor,
        capabilities: /** @type {import('../../src/contracts').ControlPlaneCapabilities} */ ({}),
        agentCatalog: { provenance: { source: 'test', commit: 'test', syncedAt: '2026-08-08T00:00:00.000Z' }, providers: [] },
        target: null,
        currentBranch: 'main',
        branches: ['main'],
      }
    },
    async listWorkflows() {
      return { workflows: [], nextCursor: null }
    },
    async getWorkflow(_scope, _actor, workflowId) {
      return {
        workflow: {
          workflowId,
          title: 'Review',
          description: 'Review changes',
          source: 'builtin',
          sourceLabel: 'Built in',
          stepCount: 0,
          agents: [],
          defaults: {},
          options: {},
          steps: [],
        },
      }
    },
    async createWorkflowPlan(requestScope, _actor, input) {
      return planFixture(requestScope, 'workflow', input.workflowId)
    },
    async createAgentRunPlan(requestScope) {
      return planFixture(requestScope, 'agent-run')
    },
    async startPlan(_scope, _actor, planId) {
      return { run: runFixture(planId), accepted: true, replayed: false }
    },
    async listRuns() {
      return { runs: [], nextCursor: null }
    },
    async getRun(_scope, _actor, runId, options) {
      return { run: runFixture(runId), view: options.view }
    },
    async waitForRun(_scope, _actor, runId) {
      return { run: runFixture(runId), reason: 'timeout', events: [], nextCursor: '0' }
    },
    async cancelRun(_scope, _actor, target) {
      return { run: runFixture(target.runId), cancelled: true, agentRunId: target.agentRunId, warnings: [] }
    },
    async retryAgentRun(_scope, _actor, input) {
      return { run: runFixture(input.runId), previousAgentRunId: input.agentRunId, agentRun: agentRunFixture(input.runId, 'agent_retry'), replayed: false }
    },
    async submitFollowup(_scope, _actor, input) {
      return { sourceRunId: input.runId, run: runFixture(input.runId), agentRuns: [agentRunFixture(input.runId, 'agent_followup')], replayed: false, warnings: [] }
    },
    async resolveReviewGate(_scope, _actor, input) {
      return { run: runFixture(input.runId), reviewGate: { reviewGateId: input.reviewGateId, runId: input.runId, stepId: 'review', status: input.decision === 'approve' ? 'approved' : 'cancelled' }, replayed: false }
    },
    async getArtifact(_scope, _actor, runId, artifactId) {
      return { runId, artifactId, contentType: 'text/plain', sizeBytes: 2, content: 'ok' }
    },
  }
}

/**
 * @param {import('../../src/contracts').ControlPlaneScope} requestScope
 * @param {'workflow' | 'agent-run'} kind
 * @param {string} [workflowId]
 * @returns {import('../../src/contracts').ControlPlanePlan}
 */
function planFixture(requestScope, kind, workflowId) {
  return {
    planId: `plan_${kind}`,
    kind,
    status: 'prepared',
    scope: requestScope,
    target: { siteId: 'site_test', siteName: 'Test site', branch: 'main', verified: true, caveats: [] },
    expiresAt: '2026-08-08T00:10:00.000Z',
    workflowId,
    steps: [],
    instances: [],
    expectedAgentRuns: 1,
    warnings: [],
    summary: 'Ready',
  }
}

/** @param {string} runId */
function runFixture(runId) {
  return { runId, status: 'running' }
}

/** @param {string} runId @param {string} agentRunId */
function agentRunFixture(runId, agentRunId) {
  return { agentRunId, runId, agent: 'claude', status: 'running' }
}

test('control plane authorizes every operation before delegation', async () => {
  /** @type {ControlPlaneAuthorizationRequest[]} */
  const authorizations = []
  const controlPlane = createNaxControlPlane(testPorts(authorizations))

  await controlPlane.getContext(scope, actor)
  await controlPlane.listWorkflows(scope, actor, {})
  await controlPlane.getWorkflow(scope, actor, 'review')
  await controlPlane.createWorkflowPlan(scope, actor, { workflowId: 'review' })
  await controlPlane.createAgentRunPlan(scope, actor, { prompt: 'Review', instance: { agent: 'claude' } })
  await controlPlane.startPlan(scope, actor, 'plan_workflow', 'request_start')
  await controlPlane.listRuns(scope, actor, {})
  await controlPlane.getRun(scope, actor, 'run_test', { view: 'summary' })
  await controlPlane.waitForRun(scope, actor, 'run_test', '0', 10)
  await controlPlane.cancelRun(scope, actor, { runId: 'run_test' })
  await controlPlane.retryAgentRun(scope, actor, { runId: 'run_test', agentRunId: 'agent_old', requestId: 'request_retry' })
  await controlPlane.submitFollowup(scope, actor, { runId: 'run_test', agentRunId: 'agent_old', requestId: 'request_followup', prompt: 'Continue' })
  await controlPlane.resolveReviewGate(scope, actor, { runId: 'run_test', reviewGateId: 'gate_test', decision: 'approve' })
  await controlPlane.getArtifact(scope, actor, 'run_test', 'artifact_test')

  assert.deepEqual(authorizations.map((request) => request.operation), [
    'getContext',
    'listWorkflows',
    'getWorkflow',
    'createWorkflowPlan',
    'createAgentRunPlan',
    'startPlan',
    'listRuns',
    'getRun',
    'waitForRun',
    'cancelRun',
    'retryAgentRun',
    'submitFollowup',
    'resolveReviewGate',
    'getArtifact',
  ])
  assert.equal(authorizations.every((request) => request.scope === scope && request.actor === actor), true)
  assert.deepEqual(authorizations.at(-1)?.target, { kind: 'artifact', id: 'artifact_test', parentId: 'run_test' })
})

test('control plane rejects missing, unstable, or unauthenticated invocation identity', async () => {
  const controlPlane = createNaxControlPlane(testPorts([]))

  await assert.rejects(controlPlane.getContext({ ...scope, scopeId: '' }, actor), /scope\.scopeId/)
  await assert.rejects(controlPlane.getContext({ ...scope, projectId: '' }, actor), /scope\.projectId/)
  await assert.rejects(controlPlane.getContext(scope, { ...actor, actorId: '' }), /actor\.actorId/)
  await assert.rejects(controlPlane.getContext(scope, { ...actor, authenticated: false }), /actor must be authenticated/)
})

test('control plane fails composition when a required port is absent', () => {
  const ports = testPorts([])
  delete /** @type {Partial<NaxControlPlanePorts>} */ (ports).getArtifact
  assert.throws(() => createNaxControlPlane(ports), /getArtifact/)
})

test('control plane stops before delegation when authorization fails', async () => {
  const ports = testPorts([])
  let delegated = false
  ports.authorize = async () => {
    throw new Error('scope_forbidden')
  }
  ports.listRuns = async () => {
    delegated = true
    return { runs: [], nextCursor: null }
  }

  const controlPlane = createNaxControlPlane(ports)
  await assert.rejects(controlPlane.listRuns(scope, actor, {}), /scope_forbidden/)
  assert.equal(delegated, false)
})

test('control plane emits value-free activity audits for success and failure', async () => {
  /** @type {import('../../src/contracts').ControlPlaneAuditEvent[]} */
  const audits = []
  const ports = testPorts([])
  let clock = 100
  ports.audit = { record(event) { audits.push(event) } }
  ports.auditContext = { runtime: 'hosted', clientName: 'fixture-client', clientVersion: '1.2.3' }
  ports.auditNow = () => new Date('2026-08-08T12:00:00.000Z')
  ports.auditClock = () => { clock += 5; return clock }
  const controlPlane = createNaxControlPlane(ports)

  await controlPlane.createWorkflowPlan(scope, actor, {
    workflowId: 'security-review',
    context: 'Bearer must-not-enter-audit',
  })
  await controlPlane.startPlan(scope, actor, 'plan_workflow', 'request_start')
  await controlPlane.submitFollowup(scope, actor, {
    runId: 'run_test',
    agentRunId: 'agent_old',
    requestId: 'request_followup',
    prompt: 'secret result text must not enter audit',
  })
  ports.getRun = async () => { throw Object.assign(new Error('Bearer sensitive-value'), { code: 'run_failed' }) }
  await assert.rejects(controlPlane.getRun(scope, actor, 'run_failed', { view: 'summary' }), /sensitive-value/)

  assert.deepEqual(audits.map((event) => event.activity), [
    'workflow_plan', 'run_start', 'agent_run_followup', 'run_get',
  ])
  assert.equal(audits[0].workflowId, 'security-review')
  assert.equal(audits[0].expectedAgentRuns, 1)
  assert.equal(audits[1].planId, 'plan_workflow')
  assert.equal(audits[1].requestId, 'request_start')
  assert.equal(audits[2].createdAgentRuns, 1)
  assert.equal(audits[3].ok, false)
  assert.equal(audits[3].errorCode, 'run_failed')
  assert.equal(audits.every((event) => event.runtime === 'hosted' && event.durationMs === 5), true)
  const serialized = JSON.stringify(audits)
  assert.doesNotMatch(serialized, /must-not-enter|secret result|sensitive-value|Bearer/)
  assert.deepEqual(Object.keys(ACTIVITY_FOR_OPERATION), [
    'getContext', 'listWorkflows', 'getWorkflow', 'createWorkflowPlan', 'createAgentRunPlan', 'startPlan', 'listRuns', 'getRun', 'waitForRun', 'cancelRun', 'retryAgentRun', 'submitFollowup', 'resolveReviewGate', 'getArtifact',
  ])
})

test('control plane audit sink failure never changes the application result', async () => {
  const ports = testPorts([])
  ports.audit = { record() { throw new Error('disk unavailable') } }
  const controlPlane = createNaxControlPlane(ports)
  assert.deepEqual(await controlPlane.listRuns(scope, actor, {}), { runs: [], nextCursor: null })
})
