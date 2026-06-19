const fs = require('fs')
const path = require('path')

function eventLogPathForRunDir(runDir) {
  return path.join(runDir, 'events.jsonl')
}

function eventLogPathForRunState(runState = {}) {
  if (!runState.dir) throw new Error('Cannot resolve event log path without runState.dir.')
  return eventLogPathForRunDir(runState.dir)
}

function appendEventLog(filePath, event) {
  if (!filePath) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`)
}

function parseEventLine(line, lineNumber) {
  try {
    const event = JSON.parse(line)
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return {
        event: null,
        error: {
          line: lineNumber,
          code: 'invalid_event',
          message: 'Event log line is not a JSON object.',
          text: line,
        },
      }
    }
    return { event, error: null }
  } catch (error) {
    return {
      event: null,
      error: {
        line: lineNumber,
        code: 'parse_error',
        message: error?.message || String(error),
        text: line,
      },
    }
  }
}

function readEventLog(filePath, { since = 0 } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { events: [], errors: [] }
  const text = fs.readFileSync(filePath, 'utf8')
  const events = []
  const errors = []
  const minimumSeq = Number.isFinite(Number(since)) ? Number(since) : 0
  const lines = text.split(/\r?\n/)

  lines.forEach((line, index) => {
    if (!line.trim()) return
    const { event, error } = parseEventLine(line, index + 1)
    if (error) {
      errors.push(error)
      return
    }
    if (Number(event.seq || 0) > minimumSeq) events.push(event)
  })

  return { events, errors }
}

function appendAndReplay(filePath, event, options = {}) {
  appendEventLog(filePath, event)
  return readEventLog(filePath, options)
}

module.exports = {
  appendAndReplay,
  appendEventLog,
  eventLogPathForRunDir,
  eventLogPathForRunState,
  readEventLog,
}
