const fs = require('fs')

const { appendEventLog } = require('./runner-event-log')

/**
 * Callback used when event emission cannot write to a sink.
 * @callback RunnerEventErrorHandler
 * @param {unknown} error
 * @returns {void}
 *
 * Clock used to stamp runner events.
 * @callback RunnerEventClock
 * @returns {Date}
 */

/**
 * Mutable runner event context copied onto emitted events.
 * @typedef {{
 *   runId?: string,
 *   flowId?: string,
 *   dashboardRunId?: string,
 *   logPath?: string,
 * }} RunnerEventContext
 *
 * Options for creating a durable runner event emitter.
 * @typedef {{
 *   runId?: string,
 *   flowId?: string,
 *   dashboardRunId?: string,
 *   logPath?: string,
 *   seqStart?: number,
 *   env?: NodeJS.ProcessEnv,
 *   stream?: import('stream').Writable,
 *   fd?: number | string,
 *   now?: RunnerEventClock,
 *   onError?: RunnerEventErrorHandler,
 * }} RunnerEventEmitterOptions
 *
 * Sanitized runner event payload with common inspected fields.
 * @typedef {Record<string, unknown> & {
 *   token?: string,
 *   nested?: Record<string, string>,
 *   promptText?: string,
 *   message?: string,
 * }} SanitizedRunnerEventPayload
 *
 * Runner event emitter returned to workflow code.
 * @typedef {{
 *   readonly enabled: boolean,
 *   readonly seq: number,
 *   emit: (type: string, payload?: import('../../types').JsonMap) => import('../../types').JsonMap,
 *   emitAsync: (type: string, payload?: import('../../types').JsonMap) => Promise<import('../../types').JsonMap>,
 *   setContext: (context?: RunnerEventContext) => void,
 *   close: () => void,
 * }} RunnerEventEmitter
 *
 * @typedef {Record<string, unknown> | unknown[]} SeenEventObject
 */

const SCHEMA_VERSION = 1
const LARGE_STRING_LIMIT = 16 * 1024
const REDACTED = '[redacted]'
const SECRET_KEY_PATTERN = /(?:token|secret|password|authorization|apikey|api_key|auth)/i
const LARGE_TEXT_KEY_PATTERN = /(?:prompt|markdown|body|resultText|text)$/i

/** @param {NodeJS.ProcessEnv} [env] @returns {boolean} */
function isRunnerEventEnabled(env = process.env) {
  return Boolean(env.NAX_EVENT_FD || env.NAX_EVENT_STREAM)
}

/** @param {unknown} value @param {string} [key] @returns {string} */
function redactString(value, key = '') {
  const text = String(value)
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED
  if (text.length > LARGE_STRING_LIMIT || LARGE_TEXT_KEY_PATTERN.test(key) && text.length > 4096) {
    return `[omitted ${text.length} chars]`
  }
  return text
}

/**
 * @param {unknown} value
 * @param {string} [key]
 * @param {WeakSet<SeenEventObject>} [seen]
 * @returns {SanitizedRunnerEventPayload}
 */
function sanitizeEventPayload(value, key = '', seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return /** @type {SanitizedRunnerEventPayload} */ (/** @type {unknown} */ (value))
  }
  if (typeof value === 'string') {
    return /** @type {SanitizedRunnerEventPayload} */ (/** @type {unknown} */ (redactString(value, key)))
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return /** @type {SanitizedRunnerEventPayload} */ (/** @type {unknown} */ (value))
  }
  if (typeof value !== 'object') {
    return /** @type {SanitizedRunnerEventPayload} */ (/** @type {unknown} */ (String(value)))
  }
  const seenValue = /** @type {SeenEventObject} */ (value)
  if (seen.has(seenValue)) {
    return /** @type {SanitizedRunnerEventPayload} */ (/** @type {unknown} */ ('[circular]'))
  }
  seen.add(seenValue)

  if (Array.isArray(value)) {
    return /** @type {SanitizedRunnerEventPayload} */ (
      /** @type {unknown} */ (value.map((item) => sanitizeEventPayload(item, key, seen)))
    )
  }

  /** @type {SanitizedRunnerEventPayload} */
  const out = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeEventPayload(childValue, childKey, seen)
  }
  return out
}

