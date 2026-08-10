/** @typedef {import('../contracts').ControlPlaneActor} ControlPlaneActor */
/** @typedef {import('../contracts').ControlPlaneAuthorizationTarget} ControlPlaneAuthorizationTarget */
/** @typedef {import('../contracts').ControlPlaneOperation} ControlPlaneOperation */
/** @typedef {import('../contracts').ControlPlaneAuditEvent} ControlPlaneAuditEvent */
/** @typedef {import('../contracts').ControlPlaneScope} ControlPlaneScope */
/** @typedef {import('../contracts').NaxControlPlane} NaxControlPlane */
/** @typedef {import('../contracts').NaxControlPlanePorts} NaxControlPlanePorts */

const { assertNaxControlPlanePorts } = require('./ports')

const ACTIVITY_FOR_OPERATION = Object.freeze({
  getContext: 'context_get',
  listWorkflows: 'workflow_list',
  getWorkflow: 'workflow_get',
  createWorkflowPlan: 'workflow_plan',
  createAgentRunPlan: 'agent_run_plan',
  startPlan: 'run_start',
  listRuns: 'run_list',
  getRun: 'run_get',
  waitForRun: 'run_wait',
  cancelRun: 'run_cancel',
  retryAgentRun: 'agent_run_retry',
  submitFollowup: 'agent_run_followup',
  resolveReviewGate: 'review_gate_resolve',
  getArtifact: 'resource_read',
})

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requiredIdentity(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string.`)
  }
  return value
}

/**
 * @param {ControlPlaneScope} scope
 * @param {ControlPlaneActor} actor
 */
function assertInvocationIdentity(scope, actor) {
  if (!scope || typeof scope !== 'object') throw new TypeError('scope is required.')
  if (!actor || typeof actor !== 'object') throw new TypeError('actor is required.')
  requiredIdentity(scope.scopeId, 'scope.scopeId')
  requiredIdentity(scope.projectId, 'scope.projectId')
  requiredIdentity(actor.actorId, 'actor.actorId')
  if (actor.authenticated !== true) throw new TypeError('actor must be authenticated.')
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {unknown} error */
function auditErrorCode(error) {
  const code = objectValue(error).code
  return typeof code === 'string' && code ? code.slice(0, 100) : 'internal_error'
}

/**
 * @param {ControlPlaneOperation} operation
 * @param {ControlPlaneScope} scope
 * @param {ControlPlaneActor} actor
 * @param {Record<string, unknown>} metadata
 * @param {unknown} result
 * @param {{ at: string, durationMs: number, ok: boolean, errorCode?: string }} outcome
 * @param {NaxControlPlanePorts} ports
 * @returns {ControlPlaneAuditEvent}
 */
function auditEvent(operation, scope, actor, metadata, result, outcome, ports) {
  const resultObject = objectValue(result)
  const run = objectValue(resultObject.run)
  const context = ports.auditContext || {}
  const agentRuns = Array.isArray(resultObject.agentRuns) ? resultObject.agentRuns : []
  const usageTotals = objectValue(run.usageTotals || resultObject.usageTotals)
  const createdAgentRuns = operation === 'retryAgentRun'
    ? (resultObject.agentRun ? 1 : 0)
    : agentRuns.length
  return {
    operation,
    activity: ACTIVITY_FOR_OPERATION[operation],
    at: outcome.at,
    durationMs: outcome.durationMs,
    ok: outcome.ok,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    scopeId: scope.scopeId,
    actorId: actor.actorId,
    ...(context.runtime ? { runtime: context.runtime } : {}),
    ...(context.clientName ? { clientName: context.clientName } : {}),
    ...(context.clientVersion ? { clientVersion: context.clientVersion } : {}),
    ...(typeof metadata.planId === 'string' && metadata.planId ? { planId: metadata.planId } : {}),
    ...(typeof metadata.requestId === 'string' && metadata.requestId ? { requestId: metadata.requestId } : {}),
    ...(typeof metadata.workflowId === 'string' && metadata.workflowId ? { workflowId: metadata.workflowId } : {}),
    ...(typeof metadata.runId === 'string' && metadata.runId ? { runId: metadata.runId } : {}),
    ...(Number.isSafeInteger(resultObject.expectedAgentRuns) ? { expectedAgentRuns: Number(resultObject.expectedAgentRuns) } : {}),
    ...(createdAgentRuns > 0 ? { createdAgentRuns } : {}),
    ...(Object.keys(usageTotals).length > 0 ? { usageTotals: /** @type {import('../contracts').ControlPlaneUsageTotals} */ (usageTotals) } : {}),
  }
}

/** @param {NaxControlPlanePorts} ports @param {ControlPlaneAuditEvent} event */
async function recordAudit(ports, event) {
  try {
    await ports.audit?.record(event)
  } catch (_error) {
    // Audit failures must never alter control-plane outcomes.
  }
}

/**
 * @template T
 * @param {NaxControlPlanePorts} ports
 * @param {ControlPlaneOperation} operation
 * @param {ControlPlaneScope} scope
 * @param {ControlPlaneActor} actor
 * @param {ControlPlaneAuthorizationTarget} target
 * @param {() => Promise<T>} execute
 * @param {Record<string, unknown>} [metadata]
 * @returns {Promise<T>}
 */
async function invoke(ports, operation, scope, actor, target, execute, metadata = {}) {
  assertInvocationIdentity(scope, actor)
  const now = ports.auditNow || (() => new Date())
  const clock = ports.auditClock || (() => Date.now())
  const at = now().toISOString()
  const started = clock()
  try {
    await ports.authorize({ operation, scope, actor, target })
    const result = await execute()
    await recordAudit(ports, auditEvent(operation, scope, actor, metadata, result, {
      at,
      durationMs: Math.max(0, Math.round(clock() - started)),
      ok: true,
    }, ports))
    return result
  } catch (error) {
    await recordAudit(ports, auditEvent(operation, scope, actor, metadata, null, {
      at,
      durationMs: Math.max(0, Math.round(clock() - started)),
      ok: false,
      errorCode: auditErrorCode(error),
    }, ports))
    throw error
  }
}

/**
 * Creates the transport-neutral application service used by MCP adapters.
 * Authorization runs before every read and mutation, including context reads.
 * @param {unknown} input
 * @returns {NaxControlPlane}
 */
function createNaxControlPlane(input) {
  const ports = assertNaxControlPlanePorts(input)

  return Object.freeze({
    getContext(scope, actor) {
      return invoke(ports, 'getContext', scope, actor, { kind: 'scope', id: scope?.scopeId }, () => ports.getContext(scope, actor))
    },
    listWorkflows(scope, actor, query) {
      return invoke(ports, 'listWorkflows', scope, actor, { kind: 'scope', id: scope?.scopeId }, () => ports.listWorkflows(scope, actor, query))
    },
    getWorkflow(scope, actor, workflowId, options) {
      return invoke(ports, 'getWorkflow', scope, actor, { kind: 'workflow', id: workflowId }, () => ports.getWorkflow(scope, actor, workflowId, options), { workflowId })
    },
    createWorkflowPlan(scope, actor, planInput) {
      return invoke(ports, 'createWorkflowPlan', scope, actor, { kind: 'workflow', id: planInput?.workflowId }, () => ports.createWorkflowPlan(scope, actor, planInput), { workflowId: planInput?.workflowId })
    },
    createAgentRunPlan(scope, actor, planInput) {
      return invoke(ports, 'createAgentRunPlan', scope, actor, { kind: 'scope', id: scope?.scopeId }, () => ports.createAgentRunPlan(scope, actor, planInput))
    },
    startPlan(scope, actor, planId, requestId) {
      return invoke(ports, 'startPlan', scope, actor, { kind: 'plan', id: planId }, () => ports.startPlan(scope, actor, planId, requestId), { planId, requestId })
    },
    listRuns(scope, actor, query) {
      return invoke(ports, 'listRuns', scope, actor, { kind: 'scope', id: scope?.scopeId }, () => ports.listRuns(scope, actor, query))
    },
    getRun(scope, actor, runId, options) {
      return invoke(ports, 'getRun', scope, actor, { kind: 'run', id: runId }, () => ports.getRun(scope, actor, runId, options), { runId })
    },
    waitForRun(scope, actor, runId, cursor, timeoutMs, signal) {
      return invoke(ports, 'waitForRun', scope, actor, { kind: 'run', id: runId }, () => ports.waitForRun(scope, actor, runId, cursor, timeoutMs, signal), { runId })
    },
    cancelRun(scope, actor, target) {
      return invoke(ports, 'cancelRun', scope, actor, {
        kind: target?.agentRunId ? 'agent-run' : 'run',
        id: target?.agentRunId || target?.runId,
        parentId: target?.agentRunId ? target?.runId : undefined,
      }, () => ports.cancelRun(scope, actor, target), { runId: target?.runId })
    },
    retryAgentRun(scope, actor, retryInput) {
      return invoke(ports, 'retryAgentRun', scope, actor, { kind: 'agent-run', id: retryInput?.agentRunId, parentId: retryInput?.runId }, () => ports.retryAgentRun(scope, actor, retryInput), { runId: retryInput?.runId, requestId: retryInput?.requestId })
    },
    submitFollowup(scope, actor, followupInput) {
      return invoke(ports, 'submitFollowup', scope, actor, { kind: 'agent-run', id: followupInput?.agentRunId, parentId: followupInput?.runId }, () => ports.submitFollowup(scope, actor, followupInput), { runId: followupInput?.runId, requestId: followupInput?.requestId })
    },
    resolveReviewGate(scope, actor, reviewInput) {
      return invoke(ports, 'resolveReviewGate', scope, actor, { kind: 'review-gate', id: reviewInput?.reviewGateId, parentId: reviewInput?.runId }, () => ports.resolveReviewGate(scope, actor, reviewInput), { runId: reviewInput?.runId })
    },
    getArtifact(scope, actor, runId, artifactId) {
      return invoke(ports, 'getArtifact', scope, actor, { kind: 'artifact', id: artifactId, parentId: runId }, () => ports.getArtifact(scope, actor, runId, artifactId), { runId })
    },
  })
}

module.exports = {
  ACTIVITY_FOR_OPERATION,
  auditEvent,
  assertInvocationIdentity,
  createNaxControlPlane,
}
