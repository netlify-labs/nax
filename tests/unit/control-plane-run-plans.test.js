const assert = require('node:assert/strict')
const test = require('node:test')

const {
  reconcileStalePlans,
  startStoredPlan,
  storedPlanFromPrepared,
} = require('../../src/control-plane/run-plans')
const { prepareAgentRunPlan } = require('../../src/control-plane/planner')

const NOW = new Date('2026-08-08T12:00:00.000Z')

/** @returns {import('../../src/contracts').ControlPlaneScope} */
function scopeFixture() {
  return { scopeId: 'scope_test', projectId: 'project_test', accountId: 'account_test', siteId: 'site_test' }
}

/** @returns {import('../../src/contracts').ControlPlaneActor} */
function actorFixture() {
  return { actorId: 'actor_test', kind: 'local-session', authenticated: true }
}

/** @returns {import('../../src/contracts').ControlPlaneTarget} */
function targetFixture() {
  return { accountId: 'account_test', siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] }
}

/** @param {string} [planId] @param {Date} [now] */
function storedFixture(planId = 'plan_01', now = NOW) {
  const prepared = prepareAgentRunPlan({ planId, now, scope: scopeFixture(), target: targetFixture(), input: { prompt: 'Audit.', instance: { agent: 'claude' } } })
  return storedPlanFromPrepared(prepared, 'actor_test', now)
}

/** @param {import('../../src/contracts').StoredControlPlanePlan[]} initial */
function memoryStore(initial) {
  const plans = new Map(initial.map((plan) => [plan.planId, structuredClone(plan)]))
  return /** @type {import('../../src/contracts').ControlPlaneRunPlanStore} */ ({
    create: async (plan) => { plans.set(plan.planId, structuredClone(plan)); return structuredClone(plan) },
    get: async (planId) => structuredClone(plans.get(planId) || null),
    claimStart: async (planId, requestId, expectedStatus) => {
      const plan = plans.get(planId)
      if (!plan || plan.status !== expectedStatus) return null
      const next = { ...plan, status: /** @type {const} */ ('starting'), requestId, updatedAt: NOW.toISOString() }
      delete next.failure
      plans.set(planId, next)
      return structuredClone(next)
    },
    bindStarted: async (planId, requestId, runId) => {
      const plan = plans.get(planId)
      if (!plan || plan.requestId !== requestId) throw Object.assign(new Error('conflict'), { code: 'idempotency_conflict' })
      const next = { ...plan, status: /** @type {const} */ ('started'), runId, updatedAt: NOW.toISOString() }
      delete next.failure
      plans.set(planId, next)
      return structuredClone(next)
    },
    markFailed: async (planId, requestId, failure) => {
      const plan = plans.get(planId)
      if (!plan || plan.requestId !== requestId) throw new Error('conflict')
      const next = { ...plan, status: /** @type {const} */ ('failed'), failure, updatedAt: NOW.toISOString() }
      plans.set(planId, next)
      return structuredClone(next)
    },
    listStaleStarting: async (before) => [...plans.values()].filter((plan) => plan.status === 'starting' && plan.updatedAt <= before).map((plan) => structuredClone(plan)),
  })
}

