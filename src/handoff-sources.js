const fs = require('fs')
const path = require('path')
const { listWorkflowStates } = require('./run-state')
const { artifactsRootForRunState, persistWorkflowArtifacts } = require('./workflow-artifacts')
const { listAgentRunnerArtifacts } = require('./agent-runner-artifacts')
const { listAgentSessionArtifacts } = require('./agent-session-artifacts')

function relativeDisplayPath(projectRoot, filePath) {
  const relative = path.relative(projectRoot || process.cwd(), filePath)
  return relative && !relative.startsWith('..') ? relative : filePath
}

function readSummary(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return ''
  return fs.readFileSync(filePath, 'utf8').trim()
}

function readSessionHandoffText(sessionDir) {
  const resultText = readSummary(path.join(sessionDir, 'result.md'))
  return resultText || readSummary(path.join(sessionDir, 'summary.md'))
}

function runnerSessionHandoffText(projectRoot, runner = {}) {
  const runnerSummary = readSummary(path.join(runner.dir || '', 'summary.md'))
  const runnerHeader = runnerSummary.split(/\n## Sessions\b/)[0].trim()
  const sessionIds = Array.isArray(runner.sessionIds) ? runner.sessionIds.filter(Boolean) : []
  const sessions = sessionIds.map((sessionId) => {
    const sessionDir = path.join(projectRoot, '.nax', 'agent-sessions', sessionId)
    const text = readSessionHandoffText(sessionDir)
    return text ? {
      sessionId,
      path: relativeDisplayPath(projectRoot, path.join(sessionDir, fs.existsSync(path.join(sessionDir, 'result.md')) ? 'result.md' : 'summary.md')),
      text,
    } : null
  }).filter(Boolean)
  if (sessions.length === 1) {
    return [runnerHeader, sessions[0].text].filter(Boolean).join('\n\n---\n\n')
  }
  if (sessions.length > 1) {
    const sessionText = sessions.map((session) => [
      `## Session ${session.sessionId}`,
      '',
      `Source: ${session.path}`,
      '',
      session.text,
    ].join('\n')).join('\n\n---\n\n')
    return [runnerHeader, sessionText].filter(Boolean).join('\n\n---\n\n')
  }
  return runnerSummary
}

function sourceUpdatedAt(source = {}) {
  return source.updatedAt || source.createdAt || ''
}

function completed(status) {
  return String(status || '').toLowerCase() === 'completed'
}

function workflowSources(projectRoot) {
  return listWorkflowStates(projectRoot).map((state) => {
    persistWorkflowArtifacts(state, { summaryOnly: true, updateLatest: false })
    const summaryPath = path.join(artifactsRootForRunState(state), 'summary.md')
    return {
      kind: 'workflow',
      id: state.runId,
      title: state.flowTitle || state.flowId || state.runId,
      status: state.status || 'running',
      summaryPath,
      summaryText: readSummary(summaryPath),
      updatedAt: state.updatedAt || state.createdAt || '',
      source: state,
    }
  }).filter((source) => completed(source.status) && source.summaryText)
}

function runnerSources(projectRoot) {
  return listAgentRunnerArtifacts(projectRoot).map((runner) => {
    const summaryPath = path.join(runner.dir, 'summary.md')
    return {
      kind: 'agent-runner',
      id: runner.runnerId,
      title: `${runner.agent || 'Agent'} runner ${runner.runnerId}`,
      status: runner.status || '',
      summaryPath,
      summaryText: runnerSessionHandoffText(projectRoot, runner),
      updatedAt: runner.updatedAt || runner.createdAt || '',
      source: runner,
    }
  }).filter((source) => completed(source.status) && source.summaryText)
}

function sessionSources(projectRoot) {
  return listAgentSessionArtifacts(projectRoot).map((session) => {
    const summaryPath = path.join(session.dir, 'summary.md')
    return {
      kind: 'agent-session',
      id: session.sessionId,
      title: `${session.agent || 'Agent'} session ${session.sessionId}`,
      status: session.status || '',
      summaryPath,
      summaryText: readSessionHandoffText(session.dir),
      updatedAt: session.updatedAt || session.createdAt || '',
      source: session,
    }
  }).filter((source) => completed(source.status) && source.summaryText)
}

function listHandoffSources(projectRoot) {
  return [
    ...sessionSources(projectRoot),
    ...runnerSources(projectRoot),
    ...workflowSources(projectRoot),
  ].sort((a, b) => {
    const byUpdatedAt = String(sourceUpdatedAt(b)).localeCompare(String(sourceUpdatedAt(a)))
    if (byUpdatedAt !== 0) return byUpdatedAt
    const priority = { workflow: 0, 'agent-session': 1, 'agent-runner': 2 }
    return priority[a.kind] - priority[b.kind]
  })
}

/** @param {string} projectRoot @param {{ id?: string, kind?: string }} param1 */
function findLatestHandoffSource(projectRoot, { id, kind } = {}) {
  const sources = listHandoffSources(projectRoot)
  if (id || kind) {
    return sources.find((source) => {
      if (kind && source.kind !== kind) return false
      if (id && source.id !== id) return false
      return true
    }) || null
  }
  return sources[0] || null
}

/** @param {string} projectRoot @param {{ id?: string, kind?: string }} param1 */
function readHandoffSource(projectRoot, { id, kind } = {}) {
  const source = findLatestHandoffSource(projectRoot, { id, kind })
  if (!source) {
    throw new Error(`No completed nax workflow, agent runner, or agent session artifacts found under ${path.join(projectRoot, '.nax')}.`)
  }
  return {
    ...source,
    displayPath: relativeDisplayPath(projectRoot, source.summaryPath),
  }
}

module.exports = {
  findLatestHandoffSource,
  listHandoffSources,
  readHandoffSource,
  relativeDisplayPath,
}
