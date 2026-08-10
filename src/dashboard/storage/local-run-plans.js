const fs = require('node:fs')
const path = require('node:path')

/** @typedef {import('../../contracts').ControlPlaneErrorShape} ControlPlaneErrorShape */
/** @typedef {import('../../contracts').ControlPlaneRunPlanStore} ControlPlaneRunPlanStore */
/** @typedef {import('../../contracts').StoredControlPlanePlan} StoredControlPlanePlan */

const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,254}$/
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?key|authorization|cookie|password|secret|token)(?:$|[_-])|(?:apiKey|authToken|accessToken|refreshToken|sessionToken)$/i
const DEFAULT_LOCK_TIMEOUT_MS = 5000
const DEFAULT_LOCK_STALE_MS = 30000

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function storeError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, recoverable: true, details })
}

/** @param {string} projectRoot */
function runPlanDirectory(projectRoot) {
  return path.join(path.resolve(projectRoot), '.nax', 'control-plane', 'plans')
}

/** @param {string} planId */
function assertPlanId(planId) {
  if (!PLAN_ID_PATTERN.test(String(planId || '')) || planId.includes('..')) throw storeError('invalid_plan_id', 'Plan ID must be one concrete opaque identifier.')
  return planId
}

/** @param {string} projectRoot @param {string} planId */
function runPlanPath(projectRoot, planId) {
  return path.join(runPlanDirectory(projectRoot), `${assertPlanId(planId)}.json`)
}

/** @param {unknown} value @param {string} [key] @param {number} [depth] */
function assertSecretFree(value, key = '', depth = 0) {
  if (SECRET_KEY_PATTERN.test(key)) throw storeError('secret_field_rejected', `Run plans cannot persist credential field "${key}".`)
  if (depth > 20 || !value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const entry of value) assertSecretFree(entry, key, depth + 1)
    return
  }
  for (const [childKey, child] of Object.entries(value)) assertSecretFree(child, childKey, depth + 1)
}

/** @param {number} milliseconds */
function sleepSync(milliseconds) {
  const state = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(state, 0, 0, milliseconds)
}

/** @param {string} lockDir @param {number} staleMs */
function removeStaleLock(lockDir, staleMs) {
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs < staleMs) return false
    fs.rmSync(lockDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} dir
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 */
function acquireStoreLock(dir, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, staleMs = DEFAULT_LOCK_STALE_MS } = {}) {
  const lockDir = path.join(dir, '.store-lock')
  const started = Date.now()
  let delay = 5
  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 })
      let released = false
      return () => {
        if (released) return
        released = true
        fs.rmSync(lockDir, { recursive: true, force: true })
      }
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== 'EEXIST') throw error
      if (removeStaleLock(lockDir, staleMs)) continue
      if (Date.now() - started >= timeoutMs) throw storeError('plan_store_busy', 'Timed out waiting for the local run-plan store lock.')
      sleepSync(delay)
      delay = Math.min(delay * 2, 100)
    }
  }
}

