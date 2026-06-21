const {
  CANCELLED_RUN_STATUS_VALUES,
  FAILED_RUN_STATUS_VALUES,
  TERMINAL_RUN_STATUS_VALUES,
} = require('./constants')

const TERMINAL_RUN_STATUSES = new Set(TERMINAL_RUN_STATUS_VALUES)
const CANCELLED_RUN_STATUSES = new Set(CANCELLED_RUN_STATUS_VALUES)
const FAILED_RUN_STATUSES = new Set(FAILED_RUN_STATUS_VALUES)

function normalizeStatus(status = '') {
  return String(status || '').trim().toLowerCase()
}

function isTerminalRunStatus(status = '') {
  return TERMINAL_RUN_STATUSES.has(normalizeStatus(status))
}

function isCancelledRunStatus(status = '') {
  return CANCELLED_RUN_STATUSES.has(normalizeStatus(status))
}

function isFailedRunStatus(status = '') {
  return FAILED_RUN_STATUSES.has(normalizeStatus(status))
}

module.exports = {
  CANCELLED_RUN_STATUSES,
  FAILED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  isCancelledRunStatus,
  isFailedRunStatus,
  isTerminalRunStatus,
  normalizeStatus,
}
