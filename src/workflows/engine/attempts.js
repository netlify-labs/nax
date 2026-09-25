// Attempt model: step.runs holds the current attempt per instance slot; superseded attempts move
// to step.attempts with their lineage, usage and a link to their attempt artifact.
const { attemptArtifactPath } = require('../artifacts/workflow-artifacts')
const { attemptRecord } = require('../../core/runs/attempts')

/** @typedef {import('../../core/runs/attempts').AttemptRecord} AttemptRecord */

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
    replacement.supersedesAttemptId = previous.attemptId ? String(previous.attemptId) : null
  }
  step.runs = step.runs || []
  step.runs[index] = replacement
  return replacement
}

module.exports = {
  supersedeRun,
}