/** @param {{ delay?: Promise<void>, failure?: Error & { mutationTransmitted?: boolean }, reconcileRunId?: string }} [options] */
function backendFixture({ delay, failure, reconcileRunId } = {}) {
  let starts = 0
  return {
    get starts() { return starts },
    async startPlan(plan) {
      starts += 1
      if (delay) await delay
      if (failure) throw failure
      return { run: { runId: `run_${plan.planId}`, status: 'running' }, accepted: true, replayed: false }
    },
    async reconcilePlan(plan) {
      const runId = reconcileRunId || plan.runId
      return runId ? { run: { runId, status: 'running' }, accepted: false, replayed: true } : null
    },
  }
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

test('start state machine claims, executes, binds, and replays one durable run', async () => {
  const store = memoryStore([storedFixture()])
  const backend = backendFixture()
  const input = { store, executionBackend: backend, scope: scopeFixture(), actor: actorFixture(), target: targetFixture(), planId: 'plan_01', requestId: 'request_01', now: NOW }
  const started = await startStoredPlan(input)
  const replayed = await startStoredPlan(input)
  assert.equal(started.run.runId, 'run_plan_01')
  assert.equal(replayed.run.runId, 'run_plan_01')
  assert.equal(replayed.replayed, true)
  assert.equal(backend.starts, 1)
  assert.equal((await store.get('plan_01'))?.status, 'started')
})

test('concurrent starts use one compare-and-set winner', async () => {
  /** @type {(value?: void) => void} */
  let release = () => {}
  const delay = new Promise((resolve) => { release = resolve })
  const store = memoryStore([storedFixture()])
  const backend = backendFixture({ delay })
  const input = { store, executionBackend: backend, scope: scopeFixture(), actor: actorFixture(), target: targetFixture(), planId: 'plan_01', requestId: 'request_01', now: NOW, waitMs: 1000, pollMs: 1 }
  const first = startStoredPlan(input)
  await new Promise((resolve) => setImmediate(resolve))
  const second = startStoredPlan(input)
  release()
  const results = await Promise.all([first, second])
  assert.equal(results[0].run.runId, results[1].run.runId)
  assert.equal(backend.starts, 1)
})

test('expiry, scope, actor, and request bindings fail closed', async () => {
  const backend = backendFixture()
  const expiredStore = memoryStore([storedFixture('plan_expired', new Date('2026-08-08T11:00:00.000Z'))])
  await assert.rejects(() => startStoredPlan({ store: expiredStore, executionBackend: backend, scope: scopeFixture(), actor: actorFixture(), target: targetFixture(), planId: 'plan_expired', requestId: 'request_01', now: NOW }), (error) => errorCode(error) === 'run_plan_expired')
  const store = memoryStore([storedFixture()])
  await assert.rejects(() => startStoredPlan({ store, executionBackend: backend, scope: { ...scopeFixture(), projectId: 'other' }, actor: actorFixture(), target: targetFixture(), planId: 'plan_01', requestId: 'request_01', now: NOW }), (error) => errorCode(error) === 'project_scope_mismatch')
  await assert.rejects(() => startStoredPlan({ store, executionBackend: backend, scope: scopeFixture(), actor: { ...actorFixture(), actorId: 'other' }, target: targetFixture(), planId: 'plan_01', requestId: 'request_01', now: NOW }), (error) => errorCode(error) === 'scope_forbidden')
  await assert.rejects(() => startStoredPlan({ store, executionBackend: backend, scope: scopeFixture(), actor: actorFixture(), target: { ...targetFixture(), branch: 'feature' }, planId: 'plan_01', requestId: 'request_01', now: NOW }), (error) => errorCode(error) === 'project_scope_mismatch')
})

test('only proven pre-transmission failures may execute again', async () => {
  const safeFailure = Object.assign(new Error('capacity before send'), { code: 'capacity', mutationTransmitted: false })
  const store = memoryStore([storedFixture()])
  await assert.rejects(() => startStoredPlan({ store, executionBackend: backendFixture({ failure: safeFailure }), scope: scopeFixture(), actor: actorFixture(), target: targetFixture(), planId: 'plan_01', requestId: 'request_01', now: NOW }))
  const recovered = await startStoredPlan({ store, executionBackend: backendFixture(), scope: scopeFixture(), actor: actorFixture(), target: targetFixture(), planId: 'plan_01', requestId: 'request_01', now: NOW })
  assert.equal(recovered.run.runId, 'run_plan_01')

  const ambiguous = memoryStore([storedFixture('plan_ambiguous')])
  await assert.rejects(() => startStoredPlan({ store: ambiguous, executionBackend: backendFixture({ failure: new Error('connection dropped') }), scope: scopeFixture(), actor: actorFixture(), target: targetFixture(), planId: 'plan_ambiguous', requestId: 'request_02', now: NOW }))
  const noReplayBackend = backendFixture()
  await assert.rejects(() => startStoredPlan({ store: ambiguous, executionBackend: noReplayBackend, scope: scopeFixture(), actor: actorFixture(), target: targetFixture(), planId: 'plan_ambiguous', requestId: 'request_02', now: NOW }), (error) => errorCode(error) === 'ambiguous_run_start')
  assert.equal(noReplayBackend.starts, 0)
})

test('stale starting plans reconcile without replaying execution', async () => {
  const starting = { ...storedFixture(), status: /** @type {const} */ ('starting'), requestId: 'request_01', updatedAt: '2026-08-08T11:00:00.000Z' }
  const store = memoryStore([starting])
  const backend = backendFixture({ reconcileRunId: 'run_reconciled' })
  const result = await reconcileStalePlans({ store, executionBackend: backend, before: new Date('2026-08-08T11:30:00.000Z') })
  assert.deepEqual(result, { reconciled: [{ planId: 'plan_01', runId: 'run_reconciled' }], unresolved: [] })
  assert.equal(backend.starts, 0)
  assert.equal((await store.get('plan_01'))?.runId, 'run_reconciled')
})

test('a crash while binding a transmitted run leaves starting state for later reconciliation', async () => {
  const durable = memoryStore([storedFixture()])
  let failBinding = true
  const store = {
    ...durable,
    async bindStarted(planId, requestId, runId) {
      if (failBinding) {
        failBinding = false
        throw new Error('simulated crash before durable binding')
      }
      return durable.bindStarted(planId, requestId, runId)
    },
  }
  const firstBackend = backendFixture()
  const input = { store, executionBackend: firstBackend, scope: scopeFixture(), actor: actorFixture(), target: targetFixture(), planId: 'plan_01', requestId: 'request_01', now: NOW }
  await assert.rejects(() => startStoredPlan(input), /simulated crash/)
  assert.equal((await store.get('plan_01'))?.status, 'starting')

  const replayBackend = backendFixture({ reconcileRunId: 'run_plan_01' })
  const replay = await startStoredPlan({ ...input, executionBackend: replayBackend, now: new Date('2026-08-08T12:01:00.000Z') })
  assert.equal(replay.run.runId, 'run_plan_01')
  assert.equal(firstBackend.starts, 1)
  assert.equal(replayBackend.starts, 0)
})
