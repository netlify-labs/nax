const { normalizeUsage } = require('./agent-run-results')
const { parseBlocks } = require('comment-block-parser')

const ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/
const MARKER_PREFIX = '<!-- netlify-workflow-prompt:'
const MARKER_SUFFIX = ' -->'
const PARSE_PATTERN = /<!-- netlify-workflow-prompt:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128}) -->/

const RUNNER_RESULT_MARKER_NAME = 'netlify-agent-run-result'
const RUNNER_STATUS_MARKER = '<!-- netlify-agent-run-status -->'
const RUNNER_HISTORY_MARKER = '<!-- netlify-agent-run-history -->'
const LEGACY_RUNNER_RESULT_PATTERN = /<!-- netlify-agent-run-result:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128}) -->/

function validateSegment(field, value) {
  if (!ID_FORMAT.test(String(value || ''))) {
    throw new Error(`Invalid ${field} for workflow prompt marker: "${value}"`)
  }
}

/** @param {import('./types').JsonMap} param0 */
function renderPromptMarker({ promptName, model, date }) {
  validateSegment('promptName', promptName)
  validateSegment('model', model)
  validateSegment('date', date)
  return `${MARKER_PREFIX}${promptName}:${model}:${date}${MARKER_SUFFIX}`
}

function parsePromptMarker(body) {
  const match = PARSE_PATTERN.exec(String(body || ''))
  if (!match) return null
  return {
    promptName: match[1],
    model: match[2],
    date: match[3],
  }
}

function bodyHasPromptMarker(body) {
  return parsePromptMarker(body) !== null
}

function bodyHasRunnerResultMarker(body) {
  return parseRunnerResultMarker(body) !== null
}

function parseRunnerResultMarker(body) {
  const text = String(body || '')
  let parsed
  try {
    parsed = parseBlocks(text, {
      syntax: 'md',
      open: RUNNER_RESULT_MARKER_NAME,
      close: false,
    })
  } catch {
    parsed = {}
  }
  const block = parsed.blocks && parsed.blocks[0]
  const options = block && block.options && typeof block.options === 'object'
    ? block.options
    : null
  if (options && (options.runnerId !== undefined || options.sessionId !== undefined)) {
    const runnerId = typeof options.runnerId === 'string' ? options.runnerId : ''
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
    if (!ID_FORMAT.test(runnerId) || !ID_FORMAT.test(sessionId)) return null
    return {
      runnerId,
      sessionId,
      usage: normalizeUsage(options),
    }
  }

  const legacy = LEGACY_RUNNER_RESULT_PATTERN.exec(text)
  if (legacy) {
    return {
      runnerId: legacy[1],
      sessionId: legacy[2],
      usage: null,
    }
  }
  return null
}

function bodyHasRunnerStatusMarker(body) {
  return String(body || '').includes(RUNNER_STATUS_MARKER)
}

function bodyHasRunnerHistoryMarker(body) {
  return String(body || '').includes(RUNNER_HISTORY_MARKER)
}

module.exports = {
  ID_FORMAT,
  MARKER_PREFIX,
  MARKER_SUFFIX,
  RUNNER_HISTORY_MARKER,
  RUNNER_RESULT_MARKER_NAME,
  RUNNER_STATUS_MARKER,
  bodyHasPromptMarker,
  bodyHasRunnerHistoryMarker,
  bodyHasRunnerResultMarker,
  bodyHasRunnerStatusMarker,
  parseRunnerResultMarker,
  parsePromptMarker,
  renderPromptMarker,
}
