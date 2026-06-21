const { createRunState, saveRunState } = require('./run-state')

function uniqueAgents(runs = []) {
  const seen = new Set()
  const agents = []
  for (const run of runs) {
    const agent = String(run?.agent || '').trim()
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    agents.push(agent)
  }
  return agents
}

function submittedStepStatus(runs = []) {
  if (runs.some((run) => ['failed', 'timeout', 'cancelled', 'canceled'].includes(String(run?.status || '').toLowerCase()))) {
    return 'failed'
  }
  if (runs.length > 0 && runs.every((run) => String(run?.status || '').toLowerCase() === 'completed')) return 'completed'
  return 'submitted'
}

function safeStepId(value, fallback = 'visualizer-followup') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || fallback
}

function followupStepTitle(target = {}, runs = []) {
  const base = target.stepTitle || target.label || 'Follow-up'
  const agents = uniqueAgents(runs)
  if (agents.length === 1) return `Follow up: ${base} (${agents[0]})`
  if (agents.length > 1) return `Follow up: ${base} (${agents.length} agents)`
  return `Follow up: ${base}`
}

/**
 * @param {{
 *   run?: Record<string, any>,
 *   promptText?: string,
 *   source?: Record<string, any>,
 *   timestamp?: string,
 * }} input
 */
function normalizeFollowupRun({ run = {}, promptText = '', source = {}, timestamp = '' } = {}) {
  return {
    transport: run.transport || 'netlify-api',
    agent: run.agent || '',
    status: run.status || 'submitted',
    promptText: run.promptText || promptText,
    compactPromptText: run.compactPromptText || '',
    resultText: run.resultText || '',
    runnerId: run.runnerId || run.existingRunnerId || '',
    sessionId: run.sessionId || '',
    existingRunnerId: run.existingRunnerId || '',
    issueUrl: run.issueUrl || '',
    commentUrl: run.commentUrl || '',
    prUrl: run.prUrl || '',
    deployUrl: run.deployUrl || '',
    links: run.links || {},
    raw: {
      ...(run.raw || {}),
      source,
    },
    createdAt: run.createdAt || timestamp,
    updatedAt: run.updatedAt || timestamp,
  }
}

/**
 * @param {{
 *   runState?: Record<string, any>,
 *   target?: Record<string, any> | null,
 *   source?: Record<string, any>,
 * }} input
 */
function followupSource({ runState = {}, target = null, source = {} } = {}) {
  return {
    type: 'visualizer-followup',
    sourceWorkflowRunId: runState.runId || '',
    sourceTargetId: target?.id || '',
    ...(source || {}),
  }
}

/**
 * Append submitted visualizer follow-ups to the source workflow so the graph and
 * run-details modal retain the accepted runner/session links after the modal closes.
 *
 * @param {{
 *   runState: Record<string, any>,
 *   runs: Array<Record<string, any>>,
 *   source?: Record<string, any>,
 *   promptText?: string,
 *   target?: Record<string, any> | null,
 *   now?: Date,
 * }} input
 */
