const { isTerminalRunStatus } = require('../status')

/**
 * @param {{ runs?: Array<{ runnerId?: unknown, issueNumber?: unknown, status?: unknown }> } | null | undefined} step
 * @returns {boolean}
 */
function hasInFlightRuns(step) {
  return (step?.runs || []).some((run) => {
    if (!run.runnerId && !run.issueNumber) return false
    return !isTerminalRunStatus(run.status)
  })
}

/**
 * @param {{ runs?: Array<{ runnerId?: unknown, issueNumber?: unknown, status?: string, resultText?: unknown }> } | null | undefined} step
 * @returns {boolean}
 */
function hasRepairableRuns(step) {
  return (step?.runs || []).some((run) => {
    if (!run.runnerId && !run.issueNumber) return false
    if (run.status === 'completed' && run.resultText) return false
    return ['submitted', 'running'].includes(run.status || '')
  })
}

/**
 * @param {{ status?: string, runs?: Array<{ status?: string }> } | null | undefined} step
 * @returns {boolean}
 */
function isCompletedStep(step) {
  if (!step) return false
  if (step.status === 'completed' || step.status === 'dry-run') return true
  const runs = Array.isArray(step.runs) ? step.runs : []
  return runs.length > 0 && runs.every((run) => run.status === 'completed' || run.status === 'dry-run')
}

/**
 * @param {{
 *   status?: string,
 *   flow?: { steps?: Array<{ id?: string }> },
 *   steps?: Array<{ id?: string, status?: string, runs?: Array<{ status?: string }> }>,
 * } | null | undefined} state
 * @returns {boolean}
 */
function hasRemainingInterruptedSteps(state) {
  if (state?.status !== 'interrupted') return false
  const flowSteps = Array.isArray(state.flow?.steps) ? state.flow.steps : []
  const savedSteps = Array.isArray(state.steps) ? state.steps : []
  if (flowSteps.length === 0 || savedSteps.length === 0) return false

  const savedById = new Map(savedSteps.map((step) => [step.id, step]))
  for (const flowStep of flowSteps) {
    const saved = savedById.get(flowStep.id)
    if (!saved) return true
    if (!isCompletedStep(saved)) return false
  }
  return false
}

/** @param {unknown} transport @returns {boolean} */
function isNetlifyApiTransport(transport) {
  return transport === 'netlify-api' || transport === 'local'
}

/**
 * @param {unknown} candidate
 * @param {unknown} requested
 * @returns {boolean}
 */
function transportMatches(candidate, requested) {
  if (!requested) return true
  if (isNetlifyApiTransport(requested)) return isNetlifyApiTransport(candidate)
  return candidate === requested
}

/**
 * @param {{
 *   status?: string,
 *   dismissedAt?: unknown,
 *   flow?: { steps?: Array<{ id?: string }> },
 *   steps?: Array<{
 *     id?: string,
 *     status?: string,
 *     runs?: Array<{ runnerId?: unknown, issueNumber?: unknown, status?: string, resultText?: unknown }>,
 *   }>,
 * } | null | undefined} state
 * @returns {boolean}
 */
function isUnfinishedRun(state) {
  if (state?.status === 'dismissed' || state?.dismissedAt) return false
  if (!Array.isArray(state.steps) || state.steps.length === 0) return false
  if (state?.status === 'awaiting_review') return true
  if (hasRemainingInterruptedSteps(state)) return true
  return state.steps.some((step) => {
    return step.status === 'running' ||
      step.status === 'submitted' ||
      step.status === 'awaiting_review' ||
      hasInFlightRuns(step) ||
      hasRepairableRuns(step)
  })
}

/**
 * @param {Parameters<typeof isUnfinishedRun>[0] & { transport?: unknown }} state
 * @returns {boolean}
 */
function isUnfinishedLocalRun(state) {
  if (!isNetlifyApiTransport(state?.transport)) return false
  return isUnfinishedRun(state)
}

module.exports = {
  hasInFlightRuns,
  hasRemainingInterruptedSteps,
  hasRepairableRuns,
  isCompletedStep,
  isNetlifyApiTransport,
  isUnfinishedLocalRun,
  isUnfinishedRun,
  transportMatches,
}
