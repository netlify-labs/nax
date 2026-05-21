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

function sourceUpdatedAt(source = {}) {
  return source.updatedAt || source.createdAt || ''
}

function completed(status) {
  return String(status || '').toLowerCase() === 'completed'
}

function workflowSources(projectRoot) {
  return listWorkflowStates(projectRoot).map((state) => {
    persistWorkflowArtifacts(state, { summaryOnly: true })
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
      summaryText: readSummary(summaryPath),
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
      summaryText: readSummary(summaryPath),
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
    const priority = { 'agent-session': 0, 'agent-runner': 1, workflow: 2 }
    const byPriority = priority[a.kind] - priority[b.kind]
    if (byPriority !== 0) return byPriority
    return String(sourceUpdatedAt(b)).localeCompare(String(sourceUpdatedAt(a)))
  })
}

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
