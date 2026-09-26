// Terminal run transitions: mark a run completed and write run-level artifacts such as findings.json.
// Artifact failures are reported as warnings and never change the run's status or exit code.
const { markRunCompleted } = require('../storage/local/graceful-run-state')
const { writeFindings } = require('./findings')

/**
 * Writes findings.json for a run that reached a terminal state (completed or failed).
 * @param {import('../types').WorkflowRunState} runState
 * @param {{ write?: typeof writeFindings, warn?: (message: string) => void }} [deps]
 * @returns {import('./findings').FindingsArtifact | null}
 */
function writeFindingsAtTerminal(runState, { write = writeFindings, warn = (message) => console.error('nax findings', message) } = {}) {
  try {
    return write(runState, runState.flow || null)
  } catch (error) {
    warn(`findings.json could not be written: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Marks a run completed and writes its terminal artifacts.
 * @param {import('../types').WorkflowRunState} runState
 * @param {{ now?: Date }} [options]
 */
function completeRun(runState, options = {}) {
  const saved = markRunCompleted(runState, options)
  writeFindingsAtTerminal(runState)
  return saved
}

module.exports = {
  completeRun,
  writeFindingsAtTerminal,
}
