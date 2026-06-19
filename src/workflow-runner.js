const path = require('path')
const { normalizeStepModels, stepModelsToEntries } = require('./agent-selection')

function noop(..._args) {}

function normalizeModels(models) {
  if (Array.isArray(models)) return models.map(String).filter(Boolean).join(',')
  return models || ''
}

/**
 * @param {{ flowId: string, projectRoot?: string, options?: Record<string, any>, dryRun?: boolean }} input
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

/** @param {{ onStdout?: (text: string) => void, onStderr?: (text: string) => void, passthrough?: boolean }} param0 */
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
 * Run a Nax workflow inside the current Node process.
 *
 * @param {{
 *   flowId: string,
 *   projectRoot?: string,
 *   options?: Record<string, any>,
 *   dryRun?: boolean,
 *   passthrough?: boolean,
 *   forceNonInteractive?: boolean,
 *   engine?: (flowId: string, options: Record<string, any>) => Promise<any>,
 *   eventSink?: (event: Record<string, any>) => void,
 * }} input
 */
async function runWorkflow(input) {
  const {
    flowId,
    projectRoot,
    dryRun = false,
    eventSink = noop,
  } = input
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
  }
  const command = workflowCommand({ flowId, projectRoot: runProjectRoot, options, dryRun: resolvedDryRun })
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  eventSink({ type: 'started', command, flowId })

  const restoreConsole = patchConsole({
    onStdout: (text) => {
      stdout += text
      eventSink({ type: 'stdout', text })
    },
    onStderr: (text) => {
      stderr += text
      eventSink({ type: 'stderr', text })
    },
    passthrough: input.passthrough === true,
  })
  const cwd = process.cwd()
  try {
    if (projectRoot) process.chdir(projectRoot)
    const handleRun = input.engine || loadCliRunner()
    await handleRun(flowId, options)
    const result = {
      status: 'completed',
      command,
      startedAt,
      exitedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: 0,
      signal: null,
      stdout,
      stderr,
    }
    eventSink({ type: 'exited', status: result.status, exitCode: result.exitCode, signal: null, durationMs: result.durationMs })
    return result
  } catch (error) {
    const message = error?.message || String(error)
    if (!stderr.includes(message)) {
      stderr += `${message}\n`
      eventSink({ type: 'stderr', text: `${message}\n` })
    }
    const result = {
      status: 'failed',
      command,
      startedAt,
      exitedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      exitCode: 1,
      signal: null,
      stdout,
      stderr,
    }
    eventSink({ type: 'error', message })
    eventSink({ type: 'exited', status: result.status, exitCode: result.exitCode, signal: null, durationMs: result.durationMs })
    return result
  } finally {
    if (process.cwd() !== cwd) process.chdir(cwd)
    restoreConsole()
  }
}

module.exports = {
  runWorkflow,
  workflowCommand,
}
