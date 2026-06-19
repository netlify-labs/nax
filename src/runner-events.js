const fs = require('fs')

const { appendEventLog } = require('./runner-event-log')

const SCHEMA_VERSION = 1
const LARGE_STRING_LIMIT = 16 * 1024
const REDACTED = '[redacted]'
const SECRET_KEY_PATTERN = /(?:token|secret|password|authorization|apikey|api_key|auth)/i
const LARGE_TEXT_KEY_PATTERN = /(?:prompt|markdown|body|resultText|text)$/i

function isRunnerEventEnabled(env = process.env) {
  return Boolean(env.NAX_EVENT_FD || env.NAX_EVENT_STREAM)
}

function redactString(value, key = '') {
  const text = String(value)
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED
  if (text.length > LARGE_STRING_LIMIT || LARGE_TEXT_KEY_PATTERN.test(key) && text.length > 4096) {
    return `[omitted ${text.length} chars]`
  }
  return text
}

function sanitizeEventPayload(value, key = '', seen = new WeakSet()) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value, key)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEventPayload(item, key, seen))
  }

  const out = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeEventPayload(childValue, childKey, seen)
  }
  return out
}

function normalizeRunnerEvent(base = {}, type, payload = {}, seq, now = new Date()) {
  const sanitized = sanitizeEventPayload(payload) || {}
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
    ...(base.visualizeRunId ? { visualizeRunId: base.visualizeRunId } : {}),
    ...sanitized,
  }
}

function createFdStream(fd) {
  const numericFd = Number(fd)
  if (!Number.isInteger(numericFd) || numericFd < 0) return null
  return fs.createWriteStream(null, { fd: numericFd, autoClose: false })
}

function writeLine(stream, line) {
  return new Promise((resolve, reject) => {
    const flushed = stream.write(line, (error) => {
      if (error) reject(error)
      else resolve()
    })
    if (!flushed && typeof stream.once === 'function') stream.once('drain', resolve)
  })
}

function createRunnerEventEmitter(options = {}) {
  let runId = options.runId || ''
  let flowId = options.flowId || ''
  let visualizeRunId = options.visualizeRunId || ''
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
    const event = normalizeRunnerEvent({ runId, flowId, visualizeRunId }, type, payload, seq, now())
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
    const event = normalizeRunnerEvent({ runId, flowId, visualizeRunId }, type, payload, seq, now())
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
      if (context.visualizeRunId !== undefined) visualizeRunId = context.visualizeRunId || ''
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
