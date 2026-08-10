const { errorResult } = require('../errors')
const { successResult } = require('../results')
const { TOOL_SPECS } = require('../schemas')
const { workflowCandidates } = require('./workflows')
const { mcpClientResolver } = require('../routing')

/** @typedef {import('../../contracts').ControlPlaneContext} ControlPlaneContext */
/** @typedef {import('../../contracts').ControlPlaneNextAction} ControlPlaneNextAction */
/** @typedef {import('../../contracts').ControlPlanePlan} ControlPlanePlan */
/** @typedef {import('../../contracts').ControlPlaneStartResult} ControlPlaneStartResult */
/** @typedef {import('../../contracts').NaxControlPlaneClient} NaxControlPlaneClient */

/** @param {ControlPlanePlan} plan */
function warningSummary(plan) {
  if (plan.warnings.length === 0) return 'Warnings: none.'
  const messages = plan.warnings.slice(0, 3).map((warning) => warning.message)
  const remaining = plan.warnings.length - messages.length
  return `Warnings (${plan.warnings.length}): ${messages.join(' ')}${remaining > 0 ? ` ${remaining} more warning${remaining === 1 ? '' : 's'} are in the structured plan.` : ''}`
}

/** @param {ControlPlanePlan} plan */
function planApprovalSummary(plan) {
  const kind = plan.kind === 'workflow'
    ? `Workflow ${plan.workflowId || plan.planId}`
    : 'Single Agent Runner'
  return [
    `${kind} is planned but has not started.`,
    `Target: ${plan.target.siteName} (${plan.target.siteId}), branch ${plan.target.branch}.`,
    `Remote runners: ${plan.expectedAgentRuns}.`,
    `Plan: ${plan.planId}, expires ${plan.expiresAt}.`,
    warningSummary(plan),
    'Review this immutable plan before calling run_start.',
  ].join(' ')
}

/** @param {ControlPlanePlan} plan @returns {ControlPlaneNextAction[]} */
function planNextActions(plan) {
  return [{
    kind: 'tool',
    tool: 'run_start',
    arguments: { plan_id: plan.planId, request_id: `request_${plan.planId}` },
  }]
}

/** @param {ControlPlaneStartResult} result */
function runStartSummary(result) {
  const disposition = result.replayed
    ? 'replayed the original idempotent start'
    : result.accepted
      ? 'accepted the immutable plan'
      : 'returned the existing durable run'
  return `NAX ${disposition}. Run ${result.run.runId} is ${result.run.status}.`
}

/** @param {ControlPlaneStartResult} result @returns {ControlPlaneNextAction[]} */
function runStartNextActions(result) {
  const runId = result.run.runId
  if (result.run.status === 'running' || result.run.status === 'booting') {
    return [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: runId, since: '0', timeout_ms: 30000 } }]
  }
  return [{ kind: 'tool', tool: 'run_get', arguments: { run_id: runId, view: 'details' } }]
}

/**
 * @param {{ server: import('@modelcontextprotocol/server').McpServer, client?: NaxControlPlaneClient, resolveClient?: import('../routing').McpClientResolver }} input
 */
function registerPlanTools({ server, client, resolveClient }) {
  const resolve = mcpClientResolver({ client, resolveClient })
  server.registerTool('workflow_plan', TOOL_SPECS.workflow_plan, async ({
    scope_id: scopeId,
    workflow_id: workflowId,
    branch,
    instances,
    step_instances: stepInstances,
    context: planContext,
    only_step: onlyStep,
    from_step: fromStep,
  }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    /** @type {NaxControlPlaneClient | undefined} */
    let selectedClient
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      selectedClient = resolved.client
      const plan = await selectedClient.createWorkflowPlan({
        workflowId,
        ...(branch ? { branch } : {}),
        ...(instances ? { instances } : {}),
        ...(stepInstances ? { stepInstances } : {}),
        ...(planContext ? { context: planContext } : {}),
        ...(onlyStep ? { onlyStep } : {}),
        ...(fromStep ? { fromStep } : {}),
      })
      return successResult({ summary: planApprovalSummary(plan), data: plan, context, nextActions: planNextActions(plan) })
    } catch (error) {
      const candidates = selectedClient ? await workflowCandidates(selectedClient, error) : []
      return errorResult(error, { toolName: 'workflow_plan', context, candidates })
    }
  })

  server.registerTool('agent_run_plan', TOOL_SPECS.agent_run_plan, async ({ scope_id: scopeId, prompt, instance, branch }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      const plan = await resolved.client.createAgentRunPlan({ prompt, instance, ...(branch ? { branch } : {}) })
      return successResult({ summary: planApprovalSummary(plan), data: plan, context, nextActions: planNextActions(plan) })
    } catch (error) {
      return errorResult(error, { toolName: 'agent_run_plan', context })
    }
  })

  server.registerTool('run_start', TOOL_SPECS.run_start, async ({ scope_id: scopeId, plan_id: planId, request_id: requestId }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      const result = await resolved.client.startPlan(planId, requestId)
      return successResult({ summary: runStartSummary(result), data: result, context, nextActions: runStartNextActions(result) })
    } catch (error) {
      return errorResult(error, { toolName: 'run_start', context })
    }
  })
}

module.exports = {
  planApprovalSummary,
  planNextActions,
  registerPlanTools,
  runStartNextActions,
  runStartSummary,
  warningSummary,
}
