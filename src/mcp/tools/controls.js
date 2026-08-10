const { errorResult } = require('../errors')
const { successResult } = require('../results')
const { TOOL_SPECS } = require('../schemas')
const { runCandidates } = require('./runs')
const { mcpClientResolver } = require('../routing')

/** @typedef {import('../../contracts').ControlPlaneContext} ControlPlaneContext */
/** @typedef {import('../../contracts').ControlPlaneNextAction} ControlPlaneNextAction */
/** @typedef {import('../../contracts').ControlPlaneRunSummary} ControlPlaneRunSummary */
/** @typedef {import('../../contracts').NaxControlPlaneClient} NaxControlPlaneClient */

/** @param {ControlPlaneRunSummary} run @returns {ControlPlaneNextAction[]} */
function observeRunActions(run) {
  if (run.status === 'running' || run.status === 'booting') {
    return [{ kind: 'tool', tool: 'run_wait', arguments: { run_id: run.runId, since: '0', timeout_ms: 30000 } }]
  }
  return [{ kind: 'tool', tool: 'run_get', arguments: { run_id: run.runId, view: 'details' } }]
}

/**
 * @param {NaxControlPlaneClient} client
 * @param {unknown} error
 * @returns {Promise<string[]>}
 */
async function controlRunCandidates(client, error) {
  return runCandidates(client, error)
}

/**
 * @param {{ server: import('@modelcontextprotocol/server').McpServer, client?: NaxControlPlaneClient, resolveClient?: import('../routing').McpClientResolver }} input
 */
function registerControlTools({ server, client, resolveClient }) {
  const resolve = mcpClientResolver({ client, resolveClient })
  server.registerTool('run_cancel', TOOL_SPECS.run_cancel, async ({ scope_id: scopeId, run_id: runId, agent_run_id: agentRunId, reason }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    /** @type {NaxControlPlaneClient | undefined} */
    let selectedClient
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      selectedClient = resolved.client
      const result = await selectedClient.cancelRun({ runId, ...(agentRunId ? { agentRunId } : {}), ...(reason ? { reason } : {}) })
      const target = agentRunId ? `agent run ${agentRunId}` : `run ${runId}`
      const warningText = result.warnings.length > 0 ? ` ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} returned.` : ''
      return successResult({
        summary: result.cancelled ? `Cancelled ${target}; resulting run status is ${result.run.status}.${warningText}` : `${target} was already terminal or unchanged; resulting run status is ${result.run.status}.${warningText}`,
        data: result,
        context,
        nextActions: [{ kind: 'tool', tool: 'run_get', arguments: { run_id: result.run.runId, view: 'summary' } }],
      })
    } catch (error) {
      const candidates = selectedClient ? await controlRunCandidates(selectedClient, error) : []
      return errorResult(error, { toolName: 'run_cancel', context, candidates })
    }
  })

  server.registerTool('agent_run_retry', TOOL_SPECS.agent_run_retry, async ({ scope_id: scopeId, run_id: runId, agent_run_id: agentRunId, request_id: requestId }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    /** @type {NaxControlPlaneClient | undefined} */
    let selectedClient
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      selectedClient = resolved.client
      const result = await selectedClient.retryAgentRun({ runId, agentRunId, requestId })
      return successResult({
        summary: `${result.replayed ? 'Replayed' : 'Accepted'} retry ${requestId} for ${agentRunId}; replacement ${result.agentRun.agentRunId} is ${result.agentRun.status}.`,
        data: result,
        context,
        nextActions: observeRunActions(result.run),
      })
    } catch (error) {
      const candidates = selectedClient ? await controlRunCandidates(selectedClient, error) : []
      return errorResult(error, { toolName: 'agent_run_retry', context, candidates })
    }
  })

  server.registerTool('agent_run_followup', TOOL_SPECS.agent_run_followup, async ({
    scope_id: scopeId,
    run_id: runId,
    agent_run_id: agentRunId,
    request_id: requestId,
    prompt,
    mode,
    artifact_ids: artifactIds,
    instances,
  }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    /** @type {NaxControlPlaneClient | undefined} */
    let selectedClient
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      selectedClient = resolved.client
      const result = await selectedClient.submitFollowup({
        runId,
        agentRunId,
        requestId,
        prompt,
        ...(mode ? { mode } : {}),
        ...(artifactIds ? { artifactIds } : {}),
        ...(instances ? { instances } : {}),
      })
      return successResult({
        summary: `${result.replayed ? 'Replayed' : 'Accepted'} follow-up ${requestId} from ${agentRunId}; ${result.agentRuns.length} agent run${result.agentRuns.length === 1 ? '' : 's'} returned and run ${result.run.runId} is ${result.run.status}.`,
        data: result,
        context,
        nextActions: observeRunActions(result.run),
      })
    } catch (error) {
      const candidates = selectedClient ? await controlRunCandidates(selectedClient, error) : []
      return errorResult(error, { toolName: 'agent_run_followup', context, candidates })
    }
  })

  server.registerTool('review_gate_resolve', TOOL_SPECS.review_gate_resolve, async ({ scope_id: scopeId, run_id: runId, review_gate_id: reviewGateId, decision, reason }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    /** @type {NaxControlPlaneClient | undefined} */
    let selectedClient
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      selectedClient = resolved.client
      const result = await selectedClient.resolveReviewGate({ runId, reviewGateId, decision, ...(reason ? { reason } : {}) })
      return successResult({
        summary: `${result.replayed ? 'Replayed' : 'Applied'} ${decision} for review gate ${reviewGateId}; run ${result.run.runId} is ${result.run.status}.`,
        data: result,
        context,
        nextActions: observeRunActions(result.run),
      })
    } catch (error) {
      const candidates = selectedClient ? await controlRunCandidates(selectedClient, error) : []
      return errorResult(error, { toolName: 'review_gate_resolve', context, candidates })
    }
  })
}

module.exports = {
  controlRunCandidates,
  observeRunActions,
  registerControlTools,
}
