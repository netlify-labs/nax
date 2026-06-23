const readline = require('readline')
const { makeBox } = require('@davidwells/box-logger')
const flavorMessages = require('../../flavor-messages.json')
const {
  formatCreditsWithCost,
  formatUsageSummary,
  usageSummariesForRunState,
} = require('../../agent-run-results')
const { titleCase } = require('../catalog/prompts')

const DEFAULT_ORCHESTRATOR = "Netlify Agent runner"
const STEP_SPINNER_FRAMES = ['◐', '◓', '◑', '◒']
const DID_YOU_KNOW_ROTATE_MS = 25000
const DID_YOU_KNOW_BORDER_COLORS = ['#00ad9f', '#22c55e', '#38bdf8', '#f59e0b', '#a78bfa']
const AGENT_RUNNER_USE_CASES = [
  ['🔨 Prototyping / internal tools', 'Turn rough operational needs into working internal apps.', 'Build an internal dashboard for our HR team.'],
  ['👀 Code reviews', 'Bring in a fresh reviewer that can inspect architecture, tests, and edge cases.', 'Audit the code with fresh eyes and identify areas for improvement.'],
  ['🔐 Security audits', 'Run deeper checks for auth gaps, data exposure, injection risk, and unsafe defaults.', 'Do a deep security audit of our code base to identify any potential issues.'],
  ['💡 Feature suggestions', 'Use the current code, docs, and product shape to find the next best bet.', 'Based on our current code base and docs, what should we build next?'],
  ['⚡ Performance improvements', 'Find slow paths, heavy bundles, expensive queries, and easy wins.', 'Scan our code base for performance bottlenecks and suggest improvements.'],
  ['📊 Telemetry and analytics', 'Spot missing events, weak funnels, and visibility gaps.', 'What analytics things are we not tracking but probably should?'],
  ['🔎 SEO audit', 'Check pages for crawlability, metadata, broken links, alt text, and page speed.', 'Audit our site for SEO issues like missing meta tags, broken links, slow pages, and missing alt text.'],
  ['📝 Copy improvements', 'Tighten messaging, calls to action, and conversion copy.', 'Rewrite our landing page copy to be more compelling and conversion-focused.'],
  ['♿ Accessibility', 'Review keyboard flows, labels, contrast, landmarks, and WCAG gaps.', 'Run an accessibility audit and fix all WCAG 2.1 AA violations.'],
  ['📱 Mobile responsiveness', 'Inspect small viewports and fix layouts that collapse poorly.', 'Improve the mobile responsiveness and audit every page on small viewports.'],
  ['🎭 End-to-end tests', 'Cover critical user journeys with browser-level tests.', 'Add end-to-end tests for our critical user flows using Playwright.'],
  ['🧪 Unit tests', 'Backfill focused tests around utility functions and tricky logic.', 'Generate unit tests for our untested utility functions.'],
  ['📚 Documentation', 'Create docs from the actual project structure and workflows.', 'Generate a README and contributing guide based on our codebase.'],
  ['🚦 Error handling', 'Improve user-facing failures, logging, empty states, and recovery paths.', 'Add proper error boundaries, logging, and user-friendly error states throughout the app.'],
  ['✨ UX polish', 'Smooth rough edges with loading states, skeletons, and transitions.', 'Add loading states, skeleton screens, and transitions to improve perceived performance.'],
]

