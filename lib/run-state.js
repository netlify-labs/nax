const fs = require('fs')
const path = require('path')

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function createRunId(flowId, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${slugify(flowId)}`
}

function getRunsDir(projectRoot) {
  return getWorkflowsDir(projectRoot)
}

function getWorkflowsDir(projectRoot) {
  return path.join(projectRoot, '.nax', 'workflows')
}

function legacyRunsDir(projectRoot) {
  return path.join(projectRoot, '.nax', 'runs')
}

function workflowStatePath(dir) {
  return path.join(dir, 'workflow.json')
}

function legacyRunStatePath(dir) {
  return path.join(dir, 'run.json')
}

function legacyRunStateFiles(projectRoot) {
  const runsDir = legacyRunsDir(projectRoot)
  if (!fs.existsSync(runsDir)) return []
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => legacyRunStatePath(path.join(runsDir, entry.name)))
    .filter((filePath) => fs.existsSync(filePath))
}

function cleanupLegacyRunsDir(projectRoot) {
  const oldDir = legacyRunsDir(projectRoot)
  const newDir = getWorkflowsDir(projectRoot)
  if (!fs.existsSync(oldDir)) return { renamed: false, orphaned: [] }
  if (!fs.existsSync(newDir)) {
    fs.mkdirSync(path.dirname(newDir), { recursive: true })
    fs.renameSync(oldDir, newDir)
    for (const filePath of fs
      .readdirSync(newDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(newDir, entry.name))) {
      const oldStatePath = legacyRunStatePath(filePath)
      const newStatePath = workflowStatePath(filePath)
      if (fs.existsSync(oldStatePath) && !fs.existsSync(newStatePath)) {
        fs.renameSync(oldStatePath, newStatePath)
      }
    }
    return { renamed: true, orphaned: [] }
  }

  const orphaned = []
  for (const filePath of legacyRunStateFiles(projectRoot)) {
    try {
      const state = readRunState(filePath)
      if (isUnfinishedRun(state)) orphaned.push(filePath)
    } catch {
      orphaned.push(filePath)
    }
  }
  if (orphaned.length > 0 && !cleanupLegacyRunsDir.warned) {
    cleanupLegacyRunsDir.warned = true
    console.warn([
      'Unfinished legacy nax runs still exist under .nax/runs and were not migrated because .nax/workflows already exists:',
      ...orphaned.map((filePath) => `- ${filePath}`),
    ].join('\n'))
  }
  return { renamed: false, orphaned }
}

function readRunState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function listRunStates(projectRoot) {
  return listWorkflowStates(projectRoot)
}

function listWorkflowStates(projectRoot) {
  cleanupLegacyRunsDir(projectRoot)
  const workflowsDir = getWorkflowsDir(projectRoot)
  if (!fs.existsSync(workflowsDir)) return []
  return fs
    .readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => workflowStatePath(path.join(workflowsDir, entry.name)))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => {
      try {
        const state = readRunState(filePath)
        return { ...state, dir: path.dirname(filePath) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
}

function hasInFlightRuns(step) {
  return (step?.runs || []).some((run) => {
    if (!run.runnerId && !run.issueNumber) return false
    return !['completed', 'failed', 'timeout', 'dry-run'].includes(run.status)
  })
}

function hasRepairableRuns(step) {
  return (step?.runs || []).some((run) => {
    if (!run.runnerId && !run.issueNumber) return false
    if (run.status === 'completed' && run.resultText) return false
    return ['submitted', 'running'].includes(run.status)
  })
}

function isNetlifyApiTransport(transport) {
  return transport === 'netlify-api' || transport === 'local'
}

function transportMatches(candidate, requested) {
  if (!requested) return true
  if (isNetlifyApiTransport(requested)) return isNetlifyApiTransport(candidate)
  return candidate === requested
}

function isUnfinishedRun(state) {
  if (state?.status === 'dismissed' || state?.dismissedAt) return false
  if (!Array.isArray(state.steps) || state.steps.length === 0) return false
  return state.steps.some((step) => {
    return step.status === 'running' ||
      step.status === 'submitted' ||
      hasInFlightRuns(step) ||
      hasRepairableRuns(step)
  })
}

function isUnfinishedLocalRun(state) {
  if (!isNetlifyApiTransport(state?.transport)) return false
  return isUnfinishedRun(state)
}

function findLatestUnfinishedRun(projectRoot, { flowId, transport } = {}) {
  return listRunStates(projectRoot).find((state) => {
    if (flowId && state.flowId !== flowId) return false
    if (transport && !transportMatches(state.transport, transport)) return false
    return isUnfinishedRun(state)
  }) || null
}

function findLatestUnfinishedLocalRun(projectRoot, { flowId } = {}) {
  return findLatestUnfinishedRun(projectRoot, { flowId, transport: 'netlify-api' })
}

function createRunState({ projectRoot, flow, transport, options = {}, now = new Date() }) {
  const runId = createRunId(flow.id, now)
  cleanupLegacyRunsDir(projectRoot)
  const dir = path.join(getWorkflowsDir(projectRoot), runId)
  return {
    schemaVersion: 1,
    runId,
    flowId: flow.id,
    flowTitle: flow.title,
    transport,
    projectRoot,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    options,
    steps: [],
    dir,
  }
}

function saveRunState(state) {
  fs.mkdirSync(state.dir, { recursive: true })
  const next = { ...state, updatedAt: new Date().toISOString() }
  fs.writeFileSync(workflowStatePath(state.dir), JSON.stringify(next, null, 2) + '\n')
  try {
    require('./workflow-artifacts').persistWorkflowArtifacts(next, { summaryOnly: true })
  } catch (error) {
    if (process.env.NAX_DEBUG_ARTIFACTS) {
      console.error(`nax artifact persistence failed: ${error.message}`)
    }
  }
  return next
}

function dismissRunState(state, { reason = 'user-declined-resume', now = new Date() } = {}) {
  return saveRunState({
    ...state,
    status: 'dismissed',
    dismissedAt: now.toISOString(),
    dismissReason: reason,
  })
}

module.exports = {
  createRunId,
  createRunState,
  dismissRunState,
  findLatestUnfinishedRun,
  findLatestUnfinishedLocalRun,
  getRunsDir,
  getWorkflowsDir,
  hasInFlightRuns,
  hasRepairableRuns,
  isNetlifyApiTransport,
  isUnfinishedRun,
  isUnfinishedLocalRun,
  listRunStates,
  listWorkflowStates,
  readRunState,
  saveRunState,
  slugify,
  workflowStatePath,
}
