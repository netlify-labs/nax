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
  return path.join(projectRoot, '.nax', 'runs')
}

function readRunState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function listRunStates(projectRoot) {
  const runsDir = getRunsDir(projectRoot)
  if (!fs.existsSync(runsDir)) return []
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name, 'run.json'))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => {
      try {
        const state = readRunState(filePath)
        return { ...state, dir: state.dir || path.dirname(filePath) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
}

function hasInFlightRuns(step) {
  return (step?.runs || []).some((run) => {
    if (!run.runnerId) return false
    return !['completed', 'failed', 'timeout', 'dry-run'].includes(run.status)
  })
}

function isUnfinishedLocalRun(state) {
  if (state?.transport !== 'local') return false
  if (!Array.isArray(state.steps) || state.steps.length === 0) return false
  return state.steps.some((step) => step.status === 'running' || step.status === 'submitted' || hasInFlightRuns(step))
}

function findLatestUnfinishedLocalRun(projectRoot, { flowId } = {}) {
  return listRunStates(projectRoot).find((state) => {
    if (flowId && state.flowId !== flowId) return false
    return isUnfinishedLocalRun(state)
  }) || null
}

function createRunState({ projectRoot, flow, transport, options = {}, now = new Date() }) {
  const runId = createRunId(flow.id, now)
  const dir = path.join(getRunsDir(projectRoot), runId)
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
  fs.writeFileSync(path.join(state.dir, 'run.json'), JSON.stringify(next, null, 2) + '\n')
  return next
}

module.exports = {
  createRunId,
  createRunState,
  findLatestUnfinishedLocalRun,
  getRunsDir,
  hasInFlightRuns,
  isUnfinishedLocalRun,
  listRunStates,
  readRunState,
  saveRunState,
  slugify,
}
