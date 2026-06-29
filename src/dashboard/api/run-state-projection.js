const { isUnfinishedRun } = require('../../core/runs/resumable')
const { isCancelledRunStatus, isFailedRunStatus } = require('../../core/status')

const STATUS_ALIASES = {
  canceled: 'cancelled',
  complete: 'completed',
  error: 'failed',
  executing: 'running',
  pending: 'running',
  processing: 'running',
  queued: 'running',
  retrying: 'running',
  submitted: 'running',
  submitting: 'running',
  timeout: 'failed',
  waiting: 'running',
}

const ACTIVE_STATUSES = new Set(['booting', 'running'])
const COMPLETED_STATUSES = new Set(['completed', 'dry-run'])
const CANCELLED_STATUSES = new Set(['abandoned', 'cancelled', 'dismissed'])
const TERMINAL_STATUSES = new Set([...COMPLETED_STATUSES, ...CANCELLED_STATUSES, 'failed', 'skipped'])
const REVIEW_STATUSES = new Set(['awaiting_review', 'interrupted'])

/**
 * @typedef {{
 *   code: string,
 *   message: string,
 *   path?: string,
 *   storedStatus?: string,
 *   projectedStatus?: string,
 * }} RunProjectionDiagnostic
 *
 * @typedef {{
 *   runId: string,
 *   flowId: string,
 *   flowTitle: string,
 *   status: string,
 *   storedStatus: string,
 *   transport: string,
 *   branch: string,
 *   target: import('../../storage/interfaces').JsonObject | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   completedAt: string,
 *   dir: string,
 *   resumable: boolean,
 *   cancellable: boolean,
 *   steps: Array<Record<string, unknown>>,
 *   diagnostics: RunProjectionDiagnostic[],
 * }} ProjectedRunSnapshot
 */

/** @param {unknown} status @returns {string} */
function statusKey(status = '') {
  const normalized = String(status || '').trim().toLowerCase()
  return STATUS_ALIASES[normalized] || normalized
}

/** @param {unknown} status @returns {boolean} */
function isActiveProjectedStatus(status = '') {
  return ACTIVE_STATUSES.has(statusKey(status))
}

/** @param {unknown} status @returns {boolean} */
function isTerminalProjectedStatus(status = '') {
  return TERMINAL_STATUSES.has(statusKey(status))
}

