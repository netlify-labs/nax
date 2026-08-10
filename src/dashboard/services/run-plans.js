const { prepareAgentRunPlan, prepareWorkflowPlan } = require('../../control-plane/planner')
const { startStoredPlan, storedPlanFromPrepared } = require('../../control-plane/run-plans')

/** @typedef {import('../../contracts').ControlPlaneActor} ControlPlaneActor */
/** @typedef {import('../../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject */
/** @typedef {import('../../contracts').ControlPlanePlan} ControlPlanePlan */
/** @typedef {import('../../contracts').ControlPlaneRunPlanStore} ControlPlaneRunPlanStore */
/** @typedef {import('../../contracts').ControlPlaneScope} ControlPlaneScope */
/** @typedef {import('../../contracts').ControlPlaneTarget} ControlPlaneTarget */
/** @typedef {import('../../contracts').StoredControlPlanePlan} StoredControlPlanePlan */
/** @typedef {import('../../contracts').WorkflowExecutionBackend} WorkflowExecutionBackend */

/**
 * @typedef {{
 *   store: ControlPlaneRunPlanStore,
 *   executionBackend: WorkflowExecutionBackend,
 *   workflowStore: import('../../storage/interfaces').WorkflowCatalog,
 *   scope: ControlPlaneScope,
 *   actor: ControlPlaneActor,
 *   createPlanId: () => string,
 *   resolveTarget: (branch?: string) => ControlPlaneTarget | Promise<ControlPlaneTarget>,
 *   now?: () => Date,
 *   ttlMs?: number,
 * }} DashboardRunPlanServiceOptions
 *
 * @typedef {{
 *   createWorkflowPlan: (workflowId: string, input?: ControlPlaneJsonObject) => Promise<ControlPlanePlan>,
 *   createAgentRunPlan: (input?: ControlPlaneJsonObject) => Promise<ControlPlanePlan>,
 *   getPlan: (planId: string) => Promise<ControlPlanePlan>,
 *   startPlan: (planId: string, input?: ControlPlaneJsonObject) => Promise<import('../../contracts').ControlPlaneStartResult>,
 * }} DashboardRunPlanService
 */

const ERROR_STATUS = Object.freeze({
  ambiguous_run_start: 409,
  context_too_large: 413,
  duplicate_run: 409,
  idempotency_conflict: 409,
  invalid_actor: 403,
  invalid_arguments: 400,
  invalid_clock: 500,
  invalid_instance_contract: 400,
  invalid_plan_id: 400,
  invalid_plan_ttl: 500,
  invalid_plan_state: 409,
  invalid_prompt: 400,
  invalid_step: 400,
  invalid_scope: 403,
  no_runnable_steps: 409,
  no_site: 409,
  project_scope_mismatch: 409,
  prompt_too_large: 413,
  run_binding_missing: 500,
  run_plan_expired: 409,
  run_plan_not_found: 404,
  run_start_in_progress: 409,
  run_start_timeout: 504,
  scope_forbidden: 403,
  target_branch_mismatch: 409,
  unverified_target: 409,
  unsupported_transport: 409,
  workflow_not_found: 404,
})

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} error */
function withHttpStatus(error) {
  if (!isObject(error)) return error
  if (typeof error.statusCode === 'number') return error
  if (typeof error.code !== 'string' && error instanceof Error && /^Unknown flow\b/.test(error.message)) {
    error.code = 'workflow_not_found'
  }
  const code = typeof error.code === 'string' ? error.code : 'internal_error'
  error.statusCode = ERROR_STATUS[code] || (code.startsWith('invalid_') ? 400 : 500)
  return error
}

/** @param {number} statusCode @param {string} code @param {string} message @param {ControlPlaneJsonObject} [details] */
function serviceError(statusCode, code, message, details = {}) {
  return Object.assign(new Error(message), { statusCode, code, recoverable: statusCode < 500, details })
}

/** @param {Record<string, unknown>} input @param {string[]} allowed */
function assertOnlyKeys(input, allowed) {
  const extras = Object.keys(input).filter((key) => !allowed.includes(key))
  if (extras.length > 0) {
    throw serviceError(400, 'invalid_arguments', `Unsupported field${extras.length === 1 ? '' : 's'}: ${extras.join(', ')}.`, { fields: extras })
  }
}

/** @param {StoredControlPlanePlan} stored @returns {ControlPlanePlan} */
function publicPlan(stored) {
  return {
    planId: stored.planId,
    kind: stored.kind,
    status: stored.status,
    scope: { ...stored.scope },
    target: { ...stored.target, caveats: [...(stored.target.caveats || [])] },
    expiresAt: stored.expiresAt,
    ...(stored.workflowId ? { workflowId: stored.workflowId } : {}),
    steps: stored.steps.map((step) => ({
      ...step,
      agents: [...step.agents],
      instances: step.instances.map((instance) => ({ ...instance })),
    })),
    instances: stored.instances.map((instance) => ({ ...instance })),
    expectedAgentRuns: stored.expectedAgentRuns,
    warnings: stored.warnings.map((warning) => ({ ...warning })),
    summary: stored.summary,
  }
}

