// Attempt model: step.runs holds the current attempt per instance slot; superseded attempts move
// to step.attempts with their lineage, usage and a link to their attempt artifact.
const { attemptArtifactPath } = require('../artifacts/workflow-artifacts')
const { randomUUID } = require('crypto')
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

/**
 * Builds a fresh attempt from a saved run for resubmission. The prompt comes from the saved text
 * (compact when asked), and every remote handle and delivery ref is dropped so the Agent Runner
 * SDK chooses inline or blob delivery again and uploads under a new key; an expired or cleaned
 * blob ref is never reused.
 * @param {import('../../types').AgentRun} saved
 * @param {{ useCompactPrompt?: boolean, existingRunnerId?: string }} [options]
 * @returns {import('../../types').AgentRun}
 */
function resubmissionRun(saved, { useCompactPrompt = false, existingRunnerId = '' } = {}) {
  const raw = /** @type {Record<string, unknown>} */ (saved.raw || {})
  return {
    transport: saved.transport,
    agent: saved.agent,
    instanceId: saved.instanceId,
    attemptId: randomUUID(),
    supersedesAttemptId: saved.attemptId || null,
    ...(saved.model ? { model: saved.model } : {}),
    ...(saved.effort ? { effort: saved.effort } : {}),
    ...(saved.resolvedFrom ? { resolvedFrom: saved.resolvedFrom } : {}),
    ...(saved.instanceLabel ? { instanceLabel: saved.instanceLabel } : {}),
    status: 'pending',
    promptText: useCompactPrompt && saved.compactPromptText ? saved.compactPromptText : saved.promptText,
    compactPromptText: useCompactPrompt ? '' : (saved.compactPromptText || ''),
    promptDelivery: {},
    resultText: '',
    runnerId: '',
    sessionId: '',
    issueUrl: '',
    commentUrl: '',
    prUrl: '',
    deployUrl: '',
    existingRunnerId,
    raw: {
      workflowRunId: raw.workflowRunId,
      stepId: raw.stepId,
      promptName: raw.promptName,
      ...(raw.configurationWarnings ? { configurationWarnings: raw.configurationWarnings } : {}),
    },
  }
}

module.exports = {
  resubmissionRun,
  supersedeRun,
}
