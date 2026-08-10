/** @typedef {import('../contracts').NaxControlPlanePorts} NaxControlPlanePorts */

const REQUIRED_PORT_METHODS = Object.freeze([
  'authorize',
  'getContext',
  'listWorkflows',
  'getWorkflow',
  'createWorkflowPlan',
  'createAgentRunPlan',
  'startPlan',
  'listRuns',
  'getRun',
  'waitForRun',
  'cancelRun',
  'retryAgentRun',
  'submitFollowup',
  'resolveReviewGate',
  'getArtifact',
])

/**
 * Validates the complete runtime-neutral port set at composition time.
 * @param {unknown} value
 * @returns {NaxControlPlanePorts}
 */
function assertNaxControlPlanePorts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('NaxControlPlane ports must be an object.')
  }

  const candidate = /** @type {Record<string, unknown>} */ (value)
  const missing = REQUIRED_PORT_METHODS.filter((method) => typeof candidate[method] !== 'function')
  if (missing.length > 0) {
    throw new TypeError(`NaxControlPlane ports are missing: ${missing.join(', ')}`)
  }
  return /** @type {NaxControlPlanePorts} */ (value)
}

module.exports = {
  REQUIRED_PORT_METHODS,
  assertNaxControlPlanePorts,
}
