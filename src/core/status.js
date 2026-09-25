const {
  CANCELLED_RUN_STATUS_VALUES,
  FAILED_RUN_STATUS_VALUES,
  TERMINAL_RUN_STATUS_VALUES,
} = require('./constants')

const TERMINAL_RUN_STATUSES = new Set(TERMINAL_RUN_STATUS_VALUES)
const CANCELLED_RUN_STATUSES = new Set(CANCELLED_RUN_STATUS_VALUES)
const FAILED_RUN_STATUSES = new Set(FAILED_RUN_STATUS_VALUES)

/** @param {unknown} status @returns {string} */
function normalizeStatus(status = '') {
  return String(status || '').trim().toLowerCase()
}

/** @param {unknown} status @returns {boolean} */
function isTerminalRunStatus(status = '') {
  return TERMINAL_RUN_STATUSES.has(normalizeStatus(status))
}

/** @param {unknown} status @returns {boolean} */
function isCancelledRunStatus(status = '') {
  return CANCELLED_RUN_STATUSES.has(normalizeStatus(status))
}

/** @param {unknown} status @returns {boolean} */
function isFailedRunStatus(status = '') {
  return FAILED_RUN_STATUSES.has(normalizeStatus(status))
}

/** Step statuses after which a workflow moves on to its next step; survivors of a partial step are valid prior results. */
const CONTINUATION_STEP_STATUSES = new Set(['completed', 'dry-run', 'completed_with_failures'])

/**
 * Whether a settled step lets the workflow continue to the next step. A partial final step is
 * rejected separately where the run is settled, because a workflow must not finish on one.
 * @param {unknown} status
 * @returns {boolean}
 */
function stepAllowsContinuation(status = '') {
  return CONTINUATION_STEP_STATUSES.has(normalizeStatus(status))
}

module.exports = {
  CANCELLED_RUN_STATUSES,
  FAILED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  isCancelledRunStatus,
  isFailedRunStatus,
  isTerminalRunStatus,
  normalizeStatus,
  stepAllowsContinuation,
}
