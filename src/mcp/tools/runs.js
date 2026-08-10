const { errorResult, expectedApplicationError } = require('../errors')
const { boundStructuredData, successResult } = require('../results')
const { TOOL_SPECS } = require('../schemas')
const { mcpClientResolver } = require('../routing')

const MAX_LIST_AGENT_RUNS = 8
const MAX_READ_AGENT_RUNS = 64
const MAX_DETAILS_INDEX_ITEMS = 100
const MAX_EVENT_DATA_BYTES = 256
const MAX_EVENT_MESSAGE_BYTES = 256

/** @typedef {import('../../contracts').ControlPlaneContext} ControlPlaneContext */
/** @typedef {import('../../contracts').ControlPlaneEvent} ControlPlaneEvent */
/** @typedef {import('../../contracts').ControlPlaneNextAction} ControlPlaneNextAction */
/** @typedef {import('../../contracts').ControlPlaneRunList} ControlPlaneRunList */
/** @typedef {import('../../contracts').ControlPlaneRunRead} ControlPlaneRunRead */
/** @typedef {import('../../contracts').ControlPlaneRunSummary} ControlPlaneRunSummary */
/** @typedef {import('../../contracts').ControlPlaneWaitResult} ControlPlaneWaitResult */
/** @typedef {import('../../contracts').NaxControlPlaneClient} NaxControlPlaneClient */

/**
 * @typedef {{
 *   agentRunsTruncated?: boolean,
 * } & ControlPlaneRunSummary} CompactRunSummary
 *
 * @typedef {{
 *   sections: { returned: number, total: number, truncated: boolean },
 *   artifacts: { returned: number, total: number, truncated: boolean },
 * }} RunDetailsLimits
 *
 * @typedef {ControlPlaneRunRead & { detailsLimits?: RunDetailsLimits }} CompactRunRead
 */

/** @param {unknown} value @param {number} maxBytes */
function boundedText(value, maxBytes) {
  const text = String(value || '')
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  return `${bytes.subarray(0, Math.max(0, maxBytes - 20)).toString('utf8')}\n[truncated]`
}

/**
 * @param {ControlPlaneRunSummary} run
 * @param {number} [agentLimit]
 * @returns {CompactRunSummary}
 */
function compactRunSummary(run, agentLimit = MAX_READ_AGENT_RUNS) {
  const agentRuns = run.agentRuns || []
  return {
    ...run,
    ...(agentRuns.length > 0 ? { agentRuns: agentRuns.slice(0, agentLimit) } : {}),
    ...(agentRuns.length > agentLimit ? { agentRunsTruncated: true } : {}),
  }
}

/** @param {ControlPlaneEvent} event @returns {ControlPlaneEvent} */
function compactEvent(event) {
  return {
    ...event,
    ...(event.message ? { message: boundedText(event.message, MAX_EVENT_MESSAGE_BYTES) } : {}),
    ...(event.data ? { data: /** @type {import('../../contracts').ControlPlaneJsonObject} */ (boundStructuredData(event.data, MAX_EVENT_DATA_BYTES)) } : {}),
  }
}

/**
 * @param {ControlPlaneRunRead} result
 * @param {string | undefined} sectionId
 * @returns {CompactRunRead}
 */
function compactRunRead(result, sectionId) {
  const run = compactRunSummary(result.run)
  if (result.view === 'events' && result.events) {
    return {
      ...result,
      run,
      events: { ...result.events, events: result.events.events.map(compactEvent) },
    }
  }
  if (result.view !== 'details' || !result.details) return { ...result, run }

  const allSections = result.details.sections
  const selectedSections = sectionId
    ? allSections.filter((section) => section.sectionId === sectionId).slice(0, 1)
    : allSections.slice(0, MAX_DETAILS_INDEX_ITEMS).map(({ markdown: _markdown, ...section }) => section)
  const artifacts = result.details.artifacts.slice(0, MAX_DETAILS_INDEX_ITEMS)
  return {
    ...result,
    run,
    details: {
      ...(result.details.summary ? { summary: boundedText(result.details.summary, 8192) } : {}),
      sections: selectedSections,
      artifacts,
    },
    detailsLimits: {
      sections: {
        returned: selectedSections.length,
        total: allSections.length,
        truncated: sectionId ? selectedSections.length === 0 : allSections.length > selectedSections.length,
      },
      artifacts: {
        returned: artifacts.length,
        total: result.details.artifacts.length,
        truncated: result.details.artifacts.length > artifacts.length,
      },
    },
  }
}