/**
 * Agent run shape with transient progress timestamps and task text.
 * @typedef {import('../../types').AgentRun & {
 *   startedAt?: string,
 *   finishedAt?: string,
 *   completedAt?: string,
 *   currentTask?: string,
 * }} ProgressAgentRun
 *
 * Workflow step shape used by retry and progress rendering.
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   title?: string,
 *   runs?: ProgressAgentRun[],
 * }} ProgressWorkflowStep
 *
 * Workflow run state shape used by retry and progress rendering.
 * @typedef {Record<string, unknown> & {
 *   steps?: ProgressWorkflowStep[],
 * }} ProgressWorkflowRunState
 *
 * Progress row rendered by the TTY progress reporter.
 * @typedef {import('../../types').JsonMap & {
 *   agent?: string,
 *   emoji?: string,
 *   phrase?: string,
 *   nextFlavor?: number,
 *   state?: string,
 *   status?: string,
 *   message?: string,
 *   currentTask?: string,
 *   hasRunUpdate?: boolean,
 *   url?: string,
 * }} ProgressRow
 *
 * Run update event consumed by progress reporters.
 * @typedef {import('../../types').JsonMap & {
 *   run?: ProgressAgentRun,
 *   state?: string,
 *   retry?: boolean,
 *   error?: string,
 *   message?: string,
 *   currentTask?: string,
 *   terminalSuccess?: boolean,
 *   terminalFailure?: boolean,
 * }} ProgressRunEvent
 *
 * Progress reporter interface used by workflow polling loops.
 * @typedef {{
 *   setCount: (count: number) => void,
 *   updateRun: (event: ProgressRunEvent) => void,
 *   message: (message: string) => void,
 *   done: (message?: string) => void,
 *   fail: (message?: string) => void,
 * }} StepProgressReporter
 *
 * Simple spinner reporter interface.
 * @typedef {{
 *   update: (message: string) => void,
 *   done: (message?: string) => void,
 *   fail: (message?: string) => void,
 * }} ProgressReporter
 *
 * Clack spinner API subset used by progress rendering.
 * @typedef {{
 *   spinner: () => {
 *     start: (message: string) => void,
 *     message: (message: string) => void,
 *     stop: (message: string, code?: number) => void,
 *   },
 * }} ClackSpinnerApi
 *
 * Options for clearing a rendered progress frame.
 * @typedef {{
 *   rows?: number,
 *   lines?: string[],
 *   columns?: number,
 *   output?: NodeJS.WriteStream,
 *   controls?: Pick<typeof readline, 'moveCursor' | 'cursorTo' | 'clearScreenDown'>,
 * }} ClearRenderedProgressFrameInput
 */

let clackModulePromise

/**
 * Lazily loads Clack for TTY progress spinners.
 * @returns {Promise<ClackSpinnerApi>}
 */
async function loadClack() {
  clackModulePromise = clackModulePromise || import('@clack/prompts')
  return clackModulePromise
}

/**
 * Parses a date-like value to milliseconds.
 * @param {string | number | Date | null | undefined} value
 * @returns {number | null}
 */
function dateMs(value) {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

/**
 * Finds the best known start timestamp for one run.
 * @param {ProgressAgentRun} [run]
 * @returns {number | null}
 */
function runStartMs(run = {}) {
  const session = run.rawResult?.latestSession || {}
  const runner = run.rawResult?.runner || {}
  return [
    run.startedAt,
    run.createdAt,
    session.created_at,
    session.createdAt,
    runner.created_at,
    runner.createdAt,
  ].map(dateMs).find((value) => value !== null) ?? null
}

/**
 * Finds the best known end timestamp for one run.
 * @param {ProgressAgentRun} [run]
 * @returns {number | null}
 */
function runEndMs(run = {}) {
  const session = run.rawResult?.latestSession || {}
  const runner = run.rawResult?.runner || {}
  return [
    run.finishedAt,
    run.completedAt,
    run.updatedAt,
    session.done_at,
    session.doneAt,
    session.updated_at,
    session.updatedAt,
    runner.done_at,
    runner.doneAt,
    runner.updated_at,
    runner.updatedAt,
  ].map(dateMs).find((value) => value !== null) ?? null
}

/**
 * Formats milliseconds as compact duration text.
 * @param {number | null | undefined} durationMs
 * @returns {string}
 */
function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || Number(durationMs) < 0) return ''
  let seconds = Math.max(1, Math.round(Number(durationMs) / 1000))
  const hours = Math.floor(seconds / 3600)
  seconds -= hours * 3600
  const minutes = Math.floor(seconds / 60)
  seconds -= minutes * 60
  if (hours > 0) return `${hours}h ${minutes}min ${seconds}s`
  if (minutes > 0) return `${minutes}min ${seconds}s`
  return `${seconds}s`
}

/**
 * Computes one run duration in milliseconds.
 * @param {ProgressAgentRun} [run]
 * @returns {number | null}
 */
