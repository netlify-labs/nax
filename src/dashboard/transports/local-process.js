const { spawn } = require('child_process')
const path = require('path')

const { workflowCommand } = require('../../workflows/engine/runner')
const { appendBounded } = require('../runtime/live-run-registry')

/**
 * @typedef {(event: Record<string, unknown>) => void} DashboardEventSink
 * @typedef {{ code?: string, message: string, line?: number, text?: string }} RunnerEventParseError
 *
 * @typedef {{
 *   spawn?: typeof spawn,
 *   execPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stdout?: Pick<NodeJS.WriteStream, 'write'>,
 *   stderr?: Pick<NodeJS.WriteStream, 'write'>,
 *   now?: () => number,
 *   isoNow?: () => string,
 *   forceKillDelayMs?: number,
 * }} LocalProcessWorkflowRunnerDeps
 *
 * @typedef {{
 *   flowId: string,
 *   projectRoot: string,
 *   options?: import('../../workflows/engine/runner').WorkflowCommandOptions,
 *   eventSink?: DashboardEventSink,
 *   tailOutput?: boolean,
 *   deps?: LocalProcessWorkflowRunnerDeps,
 * }} RunWorkflowChildInput
 *
 * @typedef {{
 *   status: string,
 *   command: Array<string>,
 *   startedAt: string,
 *   exitedAt: string,
 *   durationMs: number,
 *   exitCode: number | null,
 *   signal: string | null,
 *   stdout: string,
 *   stderr: string,
 *   stdoutDropped: number,
 *   stderrDropped: number,
 * }} WorkflowChildResult
 */

/**
 * Runner event parser handlers.
 * @typedef {{
 *   onEvent?: (event: Record<string, unknown>) => void,
 *   onError?: (error: RunnerEventParseError) => void,
 * }} RunnerEventParserHandlers
 *
 * @param {RunnerEventParserHandlers} [handlers]
 */
function createRunnerEventParser({ onEvent = () => {}, onError = () => {} } = {}) {
  let buffer = ''
  let lineNumber = 0
  let ended = false

  function parseLine(line) {
    lineNumber += 1
    if (!line.trim()) return
    try {
      const event = JSON.parse(line)
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        onError({
          code: 'invalid_runner_event',
          message: 'Runner event line is not a JSON object.',
          line: lineNumber,
          text: line,
        })
        return
      }
      if (!event.type) {
        onError({
          code: 'missing_runner_event_type',
          message: 'Runner event is missing a type.',
          line: lineNumber,
          text: line,
        })
        return
      }
      onEvent(event)
    } catch (error) {
      onError({
        code: 'parse_runner_event',
        message: error?.message || String(error),
        line: lineNumber,
        text: line,
      })
    }
  }

  return {
    push(chunk) {
      if (ended) return
      buffer += String(chunk || '')
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        parseLine(line)
        index = buffer.indexOf('\n')
      }
    },
    end() {
      if (ended) return
      ended = true
      if (!buffer) return
      const line = buffer.replace(/\r$/, '')
      buffer = ''
      parseLine(line)
    },
  }
}

