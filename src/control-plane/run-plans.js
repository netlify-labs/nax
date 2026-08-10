/** @typedef {import('../contracts').ControlPlaneActor} ControlPlaneActor */
/** @typedef {import('../contracts').ControlPlaneErrorShape} ControlPlaneErrorShape */
/** @typedef {import('../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject */
/** @typedef {import('../contracts').ControlPlaneRunPlanStore} ControlPlaneRunPlanStore */
/** @typedef {import('../contracts').ControlPlaneScope} ControlPlaneScope */
/** @typedef {import('../contracts').ControlPlaneStartResult} ControlPlaneStartResult */
/** @typedef {import('../contracts').StoredControlPlanePlan} StoredControlPlanePlan */
/** @typedef {import('../contracts').WorkflowExecutionBackend} WorkflowExecutionBackend */

/**
 * @typedef {{
 *   plan: import('../contracts').ControlPlanePlan,
 *   normalizedInput: ControlPlaneJsonObject,
 *   requestHash: string,
 * }} PreparedPlanRecord
 *
 * @typedef {{
 *   store: ControlPlaneRunPlanStore,
 *   executionBackend: WorkflowExecutionBackend,
 *   scope: ControlPlaneScope,
 *   actor: ControlPlaneActor,
 *   target: import('../contracts').ControlPlaneTarget,
 *   planId: string,
 *   requestId: string,
 *   now?: Date,
 *   waitMs?: number,
 *   pollMs?: number,
 *   staleStartingMs?: number,
 *   sleep?: (milliseconds: number) => Promise<void>,
 * }} StartPlanInput
 */

/** @param {string} code @param {string} message @param {ControlPlaneJsonObject} [details] @param {boolean} [recoverable] */
function runPlanError(code, message, details = {}, recoverable = true) {
  return Object.assign(new Error(message), { code, recoverable, details })
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
}

/** @param {number} milliseconds */
function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * @param {PreparedPlanRecord} prepared
 * @param {string} actorId
 * @param {Date} now
 * @returns {StoredControlPlanePlan}
 */
