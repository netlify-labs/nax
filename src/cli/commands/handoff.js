const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { makeBox } = require('@davidwells/box-logger')
const { formatUsageSummary, usageSummariesForRunState } = require('../../workflows/results/agent-run-results')
const { readHandoffSource, relativeDisplayPath } = require('../../workflows/followups/handoff-sources')
const { listRunStates } = require('../../storage/local/run-state')
const { titleCase } = require('../../workflows/catalog/prompts')
const { artifactsRootForRunState, persistWorkflowArtifacts } = require('../../workflows/artifacts/workflow-artifacts')
const { buildHandoffPrompt } = require('../../workflows/followups/runner')

const HANDOFF_DETAIL_LABEL_WIDTH = 9

/**
 * CLI options that select a handoff source.
 * @typedef {{
 *   workflow?: string,
 *   runner?: string,
 *   session?: string,
 *   runId?: string,
 *   sourceType?: string,
 *   type?: string,
 *   source?: string,
 * }} HandoffSourceOptions
 *
 * Handoff source descriptor with loaded summary text.
 * @typedef {Record<string, unknown> & {
 *   kind?: string,
 *   id?: string,
 *   title?: string,
 *   agent?: string,
 *   source?: import('../../types').JsonMap,
 *   runState?: import('../../types').WorkflowRunState,
 *   summaryPath?: string,
 *   displayPath?: string,
 *   summaryText?: string,
 *   updatedAt?: string,
 *   createdAt?: string,
 * }} HandoffSource
 *
 * Menu option presented by the handoff source picker.
 * @typedef {{
 *   value: string,
 *   label: string,
 *   hint?: string,
 * }} HandoffMenuOption
 *
 * Clipboard command runner compatible with child_process.spawnSync.
 * @typedef {(command: string, args: string[], options: import('child_process').SpawnSyncOptionsWithStringEncoding) => import('../../types').CommandResult} HandoffClipboardCommand
 */

/** @param {string | null | undefined} value @returns {string} */
function formatRunTimestamp(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** @param {string | null | undefined} value @returns {string} */
function normalizeHandoffSourceKind(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized === 'all') return ''
  if (normalized === 'workflow' || normalized === 'workflows') return 'workflow'
  if (normalized === 'runner' || normalized === 'runners' || normalized === 'agent-runner' || normalized === 'agent-runners') return 'agent-runner'
  if (normalized === 'session' || normalized === 'sessions' || normalized === 'agent-session' || normalized === 'agent-sessions') return 'agent-session'
  throw new Error(`Unknown handoff source type "${value}". Expected workflow, agent-runner, or agent-session.`)
}

/** @param {{ runId?: string, options?: HandoffSourceOptions }} [input] @returns {{ kind: string, id: string }} */
function handoffSourceQuery({ runId = '', options = {} } = {}) {
  if (options.workflow) return { kind: 'workflow', id: options.workflow }
  if (options.runner) return { kind: 'agent-runner', id: options.runner }
  if (options.session) return { kind: 'agent-session', id: options.session }
  if (runId || options.runId) return { kind: 'workflow', id: runId || options.runId || '' }
  return {
    kind: normalizeHandoffSourceKind(options.sourceType || options.type || ''),
    id: options.source || '',
  }
}

/** @param {string | null | undefined} kind @returns {string} */
function formatHandoffSourceKind(kind) {
  if (kind === 'workflow') return 'workflow'
  if (kind === 'agent-runner') return 'agent runner'
  if (kind === 'agent-session') return 'agent session'
  return kind || 'artifact'
}

/** @param {HandoffSource} [source] @returns {string} */
function formatHandoffSourceLabel(source = {}) {
  const stamp = formatRunTimestamp(source.updatedAt)
  return [stamp, source.title || source.id || 'Untitled'].filter(Boolean).join('  ')
}

/** @param {HandoffSource} [source] @param {string} [projectRoot] @returns {string} */
function formatHandoffSourceHint(source = {}, projectRoot = process.cwd()) {
  const displayPath = source.displayPath || relativeDisplayPath(projectRoot, source.summaryPath || '')
  return `${formatHandoffSourceKind(source.kind)} · ${displayPath}`
}

/** @param {HandoffSource} [source] @returns {import('../../types').JsonMap} */
function handoffSourcePayload(source = {}) {
  return source.source || source.runState || {}
}

/** @param {HandoffSource} [source] @param {string} [projectRoot] @returns {string} */
function formatLatestHandoffSourceHint(source = {}, projectRoot = process.cwd()) {
  const displayPath = source.displayPath || relativeDisplayPath(projectRoot, source.summaryPath || '')
  const payload = handoffSourcePayload(source)
  const agent = String(payload.agent || source.agent || '').trim().toLowerCase()
  const origin = agent || String(source.title || source.id || 'latest').trim()
  return ['from', origin, displayPath].filter(Boolean).join(' ')
}

