const fs = require('fs')
const path = require('path')
const { makeBox } = require('@davidwells/box-logger')
const { loadFlow } = require('../flows')
const { relativeDisplayPath } = require('../handoff-sources')
const { dismissRunState, isUnfinishedRun, listRunStates, workflowStatePath } = require('../run-state')
const { artifactsRootForRunState, stepArtifactsDir } = require('../workflow-artifacts')

const DEFAULT_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000
const OUTER_TERMINAL_RATIO = 0.8
const SUCCESS_COLOR = '#22c55e'
const ERROR_COLOR = '#ef4444'
const MUTED_COLOR = '#64748b'
const TEAL_COLOR = '#0d9488'

/**
 * Step state saved in durable workflow resume files.
 * @typedef {import('../types').WorkflowStep & {
 *   runs?: import('../types').AgentRun[],
 * }} ResumeStepState
 *
 * Durable run state used by resume display and selection.
 * @typedef {import('../types').WorkflowRunState & {
 *   flow?: import('../types').WorkflowFlow,
 *   steps?: ResumeStepState[],
 * }} ResumeRunState
 *
 * Flow loading options relevant to resume discovery.
 * @typedef {{
 *   projectRoot?: string,
 *   flowsDir?: string,
 *   flowsDirs?: string[] | string,
 *   dryRun?: boolean,
 *   yes?: boolean,
 * }} ResumeDiscoveryOptions
 *
 * Selected unfinished run and the flow needed to resume it.
 * @typedef {{
 *   runState: ResumeRunState,
 *   flow: import('../types').WorkflowFlow,
 * }} ResumableRunEntry
 *
 * Resume step decoration shown in workflow previews.
 * @typedef {{
 *   status: string,
 *   label: string,
 * }} ResumeStepDecoration
 */

