const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { storedPlanFromPrepared } = require('../../src/control-plane/run-plans')
const { prepareAgentRunPlan } = require('../../src/control-plane/planner')
const { createLocalRunPlanStore, runPlanPath } = require('../../src/dashboard/storage/local-run-plans')

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-plans-'))
}

/** @param {string} planId @param {Date} now */
function planFixture(planId, now) {
  const scope = { scopeId: 'scope_test', projectId: 'project_test', siteId: 'site_test' }
  const target = { siteId: 'site_test', siteName: 'Test Site', branch: 'main', verified: true, caveats: [] }
  const prepared = prepareAgentRunPlan({ planId, now, scope, target, input: { prompt: 'Audit.', instance: { agent: 'claude' } } })
  return storedPlanFromPrepared(prepared, 'actor_test', now)
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

test('local run-plan store persists restart-safe state with private permissions', async () => {
  const root = tempRoot()
  let current = new Date('2026-08-08T12:00:00.000Z')
  const store = createLocalRunPlanStore({ projectRoot: root, now: () => current })
  await store.create(planFixture('plan_01', current))
  const claimed = await store.claimStart('plan_01', 'request_01', 'prepared')
  assert.equal(claimed?.status, 'starting')
  current = new Date('2026-08-08T12:00:01.000Z')
  await store.bindStarted('plan_01', 'request_01', 'run_01')

  const restarted = createLocalRunPlanStore({ projectRoot: root, now: () => current })
  assert.equal((await restarted.get('plan_01'))?.runId, 'run_01')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(runPlanPath(root, 'plan_01')).mode & 0o777, 0o600)
  }
})

test('separate local store instances produce one atomic start claimant', async () => {
  const root = tempRoot()
  const now = new Date('2026-08-08T12:00:00.000Z')
  const first = createLocalRunPlanStore({ projectRoot: root, now: () => now })
  const second = createLocalRunPlanStore({ projectRoot: root, now: () => now })
  await first.create(planFixture('plan_01', now))
  const claims = await Promise.all([
    first.claimStart('plan_01', 'request_01', 'prepared'),
    second.claimStart('plan_01', 'request_01', 'prepared'),
  ])
  assert.equal(claims.filter(Boolean).length, 1)
})

test('request IDs cannot be reused across durable plan identities', async () => {
  const root = tempRoot()
  const now = new Date('2026-08-08T12:00:00.000Z')
  const store = createLocalRunPlanStore({ projectRoot: root, now: () => now })
  await store.create(planFixture('plan_01', now))
  await store.create(planFixture('plan_02', now))
  await store.claimStart('plan_01', 'request_shared', 'prepared')
  await assert.rejects(() => store.claimStart('plan_02', 'request_shared', 'prepared'), (error) => errorCode(error) === 'idempotency_conflict')
})

test('local store rejects secrets, conflicting identities, traversal, and corrupt records', async () => {
  const root = tempRoot()
  const now = new Date('2026-08-08T12:00:00.000Z')
  const store = createLocalRunPlanStore({ projectRoot: root, now: () => now })
  const plan = planFixture('plan_01', now)
  await assert.rejects(() => store.create(/** @type {never} */ ({ ...plan, normalizedInput: { authToken: 'secret' } })), (error) => errorCode(error) === 'secret_field_rejected')
  await store.create(plan)
  await assert.rejects(() => store.create({ ...plan, requestHash: 'different' }), (error) => errorCode(error) === 'idempotency_conflict')
  await assert.rejects(() => store.get('../escape'), (error) => errorCode(error) === 'invalid_plan_id')
  fs.writeFileSync(runPlanPath(root, 'plan_bad'), '{broken')
  await assert.rejects(() => store.get('plan_bad'), (error) => errorCode(error) === 'plan_store_corrupt')
})

test('local store retains started bindings while pruning expired and failed payloads', async () => {
  const root = tempRoot()
  let current = new Date('2026-08-08T12:00:00.000Z')
  const store = createLocalRunPlanStore({ projectRoot: root, now: () => current })
  await store.create(planFixture('plan_expired', new Date('2026-08-08T10:00:00.000Z')))
  await store.create(planFixture('plan_failed', current))
  await store.claimStart('plan_failed', 'request_failed', 'prepared')
  await store.markFailed('plan_failed', 'request_failed', { code: 'before_send', message: 'Before send.', recoverable: true, details: { mutationTransmitted: false } })
  await store.create(planFixture('plan_started', current))
  await store.claimStart('plan_started', 'request_started', 'prepared')
  await store.bindStarted('plan_started', 'request_started', 'run_started')
  current = new Date('2026-08-08T13:00:00.000Z')
  assert.equal(await store.pruneExpired('2026-08-08T12:30:00.000Z'), 2)
  assert.equal(await store.get('plan_expired'), null)
  assert.equal(await store.get('plan_failed'), null)
  assert.equal((await store.get('plan_started'))?.runId, 'run_started')
})