/** @param {HandoffSource} [source] @param {string} [projectRoot] @returns {string} */
function formatCompactHandoffSourceHint(source = {}, projectRoot = process.cwd()) {
  return formatLatestHandoffSourceHint(source, projectRoot).replace(/^from\s+/, '')
}

/** @param {string | null | undefined} value @param {number} [max] @returns {string} */
function truncateOneLine(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** @param {string} text @param {number} width @returns {string} */
function wordWrap(text, width) {
  const max = Math.max(20, Number(width) || 80)
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > max && line) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

/** @param {string | null | undefined} value @param {number} [now] @returns {string} */
function formatRelativeTime(value, now = Date.now()) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = date.getTime() - now
  const absMs = Math.abs(diffMs)
  /** @type {Array<[string, number]>} */
  const units = [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ]
  const [unit, unitMs] = units.find(([, ms]) => absMs >= ms) || units[units.length - 1]
  const count = Math.max(1, Math.round(absMs / unitMs))
  const label = `${count} ${unit}${count === 1 ? '' : 's'}`
  return diffMs > 0 ? `in ${label}` : `${label} ago`
}

/** @param {string | null | undefined} value @returns {string} */
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

/** @param {HandoffSource} [source] @returns {string} */
function sourceDisplayTitle(source = {}) {
  if (source.kind === 'workflow') return source.title || source.id || 'Workflow'
  const artifact = handoffSourcePayload(source)
  const agent = artifact.agent ? titleCase(String(artifact.agent)) : ''
  const sourceValue = /** @type {{ stepTitle?: string, stepId?: string }} */ (artifact.source || {})
  const sourceTitle = sourceValue.stepTitle || sourceValue.stepId || ''
  if (agent && sourceTitle) return `${agent} · ${sourceTitle}`
  if (agent) return agent
  return source.title || source.id || 'Artifact'
}

/** @param {HandoffSource} [source] @returns {{ step: import('../../types').WorkflowStep, run: import('../../types').AgentRun } | null} */
function finalWorkflowRun(source = {}) {
  if (source.kind !== 'workflow') return null
  const payload = /** @type {import('../../types').WorkflowRunState} */ (handoffSourcePayload(source))
  const steps = Array.isArray(payload.steps) ? payload.steps : []
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    const runs = Array.isArray(step.runs) ? step.runs : []
    for (let j = runs.length - 1; j >= 0; j -= 1) {
      const run = runs[j]
      if (run?.status === 'completed' && String(run.resultText || '').trim()) {
        return { step, run }
      }
    }
  }
  return null
}

