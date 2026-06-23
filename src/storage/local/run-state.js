const fs = require('fs')
const path = require('path')
const {
  hasInFlightRuns,
  hasRepairableRuns,
  isNetlifyApiTransport,
  isUnfinishedLocalRun,
  isUnfinishedRun,
  transportMatches,
} = require('../../core/runs/resumable')

const DEFAULT_STATE_LOCK_TIMEOUT_MS = 30000
const DEFAULT_STATE_LOCK_STALE_MS = 10 * 60 * 1000
const STATE_WRITE_DURABLE_FIELDS = [
  'runnerId',
  'sessionId',
  'issueNumber',
  'issueUrl',
  'submittedAfterSeconds',
  'existingRunnerId',
]

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

let cleanupLegacyRunsDirWarned = false

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
  if (orphaned.length > 0 && !cleanupLegacyRunsDirWarned) {
    cleanupLegacyRunsDirWarned = true
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

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4)
  const view = new Int32Array(buffer)
  Atomics.wait(view, 0, 0, ms)
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function removeStaleLock(lockDir, staleMs) {
  let stats
  try {
    stats = fs.statSync(lockDir)
  } catch {
    return false
  }
  if (Date.now() - stats.mtimeMs < staleMs) return false
  try {
    fs.rmSync(lockDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function acquireStateFileLock(filePath, {
  timeoutMs = parsePositiveInt(process.env.NAX_STATE_LOCK_TIMEOUT_MS, DEFAULT_STATE_LOCK_TIMEOUT_MS),
  staleMs = parsePositiveInt(process.env.NAX_STATE_LOCK_STALE_MS, DEFAULT_STATE_LOCK_STALE_MS),
} = {}) {
  const lockDir = `${filePath}.lock`
  const startedAt = Date.now()
  let delayMs = 5

  while (true) {
    try {
      fs.mkdirSync(lockDir)
      try {
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }, null, 2) + '\n')
      } catch {
        // The directory itself is the lock; owner metadata is only diagnostic.
      }
      let released = false
      return () => {
        if (released) return
        released = true
        fs.rmSync(lockDir, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (removeStaleLock(lockDir, staleMs)) continue
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for workflow state lock: ${lockDir}`)
      }
      sleepSync(delayMs)
      delayMs = Math.min(delayMs * 2, 100)
    }
  }
}

function fsyncPath(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Some filesystems do not support fsync on directories; the rename is still atomic.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best effort durability flush.
      }
    }
  }
}

function atomicWriteJsonFile(filePath, data) {
  const dir = path.dirname(filePath)
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`)
  let fd
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600)
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmpPath, filePath)
    fsyncPath(dir)
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best effort cleanup before removing the temp file.
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      // Best effort cleanup.
    }
    throw error
  }
}

function hasValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

function matchingExistingRun(existingRuns, incomingRun, index) {
  if (!Array.isArray(existingRuns)) return null
  const incomingRunnerId = String(incomingRun?.runnerId || '').trim()
  if (incomingRunnerId) {
    const byRunnerId = existingRuns.find((run) => String(run?.runnerId || '').trim() === incomingRunnerId)
    if (byRunnerId) return byRunnerId
  }
  const sameIndex = existingRuns[index]
  if (sameIndex && sameIndex.agent === incomingRun?.agent) return sameIndex
  const sameAgent = existingRuns.filter((run) => run?.agent === incomingRun?.agent)
  return sameAgent.length === 1 ? sameAgent[0] : null
}

function mergeRunDurableFields(existingRun = {}, incomingRun = {}) {
  if (!existingRun || !incomingRun) return incomingRun
  for (const field of STATE_WRITE_DURABLE_FIELDS) {
    if (!hasValue(incomingRun[field]) && hasValue(existingRun[field])) {
      incomingRun[field] = existingRun[field]
    }
  }
  if ((!incomingRun.links || Object.keys(incomingRun.links).length === 0) && existingRun.links && Object.keys(existingRun.links).length > 0) {
    incomingRun.links = existingRun.links
  } else if (incomingRun.links && existingRun.links) {
    incomingRun.links = { ...existingRun.links, ...incomingRun.links }
  }
  if (existingRun.raw && typeof existingRun.raw === 'object') {
    incomingRun.raw = incomingRun.raw && typeof incomingRun.raw === 'object' ? incomingRun.raw : {}
    for (const field of ['create', 'session']) {
      if (!incomingRun.raw[field] && existingRun.raw[field]) {
        incomingRun.raw[field] = existingRun.raw[field]
      }
    }
  }
  return incomingRun
}

