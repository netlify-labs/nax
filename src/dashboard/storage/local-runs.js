const { listRunStates, listWorkflowStatePage } = require('../../storage/local/run-state')
const { flowToGraph } = require('../shared/graph')
const { buildRunDetails } = require('../shared/run-details')
const { isActiveProjectedStatus, projectRunSnapshot, publicFlow, publicRunOptions, publicRunState } = require('../api/serializers')
const { requestError } = require('../api/errors')
const { isActiveFollowupStatus, syncSubmittedFollowupRunsToWorkflow } = require('../../workflows/followups/persistence')

const DEFAULT_RUNS_DURABLE_LIMIT = 50
const MAX_RUNS_DURABLE_LIMIT = 200
const DEFAULT_REFRESH_COOLDOWN_MS = 15000

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
 *   followupSyncRunCommand?: import('../../types').RunCommand,
 *   followupSyncRunner?: (input: { projectRoot?: string, runner?: import('../../types').AgentRunner, env?: NodeJS.ProcessEnv, runCommand?: import('../../types').RunCommand }) => { sessions?: import('../../types').AgentSession[] },
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
  followupSyncRunCommand,
  followupSyncRunner,
  refreshCooldownMs = DEFAULT_REFRESH_COOLDOWN_MS,
  resolveRunStateId,
}) {
  /** @type {Map<string, number>} */
  const refreshAttemptedAt = new Map()

  function listStates() {
    return listRunStates(projectRoot)
  }

  function getRunState(id) {
    const states = listStates()
    const exact = runStateForId(id, states)
    if (exact) return exact
    const resolved = typeof resolveRunStateId === 'function' ? resolveRunStateId(id) : ''
    if (!resolved || resolved === id) return null
    return runStateForId(resolved, states)
  }

  /** @param {Record<string, unknown> | null} runState @param {RefreshRunStateContext} [context] */
  function refreshRunStateIfNeeded(runState, context = {}) {
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
    const synced = syncSubmittedFollowupRunsToWorkflow({
      runState,
      projectRoot,
      env,
      runCommand: followupSyncRunCommand,
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
        runs: page.items.map(publicRunState),
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
    getRun(id) {
      const runState = refreshRunStateIfNeeded(getRunState(id), { view: 'detail' })
      return runState ? publicRunState(runState) : null
    },
    refreshRunStateIfNeeded,
    async getRunGraph(id) {
      const durable = refreshRunStateIfNeeded(getRunState(id), { view: 'graph' })
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
          ...publicRunState(durable),
          options: publicRunOptions(durable),
        },
        workflow: publicFlow(flow),
        graph: flowToGraph({ flow, runState: durable }),
      }
    },
    async getRunDetails(id) {
      const durable = refreshRunStateIfNeeded(getRunState(id), { view: 'details' })
      if (!durable) return null
      let flow = null
      try {
        flow = flowStore?.loadWorkflow ? await flowStore.loadWorkflow(durable.flowId || '') : null
      } catch (_err) {
        flow = durable.flow && Array.isArray(durable.flow.steps) ? durable.flow : null
      }
      return {
        run: {
          ...publicRunState(durable),
          options: publicRunOptions(durable),
        },
        details: buildRunDetails(durable, { flow }),
      }
    },
  }
}

module.exports = {
  DEFAULT_RUNS_DURABLE_LIMIT,
  DEFAULT_REFRESH_COOLDOWN_MS,
  MAX_RUNS_DURABLE_LIMIT,
  createLocalRunStore,
  decodeRunsCursor,
  encodeRunsCursor,
  parsePositiveInteger,
}