/** @param {HandoffSource} [source] @param {number} [max] @returns {string} */
function previewTextForHandoffSource(source = {}, max = 260) {
  const final = finalWorkflowRun(source)
  if (final?.run?.resultText) return truncateOneLine(final.run.resultText, max)
  const resultText = String(handoffSourcePayload(source).resultText || '')
  if (resultText) return truncateOneLine(resultText, max)
  const summaryText = String(source.summaryText || '')
  const lines = summaryText.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (/^[-*]\s+(Run ID|Flow|Transport|Status|Usage|Files|Runner ID|Session ID|Metadata|Result):/i.test(line)) return false
      if (/^[-*]\s*$/.test(line)) return false
      return !/^```/.test(line)
    })
  return truncateOneLine(lines.find((line) => !/^#\s/.test(line)) || lines[0] || '', max)
}

/** @param {HandoffSource} [source] @returns {string} */
function usageSummaryForHandoffSource(source = {}) {
  const payload = handoffSourcePayload(source)
  if (source.kind === 'workflow') {
    return usageSummariesForRunState(/** @type {import('../../types').WorkflowRunState} */ (payload)).totalSummary || ''
  }
  return formatUsageSummary(/** @type {import('../../types').UsageSummary} */ (payload.usage || {}))
}

/** @param {HandoffSource} [source] @returns {string} */
function handoffSourceUpdatedAt(source = {}) {
  const payload = handoffSourcePayload(source)
  return source.updatedAt || String(payload.updatedAt || source.createdAt || payload.createdAt || '')
}

/** @param {HandoffSource} [source] @returns {string} */
function handoffSourceDetailTitle(source = {}) {
  const final = finalWorkflowRun(source)
  if (source.kind === 'workflow' && final) {
    return `Latest result from "${sourceDisplayTitle(source)}" workflow "${final.step.title || final.step.id || 'Final step'}" step using ${titleCase(final.run.agent || 'agent')}`
  }
  const payload = handoffSourcePayload(source)
  if (source.kind === 'agent-session') {
    return `Latest result from ${titleCase(String(payload.agent || 'agent'))} agent session`
  }
  if (source.kind === 'agent-runner') {
    return `Latest result from ${titleCase(String(payload.agent || 'agent'))} agent runner`
  }
  return `Latest result from ${sourceDisplayTitle(source)}`
}

/** @param {string} label @param {string} value @param {number} width @param {{ block?: boolean }} [options] @returns {string[]} */
function formatHandoffDetailField(label, value, width, { block = false } = {}) {
  const text = String(value || '').trim()
  if (!text) return []
  const labelText = `${label}:`
  const indent = ' '.repeat(HANDOFF_DETAIL_LABEL_WIDTH)
  const valueWidth = Math.max(24, width - HANDOFF_DETAIL_LABEL_WIDTH)
  if (block) return [labelText, ...wordWrap(text, width).split('\n')]
  const wrapped = wordWrap(text, valueWidth).split('\n')
  return wrapped.map((line, index) => (
    index === 0 ? `${labelText.padEnd(HANDOFF_DETAIL_LABEL_WIDTH)}${line}` : `${indent}${line}`
  ))
}

/** @param {HandoffSource} [source] @param {string} [projectRoot] @param {{ width?: number }} [options] @returns {string[]} */
function handoffSourceDetailLines(source = {}, projectRoot = process.cwd(), { width = 100 } = {}) {
  const updatedAt = handoffSourceUpdatedAt(source)
  const date = formatHumanRunDate(updatedAt)
  const relative = formatRelativeTime(updatedAt)
  const lines = []
  if (date) lines.push(...formatHandoffDetailField('Date', `${date}${relative ? ` (${relative})` : ''}`, width))
  lines.push(...formatHandoffDetailField(
    'Summary',
    source.displayPath || relativeDisplayPath(projectRoot, source.summaryPath || ''),
    width,
  ))
  const preview = previewTextForHandoffSource(source)
  if (preview) lines.push(...formatHandoffDetailField('Preview', preview, width, { block: true }))
  return lines
}

/** @param {HandoffSource} [source] @param {string} [projectRoot] @returns {string} */
function formatHandoffSourceDetailBox(source = {}, projectRoot = process.cwd()) {
  const terminalWidth = process.stdout.columns || 120
  const width = Math.min(120, Math.max(76, Math.floor(terminalWidth * 0.95)))
  const lines = handoffSourceDetailLines(source, projectRoot, { width: width - 6 })
  return makeBox({
    title: handoffSourceDetailTitle(source),
    content: lines.join('\n'),
    borderStyle: 'rounded',
    borderColor: '#0d9488',
    width,
  })
}

/** @param {{ sources?: HandoffSource[], latestSource?: HandoffSource, projectRoot?: string }} [input] @returns {HandoffMenuOption[]} */
function handoffSourceMenuOptions({ sources = [], latestSource = {}, projectRoot = process.cwd() } = {}) {
  const options = [
    {
      value: 'copy-latest',
      label: 'Copy latest results markdown to clipboard',
      hint: formatLatestHandoffSourceHint(latestSource, projectRoot),
    },
    {
      value: 'copy-latest-path',
      label: 'Copy latest results filePath to clipboard',
      hint: latestSource.displayPath || relativeDisplayPath(projectRoot, latestSource.summaryPath || ''),
    },
    {
      value: 'open-latest',
      label: 'Open latest results in code editor',
      hint: latestSource.displayPath || relativeDisplayPath(projectRoot, latestSource.summaryPath || ''),
    },
    {
      value: 'workflow-latest',
      label: 'Run followup prompt with previous results',
      hint: formatCompactHandoffSourceHint(latestSource, projectRoot),
    },
  ]
  const hasKind = (kind) => sources.some((source) => source.kind === kind)
  if (hasKind('workflow')) options.push({ value: 'pick:workflow', label: 'Pick previous workflow', hint: '' })
  if (hasKind('agent-session')) options.push({ value: 'pick:agent-session', label: 'Pick previous agent session', hint: '' })
  if (hasKind('agent-runner')) options.push({ value: 'pick:agent-runner', label: 'Pick previous agent runner', hint: '' })
  options.push({ value: 'cancel', label: 'Cancel', hint: '' })
  return options
}

/** @param {import('../../types').WorkflowRunState} [runState] @returns {string} */
function handoffSummaryPath(runState = {}) {
  const root = artifactsRootForRunState(runState)
  return root ? path.join(root, 'summary.md') : ''
}

/** @param {string} projectRoot @param {string} summaryPath @returns {string} */
function relativeHandoffPath(projectRoot, summaryPath) {
  const relative = path.relative(projectRoot || process.cwd(), summaryPath)
  return relative && !relative.startsWith('..') ? relative : summaryPath
}

/** @param {string} projectRoot @param {{ runId?: string }} [options] @returns {import('../../types').WorkflowRunState | null} */
function findRunStateForHandoff(projectRoot, { runId } = {}) {
  const states = listRunStates(projectRoot)
  if (runId) {
    const matched = states.find((state) => state.runId === runId)
    if (!matched) throw new Error(`Could not find workflow ${runId} under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    return matched
  }
  return states[0] || null
}

