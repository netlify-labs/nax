// Attempt model: step.runs holds the current attempt per instance slot; superseded attempts move
// to step.attempts with their lineage, usage and a link to their attempt artifact.
const { attemptArtifactPath } = require('../artifacts/workflow-artifacts')

/**
 * @typedef {{
 *   attemptId: string,
 *   supersedesAttemptId: string | null,
 *   instanceId: string,
 *   agent: string,
 *   model?: string,
 *   effort?: string,
 *   status: string,
 *   error: string,
 *   failurePhase: string,
 *   runnerId: string,
 *   sessionId: string,
 *   usage: import('../../types').JsonMap | null,
 *   resultTextPath: string,
 *   sentAt: string,
 *   finishedAt: string,
 * }} AttemptRecord
 */

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/**
 * Metadata-only record of a run attempt; the full result text stays in its attempt artifact.
 * @param {import('../../types').AgentRun} run
 * @param {{ resultTextPath?: string }} [options]
 * @returns {AttemptRecord}
 */
function attemptRecord(run, { resultTextPath = '' } = {}) {
  const raw = /** @type {Record<string, unknown>} */ (run.raw || {})
  return {
    attemptId: text(run.attemptId),
    supersedesAttemptId: run.supersedesAttemptId ? text(run.supersedesAttemptId) : null,
    instanceId: text(run.instanceId || run.agent),
    agent: text(run.agent),
    ...(run.model ? { model: text(run.model) } : {}),
    ...(run.effort ? { effort: text(run.effort) } : {}),
    status: text(run.status),
    error: text(run.error || raw.submissionError),
    failurePhase: text(raw.failurePhase),
    runnerId: text(run.runnerId),
    sessionId: text(run.sessionId),
    usage: run.usage && typeof run.usage === 'object' ? /** @type {import('../../types').JsonMap} */ (run.usage) : null,
    resultTextPath,
    sentAt: text(run.sentAt),
    finishedAt: text(/** @type {Record<string, unknown>} */ (run).completedAt || /** @type {Record<string, unknown>} */ (run).updatedAt),
  }
}

/**
 * Replaces the current attempt at `index` with `replacement`, archiving the old attempt once.
 * @param {import('../../types').WorkflowRunState} runState
 * @param {import('../../types').WorkflowStep & { attempts?: AttemptRecord[] }} step
 * @param {number} index
 * @param {import('../../types').AgentRun} replacement
 * @returns {import('../../types').AgentRun}
 */
function supersedeRun(runState, step, index, replacement) {
  const previous = (step.runs || [])[index]
  if (previous) {
    const record = attemptRecord(previous, { resultTextPath: attemptArtifactPath(runState, step, previous) })
    const attempts = step.attempts || []
    if (!record.attemptId || !attempts.some((attempt) => attempt.attemptId === record.attemptId)) attempts.push(record)
    step.attempts = attempts
    replacement.supersedesAttemptId = previous.attemptId ? text(previous.attemptId) : null
  }
  step.runs = step.runs || []
  step.runs[index] = replacement
  return replacement
}

module.exports = {
  attemptRecord,
  supersedeRun,
}