/** @param {unknown} status @returns {boolean} */
function isReviewProjectedStatus(status = '') {
  return REVIEW_STATUSES.has(statusKey(status))
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {Record<string, unknown>} step @returns {Array<Record<string, unknown>>} */
function runList(step) {
  return Array.isArray(step.runs) ? step.runs.map(objectValue) : []
}

/** @param {Array<Record<string, unknown>>} runs @returns {string} */
function statusFromRuns(runs) {
  const statuses = runs.map((run) => statusKey(run.status)).filter(Boolean)
  if (statuses.length === 0) return ''
  if (statuses.some((status) => isFailedRunStatus(status) || status === 'failed')) return 'failed'
  if (statuses.some((status) => isCancelledRunStatus(status) || CANCELLED_STATUSES.has(status))) return 'cancelled'
  if (statuses.some(isReviewProjectedStatus)) return 'awaiting_review'
  if (statuses.some(isActiveProjectedStatus)) return 'running'
  if (statuses.every((status) => COMPLETED_STATUSES.has(status) || status === 'skipped')) return 'completed'
  return statuses[statuses.length - 1] || ''
}

/**
 * @param {Record<string, unknown>} step
 * @param {number} index
 * @param {RunProjectionDiagnostic[]} diagnostics
 * @returns {Record<string, unknown>}
 */
function projectStep(step, index, diagnostics) {
  const projectedRuns = runList(step).map((run) => ({
    ...run,
    status: statusKey(run.status),
  }))
  const storedStatus = statusKey(step.status)
  const runStatus = statusFromRuns(projectedRuns)
  const projectedStatus = runStatus || storedStatus
  if (storedStatus && runStatus && storedStatus !== runStatus) {
    diagnostics.push({
      code: 'step_status_conflict',
      message: 'Stored step status conflicts with nested agent run status.',
      path: `steps.${index}.status`,
      storedStatus,
      projectedStatus,
    })
  }
  return {
    ...step,
    status: projectedStatus,
    runs: projectedRuns,
  }
}

/** @param {Array<Record<string, unknown>>} steps @returns {string} */
function statusFromSteps(steps) {
  const statuses = steps.map((step) => statusKey(step.status)).filter(Boolean)
  if (statuses.length === 0) return ''
  if (statuses.some((status) => status === 'failed' || isFailedRunStatus(status))) return 'failed'
  if (statuses.some((status) => status === 'cancelled' || isCancelledRunStatus(status) || CANCELLED_STATUSES.has(status))) return 'cancelled'
  if (statuses.some(isReviewProjectedStatus)) return 'awaiting_review'
  if (statuses.some(isActiveProjectedStatus)) return 'running'
  if (statuses.length === steps.length && statuses.every((status) => COMPLETED_STATUSES.has(status) || status === 'skipped')) return 'completed'
  return statuses[statuses.length - 1] || ''
}

/** @param {Record<string, unknown>} runState @returns {string} */
function completedAt(runState) {
  for (const key of ['completedAt', 'exitedAt', 'cancelledAt', 'canceledAt', 'failedAt', 'dismissedAt']) {
    if (typeof runState[key] === 'string' && runState[key]) return runState[key]
  }
  return ''
}

/** @param {Record<string, unknown>} runState @returns {string} */
function flowTitle(runState) {
  if (typeof runState.flowTitle === 'string') return runState.flowTitle
  const flow = objectValue(runState.flow)
  return typeof flow.title === 'string' ? flow.title : ''
}

/** @param {Record<string, unknown>} runState @param {{ cancellable?: boolean }} [options] @returns {ProjectedRunSnapshot} */
function projectRunSnapshot(runState = {}, options = {}) {
  const diagnostics = []
  const steps = Array.isArray(runState.steps)
    ? runState.steps.map((step, index) => projectStep(objectValue(step), index, diagnostics))
    : []
  const storedStatus = statusKey(runState.status)
  const stepStatus = statusFromSteps(steps)
  let status = storedStatus || stepStatus || 'unknown'
  const target = runState.target && typeof runState.target === 'object' && !Array.isArray(runState.target)
    ? /** @type {import('../../storage/interfaces').JsonObject} */ (runState.target)
    : null

  if (stepStatus && storedStatus && stepStatus !== storedStatus) {
    diagnostics.push({
      code: 'workflow_status_conflict',
      message: 'Stored workflow status conflicts with projected step status.',
      path: 'status',
      storedStatus,
      projectedStatus: stepStatus,
    })
  }

  if (storedStatus === 'dismissed') {
    status = storedStatus
  } else if (!storedStatus || !isTerminalProjectedStatus(storedStatus) || (stepStatus && isActiveProjectedStatus(stepStatus))) {
    status = stepStatus || storedStatus || 'unknown'
  }

  const resumable = isUnfinishedRun({ ...runState, status })
  const cancellable = options.cancellable === true && isActiveProjectedStatus(status)
  return {
    runId: typeof runState.runId === 'string' ? runState.runId : '',
    flowId: typeof runState.flowId === 'string' ? runState.flowId : '',
    flowTitle: flowTitle(runState),
    status,
    storedStatus,
    transport: typeof runState.transport === 'string' ? runState.transport : '',
    branch: typeof runState.branch === 'string' ? runState.branch : '',
    target,
    createdAt: typeof runState.createdAt === 'string' ? runState.createdAt : '',
    updatedAt: typeof runState.updatedAt === 'string' ? runState.updatedAt : '',
    completedAt: completedAt(runState),
    dir: typeof runState.dir === 'string' ? runState.dir : '',
    resumable,
    cancellable,
    steps,
    diagnostics,
  }
}

module.exports = {
  isActiveProjectedStatus,
  isTerminalProjectedStatus,
  projectRunSnapshot,
  statusKey,
}