/** @param {{ projectRoot?: string, runId?: string }} [input] @returns {HandoffSource} */
function readHandoffSummary({ projectRoot, runId } = {}) {
  if (runId) {
    const runState = findRunStateForHandoff(projectRoot, { runId })
    if (!runState) throw new Error(`No nax workflows found under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    persistWorkflowArtifacts(runState, { summaryOnly: true })
    const summaryPath = handoffSummaryPath(runState)
    if (!summaryPath || !fs.existsSync(summaryPath)) {
      throw new Error(`Workflow ${runState.runId} does not have a handoff summary yet.`)
    }
    const summaryText = fs.readFileSync(summaryPath, 'utf8').trim()
    if (!summaryText) throw new Error(`Workflow ${runState.runId} has an empty handoff summary.`)
    return {
      kind: 'workflow',
      id: runState.runId,
      title: runState.flowTitle || runState.flowId || runState.runId,
      runState,
      summaryPath,
      displayPath: relativeHandoffPath(projectRoot, summaryPath),
      summaryText,
    }
  }
  return readHandoffSource(projectRoot)
}

/** @param {{ projectRoot?: string, runId?: string, options?: HandoffSourceOptions }} [input] @returns {HandoffSource} */
function readSelectedHandoffSource({ projectRoot, runId = '', options = {} } = {}) {
  const query = handoffSourceQuery({ runId, options })
  return readHandoffSource(projectRoot, query)
}

/** @param {import('../../types').WorkflowRunState} runState @param {string} projectRoot */
function printPostSuccessHandoffHint(runState, projectRoot) {
  if (!process.stdout.isTTY) return
  const summaryPath = handoffSummaryPath(runState)
  if (!summaryPath || !fs.existsSync(summaryPath)) return
  const displayPath = relativeHandoffPath(projectRoot, summaryPath)
  console.log(`The results from your workflow are in ${displayPath}`)
  console.log('')
  console.log('Hand them off to another agent with:')
  console.log('')
  console.log('nax handoff')
  console.log('')
}

/** @param {string} text @param {{ platform?: NodeJS.Platform, runCommand?: HandoffClipboardCommand }} [options] @returns {string} */
function copyToClipboard(text, { platform = process.platform, runCommand = spawnSync } = {}) {
  /** @type {Array<[string, string[]]>} */
  const candidates = platform === 'darwin'
    ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
  for (const [command, args] of candidates) {
    const result = runCommand(command, args, { input: text, encoding: 'utf8' })
    if (result.status === 0) return command
  }
  throw new Error(platform === 'darwin'
    ? 'Could not copy to clipboard with pbcopy.'
    : 'Could not copy to clipboard. Install wl-copy or xclip, or open the summary file directly.')
}

/** @param {HandoffSource} [source] @param {{ projectRoot?: string, opener?: (path: string) => Promise<unknown> }} [options] @returns {Promise<string>} */
async function openHandoffSource(source = {}, { projectRoot = process.cwd(), opener } = {}) {
  const summaryPath = source.summaryPath || source.displayPath || ''
  if (!summaryPath) throw new Error('No previous results file path is available to open.')
  const absolutePath = path.isAbsolute(summaryPath) ? summaryPath : path.resolve(projectRoot, summaryPath)
  if (!fs.existsSync(absolutePath)) throw new Error(`Previous results file does not exist: ${absolutePath}`)
  const openFile = opener || (await import('open')).default
  await openFile(absolutePath)
  return absolutePath
}

module.exports = {
  buildHandoffPrompt,
  copyToClipboard,
  findRunStateForHandoff,
  formatCompactHandoffSourceHint,
  formatHandoffSourceDetailBox,
  formatHandoffSourceHint,
  formatHandoffSourceKind,
  formatHandoffSourceLabel,
  formatLatestHandoffSourceHint,
  handoffSourceDetailLines,
  handoffSourceDetailTitle,
  handoffSourceMenuOptions,
  handoffSourceQuery,
  handoffSourceUpdatedAt,
  handoffSummaryPath,
  normalizeHandoffSourceKind,
  openHandoffSource,
  printPostSuccessHandoffHint,
  previewTextForHandoffSource,
  readHandoffSummary,
  readSelectedHandoffSource,
  relativeHandoffPath,
  sourceDisplayTitle,
  usageSummaryForHandoffSource,
}
