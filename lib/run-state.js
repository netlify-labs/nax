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
  getRunsDir,
  saveRunState,
  slugify,
}