/**
 * @param {RunnerEventContext} base
 * @param {string} type
 * @param {import('../../types').JsonMap} payload
 * @param {number} seq
 * @param {Date} [now]
 * @returns {import('../../types').JsonMap}
 */
function normalizeRunnerEvent(base = {}, type, payload = {}, seq, now = new Date()) {
  const sanitizedValue = sanitizeEventPayload(payload)
  /** @type {import('../../types').JsonMap} */
  const sanitized = sanitizedValue && typeof sanitizedValue === 'object' && !Array.isArray(sanitizedValue)
    ? /** @type {import('../../types').JsonMap} */ (sanitizedValue)
    : {}
  const runId = sanitized.runId || base.runId || ''
  const flowId = sanitized.flowId || base.flowId || ''
  return {
    schemaVersion: SCHEMA_VERSION,
    seq,
    eventId: `${runId || 'pending'}:${seq}`,
    type,
    at: now.toISOString(),
    ...(runId ? { runId } : {}),
    ...(flowId ? { flowId } : {}),
    ...(base.dashboardRunId ? { dashboardRunId: base.dashboardRunId } : {}),
    ...sanitized,
  }
}

/** @param {number | string | undefined} fd @returns {import('fs').WriteStream | null} */
function createFdStream(fd) {
  const numericFd = Number(fd)
  if (!Number.isInteger(numericFd) || numericFd < 0) return null
  return fs.createWriteStream(null, { fd: numericFd, autoClose: false })
}

/**
 * @param {import('stream').Writable} stream
 * @param {string} line
 * @returns {Promise<void>}
 */
function writeLine(stream, line) {
  return new Promise((resolve, reject) => {
    const flushed = stream.write(line, (error) => {
      if (error) reject(error)
      else resolve()
    })
    if (!flushed && typeof stream.once === 'function') stream.once('drain', resolve)
  })
}

/** @param {RunnerEventEmitterOptions} [options] @returns {RunnerEventEmitter} */
function createRunnerEventEmitter(options = {}) {
  let runId = options.runId || ''
  let flowId = options.flowId || ''
  let dashboardRunId = options.dashboardRunId || ''
  let logPath = options.logPath || ''
  let seq = Number.isFinite(Number(options.seqStart)) ? Number(options.seqStart) : 0
  const env = options.env || process.env
  const stream = options.stream || (options.fd || env.NAX_EVENT_FD ? createFdStream(options.fd || env.NAX_EVENT_FD) : null)
  const now = options.now || (() => new Date())
  const onError = typeof options.onError === 'function' ? options.onError : () => {}
  function isEnabled() {
    return Boolean(stream || logPath)
  }

  function emit(type, payload = {}) {
    seq += 1
    const event = normalizeRunnerEvent({ runId, flowId, dashboardRunId }, type, payload, seq, now())
    if (!isEnabled()) return event
    try {
      if (logPath) appendEventLog(logPath, event)
      if (stream) {
        const line = `${JSON.stringify(event)}\n`
        stream.write(line)
      }
    } catch (error) {
      onError(error)
    }
    return event
  }

  async function emitAsync(type, payload = {}) {
    seq += 1
    const event = normalizeRunnerEvent({ runId, flowId, dashboardRunId }, type, payload, seq, now())
    if (!isEnabled()) return event
    try {
      if (logPath) appendEventLog(logPath, event)
      if (stream) await writeLine(stream, `${JSON.stringify(event)}\n`)
    } catch (error) {
      onError(error)
    }
    return event
  }

  return {
    get enabled() {
      return isEnabled()
    },
    get seq() {
      return seq
    },
    emit,
    emitAsync,
    setContext(context = {}) {
      if (context.runId !== undefined) runId = context.runId || ''
      if (context.flowId !== undefined) flowId = context.flowId || ''
      if (context.dashboardRunId !== undefined) dashboardRunId = context.dashboardRunId || ''
      if (context.logPath !== undefined) logPath = context.logPath || ''
    },
    close() {
      if (stream && stream !== options.stream && typeof stream.end === 'function') stream.end()
    },
  }
}

module.exports = {
  LARGE_STRING_LIMIT,
  SCHEMA_VERSION,
  createRunnerEventEmitter,
  isRunnerEventEnabled,
  normalizeRunnerEvent,
  sanitizeEventPayload,
}
