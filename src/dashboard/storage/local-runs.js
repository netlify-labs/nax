const fs = require('node:fs')
const path = require('node:path')

const { listRunStates, listWorkflowStatePage } = require('../../storage/local/run-state')
const { flowToGraph } = require('../shared/graph')
const { buildRunDetails } = require('../shared/run-details')
const { isActiveProjectedStatus, projectRunSnapshot, publicFlow, publicRunOptions, publicRunState } = require('../api/serializers')
const { requestError } = require('../api/errors')
const { isActiveFollowupStatus, syncSubmittedFollowupRunsToWorkflow } = require('../../workflows/followups/persistence')
const { applyArtifactStatuses } = require('../shared/run-artifact-status')
const { livenessFields, stalledThresholdMs } = require('../shared/run-liveness')
const { hasUsage, usageSummariesForRunState } = require('../../workflows/results/agent-run-results')

const DEFAULT_RUNS_DURABLE_LIMIT = 50
const MAX_RUNS_DURABLE_LIMIT = 200
const DEFAULT_REFRESH_COOLDOWN_MS = 15000
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024

const TEXT_EXTENSIONS = new Map([
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.mjs', 'text/javascript'],
  ['.svg', 'image/svg+xml'],
  ['.toml', 'text/plain'],
  ['.ts', 'text/typescript'],
  ['.txt', 'text/plain'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
])
const BINARY_CONTENT_TYPES = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.zip', 'application/zip'],
])

/**
 * @param {string | number | null | undefined} value
 * @param {number} fallback
 * @param {number} max
 */
function parsePositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

/** @param {{ offset: number }} cursor */
function encodeRunsCursor(cursor) {
  return Buffer.from(JSON.stringify({ offset: cursor.offset })).toString('base64url')
}

/** @param {string | null | undefined} value */
function decodeRunsCursor(value) {
  if (!value) return { offset: 0 }
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    const offset = Number(parsed?.offset)
    if (!Number.isInteger(offset) || offset < 0) throw new Error('invalid offset')
    return { offset }
  } catch {
    throw requestError(400, 'invalid_cursor', 'Invalid runs cursor.')
  }
}

/**
 * @typedef {{
 *   projectRoot: string,
 *   env?: NodeJS.ProcessEnv,
 *   flowStore?: { loadWorkflow?: (id: string) => Promise<Record<string, unknown>> },
 *   followupSyncRunner?: (input: { projectRoot?: string, runner?: import('../../types').AgentRunner, env?: NodeJS.ProcessEnv }) => { sessions?: import('../../types').AgentSession[] } | Promise<{ sessions?: import('../../types').AgentSession[] }>,
 *   refreshCooldownMs?: number,
 *   resolveRunStateId?: (id: string) => string | null | undefined,
 * }} LocalRunStoreOptions
 *
 * @typedef {{
 *   limit?: string | number | null,
 *   cursor?: string | null,
 * }} LocalRunsPageInput
 *
 * @typedef {{
 *   force?: boolean,
 *   view?: 'list' | 'detail' | 'graph' | 'details' | string,
 *   now?: Date,
 * }} RefreshRunStateContext
 */

/**
 * @param {string} id
 * @param {Array<Record<string, unknown>>} states
 */
function runStateForId(id, states) {
  const decoded = safeDecode(id)
  return states.find((state) => state.runId === decoded) || null
}

/** @param {string} value */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch (_err) {
    return value
  }
}

/** @param {string} filePath */
function artifactContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return TEXT_EXTENSIONS.get(extension) || BINARY_CONTENT_TYPES.get(extension) || 'application/octet-stream'
}

/** @param {string} root @param {string} candidate */
function pathWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

/**
 * @param {Record<string, unknown>} durable
 * @param {string} artifactId
 */