function runDurationMs(run = {}) {
  const start = runStartMs(run)
  const end = runEndMs(run)
  return start !== null && end !== null && end >= start ? end - start : null
}

/**
 * Computes a step duration from all submitted runs.
 * @param {ProgressAgentRun[]} [runs]
 * @returns {number | null}
 */
function stepDurationMs(runs = []) {
  const starts = runs.map(runStartMs).filter((value) => value !== null)
  const ends = runs.map(runEndMs).filter((value) => value !== null)
  if (starts.length > 0 && ends.length > 0) {
    const start = Math.min(...starts)
    const end = Math.max(...ends)
    if (end >= start) return end - start
  }
  const durations = runs.map(runDurationMs).filter((value) => value !== null)
  return durations.length > 0 ? Math.max(...durations) : null
}

/** @param {number | null | undefined} value @returns {string} */
function formatCreditsValue(value) {
  return Number.isFinite(value) ? formatCreditsWithCost(Number(value)) : ''
}

/** @param {number | null | undefined} value @param {string} label @returns {string} */
function formatCountValue(value, label) {
  return Number.isFinite(value) ? `${Number(value).toLocaleString('en-US')} ${label}` : ''
}

/**
 * Formats a completed step summary with per-agent usage.
 * @param {{
 *   stepTitle?: string,
 *   runs?: ProgressAgentRun[],
 *   failedCount?: number,
 * }} [input]
 * @returns {string}
 */
function agentStepCompletionSummary({ stepTitle, runs = [], failedCount = 0 } = {}) {
  const doneCount = runs.filter((run) => run.status === 'completed').length
  const duration = formatDurationMs(stepDurationMs(runs))
  const headerStatus = failedCount > 0
    ? `${doneCount}/${runs.length} complete, ${failedCount} failed`
    : `${doneCount}/${runs.length} complete`
  const header = `${stepTitle}: ${headerStatus}${duration ? ` - ${duration}` : ''}`
  const rows = runs.map((run) => {
    const usage = run.usage || {}
    return {
      agent: `${titleCase(run.agent || 'agent')}:`,
      status: run.status === 'completed' ? 'complete' : run.status || 'unknown',
      duration: formatDurationMs(runDurationMs(run)),
      credits: formatCreditsValue(usage.totalCreditsCost),
      steps: formatCountValue(usage.stepsCount, 'steps'),
      tokens: formatCountValue(usage.totalTokens, 'tokens'),
    }
  })
  const totalUsage = usageSummariesForRunState({ steps: [{ runs }] }).total
  const totalRow = {
    agent: 'Total:',
    credits: formatCreditsValue(totalUsage.totalCreditsCost),
    steps: formatCountValue(totalUsage.stepsCount, 'steps'),
    tokens: formatCountValue(totalUsage.totalTokens, 'tokens'),
  }
  const widths = {
    agent: Math.max(totalRow.agent.length, ...rows.map((row) => row.agent.length)),
    status: Math.max(0, ...rows.map((row) => row.status.length)),
    duration: Math.max(0, ...rows.map((row) => row.duration.length)),
    credits: Math.max(totalRow.credits.length, ...rows.map((row) => row.credits.length)),
    steps: Math.max(totalRow.steps.length, ...rows.map((row) => row.steps.length)),
    tokens: Math.max(totalRow.tokens.length, ...rows.map((row) => row.tokens.length)),
  }
  const formattedRows = rows.map((row) => [
    row.agent.padEnd(widths.agent),
    row.status.padEnd(widths.status),
    row.duration.padEnd(widths.duration),
    row.credits.padStart(widths.credits),
    row.steps.padStart(widths.steps),
    row.tokens.padStart(widths.tokens),
  ].join('  ').trimEnd())
  const formattedTotal = [
    totalRow.agent.padEnd(widths.agent),
    totalRow.credits.padStart(widths.credits),
    totalRow.steps.padStart(widths.steps),
    totalRow.tokens.padStart(widths.tokens),
  ].join('  ').trimEnd()
  return [header, ...formattedRows, formattedTotal].join('\n')
}

