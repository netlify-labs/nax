const { listRunStates, listWorkflowStatePage } = require('../../run-state')
const { flowToGraph } = require('../shared/graph')
const { buildRunDetails } = require('../shared/run-details')
const { publicFlow, publicRunOptions, publicRunState } = require('../api/serializers')
const { requestError } = require('../api/errors')
const { syncSubmittedFollowupRunsToWorkflow } = require('../../followup-persistence')

const DEFAULT_RUNS_DURABLE_LIMIT = 50
const MAX_RUNS_DURABLE_LIMIT = 200

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
 *   flowStore?: { loadWorkflow?: (id: string) => Promise<object> },
 *   followupSyncRunCommand?: import('../../types').RunCommand,
 * }} LocalRunStoreOptions
 *
 * @typedef {{
 *   limit?: string | number | null,
 *   cursor?: string | null,
 * }} LocalRunsPageInput
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

/** @param {LocalRunStoreOptions} options */
function createLocalRunStore({ projectRoot, env = process.env, flowStore, followupSyncRunCommand }) {
  function listStates() {
    return listRunStates(projectRoot)
  }

  function getRunState(id) {
    return runStateForId(id, listStates())
  }

  function syncDurableFollowups(runState) {
    if (!runState) return runState
    const synced = syncSubmittedFollowupRunsToWorkflow({
      runState,
      projectRoot,
      env,
      runCommand: followupSyncRunCommand,
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
        durable: page.items.map(publicRunState),
        pagination: {
          durableLimit: page.limit,
          durableOffset: page.offset,
          durableTotal: page.total,
          nextCursor: hasMore ? encodeRunsCursor({ offset: nextOffset }) : null,
          hasMore,
        },
      }
    },
    getRunState,
    getRun(id) {
      const runState = getRunState(id)
      return runState ? publicRunState(runState) : null
    },
    async getRunGraph(id) {
      const durable = syncDurableFollowups(getRunState(id))
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
      const durable = syncDurableFollowups(getRunState(id))
      if (!durable) return null
      let flow = null
      try {
        flow = flowStore?.loadWorkflow ? await flowStore.loadWorkflow(durable.flowId || '') : null
      } catch (_err) {
        flow = durable.flow && Array.isArray(durable.flow.steps) ? durable.flow : null
      }
      return {
        run: publicRunState(durable),
        details: buildRunDetails(durable, { flow }),
      }
    },
  }
}

module.exports = {
  DEFAULT_RUNS_DURABLE_LIMIT,
  MAX_RUNS_DURABLE_LIMIT,
  createLocalRunStore,
  decodeRunsCursor,
  encodeRunsCursor,
  parsePositiveInteger,
}
