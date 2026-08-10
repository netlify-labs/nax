const { sha256 } = require('./planner')

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

/** @param {string} prefix @param {string[]} parts */
function opaqueControlPlaneId(prefix, parts) {
  return `${prefix}_${sha256(parts.join('\0')).slice(0, 32)}`
}

/** @param {string} runId @param {string} stepId @param {Record<string, unknown>} agentRun @param {number} index */
function controlPlaneAgentRunId(runId, stepId, agentRun, index) {
  return opaqueControlPlaneId('agent_run', [
    runId,
    stepId,
    stringValue(agentRun.runnerId),
    stringValue(agentRun.sessionId),
    stringValue(agentRun.instanceId),
    stringValue(agentRun.agent),
    String(index),
  ])
}

/** @param {string} runId @param {string} stepId */
function controlPlaneReviewGateId(runId, stepId) {
  return opaqueControlPlaneId('review_gate', [runId, stepId])
}

module.exports = {
  controlPlaneAgentRunId,
  controlPlaneReviewGateId,
  opaqueControlPlaneId,
}