function storedPlanFromPrepared(prepared, actorId, now) {
  if (!actorId) throw runPlanError('invalid_actor', 'A stable authenticated actor ID is required to store a plan.')
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw runPlanError('invalid_clock', 'A valid explicit clock is required to store a plan.')
  const at = now.toISOString()
  return {
    ...prepared.plan,
    scope: { ...prepared.plan.scope },
    target: { ...prepared.plan.target, caveats: [...(prepared.plan.target.caveats || [])] },
    steps: prepared.plan.steps.map((step) => ({ ...step, agents: [...step.agents], instances: step.instances.map((instance) => ({ ...instance })) })),
    instances: prepared.plan.instances.map((instance) => ({ ...instance })),
    warnings: prepared.plan.warnings.map((warning) => ({ ...warning })),
    actorId,
    requestHash: prepared.requestHash,
    normalizedInput: { ...prepared.normalizedInput },
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * @param {StoredControlPlanePlan} plan
 * @param {ControlPlaneScope} scope
 * @param {ControlPlaneActor} actor
 * @param {Date} now
 * @param {import('../contracts').ControlPlaneTarget} target
 */
function assertStartBinding(plan, scope, actor, now, target) {
  if (plan.scope.scopeId !== scope.scopeId || plan.scope.projectId !== scope.projectId) {
    throw runPlanError('project_scope_mismatch', 'The saved plan belongs to a different project scope.', { planId: plan.planId })
  }
  for (const key of /** @type {const} */ (['accountId', 'siteId', 'repositoryId'])) {
    if (plan.scope[key] !== scope[key]) {
      throw runPlanError('project_scope_mismatch', `The saved plan ${key} does not match the current scope.`, { planId: plan.planId })
    }
  }
  if (plan.actorId !== actor.actorId || actor.authenticated !== true) {
    throw runPlanError('scope_forbidden', 'The current actor is not authorized to start this saved plan.', { planId: plan.planId })
  }
  if (plan.status === 'prepared' && Date.parse(plan.expiresAt) <= now.getTime()) {
    throw runPlanError('run_plan_expired', `Plan "${plan.planId}" expired before it was started.`, {
      planId: plan.planId,
      expiresAt: plan.expiresAt,
      planKind: plan.kind,
      ...(plan.workflowId ? { workflowId: plan.workflowId } : {}),
    })
  }
  if (!target || target.verified !== true || plan.target.siteId !== target.siteId || plan.target.accountId !== target.accountId || plan.target.branch !== target.branch) {
    throw runPlanError('project_scope_mismatch', 'The current Netlify site, account, or branch no longer matches the immutable saved plan.', {
      planId: plan.planId,
      planSiteId: plan.target.siteId,
      currentSiteId: target?.siteId || '',
      planBranch: plan.target.branch,
      currentBranch: target?.branch || '',
    })
  }
}

/** @param {StoredControlPlanePlan} plan @param {string} requestId */
function assertRequestIdentity(plan, requestId) {
  if (!requestId) throw runPlanError('invalid_arguments', 'request_id is required to start a plan.', { planId: plan.planId })
  if (plan.requestId && plan.requestId !== requestId) {
    throw runPlanError('idempotency_conflict', 'This plan is already bound to a different start request.', {
      planId: plan.planId,
      existingRequestId: plan.requestId,
      requestId,
    })
  }
}

/** @param {unknown} error @returns {ControlPlaneErrorShape} */
function executionFailure(error) {
  const value = objectValue(error)
  const details = objectValue(value.details)
  const mutationTransmitted = typeof details.mutationTransmitted === 'boolean'
    ? details.mutationTransmitted
    : typeof value.mutationTransmitted === 'boolean'
      ? value.mutationTransmitted
      : undefined
  return {
    code: typeof value.code === 'string' ? value.code : 'run_start_failed',
    message: error instanceof Error ? error.message : 'The execution backend failed while starting the plan.',
    recoverable: typeof value.recoverable === 'boolean' ? value.recoverable : mutationTransmitted === false,
    details: /** @type {ControlPlaneJsonObject} */ ({
      ...details,
      ...(mutationTransmitted === undefined ? { ambiguous: true } : { mutationTransmitted, ambiguous: mutationTransmitted }),
    }),
  }
}

/** @param {StoredControlPlanePlan} plan */
function failureProvesNoMutation(plan) {
  return plan.failure?.details?.mutationTransmitted === false
}

/**
 * @param {ControlPlaneRunPlanStore} store
 * @param {WorkflowExecutionBackend} executionBackend
 * @param {StoredControlPlanePlan} plan
 * @returns {Promise<ControlPlaneStartResult | null>}
 */
async function reconcileAndBind(store, executionBackend, plan) {
  const reconciled = await executionBackend.reconcilePlan(plan)
  if (!reconciled?.run?.runId) return null
  const requestId = plan.requestId || ''
  if (!requestId) return null
  await store.bindStarted(plan.planId, requestId, reconciled.run.runId)
  return { ...reconciled, accepted: false, replayed: true }
}

/**
 * @param {StartPlanInput} input
 * @returns {Promise<ControlPlaneStartResult>}
 */
async function startStoredPlan({
  store,
  executionBackend,
  scope,
  actor,
  target,
  planId,
  requestId,
  now = new Date(),
  waitMs = 250,
  pollMs = 25,
  staleStartingMs = 30_000,
  sleep = defaultSleep,
}) {
  let plan = await store.get(planId)
  if (!plan) throw runPlanError('run_plan_not_found', `Unknown run plan "${planId}".`, { planId })
  assertStartBinding(plan, scope, actor, now, target)
  assertRequestIdentity(plan, requestId)

  if (plan.status === 'started') {
    const replay = await reconcileAndBind(store, executionBackend, plan)
    if (replay) return replay
    throw runPlanError('run_binding_missing', 'The started plan has no recoverable durable run binding.', { planId, runId: plan.runId || '' }, false)
  }

  if (plan.status === 'starting') {
    if (Date.parse(plan.updatedAt) <= now.getTime() - staleStartingMs) {
      const reconciled = await reconcileAndBind(store, executionBackend, plan)
      if (reconciled) return reconciled
    }
    const deadline = Date.now() + Math.max(0, waitMs)
    while (Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
      const current = await store.get(planId)
      if (!current) break
      assertRequestIdentity(current, requestId)
      if (current.status === 'started') {
        const replay = await reconcileAndBind(store, executionBackend, current)
        if (replay) return replay
      }
      if (current.status === 'failed') {
        throw runPlanError(current.failure?.code || 'run_start_failed', current.failure?.message || 'The concurrent plan start failed.', current.failure?.details || {})
      }
    }
    throw runPlanError('run_start_in_progress', 'This plan is already being started; retry the same request shortly.', { planId, requestId, runId: plan.runId || '' })
  }

  if (plan.status === 'failed' && !failureProvesNoMutation(plan)) {
    const reconciled = await reconcileAndBind(store, executionBackend, plan)
    if (reconciled) return reconciled
    throw runPlanError('ambiguous_run_start', 'The previous start may have reached the remote service and could not be reconciled; it will not be replayed blindly.', { planId, requestId })
  }

  const expectedStatus = plan.status === 'failed' ? /** @type {const} */ ('failed') : /** @type {const} */ ('prepared')
  const claimed = await store.claimStart(planId, requestId, expectedStatus)
  if (!claimed) {
    plan = await store.get(planId)
    if (plan?.status === 'starting' || plan?.status === 'started') {
      return startStoredPlan({ store, executionBackend, scope, actor, target, planId, requestId, now, waitMs, pollMs, staleStartingMs, sleep })
    }
    throw runPlanError('idempotency_conflict', 'The plan changed before this request could claim it.', { planId, requestId })
  }

  let result
  try {
    result = await executionBackend.startPlan(claimed)
  } catch (error) {
    try {
      await store.markFailed(planId, requestId, executionFailure(error))
    } catch (_storeError) {
      // Preserve the execution failure; a retained `starting` record is safer
      // than masking an ambiguous remote mutation with a storage error.
    }
    throw error
  }
  if (!result?.run?.runId) {
    const error = runPlanError('run_binding_missing', 'The execution backend did not return a durable run ID.', { planId, requestId, mutationTransmitted: true }, false)
    await store.markFailed(planId, requestId, executionFailure(error))
    throw error
  }

  await store.bindStarted(planId, requestId, result.run.runId)
  return { ...result, replayed: result.replayed === true }
}

/**
 * Reconciles stale `starting` records without ever calling startPlan again.
 * @param {{ store: ControlPlaneRunPlanStore, executionBackend: WorkflowExecutionBackend, before: Date }} input
 */
async function reconcileStalePlans({ store, executionBackend, before }) {
  const stale = await store.listStaleStarting(before.toISOString())
  const reconciled = []
  const unresolved = []
  for (const plan of stale) {
    const result = await reconcileAndBind(store, executionBackend, plan)
    if (result) reconciled.push({ planId: plan.planId, runId: result.run.runId })
    else unresolved.push(plan.planId)
  }
  return { reconciled, unresolved }
}

module.exports = {
  assertRequestIdentity,
  assertStartBinding,
  executionFailure,
  failureProvesNoMutation,
  reconcileStalePlans,
  runPlanError,
  startStoredPlan,
  storedPlanFromPrepared,
}
