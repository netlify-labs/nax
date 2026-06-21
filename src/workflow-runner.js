const path = require('path')
const { normalizeStepModels, stepModelsToEntries } = require('./agent-selection')

function noop(..._args) {}

function normalizeModels(models) {
  if (Array.isArray(models)) return models.map(String).filter(Boolean).join(',')
  return models || ''
}

/**
 * Workflow CLI option subset used to build and run internal commands.
 * @typedef {import('./types').JsonMap & {
 *   projectRoot?: string,
 *   transport?: string,
 *   branch?: string,
 *   context?: string,
 *   notifyUrl?: string,
 *   notifyEvents?: string | string[],
 *   step?: string,
 *   fromStep?: string,
 *   models?: string | string[],
 *   stepModels?: unknown,
 *   dryRun?: boolean,
 * }} WorkflowCommandOptions
 */

/**
 * @param {{ flowId: string, projectRoot?: string, options?: WorkflowCommandOptions, dryRun?: boolean }} input
 */
function workflowCommand(input) {
  const { flowId, options = {}, dryRun = false } = input
  const projectRoot = input.projectRoot || options.projectRoot || process.cwd()
  const args = [
    'nax',
    'run',
    flowId,
    '--project-root',
    projectRoot,
    '--force',
    '--transport',
    options.transport || 'auto',
  ]
  if (dryRun) args.push('--dry')
  if (options.branch) args.push('--branch', options.branch)
  if (options.context) args.push('--context', options.context)
  if (options.notifyUrl) args.push('--notify-url', options.notifyUrl)
  if (options.notifyEvents) args.push('--notify-events', Array.isArray(options.notifyEvents) ? options.notifyEvents.join(',') : options.notifyEvents)
  if (options.step) args.push('--step', options.step)
  if (options.fromStep) args.push('--from-step', options.fromStep)
  if (options.models?.length) args.push('--models', Array.isArray(options.models) ? options.models.join(',') : options.models)
  for (const entry of stepModelsToEntries(options.stepModels)) {
    args.push('--step-models', entry)
  }
  return args
}

function loadCliRunner() {
  const cli = require(path.resolve(__dirname, '..', 'bin', 'nax.js'))
  const handleRun = cli?._private?.handleRunEngine || cli?._private?.handleRun
  if (typeof handleRun !== 'function') {
    throw new Error('Internal workflow runner is unavailable.')
  }
  return handleRun
}

function loadCliResumeRunner() {
  const cli = require(path.resolve(__dirname, '..', 'bin', 'nax.js'))
  const resumeRun = cli?._private?.resumeRunById
  if (typeof resumeRun !== 'function') {
    throw new Error('Internal workflow resume runner is unavailable.')
  }
  return resumeRun
}

/**
 * @callback WorkflowEventSink
 * @param {import('./types').JsonMap} event
 * @returns {void}
 */

/**
 * @typedef {{
 *   onStdout?: (text: string) => void,
 *   onStderr?: (text: string) => void,
 *   passthrough?: boolean,
 * }} WorkflowConsolePatchOptions
 *
 * @typedef {{
 *   status: string,
 *   command: string[],
 *   startedAt: string,
 *   exitedAt: string,
 *   durationMs: number,
 *   exitCode: number,
 *   signal: null,
 *   stdout: string,
 *   stderr: string,
 * }} WorkflowExecutionResult
 */

/** @param {WorkflowConsolePatchOptions} options @returns {() => void} */
function patchConsole({ onStdout = noop, onStderr = noop, passthrough = false }) {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  }
  console.log = (...args) => {
    const text = `${args.map(String).join(' ')}\n`
    onStdout(text)
    if (passthrough) original.log(...args)
  }
  console.info = (...args) => {
    const text = `${args.map(String).join(' ')}\n`
    onStdout(text)
    if (passthrough) original.info(...args)
  }
  console.warn = (...args) => {
    const text = `${args.map(String).join(' ')}\n`
    onStderr(text)
    if (passthrough) original.warn(...args)
  }
  console.error = (...args) => {
    const text = `${args.map(String).join(' ')}\n`
    onStderr(text)
    if (passthrough) original.error(...args)
  }
  return () => {
    console.log = original.log
    console.info = original.info
    console.warn = original.warn
    console.error = original.error
  }
}

/**
 * @typedef {{
 *   command: string[],
 *   startEvent: import('./types').JsonMap,
 *   projectRoot?: string,
 *   passthrough?: boolean,
 *   eventSink?: WorkflowEventSink,
 *   run: () => Promise<unknown>,
 *   successStatus?: (status: unknown) => string,
 * }} InProcessWorkflowOptions
 */