/** @param {RunWorkflowChildInput} input */
function runWorkflowChild({ flowId, projectRoot, options = {}, eventSink = () => {}, tailOutput = false, deps = {} }) {
  const spawnCommand = deps.spawn || spawn
  const execPath = deps.execPath || process.execPath
  const sourceEnv = deps.env || process.env
  const stdoutTarget = deps.stdout || process.stdout
  const stderrTarget = deps.stderr || process.stderr
  const now = deps.now || Date.now
  const isoNow = deps.isoNow || (() => new Date().toISOString())
  const forceKillDelayMs = deps.forceKillDelayMs ?? 3000
  const command = workflowCommand({ flowId, projectRoot, options })
  const args = [path.resolve(__dirname, '..', '..', 'cli', 'nax.js'), ...command.slice(1)]
  const startedAt = isoNow()
  const started = now()
  let stdout = ''
  let stderr = ''
  let stdoutDropped = 0
  let stderrDropped = 0
  let cancelRequested = false
  let settled = false
  let runnerTerminalStatus = ''
  /** @type {NodeJS.Timeout | null} */
  let forceKillTimer = null
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...sourceEnv,
    FORCE_COLOR: sourceEnv.FORCE_COLOR || '1',
    NAX_EVENT_FD: '3',
    NAX_EVENT_STREAM: 'jsonl',
  }
  delete childEnv.NO_COLOR

  eventSink({ type: 'started', command, flowId })
  const child = spawnCommand(execPath, args, {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  const stdoutStream = child.stdout
  const stderrStream = child.stderr
  if (!stdoutStream || !stderrStream) throw new Error('Could not attach workflow runner output streams.')

  stdoutStream.setEncoding('utf8')
  stderrStream.setEncoding('utf8')
  stdoutStream.on('data', (text) => {
    const bounded = appendBounded(stdout, text)
    stdout = bounded.text
    stdoutDropped += bounded.dropped
    if (tailOutput) stdoutTarget.write(text)
    eventSink({ type: 'stdout', text })
  })
  stderrStream.on('data', (text) => {
    const bounded = appendBounded(stderr, text)
    stderr = bounded.text
    stderrDropped += bounded.dropped
    if (tailOutput) stderrTarget.write(text)
    eventSink({ type: 'stderr', text })
  })
  const eventParser = createRunnerEventParser({
    onEvent: (event) => {
      if (event?.type === 'workflow_awaiting_review') runnerTerminalStatus = 'awaiting_review'
      eventSink({ type: 'runner_event', event })
    },
    onError: (error) => eventSink({
      type: 'runner_event_error',
      message: error.message,
      line: error.line || '',
      code: error.code || 'runner_event_error',
      text: error.text || '',
    }),
  })
  /** @type {import('node:stream').Readable | undefined} */
  const eventStream = child.stdio?.[3] && 'setEncoding' in child.stdio[3]
    ? /** @type {import('node:stream').Readable} */ (child.stdio[3])
    : undefined
  if (eventStream) {
    eventStream.setEncoding('utf8')
    eventStream.on('data', (chunk) => eventParser.push(chunk))
    eventStream.on('end', () => eventParser.end())
    eventStream.on('error', (error) => {
      eventSink({
        type: 'runner_event_error',
        message: error?.message || String(error),
        code: 'runner_event_stream_error',
      })
    })
  }

  const promise = new Promise((resolve) => {
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (forceKillTimer) clearTimeout(forceKillTimer)
      const message = error?.message || String(error)
      const bounded = appendBounded(stderr, `${message}\n`)
      stderr = bounded.text
      stderrDropped += bounded.dropped
      eventSink({ type: 'stderr', text: `${message}\n` })
      eventSink({ type: 'error', message })
      const result = {
        status: 'failed',
        command,
        startedAt,
        exitedAt: isoNow(),
        durationMs: now() - started,
        exitCode: 1,
        signal: null,
        stdout,
        stderr,
        stdoutDropped,
        stderrDropped,
      }
      eventSink({ type: 'exited', status: result.status, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs })
      resolve(result)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (forceKillTimer) clearTimeout(forceKillTimer)
      const status = code === 0 ? runnerTerminalStatus || 'completed' : cancelRequested ? 'cancelled' : 'failed'
      const result = {
        status,
        command,
        startedAt,
        exitedAt: isoNow(),
        durationMs: now() - started,
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        stdout,
        stderr,
        stdoutDropped,
        stderrDropped,
      }
      if (status === 'failed') {
        const message = stderr.trim().split('\n').filter(Boolean).pop() || `Workflow "${flowId}" failed.`
        eventSink({ type: 'error', message })
      }
      eventParser.end()
      eventSink({ type: 'exited', status: result.status, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs })
      resolve(result)
    })
  })

  return {
    command,
    promise,
    cancel() {
      if (settled || child.killed) return false
      cancelRequested = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, forceKillDelayMs)
      return true
    },
  }
}

module.exports = {
  createRunnerEventParser,
  runWorkflowChild,
}