/** @param {string | null | undefined} hex @returns {string} */
function rgbAnsi(hex) {
  const normalized = String(hex || '').replace(/^#/, '')
  if (!/^[\da-f]{6}$/i.test(normalized)) return ''
  const r = parseInt(normalized.slice(0, 2), 16)
  const g = parseInt(normalized.slice(2, 4), 16)
  const b = parseInt(normalized.slice(4, 6), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

/** @param {string} text @param {string} color @returns {string} */
function colorText(text, color) {
  const open = rgbAnsi(color)
  if (!open || (process.env.NO_COLOR && !process.env.FORCE_COLOR)) return text
  return `${open}${text}\x1b[39m`
}

/** @param {string | number | Date | null | undefined} value @returns {number | null} */
function timestampMs(value) {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

/** @param {ResumeRunState} [runState] @returns {number | null} */
function runStateActivityMs(runState = {}) {
  return timestampMs(runState.updatedAt) || timestampMs(runState.createdAt)
}

/**
 * Formats a timestamp using the user's locale.
 * @param {string | number | Date | null | undefined} value
 * @returns {string}
 */
function formatHumanRunDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Formats relative time with up to two useful units.
 * @param {string | number | Date | null | undefined} value
 * @param {number} [now]
 * @returns {string}
 */
function formatDetailedRelativeTime(value, now = Date.now()) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = date.getTime() - now
  let remaining = Math.abs(diffMs)
  /** @type {Array<[string, number]>} */
  const units = [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ]
  const parts = []
  for (const [unit, unitMs] of units) {
    if (parts.length >= 2) break
    const count = Math.floor(remaining / unitMs)
    if (count <= 0) continue
    remaining -= count * unitMs
    parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`)
  }
  if (parts.length === 0) parts.push('just now')
  const label = parts.length === 1 ? parts[0] : `${parts[0]} and ${parts[1]}`
  if (label === 'just now') return label
  return diffMs > 0 ? `in ${label}` : `${label} ago`
}

/** @param {string} status @returns {string} */
function resumeStatusColor(status) {
  if (status === 'completed' || status === 'dry-run') return SUCCESS_COLOR
  if (status === 'failed' || status === 'timeout') return ERROR_COLOR
  return ''
}

/**
 * Checks whether an unfinished run should be offered automatically.
 * @param {ResumeRunState} [runState]
 * @param {{ allStates?: ResumeRunState[], now?: number }} [options]
 * @returns {boolean}
 */
function isAutomaticResumeCandidate(runState = {}, { allStates = [], now = Date.now() } = {}) {
  if (!isUnfinishedRun(runState)) return false
  if (allStates[0]?.runId === runState.runId) return true
  const activity = runStateActivityMs(runState)
  return Number.isFinite(activity) && now - Number(activity) <= DEFAULT_RESUME_WINDOW_MS
}

/** @param {ResumeStepState | null | undefined} savedStep @returns {string} */
function savedStepStatus(savedStep) {
  if (!savedStep) return 'pending'
  if (savedStep.status === 'dry-run') return 'dry-run'
  if (savedStep.status === 'completed') return 'completed'
  const runs = Array.isArray(savedStep.runs) ? savedStep.runs : []
  if (runs.length > 0 && runs.every((run) => run.status === 'completed' || run.status === 'dry-run')) {
    return 'completed'
  }
  if (savedStep.status === 'failed' || savedStep.status === 'timeout') return savedStep.status
  return savedStep.status || 'running'
}

/**
 * Builds resume labels for each displayed step.
 * @param {{ steps?: import('../types').WorkflowStep[], runState?: ResumeRunState | null }} [input]
 * @returns {Map<string | undefined, ResumeStepDecoration>}
 */
function resumeStepDecorations({ steps = [], runState = null } = {}) {
  if (!runState) return new Map()
  const byId = new Map((runState.steps || []).map((step) => [step.id, step]))
  let resumeMarked = false
  return new Map(steps.map((step) => {
    const status = savedStepStatus(byId.get(step.id))
    let label = ''
    if (status === 'completed' || status === 'dry-run') label = 'completed'
    else if (!resumeMarked) {
      label = 'resume here'
      resumeMarked = true
    } else {
      label = 'pending'
    }
    return [step.id, { status, label }]
  }))
}

/** @param {ResumeStepState | null | undefined} savedStep @param {string} agent @returns {string} */
function savedAgentStatus(savedStep, agent) {
  const stepStatus = savedStepStatus(savedStep)
  const runs = Array.isArray(savedStep?.runs) ? savedStep.runs : []
  const normalizedAgent = String(agent || '').toLowerCase()
  const run = runs.find((candidate) => String(candidate?.agent || '').toLowerCase() === normalizedAgent)
  if (run?.status) return run.status
  if (stepStatus === 'completed' || stepStatus === 'dry-run' || stepStatus === 'failed' || stepStatus === 'timeout') {
    return stepStatus
  }
  return ''
}

/**
 * Returns the finished-step summary display path when present.
 * @param {{
 *   runState?: ResumeRunState | null,
 *   savedStep?: ResumeStepState | null,
 *   projectRoot?: string,
 * }} [input]
 * @returns {string}
 */
function stepResultsSummaryPath({ runState = null, savedStep = null, projectRoot = process.cwd() } = {}) {
  const status = savedStepStatus(savedStep)
  if (!(status === 'completed' || status === 'dry-run' || status === 'failed' || status === 'timeout')) return ''
  if (!runState || !savedStep) return ''
  const summaryPath = path.join(stepArtifactsDir(runState, savedStep), 'summary.md')
  if (!fs.existsSync(summaryPath)) return ''
  const displayPath = relativeDisplayPath(projectRoot || runState.projectRoot || process.cwd(), summaryPath)
  return displayPath && !path.isAbsolute(displayPath) && !displayPath.startsWith('./')
    ? `./${displayPath}`
    : displayPath
}

/** @param {ResumeRunState} [runState] @param {string} [projectRoot] @returns {string} */
function workflowSummaryDisplayPath(runState = {}, projectRoot = process.cwd()) {
  const summaryPath = artifactsRootForRunState(runState)
    ? path.join(artifactsRootForRunState(runState), 'summary.md')
    : ''
  if (!summaryPath || !fs.existsSync(summaryPath)) return ''
  const displayPath = relativeDisplayPath(projectRoot || runState.projectRoot || process.cwd(), summaryPath)
  return displayPath && !path.isAbsolute(displayPath) && !displayPath.startsWith('./')
    ? `./${displayPath}`
    : displayPath
}

/** @param {ResumeRunState} [runState] @returns {string} */
function resumeLastStepTitle(runState = {}) {
  const steps = Array.isArray(runState.steps) ? runState.steps : []
  if (steps.length === 0) return ''
  const active = steps.find((step) => {
    const status = savedStepStatus(step)
    return status !== 'completed' && status !== 'dry-run'
  })
  const step = active || steps[steps.length - 1]
  return step?.title || step?.id || ''
}

/** @param {ResumeRunState} [runState] @returns {string} */
function resumeRunDetailsTitle(runState = {}) {
  const title = runState.flowTitle || runState.flowId || 'workflow'
  return `Unfinished "${title}" workflow run found`
}

/**
 * Formats the resume preview detail lines.
 * @param {ResumeRunState} [runState]
 * @param {{ projectRoot?: string, now?: number }} [options]
 * @returns {string[]}
 */
function formatResumeRunDetails(runState = {}, { projectRoot = process.cwd(), now = Date.now() } = {}) {
  const started = runState.createdAt || ''
  const updated = runState.updatedAt || runState.createdAt || ''
  const startedDate = formatHumanRunDate(started)
  const startedAgo = formatDetailedRelativeTime(started, now)
  const updatedDate = formatHumanRunDate(updated)
  const updatedAgo = formatDetailedRelativeTime(updated, now)
  const statePath = runState.dir ? relativeDisplayPath(projectRoot, workflowStatePath(runState.dir)) : ''
  const summaryPath = workflowSummaryDisplayPath(runState, projectRoot)
  const lastStep = resumeLastStepTitle(runState)
  return [
    lastStep ? `Last Step: ${lastStep}` : '',
    `Run ID: ${runState.runId || 'unknown'}`,
    `Transport: ${runState.transport || 'unknown'}`,
    startedDate ? `Started: ${startedDate}${startedAgo ? ` (${startedAgo})` : ''}` : '',
    updatedDate && updated !== started ? `Updated: ${updatedDate}${updatedAgo ? ` (${updatedAgo})` : ''}` : '',
    statePath ? `State: ${statePath}` : '',
    summaryPath ? `Summary: ${summaryPath}` : '',
  ].filter(Boolean)
}

/**
 * Prints an unfinished-run resume preview box.
 * @param {ResumeRunState} [runState]
 * @param {{ projectRoot?: string }} [options]
 */
function printResumeRunDetails(runState = {}, { projectRoot = process.cwd() } = {}) {
  const lines = formatResumeRunDetails(runState, { projectRoot })
  if (lines.length === 0) return
  const terminalWidth = process.stdout.columns || 100
  const width = Math.min(Math.max(...lines.map((line) => line.length)) + 6, Math.max(60, Math.floor(terminalWidth * OUTER_TERMINAL_RATIO)))
  console.log('')
  console.log(makeBox({
    title: resumeRunDetailsTitle(runState),
    content: lines.join('\n'),
    borderStyle: 'rounded',
    borderColor: TEAL_COLOR,
    width,
  }))
  console.log('')
}

/** @param {ResumeDiscoveryOptions} [options] @param {string} [projectRoot] */
function flowLoadOptions(options = {}, projectRoot = options.projectRoot || process.cwd()) {
  return {
    projectRoot,
    flowsDir: options.flowsDir,
    flowsDirs: options.flowsDirs,
  }
}

/** @param {ResumeRunState} [runState] @returns {import('../types').WorkflowFlow | null} */
function flowFromRunState(runState = {}) {
  if (runState.flow && typeof runState.flow === 'object' && Array.isArray(runState.flow.steps)) {
    return runState.flow
  }
  return null
}

/**
 * Finds the latest unfinished run that can be resumed.
 * @param {{
 *   projectRoot: string,
 *   options?: ResumeDiscoveryOptions,
 *   flow?: import('../types').WorkflowFlow | null,
 *   now?: number,
 * }} input
 * @returns {Promise<ResumableRunEntry | null>}
 */
async function findLatestResumableRun({ projectRoot, options = {}, flow = null, now = Date.now() }) {
  const states = /** @type {ResumeRunState[]} */ (listRunStates(projectRoot))
  for (const state of states) {
    if (flow && state.flowId !== flow.id) continue
    if (!isUnfinishedRun(state)) continue
    if (!isAutomaticResumeCandidate(state, { allStates: states, now })) continue
    const embeddedFlow = flowFromRunState(state)
    if (embeddedFlow) return { runState: state, flow: embeddedFlow }
    if (flow) return { runState: state, flow }
    try {
      const loadedFlow = await loadFlow(state.flowId, flowLoadOptions({ ...(state.options || {}), ...options }, projectRoot))
      return { runState: state, flow: loadedFlow }
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error)
      dismissRunState(state, { reason: 'flow-unavailable' })
      console.warn(`Skipped stale unfinished run ${state.runId}: ${message}`)
    }
  }
  return null
}

module.exports = {
  DEFAULT_RESUME_WINDOW_MS,
  ERROR_COLOR,
  MUTED_COLOR,
  SUCCESS_COLOR,
  TEAL_COLOR,
  colorText,
  findLatestResumableRun,
  flowFromRunState,
  flowLoadOptions,
  formatDetailedRelativeTime,
  formatResumeRunDetails,
  isAutomaticResumeCandidate,
  printResumeRunDetails,
  resumeLastStepTitle,
  resumeRunDetailsTitle,
  resumeStatusColor,
  resumeStepDecorations,
  rgbAnsi,
  runStateActivityMs,
  savedAgentStatus,
  savedStepStatus,
  stepResultsSummaryPath,
  timestampMs,
  workflowSummaryDisplayPath,
}