/** @param {import('../../types').WorkflowStep[]} steps @param {number} index @returns {string} */
function nextLocalStepMessage(steps, index) {
  const nextStep = steps[index + 1]
  return nextStep ? `Preparing next step: ${nextStep.title}...` : 'Finalizing workflow outputs...'
}

/** @param {ProgressAgentRun} run @returns {boolean} */
function shouldPollLocalRun(run) {
  if (!run.runnerId) return false
  if (run.status === 'dry-run') return false
  if (run.status === 'failed' || run.status === 'timeout') return false
  if (run.status === 'completed' && run.resultText) return false
  return true
}

/**
 * Finds failed local runs eligible for retry.
 * @param {ProgressWorkflowRunState} runState
 * @param {{ stepId?: string, agent?: string }} [options]
 * @returns {Array<{
 *   step: ProgressWorkflowStep,
 *   stepIndex: number,
 *   run: ProgressAgentRun,
 *   runIndex: number,
 * }>}
 */
function localRetryCandidates(runState, { stepId, agent } = {}) {
  const requestedAgent = String(agent || '').trim().toLowerCase()
  return (runState.steps || []).flatMap((step, stepIndex) => {
    if (stepId && step.id !== stepId) return []
    return (step.runs || []).map((run, runIndex) => ({
      step,
      stepIndex,
      run,
      runIndex,
    })).filter(({ run }) => {
      if (requestedAgent && String(run.agent || '').toLowerCase() !== requestedAgent) return false
      if (!run.runnerId) return false
      return run.status === 'failed' || run.status === 'timeout'
    })
  })
}

/** @param {ProgressAgentRun} run @returns {boolean} */
function shouldPollGithubRun(run) {
  if (!run.issueNumber) return false
  if (run.status === 'dry-run') return false
  if (run.status === 'failed') return false
  if (run.status === 'completed' && run.resultText) return false
  if (run.status === 'timeout' && run.resultText) return false
  return true
}

