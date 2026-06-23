const { saveRunState } = require('../storage/local/run-state')

const HUMAN_REVIEW_ACTION = 'human-review'
const HUMAN_REVIEW_WAIT_FOR = 'human-review'
const HUMAN_REVIEW_SUBMIT = 'human-review'
const AWAITING_REVIEW = 'awaiting_review'

/**
 * Review metadata persisted on a human review step.
 * @typedef {{
 *   status?: string,
 *   requestedAt?: string,
 *   approvedAt?: string,
 *   cancelledAt?: string,
 *   reviewer?: string,
 *   reason?: string,
 *   instructions?: string,
 *   defaultAction?: string,
 *   timeout?: string,
 * }} HumanReviewMetadata
 *
 * Workflow step shape with human-review configuration.
 * @typedef {import('../types').WorkflowStep & {
 *   defaultAction?: string,
 *   timeout?: string,
 *   review?: HumanReviewMetadata,
 * }} HumanReviewStep
 *
 * Clock option for deterministic human-review state updates.
 * @typedef {{
 *   now?: Date,
 * }} HumanReviewClockOptions
 *
 * Input for approving or cancelling a human-review gate.
 * @typedef {{
 *   runState: import('../types').WorkflowRunState,
 *   stepId?: string,
 *   reviewer?: string,
 *   reason?: string,
 *   now?: Date,
 * }} HumanReviewGateInput
 */

/** @param {HumanReviewStep} [step] @returns {boolean} */
function isHumanReviewStep(step = {}) {
  return String(step.type || step.action || '').trim() === HUMAN_REVIEW_ACTION
}

/**
 * @param {HumanReviewStep} [step]
 * @param {HumanReviewClockOptions} [options]
 * @returns {import('../types').WorkflowStep}
 */
function createHumanReviewStepState(step = {}, { now = new Date() } = {}) {
  const at = now.toISOString()
  return {
    id: step.id || 'human-review',
    title: step.title || step.id || 'Human Review',
    description: step.description || '',
    action: HUMAN_REVIEW_ACTION,
    submit: HUMAN_REVIEW_SUBMIT,
    waitFor: HUMAN_REVIEW_WAIT_FOR,
    agents: [],
    status: AWAITING_REVIEW,
    runs: [],
    review: {
      status: AWAITING_REVIEW,
      requestedAt: at,
      instructions: step.review?.instructions || step.description || '',
      defaultAction: step.review?.defaultAction || step.defaultAction || 'pause',
      timeout: step.review?.timeout || step.timeout || '',
    },
  }
}

/**
 * @param {import('../types').WorkflowRunState} [runState]
 * @param {string} [stepId]
 * @returns {import('../types').WorkflowStep | null}
 */
function findReviewStep(runState = {}, stepId = '') {
  const steps = Array.isArray(runState.steps) ? runState.steps : []
  if (stepId) return steps.find((step) => step.id === stepId) || null
  return steps.find((step) => step.status === AWAITING_REVIEW || step.review?.status === AWAITING_REVIEW) || null
}

/** @param {HumanReviewGateInput} input @returns {import('../types').WorkflowRunState} */
function approveHumanReviewGate({ runState, stepId = '', reviewer = 'dashboard', now = new Date() }) {
  const target = findReviewStep(runState, stepId)
  if (!target) {
    const error = /** @type {Error & { code?: string }} */ (new Error('No human review gate is awaiting approval for this workflow.'))
    error.code = 'no_review_gate'
    throw error
  }
  const at = now.toISOString()
  const steps = (Array.isArray(runState.steps) ? runState.steps : []).map((step) => {
    if (step !== target) return step
    return {
      ...step,
      status: 'completed',
      review: {
        ...(step.review || {}),
        status: 'approved',
        approvedAt: at,
        reviewer,
      },
    }
  })
  return saveRunState({
    ...runState,
    status: 'running',
    steps,
  })
}

/** @param {HumanReviewGateInput} input @returns {import('../types').WorkflowRunState} */
function cancelHumanReviewGate({ runState, stepId = '', reviewer = 'dashboard', reason = 'cancelled by reviewer', now = new Date() }) {
  const target = findReviewStep(runState, stepId)
  if (!target) {
    const error = /** @type {Error & { code?: string }} */ (new Error('No human review gate is awaiting cancellation for this workflow.'))
    error.code = 'no_review_gate'
    throw error
  }
  const at = now.toISOString()
  const steps = (Array.isArray(runState.steps) ? runState.steps : []).map((step) => {
    if (step !== target) return step
    return {
      ...step,
      status: 'cancelled',
      review: {
        ...(step.review || {}),
        status: 'cancelled',
        cancelledAt: at,
        reviewer,
        reason,
      },
    }
  })
  return saveRunState({
    ...runState,
    status: 'cancelled',
    cancelledAt: at,
    cancelReason: reason,
    steps,
  })
}

module.exports = {
  AWAITING_REVIEW,
  HUMAN_REVIEW_ACTION,
  HUMAN_REVIEW_SUBMIT,
  HUMAN_REVIEW_WAIT_FOR,
  approveHumanReviewGate,
  cancelHumanReviewGate,
  createHumanReviewStepState,
  findReviewStep,
  isHumanReviewStep,
}
