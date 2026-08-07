const path = require('path')

const { normalizeAgentList, normalizeStepAgents } = require('../../core/agents/selection')
const {
  normalizeProviderEffortMap,
  normalizeProviderModelMap,
  normalizeStepProviderEffortMap,
  normalizeStepProviderModelMap,
} = require('../../core/agents/configuration')
const { isActiveProjectedStatus, projectRunSnapshot } = require('./run-state-projection')

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
        models: step.models || {},
        efforts: step.efforts || {},
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
  const snapshot = projectRunSnapshot({ ...runState, status: '' })
  return snapshot.status === 'unknown' ? '' : snapshot.status
}

function publicRunState(runState = {}) {
  const snapshot = projectRunSnapshot(runState)
  const summaryPath = snapshot.dir ? path.join(snapshot.dir, 'artifacts', 'summary.md') : ''
  return {
    runId: snapshot.runId,
    flowId: snapshot.flowId,
    flowTitle: snapshot.flowTitle,
    status: snapshot.status,
    transport: snapshot.transport,
    branch: snapshot.branch,
    target: snapshot.target,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    dir: snapshot.dir,
    summaryPath,
    resumable: snapshot.resumable,
    cancellable: snapshot.cancellable,
    steps: snapshot.steps,
    diagnostics: snapshot.diagnostics,
  }
}

function publicRunOptions(runState = {}) {
  const options = runState.options || {}
  return {
    branch: options.branch || runState.branch || '',
    target: runState.target || options.target || null,
    transport: options.transport || runState.transport || '',
    agents: normalizeAgentList(options.agents),
    stepAgents: normalizeStepAgents(options.stepAgents),
    models: normalizeProviderModelMap(options.models),
    efforts: normalizeProviderEffortMap(options.efforts),
    stepModels: normalizeStepProviderModelMap(options.stepModels),
    stepEfforts: normalizeStepProviderEffortMap(options.stepEfforts),
    context: options.context || '',
    step: options.step || '',
    fromStep: options.fromStep || '',
  }
}

module.exports = {
  contractTypecheckProbe,
  inferRunStateStatus,
  isActiveProjectedStatus,
  projectRunSnapshot,
  publicFlow,
  publicRunOptions,
  publicRunState,
}