/**
 * @param {string[]} command
 * @param {string} startedAt
 * @param {number} started
 * @param {string} status
 * @param {number} exitCode
 * @param {string} stdout
 * @param {string} stderr
 * @returns {WorkflowExecutionResult}
 */
function workflowResult(command, startedAt, started, status, exitCode, stdout, stderr) {
  return {
    status,
    command,
    startedAt,
    exitedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode,
    signal: null,
    stdout,
    stderr,
  }
}

/** @param {InProcessWorkflowOptions} options @returns {Promise<WorkflowExecutionResult>} */
async function runInProcessWorkflow({
  command,
  startEvent,
  projectRoot,
  passthrough = false,
  eventSink = noop,
  run,
  successStatus = () => 'completed',
}) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  eventSink({ type: 'started', command, ...startEvent })

  const restoreConsole = patchConsole({
    onStdout: (text) => {
      stdout += text
      eventSink({ type: 'stdout', text })
    },
    onStderr: (text) => {
      stderr += text
      eventSink({ type: 'stderr', text })
    },
    passthrough,
  })
  const cwd = process.cwd()
  /** @param {WorkflowExecutionResult} result */
  const emitExited = (result) => eventSink({
    type: 'exited',
    status: result.status,
    exitCode: result.exitCode,
    signal: null,
    durationMs: result.durationMs,
  })
  try {
    if (projectRoot) process.chdir(projectRoot)
    const status = await run()
    const result = workflowResult(command, startedAt, started, successStatus(status), 0, stdout, stderr)
    emitExited(result)
    return result
  } catch (error) {
    /** @type {{ code?: string, message?: string }} */
    const codedError = error && typeof error === 'object' ? error : {}
    if (codedError.code === 'awaiting_review') {
      const result = workflowResult(command, startedAt, started, 'awaiting_review', 0, stdout, stderr)
      emitExited(result)
      return result
    }
    const message = codedError.message || String(error)
    if (!stderr.includes(message)) {
      stderr += `${message}\n`
      eventSink({ type: 'stderr', text: `${message}\n` })
    }
    const result = workflowResult(command, startedAt, started, 'failed', 1, stdout, stderr)
    eventSink({ type: 'error', message })
    emitExited(result)
    return result
  } finally {
    if (process.cwd() !== cwd) process.chdir(cwd)
    restoreConsole()
  }
}

/**
 * Run a Nax workflow inside the current Node process.
 *
 * @param {{
 *   flowId: string,
 *   projectRoot?: string,
 *   options?: WorkflowCommandOptions,
 *   dryRun?: boolean,
 *   passthrough?: boolean,
 *   forceNonInteractive?: boolean,
 *   engine?: (flowId: string, options: WorkflowCommandOptions) => Promise<unknown>,
 *   eventSink?: (event: import('./types').JsonMap) => void,
 *   runnerEventSink?: (event: import('./types').JsonMap) => void,
 * }} input
 */
async function runWorkflow(input) {
  const { flowId, projectRoot, dryRun = false, eventSink = noop } = input
  const runProjectRoot = projectRoot || input.options?.projectRoot || process.cwd()
  const forceNonInteractive = input.forceNonInteractive !== false
  const resolvedDryRun = dryRun || input.options?.dryRun === true
  const options = {
    ...(input.options || {}),
    dryRun: resolvedDryRun,
    models: normalizeModels(input.options?.models),
    stepModels: normalizeStepModels(input.options?.stepModels),
    ...(projectRoot ? { projectRoot } : {}),
    ...(forceNonInteractive ? { force: true, yes: true } : {}),
    ...(input.runnerEventSink ? { runnerEventSink: input.runnerEventSink } : {}),
  }
  const command = workflowCommand({ flowId, projectRoot: runProjectRoot, options, dryRun: resolvedDryRun })
  return runInProcessWorkflow({
    command,
    startEvent: { flowId },
    projectRoot,
    eventSink,
    passthrough: input.passthrough === true,
    successStatus: (status) => status === 'awaiting_review' ? 'awaiting_review' : 'completed',
    run: async () => {
      const handleRun = input.engine || loadCliRunner()
      return handleRun(flowId, options)
    },
  })
}

async function resumeWorkflow(input) {
  const { runId, projectRoot, eventSink = noop } = input
  const command = ['nax', 'resume', runId, '--project-root', projectRoot || process.cwd()]
  return runInProcessWorkflow({
    command,
    startEvent: { runId },
    projectRoot,
    eventSink,
    passthrough: input.passthrough === true,
    run: async () => {
      const resumeRun = input.engine || loadCliResumeRunner()
      await resumeRun(runId, input.options || {})
      return null
    },
  })
}

module.exports = {
  resumeWorkflow,
  runWorkflow,
  workflowCommand,
}
