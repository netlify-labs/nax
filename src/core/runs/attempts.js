// Pure attempt records: metadata for superseded run attempts (lineage, status, usage, timing).
// Shared by the engine (when replacing an attempt) and run-state merging (when archiving stale writers).

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

module.exports = {
  attemptRecord,
}
