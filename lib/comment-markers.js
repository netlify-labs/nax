const ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/
const MARKER_PREFIX = '<!-- netlify-workflow-prompt:'
const MARKER_SUFFIX = ' -->'
const PARSE_PATTERN = /<!-- netlify-workflow-prompt:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128}) -->/

const RUNNER_RESULT_MARKER_PATTERN = /<!-- netlify-agent-run-result:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128} -->/
const RUNNER_STATUS_MARKER = '<!-- netlify-agent-run-status -->'
const RUNNER_HISTORY_MARKER = '<!-- netlify-agent-run-history -->'

function validateSegment(field, value) {
  if (!ID_FORMAT.test(String(value || ''))) {
    throw new Error(`Invalid ${field} for workflow prompt marker: "${value}"`)
  }
}

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
  return RUNNER_RESULT_MARKER_PATTERN.test(String(body || ''))
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
  RUNNER_RESULT_MARKER_PATTERN,
  RUNNER_STATUS_MARKER,
  bodyHasPromptMarker,
  bodyHasRunnerHistoryMarker,
  bodyHasRunnerResultMarker,
  bodyHasRunnerStatusMarker,
  parsePromptMarker,
  renderPromptMarker,
}