function readRunArtifact(durable, artifactId) {
  const runId = String(durable.runId || '')
  const details = buildRunDetails(durable)
  const candidates = Array.isArray(details.followupArtifacts) ? details.followupArtifacts : []
  const matches = candidates.filter((artifact) => String(artifact.id || '') === artifactId)
  if (matches.length === 0) {
    throw requestError(404, 'artifact_not_found', `Artifact "${artifactId}" does not belong to run "${runId}".`, {
      recoverable: true,
      details: { runId, artifactId, artifactIds: candidates.map((artifact) => String(artifact.id || '')).filter(Boolean) },
    })
  }
  if (matches.length > 1) throw requestError(409, 'ambiguous_artifact', `Artifact "${artifactId}" is ambiguous in this run.`, { recoverable: true, details: { runId, artifactId } })
  const filePath = String(matches[0].absolutePath || '')
  const runDir = String(durable.dir || '')
  if (!filePath || !runDir) throw requestError(404, 'artifact_not_found', `Artifact "${artifactId}" has no durable content.`, { recoverable: true, details: { runId, artifactId } })

  let realRoot
  let realFile
  try {
    realRoot = fs.realpathSync(runDir)
    realFile = fs.realpathSync(filePath)
  } catch (_error) {
    throw requestError(404, 'artifact_not_found', `Artifact "${artifactId}" is no longer available.`, { recoverable: true, details: { runId, artifactId } })
  }
  if (!pathWithin(realRoot, realFile)) {
    throw requestError(403, 'artifact_scope_forbidden', 'Artifact content resolves outside its owning run.', { recoverable: false, details: { runId, artifactId } })
  }
  const stat = fs.statSync(realFile)
  if (!stat.isFile()) throw requestError(404, 'artifact_not_found', `Artifact "${artifactId}" is not a regular file.`, { recoverable: true, details: { runId, artifactId } })
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw requestError(413, 'artifact_too_large', `Artifact "${artifactId}" exceeds the ${MAX_ARTIFACT_BYTES}-byte resource limit.`, {
      recoverable: true,
      details: { runId, artifactId, sizeBytes: stat.size, maxBytes: MAX_ARTIFACT_BYTES },
    })
  }
  const contentType = artifactContentType(realFile)
  const bytes = fs.readFileSync(realFile)
  const text = TEXT_EXTENSIONS.has(path.extname(realFile).toLowerCase())
  return {
    runId,
    artifactId,
    contentType,
    sizeBytes: bytes.length,
    encoding: text ? 'utf8' : 'base64',
    content: text ? bytes.toString('utf8') : bytes.toString('base64'),
  }
}

/** @param {string | null | undefined} value */
function timestampMs(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : 0
}

/** @param {Record<string, unknown>} runState */
function hasRefreshableFollowupRuns(runState) {
  const steps = Array.isArray(runState.steps) ? runState.steps : []
  return steps.some((step) => {
    if (step?.source?.type !== 'dashboard-followup') return false
    const runs = Array.isArray(step.runs) ? step.runs : []
    return runs.some((run) => isActiveFollowupStatus(run?.status) && Boolean(run?.runnerId))
  })
}

