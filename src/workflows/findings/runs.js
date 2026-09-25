// Chooses which saved workflow run findings handoff should read.
// Eligible: terminal status with results (completed, partial, or failed) and a findings declaration.
const { listRunStates } = require('../../storage/local/run-state')

const FINDINGS_RUN_STATUSES = new Set(['completed', 'completed_with_failures', 'failed'])

/**
 * @param {import('../../types').WorkflowRunState} state
 * @returns {boolean}
 */
function isEligibleFindingsRun(state) {
  if (!FINDINGS_RUN_STATUSES.has(String(state.status || ''))) return false
  const declaration = state.flow && state.flow.findings
  if (!declaration) return false
  const step = (state.steps || []).find((candidate) => candidate.id === declaration.step)
  return (step?.runs || []).some((run) => run.status === 'completed' && String(run.resultText || '').trim())
}

/**
 * Returns the run with the given id, or the newest eligible findings run.
 * @param {string} projectRoot
 * @param {string} [runId]
 * @returns {import('../../types').WorkflowRunState | null}
 */
function resolveFindingsRun(projectRoot, runId = '') {
  const states = listRunStates(projectRoot)
  if (runId) return states.find((state) => state.runId === runId) || null
  return states.find(isEligibleFindingsRun) || null
}

module.exports = {
  isEligibleFindingsRun,
  resolveFindingsRun,
}