/** @param {ControlPlaneRunList} result */
function runListSummary(result) {
  if (result.runs.length === 0) return 'No NAX runs matched this page.'
  const labels = result.runs.slice(0, 5).map((run) => `${run.title || run.workflowId || run.runId} (${run.runId}, ${run.status})`)
  const remaining = result.runs.length - labels.length
  return `Found ${result.runs.length} NAX run${result.runs.length === 1 ? '' : 's'}: ${labels.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}.`
}

/** @param {ControlPlaneRunRead} result */
function runReadSummary(result) {
  const run = result.run
  if (result.view === 'details') return `${run.title || run.runId} (${run.runId}) is ${run.status}; bounded result details are included.`
  if (result.view === 'graph') return `${run.title || run.runId} (${run.runId}) is ${run.status}; its execution graph is included.`
  if (result.view === 'events') {
    const count = result.events?.events.length || 0
    return `${run.title || run.runId} (${run.runId}) is ${run.status}; ${count} event${count === 1 ? '' : 's'} returned.`
  }
  return `${run.title || run.runId} (${run.runId}) is ${run.status}.`
}

/** @param {ControlPlaneWaitResult} result */
function runWaitSummary(result) {
  const count = result.events.length
  const suffix = count > 0 ? ` with ${count} new event${count === 1 ? '' : 's'}` : ''
  return `${result.run.title || result.run.runId} (${result.run.runId}) wait returned ${result.reason}${suffix}; current status is ${result.run.status}.`
}

/**
 * @param {ControlPlaneRunSummary} run
 * @param {{ view?: import('../../contracts').ControlPlaneRunView, cursor?: string, reason?: import('../../contracts').ControlPlaneWaitReason }} [options]
 * @returns {ControlPlaneNextAction[]}
 */
function runNextActions(run, { view, cursor = '0', reason } = {}) {
  if (reason === 'events' || view === 'events' && !run.stalled) {
    return [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: run.runId, since: cursor, timeout_ms: 30000 } }]
  }
  if (reason === 'timeout') {
    return [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: run.runId, since: cursor, timeout_ms: 30000 } }]
  }
  if (reason === 'review' || run.reviewGate?.status === 'awaiting' || run.status === 'awaiting_review' || run.status === 'interrupted') {
    return [{ kind: 'tool', tool: 'run_get', arguments: { run_id: run.runId, view: 'details' } }]
  }
  if (reason === 'stalled' || run.stalled) {
    return [{ kind: 'tool', tool: 'run_get', arguments: { run_id: run.runId, view: 'events', since: cursor, limit: 100 } }]
  }
  if (run.status === 'running' || run.status === 'booting') {
    return [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: run.runId, since: cursor, timeout_ms: 30000 } }]
  }
  if (view !== 'details') return [{ kind: 'tool', tool: 'run_get', arguments: { run_id: run.runId, view: 'details' } }]
  return []
}

/**
 * @param {NaxControlPlaneClient} client
 * @param {unknown} error
 * @returns {Promise<string[]>}
 */
async function runCandidates(client, error) {
  if (!expectedApplicationError(error)) throw error
  const code = String(/** @type {{ code?: unknown }} */ (error).code || '')
  if (code !== 'not_found' && code !== 'run_not_found' && !code.startsWith('unknown_')) return []
  try {
    const result = await client.listRuns({ limit: 100 })
    return result.runs.map((run) => run.runId)
  } catch (_candidateError) {
    return []
  }
}

/**
 * @param {{ server: import('@modelcontextprotocol/server').McpServer, client?: NaxControlPlaneClient, resolveClient?: import('../routing').McpClientResolver }} input
 */
