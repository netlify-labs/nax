const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createDashboardRunPlanService } = require('../../src/dashboard/services/run-plans')
const { createLocalRunPlanStore } = require('../../src/dashboard/storage/local-run-plans')

const scope = { scopeId: 'scope_test', projectId: 'project_test' }
/** @type {import('../../src/contracts').ControlPlaneActor} */
const actor = { actorId: 'actor_test', kind: 'local-session', authenticated: true }
const target = { siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] }
const flow = {
  id: 'review',
  title: 'Review',
  steps: [{ id: 'audit', title: 'Audit', action: 'issue', submit: 'new-run', waitFor: 'agent-results', agents: ['claude'], prompt: 'Audit.' }],
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-plan-service-'))
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

/** @param {{ now?: () => Date, actorOverride?: typeof actor, backend?: import('../../src/contracts').WorkflowExecutionBackend }} [options] */
function fixture(options = {}) {
  const root = tempRoot()
  const store = createLocalRunPlanStore({ projectRoot: root, now: options.now })
  let nextId = 0
  let starts = 0
  const backend = options.backend || {
    async startPlan() {
      starts += 1
      return { run: { runId: 'run_test', workflowId: 'review', status: 'running' }, accepted: true, replayed: false }
    },
    async reconcilePlan(plan) {
      return plan.runId ? { run: { runId: plan.runId, workflowId: 'review', status: 'running' }, accepted: false, replayed: true } : null
    },
  }
  const service = createDashboardRunPlanService({
    store,
    executionBackend: backend,
    workflowStore: { loadWorkflow: async () => flow },
    scope,
    actor: options.actorOverride || actor,
    createPlanId: () => `plan_${++nextId}`,
    resolveTarget: async (branch) => ({ ...target, branch: branch || target.branch }),
    now: options.now,
  })
  return { service, store, starts: () => starts }
}

test('dashboard run-plan service plans without executing and keeps stored inputs private', async () => {
  const { service, store, starts } = fixture({ now: () => new Date('2026-08-08T12:00:00.000Z') })
  const plan = await service.createWorkflowPlan('review', {
    branch: 'main',
    stepInstances: { audit: [{ agent: 'claude', model: 'claude-opus-4-1', effort: 'high', label: 'deep' }] },
    context: 'Focus on auth.',
  })
  assert.equal(starts(), 0)
  assert.equal(plan.planId, 'plan_1')
  assert.equal(plan.expectedAgentRuns, 1)
  assert.equal(plan.steps[0].instances[0].label, 'deep')
  assert.equal('normalizedInput' in plan, false)
  assert.equal((await store.get(plan.planId))?.normalizedInput.context, 'Focus on auth.')
})

test('dashboard run-plan service starts once and replays the durable binding', async () => {
  const { service, starts } = fixture({ now: () => new Date('2026-08-08T12:00:00.000Z') })
  const plan = await service.createAgentRunPlan({ prompt: 'Audit.', instance: { agent: 'claude' }, branch: 'main' })
  const first = await service.startPlan(plan.planId, { requestId: 'request_1' })
  const replay = await service.startPlan(plan.planId, { requestId: 'request_1' })
  assert.equal(first.run.runId, 'run_test')
  assert.equal(replay.run.runId, 'run_test')
  assert.equal(replay.replayed, true)
  assert.equal(starts(), 1)
})

test('dashboard run-plan service rejects start overrides, expiration, and foreign actors', async () => {
  let current = new Date('2026-08-08T12:00:00.000Z')
  const { service, store } = fixture({ now: () => current })
  const plan = await service.createAgentRunPlan({ prompt: 'Audit.', instance: { agent: 'claude' } })
  await assert.rejects(() => service.startPlan(plan.planId, { requestId: 'request_1', branch: 'other' }), (error) => errorCode(error) === 'invalid_arguments')
  current = new Date('2026-08-08T12:11:00.000Z')
  await assert.rejects(() => service.startPlan(plan.planId, { requestId: 'request_1' }), (error) => errorCode(error) === 'run_plan_expired')

  const foreign = createDashboardRunPlanService({
    store,
    executionBackend: { startPlan: async () => { throw new Error('not called') }, reconcilePlan: async () => null },
    workflowStore: { loadWorkflow: async () => flow },
    scope,
    actor: { ...actor, actorId: 'actor_foreign' },
    createPlanId: () => 'plan_foreign',
    resolveTarget: async () => target,
    now: () => current,
  })
  await assert.rejects(() => foreign.getPlan(plan.planId), (error) => errorCode(error) === 'scope_forbidden')
})
