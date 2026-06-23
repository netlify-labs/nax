const path = require('path')

const { normalizeAgentList, normalizeStepModels } = require('../../core/agents/selection')
const { isUnfinishedRun } = require('../../core/runs/resumable')
const { isCancelledRunStatus, isFailedRunStatus } = require('../../core/status')

/** @typedef {import('../../contracts').DashboardRun} DashboardRun */

/** @returns {DashboardRun | null} */
function contractTypecheckProbe() {
  return null
}

function publicFlow(flow = {}) {
  return {
    id: flow.id || '',
    title: flow.title || '',
    description: flow.description || '',
    source: flow.source || '',
    sourceLabel: flow.sourceLabel || '',
    sourceDir: flow.sourceDir || '',
    sourcePriority: flow.sourcePriority ?? null,
    dir: flow.dir || '',
    file: flow.file || '',
    defaults: flow.defaults || {},
    options: flow.options || {},
    steps: Array.isArray(flow.steps)
      ? flow.steps.map((step) => ({
        id: step.id || '',
        title: step.title || '',
        description: step.description || '',
        prompt: step.prompt || '',
        type: step.type || '',
        action: step.action || '',
        submit: step.submit || '',
        agents: Array.isArray(step.agents) ? step.agents : [],
        input: Array.isArray(step.input) ? step.input : [],
        waitFor: step.waitFor || '',
        review: step.review || null,
        autoArchive: step.autoArchive,
        isArchivable: step.isArchivable,
      }))
      : [],
  }
}

function inferRunStateStatus(runState = {}) {
  const steps = Array.isArray(runState.steps) ? runState.steps : []
  if (steps.length === 0) return ''

  const statuses = steps.map((step) => String(step?.status || '').toLowerCase()).filter(Boolean)
  if (statuses.some((status) => isFailedRunStatus(status))) {
    return 'failed'
  }
  if (statuses.some((status) => isCancelledRunStatus(status))) return 'cancelled'
  if (runState?.status === 'awaiting_review' || statuses.some((status) => status === 'awaiting_review')) {
    return 'awaiting_review'
  }
  if (statuses.length === steps.length && statuses.every((status) => ['complete', 'completed', 'dry-run'].includes(status))) {
    return 'completed'
  }
  if (statuses.some((status) => ['running', 'submitted', 'submitting', 'pending', 'waiting', 'retrying', 'queued'].includes(status))) {
    return 'running'
  }
  return statuses[statuses.length - 1] || ''
}

function publicRunState(runState = {}) {
  const summaryPath = runState.dir ? path.join(runState.dir, 'artifacts', 'summary.md') : ''
  return {
    runId: runState.runId || '',
    flowId: runState.flowId || '',
    flowTitle: runState.flowTitle || '',
    status: runState.status || inferRunStateStatus(runState),
    transport: runState.transport || '',
    branch: runState.branch || '',
    target: runState.target || null,
    createdAt: runState.createdAt || '',
    updatedAt: runState.updatedAt || '',
    dir: runState.dir || '',
    summaryPath,
    resumable: isUnfinishedRun(runState),
    steps: Array.isArray(runState.steps) ? runState.steps : [],
  }
}

function publicRunOptions(runState = {}) {
  const options = runState.options || {}
  return {
    branch: options.branch || runState.branch || '',
    target: runState.target || options.target || null,
    transport: options.transport || runState.transport || '',
    models: normalizeAgentList(options.models),
    stepModels: normalizeStepModels(options.stepModels),
    context: options.context || '',
    step: options.step || '',
    fromStep: options.fromStep || '',
  }
}

module.exports = {
  contractTypecheckProbe,
  inferRunStateStatus,
  publicFlow,
  publicRunOptions,
  publicRunState,
}
