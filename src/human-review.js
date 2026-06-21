const { saveRunState } = require('./run-state')

const HUMAN_REVIEW_ACTION = 'human-review'
const HUMAN_REVIEW_WAIT_FOR = 'human-review'
const HUMAN_REVIEW_SUBMIT = 'human-review'
const AWAITING_REVIEW = 'awaiting_review'

function isHumanReviewStep(step = {}) {
  return String(step.type || step.action || '').trim() === HUMAN_REVIEW_ACTION
}

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

function findReviewStep(runState = {}, stepId = '') {
  const steps = Array.isArray(runState.steps) ? runState.steps : []
  if (stepId) return steps.find((step) => step.id === stepId) || null
  return steps.find((step) => step.status === AWAITING_REVIEW || step.review?.status === AWAITING_REVIEW) || null
}

function approveHumanReviewGate({ runState, stepId = '', reviewer = 'visualizer', now = new Date() }) {
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

function cancelHumanReviewGate({ runState, stepId = '', reviewer = 'visualizer', reason = 'cancelled by reviewer', now = new Date() }) {
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
