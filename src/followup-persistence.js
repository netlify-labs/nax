const path = require('path')
const { normalizeAgentRunResult } = require('./agent-run-results')
const { syncAgentRunner } = require('./agent-runner-sync')
const { createRunState, saveRunState } = require('./run-state')
const { isCancelledRunStatus, isFailedRunStatus, isTerminalRunStatus } = require('./status')

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
  if (runs.length > 0 && runs.every((run) => isCancelledRunStatus(run?.status))) return 'cancelled'
  if (runs.some((run) => isFailedRunStatus(run?.status))) {
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

function cleanFollowupBaseTitle(value = '') {
  let title = String(value || '').trim() || 'Follow-up'
  title = title.replace(/^Step\s+\d+:\s*/i, '').trim()
  title = title.replace(/^Follow[- ]up(?:\s+\d+)?:\s*/i, '').trim()
  title = title.replace(/\s+follow[- ]up(?:\s+\([^)]*\))?$/i, '').trim()
  return title || 'Follow-up'
}

function followupOrdinal(runState = {}) {
  const steps = Array.isArray(runState.steps) ? runState.steps : []
  return steps.filter((step) => step?.source?.type === 'visualizer-followup').length + 1
}

function followupStepTitle(target = {}, runs = [], ordinal = 1) {
  const base = cleanFollowupBaseTitle(target.stepTitle || target.label || 'Follow-up')
  const agents = uniqueAgents(runs)
  const agentSuffix = agents.length === 1
    ? ` (${agents[0]})`
    : agents.length > 1
      ? ` (${agents.length} agents)`
      : ''
  const suffix = agentSuffix && base.endsWith(agentSuffix) ? '' : agentSuffix
  return `Follow-up ${Math.max(1, Number(ordinal) || 1)}: ${base}${suffix}`
}

function normalizeFollowupStepTitles(steps = []) {
  let ordinal = 0
  let changed = false
  const titles = new Map()
  const nextSteps = steps.map((step) => {
    if (step?.source?.type !== 'visualizer-followup') return step
    ordinal += 1
    const title = followupStepTitle({ stepTitle: step.title || step.id || 'Follow-up' }, step.runs || [], ordinal)
    if (title === step.title) return step
    changed = true
    if (step.id) titles.set(step.id, title)
    return { ...step, title }
  })
  return { steps: nextSteps, titles, changed }
}

function updateFlowStepTitles(flow, titles) {
  if (!flow || !Array.isArray(flow.steps) || !titles?.size) return flow
  let changed = false
  const steps = flow.steps.map((step) => {
    const title = titles.get(step.id)
    if (!title || step.title === title) return step
    changed = true
    return { ...step, title }
  })
  return changed ? { ...flow, steps } : flow
}

function isActiveFollowupStatus(status = '') {
  return ['pending', 'queued', 'running', 'submitted', 'submitting', 'waiting', 'retrying'].includes(String(status || '').toLowerCase())
}

function workflowStatusFromSteps(steps = [], fallback = 'submitted') {
  const statuses = steps.map((step) => String(step?.status || '').toLowerCase()).filter(Boolean)
  if (statuses.length === 0) return fallback || 'submitted'
  if (statuses.some((status) => isFailedRunStatus(status))) return 'failed'
  if (statuses.some((status) => isActiveFollowupStatus(status))) return 'submitted'
  if (statuses.every((status) => isCancelledRunStatus(status))) return 'cancelled'
  if (statuses.every((status) => status === 'completed')) return 'completed'
  if (statuses.every((status) => isTerminalRunStatus(status))) return statuses.some((status) => status === 'completed') ? 'completed' : 'cancelled'
  return fallback || statuses[statuses.length - 1] || 'submitted'
}

function followupProjectRoot(runState = {}) {
  if (runState.projectRoot) return runState.projectRoot
  if (!runState.dir) return ''
  return path.resolve(runState.dir, '..', '..', '..')
}

function sessionForRun(sessions = [], run = {}) {
  const id = String(run.sessionId || '')
  if (id) {
    const exact = sessions.find((session) => String(session.sessionId || '') === id)
    if (exact) return exact
  }
  return null
}

