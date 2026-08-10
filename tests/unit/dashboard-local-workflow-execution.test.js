const assert = require('node:assert/strict')
const test = require('node:test')

const { createLocalWorkflowExecutionBackend } = require('../../src/dashboard/runtime/local-workflow-execution')

/** @param {unknown} error */
function errorHasNoMutation(error, code) {
  if (!error || typeof error !== 'object') return false
  const value = /** @type {Record<string, unknown>} */ (error)
  const details = value.details && typeof value.details === 'object' && !Array.isArray(value.details)
    ? /** @type {Record<string, unknown>} */ (value.details)
    : {}
  return value.code === code && details.mutationTransmitted === false
}

const basePlan = {
  planId: 'plan_test',
  kind: 'workflow',
  status: 'starting',
  scope: { scopeId: 'scope_test', projectId: 'project_test' },
  target: { siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] },
  expiresAt: '2026-08-08T12:10:00.000Z',
  workflowId: 'review',
  steps: [{
    stepId: 'audit',
    title: 'Audit',
    action: 'issue',
    submit: 'new-run',
    waitFor: 'agent-results',
    agents: ['claude'],
    instances: [{ agent: 'claude', model: 'claude-opus-4-1', effort: 'high', label: 'deep', instanceId: 'claude:claude-opus-4-1:high', resolvedFrom: 'pinned' }],
    reviewGate: false,
  }],
  instances: [{ agent: 'claude', model: 'claude-opus-4-1', effort: 'high', label: 'deep', instanceId: 'claude:claude-opus-4-1:high', resolvedFrom: 'pinned' }],
  expectedAgentRuns: 1,
  warnings: [],
  summary: 'Prepared.',
  actorId: 'actor_test',
  requestHash: 'hash',
  normalizedInput: { workflowId: 'review', branch: 'main', transport: 'netlify-api', context: 'Focus.' },
  createdAt: '2026-08-08T12:00:00.000Z',
  updatedAt: '2026-08-08T12:00:00.000Z',
  requestId: 'request_test',
}

test('local workflow backend starts the shared in-process engine and binds its durable event', async () => {
  const calls = []
  const backend = createLocalWorkflowExecutionBackend({
    projectRoot: '/repo',
    runWorkflowEngine: async (flowId, options) => {
      calls.push({ flowId, options })
      const runnerEventSink = typeof options.runnerEventSink === 'function' ? options.runnerEventSink : () => {}
      runnerEventSink({
        type: 'workflow_started',
        runId: 'run_test',
        flowId,
        flowTitle: 'Review',
        status: 'running',
        createdAt: '2026-08-08T12:00:00.000Z',
      })
    },
  })
  const result = await backend.startPlan(/** @type {import('../../src/contracts').StoredControlPlanePlan} */ (basePlan))
  assert.equal(result.run.runId, 'run_test')
  assert.equal(result.run.source, 'mcp')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].flowId, 'review')
  assert.equal(calls[0].options.transport, 'netlify-api')
  assert.equal(calls[0].options.controlPlane.planId, 'plan_test')
  assert.equal(calls[0].options.controlPlaneTarget.siteId, 'site_test')
  assert.deepEqual(calls[0].options.controlPlaneLineups.audit, [{ agent: 'claude', model: 'claude-opus-4-1', effort: 'high', label: 'deep' }])
  assert.deepEqual(calls[0].options.controlPlaneSelectedSteps, ['audit'])
})

test('local workflow backend submits an exact single-agent plan through the shared dashboard service', async () => {
  const calls = []
  const backend = createLocalWorkflowExecutionBackend({
    projectRoot: '/repo',
    submitAgentRun: async (input) => {
      calls.push(input)
      return { run: { runId: 'agent_run_test', flowId: 'agent-run', flowTitle: 'Claude agent run', status: 'submitted' } }
    },
  })
  const plan = {
    ...basePlan,
    kind: 'agent-run',
    workflowId: undefined,
    normalizedInput: { prompt: 'Audit auth.', instance: { agent: 'claude', model: 'claude-opus-4-1', effort: 'high' }, branch: 'main', transport: 'netlify-api' },
  }
  const result = await backend.startPlan(/** @type {import('../../src/contracts').StoredControlPlanePlan} */ (plan))
  assert.equal(result.run.runId, 'agent_run_test')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].siteId, 'site_test')
  assert.deepEqual(calls[0].body.models, { claude: 'claude-opus-4-1' })
  assert.deepEqual(calls[0].body.efforts, { claude: 'high' })
  assert.equal(calls[0].source.planId, 'plan_test')
  assert.equal(calls[0].target.branch, 'main')
})

test('local workflow backend reconciles restart state by saved plan metadata', async () => {
  const backend = createLocalWorkflowExecutionBackend({
    projectRoot: '/repo',
    listRuns: () => [{
      runId: 'run_restarted',
      flowId: 'review',
      flowTitle: 'Review',
      status: 'running',
      branch: 'main',
      source: { type: 'mcp', planId: 'plan_test' },
    }],
  })
  const result = await backend.reconcilePlan(/** @type {import('../../src/contracts').StoredControlPlanePlan} */ (basePlan))
  assert.equal(result?.run.runId, 'run_restarted')
  assert.equal(result?.replayed, true)
})

test('local workflow backend rejects active duplicates before invoking the engine', async () => {
  let invoked = false
  const backend = createLocalWorkflowExecutionBackend({
    projectRoot: '/repo',
    listRuns: () => [{ runId: 'run_existing', flowId: 'review', status: 'running' }],
    runWorkflowEngine: async () => { invoked = true },
  })
  await assert.rejects(
    () => backend.startPlan(/** @type {import('../../src/contracts').StoredControlPlanePlan} */ (basePlan)),
    /** @param {unknown} error */ (error) => errorHasNoMutation(error, 'duplicate_run'),
  )
  assert.equal(invoked, false)
})

test('local workflow backend proves no mutation when the engine exits before durable start', async () => {
  const backend = createLocalWorkflowExecutionBackend({
    projectRoot: '/repo',
    runWorkflowEngine: async () => {},
  })
  await assert.rejects(
    () => backend.startPlan(/** @type {import('../../src/contracts').StoredControlPlanePlan} */ (basePlan)),
    /** @param {unknown} error */ (error) => errorHasNoMutation(error, 'run_binding_missing'),
  )
})