/** @param {LocalRunStoreOptions} options */
function createLocalRunStore({
  projectRoot,
  env = process.env,
  flowStore,
  followupSyncRunner,
  refreshCooldownMs = DEFAULT_REFRESH_COOLDOWN_MS,
  resolveRunStateId,
}) {
  /** @type {Map<string, number>} */
  const refreshAttemptedAt = new Map()
  const stalledAfterMs = stalledThresholdMs(env)

  /** @param {Record<string, unknown> | null} runState */
  function publicRunWithLiveness(runState) {
    if (!runState) return null
    const run = publicRunState(runState)
    const usageTotals = usageSummariesForRunState(runState).total
    return {
      ...run,
      ...livenessFields(runState, String(run.status || ''), { thresholdMs: stalledAfterMs }),
      ...(hasUsage(usageTotals) ? { usageTotals } : {}),
    }
  }

  function listStates() {
    return listRunStates(projectRoot)
  }

  function getRunState(id) {
    const states = listStates()
    const exact = runStateForId(id, states)
    if (exact) return applyArtifactStatuses(exact)
    const resolved = typeof resolveRunStateId === 'function' ? resolveRunStateId(id) : ''
    if (!resolved || resolved === id) return null
    return applyArtifactStatuses(runStateForId(resolved, states))
  }

  /** @param {Record<string, unknown> | null} runState @param {RefreshRunStateContext} [context] */
  async function refreshRunStateIfNeeded(runState, context = {}) {
    if (!runState) return runState
    const snapshot = projectRunSnapshot(runState)
    const runId = String(runState.runId || '')
    const nowMs = context.now instanceof Date ? context.now.getTime() : Date.now()
    const lastAttemptMs = refreshAttemptedAt.get(runId) || 0
    const detailView = context.view === 'detail' || context.view === 'graph' || context.view === 'details'
    const hasRefreshCandidates = hasRefreshableFollowupRuns(runState)
    const staleMs = nowMs - timestampMs(String(runState.updatedAt || runState.createdAt || ''))
    const shouldConsiderRefresh = context.force === true ||
      (detailView && snapshot.diagnostics.length > 0) ||
      (detailView && hasRefreshCandidates && isActiveProjectedStatus(snapshot.status)) ||
      (detailView && hasRefreshCandidates && staleMs > refreshCooldownMs)
    if (!shouldConsiderRefresh) return runState
    if (!context.force && lastAttemptMs > 0 && nowMs - lastAttemptMs < refreshCooldownMs) return runState
    if (!hasRefreshCandidates) return runState
    refreshAttemptedAt.set(runId, nowMs)
    const synced = await syncSubmittedFollowupRunsToWorkflow({
      runState,
      projectRoot,
      env,
      syncRunner: followupSyncRunner,
    })
    return synced.runState || runState
  }

  return {
    /** @param {LocalRunsPageInput} [input] */
    listRunsPage({ limit: limitValue, cursor: cursorValue } = {}) {
      const limit = parsePositiveInteger(limitValue, DEFAULT_RUNS_DURABLE_LIMIT, MAX_RUNS_DURABLE_LIMIT)
      const { offset } = decodeRunsCursor(cursorValue)
      // Preserve the dashboard performance invariant: enumerate and slice durable
      // state files before parsing workflow JSON for the selected page.
      const page = listWorkflowStatePage(projectRoot, { limit, offset })
      const nextOffset = page.offset + page.limit
      const hasMore = nextOffset < page.total
      return {
        runs: page.items.map((item) => publicRunWithLiveness(applyArtifactStatuses(item))),
        pagination: {
          limit: page.limit,
          offset: page.offset,
          total: page.total,
          nextCursor: hasMore ? encodeRunsCursor({ offset: nextOffset }) : null,
          hasMore,
        },
      }
    },
    getRunState,
    async getRun(id) {
      const runState = await refreshRunStateIfNeeded(getRunState(id), { view: 'detail' })
      return publicRunWithLiveness(runState)
    },
    refreshRunStateIfNeeded,
    async getRunGraph(id) {
      const durable = await refreshRunStateIfNeeded(getRunState(id), { view: 'graph' })
      if (!durable) return null
      let flow = null
      try {
        flow = flowStore?.loadWorkflow ? await flowStore.loadWorkflow(durable.flowId || '') : null
      } catch (_err) {
        flow = null
      }
      if (!flow && durable.flow && Array.isArray(durable.flow.steps)) flow = durable.flow
      if (!flow) return null
      return {
        run: {
          ...publicRunWithLiveness(durable),
          options: publicRunOptions(durable),
        },
        workflow: publicFlow(flow),
        graph: flowToGraph({ flow, runState: durable }),
      }
    },
    async getRunDetails(id) {
      const durable = await refreshRunStateIfNeeded(getRunState(id), { view: 'details' })
      if (!durable) return null
      let flow = null
      try {
        flow = flowStore?.loadWorkflow ? await flowStore.loadWorkflow(durable.flowId || '') : null
      } catch (_err) {
        flow = durable.flow && Array.isArray(durable.flow.steps) ? durable.flow : null
      }
      return {
        run: {
          ...publicRunWithLiveness(durable),
          options: publicRunOptions(durable),
        },
        details: buildRunDetails(durable, { flow }),
      }
    },
    async getRunArtifact(id, artifactId) {
      const durable = await refreshRunStateIfNeeded(getRunState(id), { view: 'details' })
      if (!durable) return null
      return readRunArtifact(durable, artifactId)
    },
  }
}

module.exports = {
  DEFAULT_RUNS_DURABLE_LIMIT,
  DEFAULT_REFRESH_COOLDOWN_MS,
  MAX_ARTIFACT_BYTES,
  MAX_RUNS_DURABLE_LIMIT,
  artifactContentType,
  createLocalRunStore,
  decodeRunsCursor,
  encodeRunsCursor,
  parsePositiveInteger,
  pathWithin,
  readRunArtifact,
}