function mergeExistingStateForWrite(existingState, incomingState) {
  if (!existingState || existingState.runId !== incomingState?.runId) return incomingState
  const existingSteps = Array.isArray(existingState.steps) ? existingState.steps : []
  const incomingSteps = Array.isArray(incomingState.steps) ? incomingState.steps : []
  const existingByStepId = new Map(existingSteps.filter((step) => step?.id).map((step) => [step.id, step]))

  for (const [stepIndex, incomingStep] of incomingSteps.entries()) {
    const existingStep = existingByStepId.get(incomingStep?.id) || existingSteps[stepIndex]
    if (!existingStep || !Array.isArray(incomingStep?.runs)) continue
    const existingRuns = Array.isArray(existingStep.runs) ? existingStep.runs : []
    for (const [runIndex, incomingRun] of incomingStep.runs.entries()) {
      const existingRun = matchingExistingRun(existingRuns, incomingRun, runIndex)
      if (existingRun) mergeRunDurableFields(existingRun, incomingRun)
    }
  }
  return incomingState
}

function listRunStates(projectRoot) {
  return listWorkflowStates(projectRoot)
}

/**
 * @typedef {{
 *   filePath: string,
 *   mtimeMs: number,
 * }} WorkflowStateFile
 */

/**
 * @param {string} projectRoot
 * @returns {WorkflowStateFile[]}
 */
function listWorkflowStateFiles(projectRoot) {
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
        const stats = fs.statSync(filePath)
        return { filePath, mtimeMs: stats.mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const byMtime = b.mtimeMs - a.mtimeMs
      return byMtime || b.filePath.localeCompare(a.filePath)
    })
}

/**
 * Lists one durable workflow state page without parsing every workflow.json.
 *
 * This intentionally sorts by workflow.json mtime instead of parsing updatedAt
 * from every state file. That keeps dashboard startup bounded by one page of
 * JSON parsing; offset cursors can tolerate minor shifts in this local UI.
 *
 * @param {string} projectRoot
 * @param {{ limit?: number, offset?: number }} [options]
 * @returns {{ items: Array<Record<string, unknown>>, total: number, limit: number, offset: number }}
 */
function listWorkflowStatePage(projectRoot, { limit = 50, offset = 0 } = {}) {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50
  const normalizedOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
  const files = listWorkflowStateFiles(projectRoot)
  const items = files
    .slice(normalizedOffset, normalizedOffset + normalizedLimit)
    .map(({ filePath }) => {
      try {
        const state = readRunState(filePath)
        return { ...state, dir: path.dirname(filePath) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return {
    items,
    total: files.length,
    limit: normalizedLimit,
    offset: normalizedOffset,
  }
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

/** @param {string} projectRoot @param {{ flowId?: string, transport?: string }} param1 */
function findLatestUnfinishedRun(projectRoot, { flowId, transport } = {}) {
  return listRunStates(projectRoot).find((state) => {
    if (flowId && state.flowId !== flowId) return false
    if (transport && !transportMatches(state.transport, transport)) return false
    return isUnfinishedRun(state)
  }) || null
}

/** @param {string} projectRoot @param {{ flowId?: string }} param1 */
function findLatestUnfinishedLocalRun(projectRoot, { flowId } = {}) {
  return findLatestUnfinishedRun(projectRoot, { flowId, transport: 'netlify-api' })
}

/**
 * Create a durable workflow run state.
 * @typedef {{
 *   projectRoot: string,
 *   flow: import('../../types').WorkflowFlow,
 *   transport?: string,
 *   options?: import('../../types').JsonMap,
 *   target?: import('../../types').TargetLike | null,
 *   now?: Date,
 * }} CreateRunStateInput
 */

/** @param {CreateRunStateInput} param0 */
function createRunState({ projectRoot, flow, transport, options = {}, target = null, now = new Date() }) {
  const runId = createRunId(flow.id, now)
  cleanupLegacyRunsDir(projectRoot)
  const dir = path.join(getWorkflowsDir(projectRoot), runId)
  return {
    schemaVersion: 1,
    runId,
    flowId: flow.id,
    flowTitle: flow.title,
    flow,
    transport,
    projectRoot,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    options,
    status: 'running',
    context: null,
    blobCleanupWarning: '',
    ...(target ? {
      target,
      branch: target.branch || '',
      branchSource: target.sourceType || '',
    } : {}),
    steps: [],
    dir,
  }
}

function saveRunState(state) {
  fs.mkdirSync(state.dir, { recursive: true })
  const filePath = workflowStatePath(state.dir)
  const release = acquireStateFileLock(filePath)
  let next
  try {
    next = { ...state, updatedAt: new Date().toISOString() }
    if (fs.existsSync(filePath)) {
      try {
        next = mergeExistingStateForWrite(readRunState(filePath), next)
      } catch {
        // If the existing state is corrupt, the new complete state replaces it.
      }
    }
    atomicWriteJsonFile(filePath, JSON.stringify(next, null, 2) + '\n')
  } finally {
    release()
  }
  try {
    require('../../workflows/artifacts/workflow-artifacts').persistWorkflowArtifacts(next, { summaryOnly: true })
  } catch (error) {
    if (process.env.NAX_DEBUG_ARTIFACTS) {
      console.error(`nax artifact persistence failed: ${error.message}`)
    }
  }
  return next
}

/** @param {import('../../types').WorkflowRunState} state @param {{ reason?: string, now?: Date }} param1 */
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
  listWorkflowStatePage,
  listWorkflowStates,
  readRunState,
  saveRunState,
  slugify,
  workflowStatePath,
}