function registerRunTools({ server, client, resolveClient }) {
  const resolve = mcpClientResolver({ client, resolveClient })
  server.registerTool('run_list', TOOL_SPECS.run_list, async ({ scope_id: scopeId, status, workflow_id: workflowId, limit, cursor }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      const result = await resolved.client.listRuns({
        ...(status ? { status } : {}),
        ...(workflowId ? { workflowId } : {}),
        ...(limit ? { limit } : {}),
        ...(cursor !== undefined ? { cursor: String(cursor) } : {}),
      })
      const data = { ...result, runs: result.runs.map((run) => compactRunSummary(run, MAX_LIST_AGENT_RUNS)) }
      /** @type {ControlPlaneNextAction[]} */
      const nextActions = []
      const first = result.runs[0]
      if (first) nextActions.push({ kind: 'tool', tool: 'run_get', arguments: { run_id: first.runId, view: 'summary' } })
      if (result.nextCursor) {
        nextActions.push({
          kind: 'tool',
          tool: 'run_list',
          arguments: {
            ...(status ? { status } : {}),
            ...(workflowId ? { workflow_id: workflowId } : {}),
            limit: limit || 50,
            cursor: result.nextCursor,
          },
        })
      }
      return successResult({ summary: runListSummary(result), data, context, nextActions })
    } catch (error) {
      return errorResult(error, { toolName: 'run_list', context })
    }
  })

  server.registerTool('run_get', TOOL_SPECS.run_get, async ({ scope_id: scopeId, run_id: runId, view, section_id: sectionId, since, limit }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    /** @type {NaxControlPlaneClient | undefined} */
    let selectedClient
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      selectedClient = resolved.client
      const result = await selectedClient.getRun(runId, {
        view,
        ...(sectionId ? { sectionId } : {}),
        ...(since !== undefined ? { since: String(since) } : {}),
        ...(limit ? { limit } : {}),
      })
      const data = compactRunRead(result, sectionId)
      /** @type {ControlPlaneNextAction[]} */
      const nextActions = runNextActions(result.run, { view, cursor: result.events?.nextCursor || String(since || '0') })
      if (view === 'details') {
        const section = data.details?.sections.find((candidate) => !sectionId && candidate.sectionId)
        if (section) nextActions.unshift({ kind: 'tool', tool: 'run_get', arguments: { run_id: runId, view: 'details', section_id: section.sectionId } })
        const resource = data.details?.artifacts[0]?.resourceUri || data.details?.sections[0]?.resourceUri
        if (sectionId && resource) nextActions.unshift({ kind: 'resource', uri: resource })
      }
      return successResult({ summary: runReadSummary(result), data, context, nextActions })
    } catch (error) {
      const candidates = selectedClient ? await runCandidates(selectedClient, error) : []
      return errorResult(error, { toolName: 'run_get', context, candidates })
    }
  })

  server.registerTool('run_wait', TOOL_SPECS.run_wait, async ({ scope_id: scopeId, run_id: runId, since, timeout_ms: timeoutMs }, requestContext) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    /** @type {NaxControlPlaneClient | undefined} */
    let selectedClient
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      selectedClient = resolved.client
      const cursor = String(since || '0')
      const result = await selectedClient.waitForRun(runId, cursor, timeoutMs === undefined ? 30000 : timeoutMs, requestContext?.mcpReq.signal)
      const data = {
        ...result,
        run: compactRunSummary(result.run),
        events: result.events.map(compactEvent),
      }
      const nextActions = runNextActions(result.run, { cursor: result.nextCursor, reason: result.reason })
      return successResult({ summary: runWaitSummary(result), data, context, nextActions })
    } catch (error) {
      const candidates = selectedClient ? await runCandidates(selectedClient, error) : []
      return errorResult(error, { toolName: 'run_wait', context, candidates })
    }
  })
}

module.exports = {
  compactEvent,
  compactRunRead,
  compactRunSummary,
  registerRunTools,
  runCandidates,
  runListSummary,
  runNextActions,
  runReadSummary,
  runWaitSummary,
}