function runChanged(left = {}, right = {}) {
  return [
    'status',
    'resultText',
    'sessionId',
    'runnerId',
    'deployUrl',
    'prUrl',
    'issueUrl',
    'commentUrl',
    'updatedAt',
  ].some((key) => JSON.stringify(left[key] ?? null) !== JSON.stringify(right[key] ?? null)) ||
    JSON.stringify(left.links || {}) !== JSON.stringify(right.links || {}) ||
    JSON.stringify(left.usage || null) !== JSON.stringify(right.usage || null) ||
    JSON.stringify(left.fileChanges || null) !== JSON.stringify(right.fileChanges || null)
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
    title: followupStepTitle(target || {}, submittedRuns, followupOrdinal(runState)),
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

/**
 * Refresh submitted visualizer follow-ups from Netlify Agent Runner sessions and
 * merge terminal remote state back into the durable workflow graph state.
 *
 * @param {{
 *   runState?: Record<string, any>,
 *   projectRoot?: string,
 *   env?: Record<string, string>,
 *   runCommand?: Function,
 *   syncRunner?: Function,
 * }} input
 */
function syncSubmittedFollowupRunsToWorkflow({
  runState,
  projectRoot = followupProjectRoot(runState),
  env = process.env,
  runCommand,
  syncRunner = syncAgentRunner,
} = {}) {
  if (!runState?.dir || !projectRoot) return { runState, changed: false, warnings: [] }
  const titleNormalization = normalizeFollowupStepTitles(Array.isArray(runState.steps) ? runState.steps : [])
  const steps = titleNormalization.steps
  const candidates = []
  for (const step of steps) {
    if (step?.source?.type !== 'visualizer-followup') continue
    for (const run of Array.isArray(step.runs) ? step.runs : []) {
      if (!isActiveFollowupStatus(run?.status) || !run?.runnerId) continue
      candidates.push({ step, run })
    }
  }

  const warnings = []
  const sessionsByRunner = new Map()
  for (const runnerId of [...new Set(candidates.map(({ run }) => String(run.runnerId || '')).filter(Boolean))]) {
    const candidate = candidates.find(({ run }) => String(run.runnerId || '') === runnerId)
    try {
      const synced = syncRunner({
        projectRoot,
        env,
        runCommand,
        runner: {
          runnerId,
          agent: candidate?.run?.agent || '',
          status: candidate?.run?.status || '',
          source: candidate?.step?.source || null,
          links: candidate?.run?.links || {},
          createdAt: candidate?.run?.createdAt || '',
          updatedAt: candidate?.run?.updatedAt || '',
          fileChanges: candidate?.run?.fileChanges || null,
        },
      })
      sessionsByRunner.set(runnerId, Array.isArray(synced.sessions) ? synced.sessions : [])
    } catch (error) {
      warnings.push(error?.message || String(error))
    }
  }

  let changed = titleNormalization.changed
  const nextSteps = candidates.length === 0 ? steps : steps.map((step) => {
    if (step?.source?.type !== 'visualizer-followup') return step
    let stepChanged = false
    const nextRuns = (Array.isArray(step.runs) ? step.runs : []).map((run) => {
      if (!isActiveFollowupStatus(run?.status) || !run?.runnerId) return run
      const session = sessionForRun(sessionsByRunner.get(String(run.runnerId || '')) || [], run)
      if (!session?.sessionId) return run
      const nextRun = {
        ...normalizeAgentRunResult({
          run,
          session,
          status: session.status || run.status || 'submitted',
          resultText: session.resultText !== undefined ? session.resultText : run.resultText,
          usage: session.usage || run.usage,
          fileChanges: session.fileChanges || run.fileChanges,
          links: session.links || run.links || {},
        }),
        updatedAt: session.updatedAt || run.updatedAt || '',
      }
      if (!runChanged(run, nextRun)) return run
      changed = true
      stepChanged = true
      return nextRun
    })
    if (!stepChanged) return step
    return {
      ...step,
      status: submittedStepStatus(nextRuns),
      runs: nextRuns,
    }
  })

  if (!changed) return { runState, changed: false, warnings }
  const nextRunState = saveRunState({
    ...runState,
    flow: updateFlowStepTitles(runState.flow, titleNormalization.titles),
    status: candidates.length > 0 ? workflowStatusFromSteps(nextSteps, runState.status) : runState.status,
    steps: nextSteps,
  })
  return { runState: nextRunState, changed: true, warnings }
}

/**
 * @param {{
 *   runState: Record<string, any>,
 *   stepId?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   agent?: string,
 *   now?: Date,
 * }} input
 */
function cancelFollowupRunInWorkflow({
  runState,
  stepId = '',
  runnerId = '',
  sessionId = '',
  agent = '',
  now = new Date(),
}) {
  if (!runState?.dir) throw new Error('Cannot cancel a follow-up run without a workflow state directory.')
  const steps = Array.isArray(runState.steps) ? runState.steps : []
  const updatedAt = now.toISOString()
  const matches = []

  for (const step of steps) {
    const runs = Array.isArray(step.runs) ? step.runs : []
    if (stepId && step.id !== stepId) continue
    for (const run of runs) {
      const candidateRunner = String(run?.runnerId || run?.existingRunnerId || '')
      const candidateSession = String(run?.sessionId || '')
      const candidateAgent = String(run?.agent || '')
      const idMatches = sessionId
        ? candidateSession === sessionId
        : runnerId && candidateRunner === runnerId
      const agentMatches = !agent || candidateAgent === agent
      if (!idMatches || !agentMatches) continue
      matches.push({ step, run })
    }
  }

  if (matches.length === 0) {
    const target = [runnerId ? `runner ${runnerId}` : '', sessionId ? `session ${sessionId}` : ''].filter(Boolean).join(' / ')
    throw new Error(`No matching follow-up run was found for ${target || 'the selected target'}.`)
  }

  const activeMatches = matches.filter(({ run }) => isActiveFollowupStatus(run.status))
  if (activeMatches.length === 0) {
    return {
      runState,
      changed: false,
      run: matches[0].run,
    }
  }
  if (activeMatches.length > 1) {
    const target = sessionId ? `session ${sessionId}` : `runner ${runnerId}`
    throw new Error(`Multiple active follow-up runs matched ${target}. Select a specific session before cancelling.`)
  }

  let changed = false
  let selectedRun = null
  const targetRun = activeMatches[0].run
  const nextSteps = steps.map((step) => {
    const runs = Array.isArray(step.runs) ? step.runs : []
    if (stepId && step.id !== stepId) return step
    let stepChanged = false
    const nextRuns = runs.map((run) => {
      if (run !== targetRun) return run
      changed = true
      stepChanged = true
      selectedRun = {
        ...run,
        status: 'cancelled',
        updatedAt,
        raw: {
          ...(run.raw || {}),
          cancelledAt: updatedAt,
          cancelSource: 'visualizer',
        },
      }
      return selectedRun
    })
    if (!stepChanged) return step
    return {
      ...step,
      status: submittedStepStatus(nextRuns),
      runs: nextRuns,
    }
  })

  if (!changed) {
    return {
      runState,
      changed: false,
      run: selectedRun,
    }
  }

  const nextStatus = submittedStepStatus(nextSteps.flatMap((step) => Array.isArray(step.runs) ? step.runs : []))
  return {
    runState: saveRunState({
      ...runState,
      status: nextStatus,
      updatedAt,
      steps: nextSteps,
    }),
    changed: true,
    run: selectedRun,
  }
}

module.exports = {
  appendFollowupRunsToWorkflow,
  cancelFollowupRunInWorkflow,
  followupStepTitle,
  freshAgentFlow,
  isActiveFollowupStatus,
  persistFreshPseudoWorkflow,
  safeStepId,
  submittedStepStatus,
  syncSubmittedFollowupRunsToWorkflow,
  uniqueAgents,
}