/** @param {StoredControlPlanePlan} plan @param {ControlPlaneScope} scope @param {ControlPlaneActor} actor */
function assertPlanAccess(plan, scope, actor) {
  if (actor.authenticated !== true || plan.actorId !== actor.actorId) {
    throw serviceError(403, 'scope_forbidden', 'The current actor cannot access this run plan.', { planId: plan.planId })
  }
  if (
    plan.scope.scopeId !== scope.scopeId ||
    plan.scope.projectId !== scope.projectId ||
    plan.scope.accountId !== scope.accountId ||
    plan.scope.siteId !== scope.siteId ||
    plan.scope.repositoryId !== scope.repositoryId
  ) {
    throw serviceError(409, 'project_scope_mismatch', 'The run plan belongs to a different project scope.', { planId: plan.planId })
  }
}

/**
 * @param {DashboardRunPlanServiceOptions} options
 * @returns {DashboardRunPlanService}
 */
function createDashboardRunPlanService({
  store,
  executionBackend,
  workflowStore,
  scope,
  actor,
  createPlanId,
  resolveTarget,
  now = () => new Date(),
  ttlMs,
}) {
  if (!store || !executionBackend || !workflowStore || typeof createPlanId !== 'function' || typeof resolveTarget !== 'function') {
    throw new TypeError('Run-plan service requires stores, an execution backend, an ID generator, and a target resolver.')
  }

  /** @param {import('../../control-plane/planner').PreparedControlPlanePlan} prepared @param {Date} at */
  async function persist(prepared, at) {
    const stored = storedPlanFromPrepared(prepared, actor.actorId, at)
    return publicPlan(await store.create(stored))
  }

  return {
    async createWorkflowPlan(workflowId, input = {}) {
      try {
        assertOnlyKeys(input, ['branch', 'instances', 'stepInstances', 'context', 'onlyStep', 'fromStep'])
        if (typeof workflowStore.loadWorkflow !== 'function') {
          throw serviceError(501, 'hosted_storage_unavailable', 'Workflow planning storage is not available in this runtime.')
        }
        const at = now()
        const target = await resolveTarget(typeof input.branch === 'string' ? input.branch : undefined)
        const flow = /** @type {import('../../types').WorkflowFlow} */ (await workflowStore.loadWorkflow(workflowId))
        const prepared = prepareWorkflowPlan({
          planId: createPlanId(),
          now: at,
          ...(ttlMs === undefined ? {} : { ttlMs }),
          scope,
          target,
          flow,
          input: /** @type {import('../../contracts').ControlPlaneWorkflowPlanInput} */ ({ ...input, workflowId }),
        })
        return await persist(prepared, at)
      } catch (error) {
        throw withHttpStatus(error)
      }
    },

    async createAgentRunPlan(input = {}) {
      try {
        assertOnlyKeys(input, ['prompt', 'instance', 'branch'])
        const at = now()
        const target = await resolveTarget(typeof input.branch === 'string' ? input.branch : undefined)
        const prepared = prepareAgentRunPlan({
          planId: createPlanId(),
          now: at,
          ...(ttlMs === undefined ? {} : { ttlMs }),
          scope,
          target,
          input: /** @type {import('../../contracts').ControlPlaneAgentRunPlanInput} */ (input),
        })
        return await persist(prepared, at)
      } catch (error) {
        throw withHttpStatus(error)
      }
    },

    async getPlan(planId) {
      try {
        const plan = await store.get(planId)
        if (!plan) throw serviceError(404, 'run_plan_not_found', `Unknown run plan "${planId}".`, { planId })
        assertPlanAccess(plan, scope, actor)
        return publicPlan(plan)
      } catch (error) {
        throw withHttpStatus(error)
      }
    },

    async startPlan(planId, input = {}) {
      try {
        assertOnlyKeys(input, ['requestId'])
        const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : ''
        if (!requestId) throw serviceError(400, 'invalid_arguments', 'requestId is required to start a run plan.', { planId })
        const saved = await store.get(planId)
        if (!saved) throw serviceError(404, 'run_plan_not_found', `Unknown run plan "${planId}".`, { planId })
        assertPlanAccess(saved, scope, actor)
        const target = await resolveTarget(saved.target.branch)
        return await startStoredPlan({
          store,
          executionBackend,
          scope,
          actor,
          target,
          planId,
          requestId,
          now: now(),
        })
      } catch (error) {
        throw withHttpStatus(error)
      }
    },
  }
}

module.exports = {
  assertOnlyKeys,
  assertPlanAccess,
  createDashboardRunPlanService,
  publicPlan,
  serviceError,
  withHttpStatus,
}