/** @param {string} url @returns {number | null} */
function parseIssueNumberFromUrl(url) {
  const match = String(url || '').match(/\/issues\/(\d+)(?:#.*)?$/)
  return match ? Number(match[1]) : null
}

/**
 * Creates a small spinner-like progress reporter.
 * @param {string} initialMessage
 * @returns {Promise<ProgressReporter>}
 */
async function makeProgressReporter(initialMessage) {
  if (!process.stdout.isTTY) {
    return {
      update: (message) => console.log(message),
      done: (message) => { if (message) console.log(message) },
      fail: (message) => { if (message) console.log(message) },
    }
  }
  const clack = await loadClack()
  const spinner = clack.spinner()
  spinner.start(initialMessage)
  return {
    update: (message) => spinner.message(message),
    done: (message) => spinner.stop(message || initialMessage),
    fail: (message) => spinner.stop(message || initialMessage, 1),
  }
}

/**
 * Picks a rotating flavor message, avoiding active phrases.
 * @param {{
 *   used?: Set<string>,
 *   random?: () => number,
 * }} [input]
 * @returns {string[]}
 */
function pickFlavor({ used = new Set(), random = Math.random } = {}) {
  if (flavorMessages.length === 0) return ['', '']
  const start = Math.floor(random() * flavorMessages.length)
  for (let offset = 0; offset < flavorMessages.length; offset += 1) {
    const candidate = flavorMessages[(start + offset) % flavorMessages.length]
    if (!used.has(candidate[0])) return candidate
  }
  return flavorMessages[start]
}

/** @param {string[]} agents @returns {string} */
function pickAgentLabel(agents) {
  if (!agents || agents.length === 0) return 'Agent'
  return titleCase(agents[Math.floor(Math.random() * agents.length)])
}

/**
 * Compacts arbitrary errors for one-line display.
 * @param {unknown} error
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
function conciseErrorMessage(error, { maxLength = 700 } = {}) {
  const raw = String(error && typeof error === 'object' && 'message' in error ? error.message : error || 'Unknown error').replace(/\s+/g, ' ').trim()
  if (raw.length <= maxLength) return raw
  return `${raw.slice(0, maxLength - 1)}…`
}

/**
 * Formats aggregate submission failures.
 * @param {Array<{ label?: string, error?: unknown }>} failures
 * @returns {string}
 */
function submissionFailureSummary(failures) {
  const lines = failures
    .filter((failure) => failure?.label)
    .map((failure) => `- ${failure.label}: ${conciseErrorMessage(failure.error)}`)
  return `Netlify agent submission failed for ${lines.length} ${lines.length === 1 ? 'run' : 'runs'}:\n${lines.join('\n')}`
}

/**
 * Starts a TTY-only heartbeat while submissions are pending.
 * @param {{
 *   pendingLabels?: Set<string>,
 *   startedAt?: number,
 *   intervalMs?: number,
 * }} [input]
 * @returns {() => void}
 */
function startSubmissionHeartbeat({ pendingLabels = new Set(), startedAt = Date.now(), intervalMs = 30000 } = {}) {
  if (!process.stdout.isTTY) return () => {}
  const timer = setInterval(() => {
    const labels = [...pendingLabels]
    if (labels.length === 0) return
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
    console.log(`Still submitting after ${elapsedSeconds}s: ${labels.join(', ')}`)
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** @param {{ min: number, max: number }} input @returns {number} */
function nextFlavorAt({ min, max }) {
  const range = Math.max(0, max - min)
  return Date.now() + min + Math.floor(Math.random() * (range + 1))
}

/** @param {string | null | undefined} line @returns {number} */
function visibleLength(line) {
  return String(line ?? '').replace(/\x1b\[[0-9;]*m/g, '').length
}

/** @param {string[]} lines @param {number | undefined} columns @returns {number} */
function physicalRowCount(lines, columns) {
  const cols = Number(columns) || 0
  if (cols <= 0) return lines.length
  let count = 0
  for (const line of lines) {
    count += Math.max(1, Math.ceil(visibleLength(line) / cols))
  }
  return count
}

/**
 * Clears a previously rendered progress frame and returns physical rows cleared.
 * @param {ClearRenderedProgressFrameInput} [input]
 * @returns {number}
 */
function clearRenderedProgressFrame({
  rows = 0,
  lines = [],
  columns,
  output = process.stdout,
  controls = readline,
} = {}) {
  const previousColumns = Number(columns) || 0
  const currentColumns = Number(output.columns) || Number(process.stdout.columns) || previousColumns
  const clearRows = Math.max(
    Number(rows) || 0,
    physicalRowCount(lines, previousColumns),
    physicalRowCount(lines, currentColumns),
  )
  if (clearRows > 0) {
    controls.moveCursor(output, 0, -clearRows)
    controls.cursorTo(output, 0)
    controls.clearScreenDown(output)
  }
  return clearRows
}

/** @param {string} text @param {{ width?: number, indent?: string }} [options] @returns {string[]} */
function wrapLine(text, { width = 100, indent = '' } = {}) {
  const maxWidth = Math.max(20, width)
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    const prefix = lines.length === 0 ? '' : indent
    const next = current ? `${current} ${word}` : `${prefix}${word}`
    if (next.length > maxWidth && current) {
      lines.push(current)
      current = `${indent}${word}`
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/** @param {string} title @returns {string} */
function agentRunUseCaseTitle(title) {
  const value = String(title || '').trim()
  const match = value.match(/^(\S+)\s+(.+)$/)
  if (!match) return `Use Agent Runs for ${value || 'more workflows'}`
  return `${match[1]} Use Agent Runs for ${match[2]}`
}

/**
 * Formats the rotating Did You Know progress box.
 * @param {string[]} useCase
 * @param {{
 *   width?: number,
 *   color?: string,
 *   marginRight?: number,
 * }} [options]
 * @returns {string[]}
 */
function formatDidYouKnowLines(useCase, {
  width,
  color = DID_YOU_KNOW_BORDER_COLORS[0],
  marginRight = 2,
} = {}) {
  if (!Array.isArray(useCase) || useCase.length < 2) return []
  const [title, description, prompt = ''] = useCase
  const viewportWidth = Number(width) || process.stdout.columns || 100
  const maxWidth = Math.max(24, viewportWidth - Math.max(0, marginRight) - 2)
  return [
    ...wrapLine('While agent runners are doing their magic, here are some other use cases for Netlify Agent runners', { width: maxWidth }),
    ...makeBox({
      title: agentRunUseCaseTitle(title),
      content: ({ innerWidth }) => {
        const contentWidth = Math.max(20, innerWidth)
        return [
          ...wrapLine(description, {
            width: contentWidth,
            indent: '',
          }),
          ...(prompt ? [
            '',
            'Prompt Examples:',
            ...wrapLine(`- "${prompt}"`, {
              width: contentWidth,
              indent: '  ',
            }),
          ] : []),
        ].join('\n')
      },
      borderStyle: 'rounded',
      borderColor: color,
      marginRight,
      maxWidth,
    }).split('\n'),
  ]
}

/** @param {ProgressRunEvent} [event] @param {{ agentWidth?: number, stateWidth?: number }} [options] @returns {string} */
function formatNonTtyRunStatusMessage(event = {}, { agentWidth = 0, stateWidth = 0 } = {}) {
  const run = event.run || {}
  const agent = String(run.agent || 'agent')
  const id = run.runnerId || run.issueNumber || ''
  const state = String(event.state || run.status || 'unknown')
  return `${agent.padEnd(agentWidth)} ${id}: ${state.padEnd(stateWidth)}`
}

/** @param {import('../../types').UsageSummary | null | undefined} usage @returns {string} */
function formatUsageLogLine(usage) {
  const summary = formatUsageSummary(usage)
  return summary ? `**Usage:** ${summary.replace(/, /g, ' · ')}` : ''
}

/** @param {string | null | undefined} value @param {{ max?: number }} [options] @returns {string} */
function compactCurrentTask(value, { max = 96 } = {}) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** @param {ProgressRow} row @param {{ nameWidth?: number, frame?: number, orchestrator?: string }} [options] @returns {string} */
function formatTtyProgressRow(row, { nameWidth = 0, frame = 0, orchestrator = DEFAULT_ORCHESTRATOR } = {}) {
  const name = titleCase(row.agent).padEnd(nameWidth, ' ')
  if (row.status === 'completed') return `✓ ${name} · 🟢 complete${row.url ? ` - ${row.url}` : ''}`
  if (row.status === 'failed') return `✖ ${name} · failed${row.message ? ` · ${row.message}` : ''}`
  const icon = STEP_SPINNER_FRAMES[frame % STEP_SPINNER_FRAMES.length]
  const label = row.message || `${row.emoji} ${orchestrator} ${row.phrase}`
  const currentTask = compactCurrentTask(row.currentTask)
  return `${icon} ${name} · ${label}${currentTask ? ` - "${currentTask}"` : ''}${row.url ? ` - ${row.url}` : ''}`
}

/**
 * Creates the workflow step progress reporter.
 * @param {{
 *   stepTitle?: string,
 *   total?: number,
 *   agents?: string[],
 *   orchestrator?: string,
 *   flavorMinMs?: number,
 *   flavorMaxMs?: number,
 *   nonTtyHeartbeatMs?: number,
 * }} [input]
 * @returns {StepProgressReporter}
 */
function makeStepProgressReporter({
  stepTitle,
  total = 0,
  agents = [],
  orchestrator = DEFAULT_ORCHESTRATOR,
  flavorMinMs = 10000,
  flavorMaxMs = 15000,
  nonTtyHeartbeatMs = 60000,
} = {}) {
  if (!process.stdout.isTTY) {
    let lastCount = -1
    const lastRunLogs = new Map()
    const agentWidth = Math.max(0, ...agents.map((agent) => String(agent).length))
    let stateWidth = 0
    return {
      setCount: (n) => {
        if (n === lastCount) return
        lastCount = n
        console.log(`Waiting for ${stepTitle}: ${n}/${total} complete`)
      },
      updateRun: (event) => {
        const id = event.run?.runnerId || event.run?.issueNumber || event.run?.agent
        if (!id) return
        stateWidth = Math.max(stateWidth, String(event.state || event.run?.status || 'unknown').length)
        const statusMessage = formatNonTtyRunStatusMessage(event, { agentWidth, stateWidth })
        const useStatusMessage = event.run && (event.state || event.run?.status) && !event.retry && !event.error
        const message = useStatusMessage ? statusMessage : (event.message || statusMessage)
        const previous = lastRunLogs.get(id) || {}
        const checkCount = Number(previous.checkCount || 0) + 1
        const now = Date.now()
        if (previous?.message === message && now - previous.loggedAt < nonTtyHeartbeatMs) {
          lastRunLogs.set(id, { ...previous, checkCount })
          return
        }
        lastRunLogs.set(id, { message, loggedAt: now, checkCount })
        const runUrl = event.run?.links?.sessionUrl || event.run?.links?.agentRunUrl || ''
        const usageLine = event.terminalSuccess ? formatUsageLogLine(event.run?.usage) : ''
        const runUrlLine = runUrl && !String(message).includes(runUrl) ? `Agent run: ${runUrl}` : ''
        console.log([
          `${message} (check #${checkCount})`,
          runUrlLine,
          usageLine,
        ].filter(Boolean).join('\n'))
      },
      message: (msg) => console.log(msg),
      done: (msg) => { if (msg) console.log(msg) },
      fail: (msg) => { if (msg) console.log(msg) },
    }
  }

  const rows = new Map()
  const usedFlavorPhrases = (exceptRow) => new Set([...rows.values()]
    .filter((row) => row !== exceptRow && (row.status === 'pending' || row.status === 'running'))
    .map((row) => row.phrase)
    .filter(Boolean))
  const assignFlavor = (row) => {
    const [phrase, emoji] = pickFlavor({ used: usedFlavorPhrases(row) })
    row.phrase = phrase
    row.emoji = emoji
    row.nextFlavor = nextFlavorAt({ min: flavorMinMs, max: flavorMaxMs })
  }
  const createRow = (agent) => {
    const row = {
      agent,
      emoji: '',
      phrase: '',
      nextFlavor: 0,
      state: 'pending',
      status: 'pending',
      message: '',
      currentTask: '',
      hasRunUpdate: false,
    }
    assignFlavor(row)
    return row
  }
  for (const agent of agents) {
    rows.set(agent, createRow(agent))
  }
  let frame = 0
  let renderedLines = 0
  let renderedFrameLines = []
  let renderedColumns = process.stdout.columns
  let finished = false
  let didYouKnowIndex = 0
  let nextDidYouKnowAt = Date.now() + DID_YOU_KNOW_ROTATE_MS

  const rowForAgent = (agent) => {
    const key = agent || `agent-${rows.size + 1}`
    if (!rows.has(key)) rows.set(key, createRow(key))
    return rows.get(key)
  }

  const completeCount = () => [...rows.values()].filter((row) => row.status === 'completed').length
  const displayRows = () => [...rows.values()]
  const rotateFlavor = (row) => {
    if (row.status !== 'pending' && row.status !== 'running') return
    if (Date.now() < row.nextFlavor) return
    assignFlavor(row)
  }
  const renderRow = (row, nameWidth) => {
    return formatTtyProgressRow(row, { nameWidth, frame, orchestrator })
  }
  const renderLines = () => {
    const now = Date.now()
    if (AGENT_RUNNER_USE_CASES.length > 0 && now >= nextDidYouKnowAt) {
      didYouKnowIndex = (didYouKnowIndex + 1) % AGENT_RUNNER_USE_CASES.length
      nextDidYouKnowAt = now + DID_YOU_KNOW_ROTATE_MS
    }
    for (const row of rows.values()) rotateFlavor(row)
    const visibleRows = displayRows()
    const nameWidth = visibleRows.reduce((max, row) => Math.max(max, titleCase(row.agent).length), 0)
    const activeRows = visibleRows.some((row) => row.status === 'pending' || row.status === 'running')
    const didYouKnowLines = activeRows
      ? formatDidYouKnowLines(AGENT_RUNNER_USE_CASES[didYouKnowIndex], {
          color: DID_YOU_KNOW_BORDER_COLORS[didYouKnowIndex % DID_YOU_KNOW_BORDER_COLORS.length],
        })
      : []
    return [
      ...didYouKnowLines,
      ...(didYouKnowLines.length > 0 ? [''] : []),
      `Waiting for ${stepTitle}: ${completeCount()}/${total} complete`,
      ...visibleRows.map((row) => renderRow(row, nameWidth)),
    ]
  }
  const writeLines = (lines) => {
    if (finished) return
    clearRenderedProgressFrame({
      rows: renderedLines,
      lines: renderedFrameLines,
      columns: renderedColumns,
    })
    process.stdout.write(`${lines.join('\n')}\n`)
    renderedLines = physicalRowCount(lines, process.stdout.columns)
    renderedFrameLines = lines
    renderedColumns = process.stdout.columns
  }
  const redraw = () => {
    frame += 1
    writeLines(renderLines())
  }
  process.stdout.write('\n')
  writeLines(renderLines())
  const timer = setInterval(redraw, 180)
  timer.unref?.()
  const stop = (msg) => {
    finished = true
    clearInterval(timer)
    clearRenderedProgressFrame({
      rows: renderedLines,
      lines: renderedFrameLines,
      columns: renderedColumns,
    })
    const lines = renderLines()
    process.stdout.write(`${lines.join('\n')}\n`)
    renderedLines = 0
    renderedFrameLines = []
    renderedColumns = process.stdout.columns
    if (msg) console.log(`\n${msg}`)
  }
  return {
    setCount: (n) => {
      const hasRunSpecificRows = [...rows.values()].some((row) => row.hasRunUpdate)
      if (hasRunSpecificRows) {
        redraw()
        return
      }
      let remaining = n
      for (const row of rows.values()) {
        row.status = remaining > 0 ? 'completed' : 'running'
        row.message = ''
        remaining -= 1
      }
      redraw()
    },
    updateRun: (event) => {
      const row = rowForAgent(event.run?.agent)
      row.hasRunUpdate = true
      row.state = event.state || row.state
      if (event.terminalSuccess || event.run?.status === 'completed') {
        row.status = 'completed'
        row.message = ''
        row.currentTask = ''
        row.url = event.run?.links?.sessionUrl || event.run?.links?.agentRunUrl || ''
      } else if (event.terminalFailure || event.run?.status === 'failed' || event.run?.status === 'timeout') {
        row.status = 'failed'
        row.message = event.error || event.run?.resultText || event.state || ''
        row.currentTask = ''
        row.url = ''
      } else {
        row.status = 'running'
        row.message = event.retry ? (event.message || 'retrying') : ''
        row.currentTask = event.currentTask || event.run?.currentTask || row.currentTask || ''
        row.url = event.run?.links?.sessionUrl || event.run?.links?.agentRunUrl || row.url || ''
      }
      redraw()
    },
    message: (msg) => {
      if (!msg) return
      const row = rowForAgent('status')
      row.status = 'running'
      row.message = msg
      redraw()
    },
    done: (msg) => {
      stop(msg || `${stepTitle}: ${total}/${total} complete`)
    },
    fail: (msg) => {
      stop(msg || `Failed waiting for ${stepTitle}`)
    },
  }
}

module.exports = {
  AGENT_RUNNER_USE_CASES,
  DEFAULT_ORCHESTRATOR,
  DID_YOU_KNOW_BORDER_COLORS,
  DID_YOU_KNOW_ROTATE_MS,
  STEP_SPINNER_FRAMES,
  agentRunUseCaseTitle,
  agentStepCompletionSummary,
  clearRenderedProgressFrame,
  compactCurrentTask,
  conciseErrorMessage,
  dateMs,
  formatCountValue,
  formatCreditsValue,
  formatDidYouKnowLines,
  formatDurationMs,
  formatNonTtyRunStatusMessage,
  formatTtyProgressRow,
  formatUsageLogLine,
  localRetryCandidates,
  makeProgressReporter,
  makeStepProgressReporter,
  nextFlavorAt,
  nextLocalStepMessage,
  parseIssueNumberFromUrl,
  physicalRowCount,
  pickAgentLabel,
  pickFlavor,
  runDurationMs,
  runEndMs,
  runStartMs,
  shouldPollGithubRun,
  shouldPollLocalRun,
  startSubmissionHeartbeat,
  stepDurationMs,
  submissionFailureSummary,
  visibleLength,
  wrapLine,
}