function appendFollowupRunsToWorkflow({
  runState,
  runs,
  source = {},
  promptText = '',
  target = null,
  now = new Date(),
}) {
  if (!runState?.dir) throw new Error('Cannot append follow-up runs without a workflow state directory.')
  const submittedRuns = Array.isArray(runs) ? runs.filter(Boolean) : []
  if (submittedRuns.length === 0) return runState

  const timestamp = now.toISOString()
  const sourceId = safeStepId(source.id || `followup-${timestamp}`, 'visualizer-followup')
  const stepId = `visualizer-${sourceId}`
  const agents = uniqueAgents(submittedRuns)
  const stepSource = followupSource({ runState, target, source })
  const normalizedRuns = submittedRuns.map((run) => normalizeFollowupRun({
    run,
    promptText,
    source: stepSource,
    timestamp,
  }))
  const sourceStepId = target?.stepId || ''
  const status = submittedStepStatus(normalizedRuns)
  const step = {
    id: stepId,
    title: followupStepTitle(target || {}, submittedRuns),
    description: 'Follow-up submitted from the visualizer.',
    action: 'agent-run',
    submit: submittedRuns.some((run) => run.existingRunnerId) ? 'follow-up' : 'new-run',
    waitFor: '',
    agents,
    input: sourceStepId ? [{ step: sourceStepId, results: 'selected' }] : [],
    promptText,
    status,
    source: stepSource,
    runs: normalizedRuns,
  }

  const nextFlow = runState.flow && Array.isArray(runState.flow.steps)
    ? {
        ...runState.flow,
        steps: runState.flow.steps.some((candidate) => candidate.id === step.id)
          ? runState.flow.steps
          : [...runState.flow.steps, {
              id: step.id,
              title: step.title,
              description: step.description,
              prompt: '',
              action: step.action,
              submit: step.submit,
              waitFor: step.waitFor,
              agents: step.agents,
              input: step.input,
            }],
      }
    : runState.flow

  return saveRunState({
    ...runState,
    status,
    flow: nextFlow,
    steps: [...(Array.isArray(runState.steps) ? runState.steps : []), step],
  })
}

function freshAgentFlow({ title = 'Agent Run', stepTitle = 'Fresh Agent Runner' } = {}) {
  return {
    id: 'agent-run',
    title,
    description: 'One-off Netlify agent runner launched from visualizer follow-up.',
    source: 'visualizer',
    sourceLabel: 'visualizer',
    steps: [{
      id: 'fresh-agent-runner',
      title: stepTitle,
      description: 'Fresh agent runner seeded with selected prior results.',
      prompt: '',
      action: 'agent-run',
      submit: 'new-run',
      waitFor: '',
      agents: [],
      input: [],
    }],
  }
}

/**
 * @param {{
 *   projectRoot: string,
 *   runs: Array<Record<string, any>>,
 *   source?: Record<string, any>,
 *   promptText?: string,
 *   target?: Record<string, any> | null,
 *   now?: Date,
 *   title?: string,
 *   stepTitle?: string,
 * }} input
 */
function persistFreshPseudoWorkflow({
  projectRoot,
  runs,
  source = {},
  promptText = '',
  target = null,
  now = new Date(),
  title = 'Agent Run',
  stepTitle = 'Fresh Agent Runner',
}) {
  const agents = uniqueAgents(runs)
  const status = submittedStepStatus(runs)
  const flow = freshAgentFlow({ title, stepTitle })
  flow.steps[0].agents = agents
  /** @type {any} */
  const state = createRunState({
    projectRoot,
    flow,
    transport: 'netlify-api',
    target,
    options: {
      models: agents,
      context: '',
      visualizerFollowup: true,
    },
    now,
  })
  const timestamp = now.toISOString()
  state.status = status
  state.source = {
    type: 'visualizer-followup',
    mode: 'fresh-runner',
    ...source,
  }
  state.steps = [{
    id: 'fresh-agent-runner',
    title: stepTitle,
    status,
    agents,
    promptText,
    runs: runs.map((run) => ({
      transport: run.transport || 'netlify-api',
      agent: run.agent || '',
      status: run.status || 'submitted',
      promptText: run.promptText || promptText,
      compactPromptText: run.compactPromptText || '',
      resultText: run.resultText || '',
      runnerId: run.runnerId || '',
      sessionId: run.sessionId || '',
      issueUrl: run.issueUrl || '',
      commentUrl: run.commentUrl || '',
      prUrl: run.prUrl || '',
      deployUrl: run.deployUrl || '',
      links: run.links || {},
      raw: {
        ...(run.raw || {}),
        source,
      },
      createdAt: run.createdAt || timestamp,
      updatedAt: run.updatedAt || timestamp,
    })),
  }]
  return saveRunState(state)
}

module.exports = {
  appendFollowupRunsToWorkflow,
  followupStepTitle,
  freshAgentFlow,
  persistFreshPseudoWorkflow,
  safeStepId,
  submittedStepStatus,
  uniqueAgents,
}
