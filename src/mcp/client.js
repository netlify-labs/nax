/** @typedef {import('../contracts').ControlPlaneActor} ControlPlaneActor */
/** @typedef {import('../contracts').ControlPlaneScope} ControlPlaneScope */
/** @typedef {import('../contracts').NaxControlPlane} NaxControlPlane */
/** @typedef {import('../contracts').NaxControlPlaneClient} NaxControlPlaneClient */

/**
 * Binds one authenticated actor and one immutable project scope to the
 * transport-neutral control plane. MCP tool handlers use this facade instead
 * of importing a dashboard, desktop, or hosted runtime adapter directly.
 *
 * @param {{
 *   controlPlane: NaxControlPlane,
 *   scope: ControlPlaneScope,
 *   actor: ControlPlaneActor,
 * }} input
 * @returns {NaxControlPlaneClient}
 */
function createMcpControlPlaneClient({ controlPlane, scope, actor }) {
  if (!controlPlane || typeof controlPlane !== 'object') throw new TypeError('controlPlane is required.')
  if (!scope || typeof scope !== 'object') throw new TypeError('scope is required.')
  if (!actor || typeof actor !== 'object') throw new TypeError('actor is required.')
  const boundScope = Object.freeze({ ...scope })
  const boundActor = Object.freeze({ ...actor })

  return Object.freeze({
    getContext: () => controlPlane.getContext(boundScope, boundActor),
    listWorkflows: (query) => controlPlane.listWorkflows(boundScope, boundActor, query),
    getWorkflow: (workflowId, options) => controlPlane.getWorkflow(boundScope, boundActor, workflowId, options),
    createWorkflowPlan: (planInput) => controlPlane.createWorkflowPlan(boundScope, boundActor, planInput),
    createAgentRunPlan: (planInput) => controlPlane.createAgentRunPlan(boundScope, boundActor, planInput),
    startPlan: (planId, requestId) => controlPlane.startPlan(boundScope, boundActor, planId, requestId),
    listRuns: (query) => controlPlane.listRuns(boundScope, boundActor, query),
    getRun: (runId, options) => controlPlane.getRun(boundScope, boundActor, runId, options),
    waitForRun: (runId, cursor, timeoutMs, signal) => controlPlane.waitForRun(boundScope, boundActor, runId, cursor, timeoutMs, signal),
    cancelRun: (target) => controlPlane.cancelRun(boundScope, boundActor, target),
    retryAgentRun: (retryInput) => controlPlane.retryAgentRun(boundScope, boundActor, retryInput),
    submitFollowup: (followupInput) => controlPlane.submitFollowup(boundScope, boundActor, followupInput),
    resolveReviewGate: (reviewInput) => controlPlane.resolveReviewGate(boundScope, boundActor, reviewInput),
    getArtifact: (runId, artifactId) => controlPlane.getArtifact(boundScope, boundActor, runId, artifactId),
  })
}

module.exports = {
  createMcpControlPlaneClient,
}
