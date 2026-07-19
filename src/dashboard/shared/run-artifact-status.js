// Upgrades stale active agent-run records in a workflow run state using the
// terminal statuses proven by saved step agent-runner artifacts on disk.
const fs = require('fs')
const path = require('path')
const { isActiveProjectedStatus, isTerminalProjectedStatus, statusKey } = require('../api/run-state-projection')

/** @param {string} filePath */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} dir */
function listDirectories(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

/** @param {Record<string, unknown>} runState @returns {boolean} */
function hasStaleActiveRuns(runState) {
  const steps = Array.isArray(runState?.steps) ? runState.steps : []
  return steps.some((step) => (Array.isArray(step?.runs) ? step.runs : [])
    .some((run) => isActiveProjectedStatus(run?.status)))
}

/**
 * Collects terminal agent statuses from `<runDir>/artifacts/steps/*` keyed by
 * `stepId/agent`; artifact metadata is the strongest local completion evidence.
 * @param {string} runDir
 * @returns {Map<string, { status: string, runnerId: string }>}
 */
function terminalArtifactStatuses(runDir) {
  const statuses = new Map()
  for (const stepDir of listDirectories(path.join(runDir, 'artifacts', 'steps'))) {
    const stepMeta = readJson(path.join(stepDir, 'step.json')) || {}
    const runnersDir = path.join(stepDir, 'agent-runners')
    let entries = []
    try {
      entries = fs.readdirSync(runnersDir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.json') || /\.attempt-\d+\./.test(name)) continue
      const artifact = readJson(path.join(runnersDir, name))
      if (!artifact || typeof artifact !== 'object') continue
      const status = statusKey(artifact.status)
      if (!isTerminalProjectedStatus(status)) continue
      const stepId = String(artifact.stepId || stepMeta.id || '')
      const agent = String(artifact.agent || path.basename(name, '.json'))
      if (!stepId || !agent) continue
      statuses.set(`${stepId}/${agent}`, {
        status,
        runnerId: String(artifact.runnerId || ''),
      })
    }
  }
  return statuses
}

/**
 * Mutates run records in place: an active-looking record whose step/agent has
 * a terminal artifact takes the artifact status. Never persisted to disk.
 * @param {Record<string, unknown>} runState
 */
function applyArtifactStatuses(runState) {
  if (!runState?.dir || !hasStaleActiveRuns(runState)) return runState
  const statuses = terminalArtifactStatuses(String(runState.dir))
  if (statuses.size === 0) return runState
  for (const step of Array.isArray(runState.steps) ? runState.steps : []) {
    const stepId = String(step?.id || '')
    if (!stepId) continue
    for (const run of Array.isArray(step.runs) ? step.runs : []) {
      if (!isActiveProjectedStatus(run?.status)) continue
      const artifact = statuses.get(`${stepId}/${String(run?.agent || '')}`)
      if (!artifact) continue
      if (artifact.runnerId && run.runnerId && artifact.runnerId !== String(run.runnerId)) continue
      run.status = artifact.status
    }
  }
  return runState
}

module.exports = {
  applyArtifactStatuses,
}