/** @param {string} filePath */
function readPlan(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return /** @type {StoredControlPlanePlan} */ (JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch (error) {
    throw storeError('plan_store_corrupt', `Could not read stored run plan "${path.basename(filePath, '.json')}".`, { reason: error instanceof Error ? error.message : String(error) })
  }
}

/** @param {string} filePath @param {StoredControlPlanePlan} plan */
function atomicWritePlan(filePath, plan) {
  const dir = path.dirname(filePath)
  const temporary = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(plan, null, 2)}\n`)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filePath)
    fs.chmodSync(filePath, 0o600)
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw error
  }
}

/** @param {string} dir */
function listPlans(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readPlan(path.join(dir, entry.name)))
    .filter((plan) => plan !== null)
}

/**
 * @param {{ projectRoot: string, now?: () => Date, lockTimeoutMs?: number, lockStaleMs?: number }} options
 * @returns {ControlPlaneRunPlanStore & { pruneExpired(before: string): Promise<number>, directory: string }}
 */
function createLocalRunPlanStore({ projectRoot, now = () => new Date(), lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, lockStaleMs = DEFAULT_LOCK_STALE_MS }) {
  const directory = runPlanDirectory(projectRoot)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(path.join(path.resolve(projectRoot), '.nax', 'control-plane'), 0o700)
  fs.chmodSync(directory, 0o700)

  /** @template T @param {() => T} operation */
  function locked(operation) {
    const release = acquireStoreLock(directory, { timeoutMs: lockTimeoutMs, staleMs: lockStaleMs })
    try {
      return operation()
    } finally {
      release()
    }
  }

  return {
    directory,
    async create(plan) {
      assertSecretFree(plan)
      return locked(() => {
        const filePath = runPlanPath(projectRoot, plan.planId)
        const existing = readPlan(filePath)
        if (existing) {
          if (existing.requestHash === plan.requestHash && existing.actorId === plan.actorId) return existing
          throw storeError('idempotency_conflict', `Plan ID "${plan.planId}" already belongs to different normalized input.`, { planId: plan.planId })
        }
        atomicWritePlan(filePath, plan)
        return plan
      })
    },
    async get(planId) {
      return readPlan(runPlanPath(projectRoot, planId))
    },
    async claimStart(planId, requestId, expectedStatus) {
      return locked(() => {
        const filePath = runPlanPath(projectRoot, planId)
        const plan = readPlan(filePath)
        if (!plan || plan.status !== expectedStatus) return null
        const conflicting = listPlans(directory).find((candidate) => candidate.planId !== planId && candidate.requestId === requestId)
        if (conflicting) {
          throw storeError('idempotency_conflict', `Request ID "${requestId}" is already bound to another plan.`, {
            planId,
            existingPlanId: conflicting.planId,
            requestId,
          })
        }
        if (plan.requestId && plan.requestId !== requestId) {
          throw storeError('idempotency_conflict', `Plan "${planId}" is already bound to another request.`, { planId, requestId, existingRequestId: plan.requestId })
        }
        const claimed = { ...plan, status: /** @type {const} */ ('starting'), requestId, updatedAt: now().toISOString() }
        delete claimed.failure
        atomicWritePlan(filePath, claimed)
        return claimed
      })
    },
    async bindStarted(planId, requestId, runId) {
      return locked(() => {
        const filePath = runPlanPath(projectRoot, planId)
        const plan = readPlan(filePath)
        if (!plan) throw storeError('run_plan_not_found', `Unknown run plan "${planId}".`, { planId })
        if (plan.requestId !== requestId) throw storeError('idempotency_conflict', `Plan "${planId}" is bound to another request.`, { planId, requestId })
        if (plan.status === 'started') {
          if (plan.runId !== runId) throw storeError('idempotency_conflict', `Plan "${planId}" is already bound to a different run.`, { planId, runId, existingRunId: plan.runId || '' })
          return plan
        }
        if (plan.status !== 'starting' && plan.status !== 'failed') throw storeError('invalid_plan_state', `Plan "${planId}" cannot bind a run from state "${plan.status}".`, { planId })
        const started = { ...plan, status: /** @type {const} */ ('started'), runId, updatedAt: now().toISOString() }
        delete started.failure
        atomicWritePlan(filePath, started)
        return started
      })
    },
    async markFailed(planId, requestId, failure) {
      return locked(() => {
        const filePath = runPlanPath(projectRoot, planId)
        const plan = readPlan(filePath)
        if (!plan) throw storeError('run_plan_not_found', `Unknown run plan "${planId}".`, { planId })
        if (plan.requestId !== requestId) throw storeError('idempotency_conflict', `Plan "${planId}" is bound to another request.`, { planId, requestId })
        if (plan.status === 'started') return plan
        if (plan.status !== 'starting') throw storeError('invalid_plan_state', `Plan "${planId}" cannot fail from state "${plan.status}".`, { planId })
        const failed = { ...plan, status: /** @type {const} */ ('failed'), failure: /** @type {ControlPlaneErrorShape} */ ({ ...failure, details: failure.details ? { ...failure.details } : undefined }), updatedAt: now().toISOString() }
        atomicWritePlan(filePath, failed)
        return failed
      })
    },
    async listStaleStarting(before) {
      const threshold = Date.parse(before)
      if (!Number.isFinite(threshold)) throw storeError('invalid_arguments', 'Stale-plan cutoff must be an ISO timestamp.')
      return listPlans(directory).filter((plan) => plan.status === 'starting' && Date.parse(plan.updatedAt) <= threshold)
    },
    async pruneExpired(before) {
      const threshold = Date.parse(before)
      if (!Number.isFinite(threshold)) throw storeError('invalid_arguments', 'Plan retention cutoff must be an ISO timestamp.')
      return locked(() => {
        let removed = 0
        for (const plan of listPlans(directory)) {
          const expiredPrepared = plan.status === 'prepared' && Date.parse(plan.expiresAt) <= threshold
          const oldFailed = plan.status === 'failed' && Date.parse(plan.updatedAt) <= threshold
          if (!expiredPrepared && !oldFailed) continue
          fs.rmSync(runPlanPath(projectRoot, plan.planId), { force: true })
          removed += 1
        }
        return removed
      })
    },
  }
}

module.exports = {
  acquireStoreLock,
  assertPlanId,
  assertSecretFree,
  createLocalRunPlanStore,
  runPlanDirectory,
  runPlanPath,
  storeError,
}
