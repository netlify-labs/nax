const { errorResult, expectedApplicationError } = require('../errors')
const { successResult } = require('../results')
const { TOOL_SPECS } = require('../schemas')
const { mcpClientResolver } = require('../routing')

/** @typedef {import('../../contracts').ControlPlaneContext} ControlPlaneContext */
/** @typedef {import('../../contracts').ControlPlaneWorkflowList} ControlPlaneWorkflowList */
/** @typedef {import('../../contracts').ControlPlaneWorkflowRead} ControlPlaneWorkflowRead */
/** @typedef {import('../../contracts').NaxControlPlaneClient} NaxControlPlaneClient */

/** @param {ControlPlaneWorkflowList} result */
function workflowListSummary(result) {
  if (result.workflows.length === 0) return 'No NAX workflows matched this page.'
  const names = result.workflows.slice(0, 5).map((workflow) => `${workflow.title} (${workflow.workflowId})`)
  const remaining = result.workflows.length - names.length
  return `Found ${result.workflows.length} NAX workflow${result.workflows.length === 1 ? '' : 's'}: ${names.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}.`
}

/** @param {ControlPlaneWorkflowRead} result */
function workflowReadSummary(result) {
  const workflow = result.workflow
  return `${workflow.title} (${workflow.workflowId}) has ${workflow.stepCount} step${workflow.stepCount === 1 ? '' : 's'} and ${workflow.agents.length} agent provider${workflow.agents.length === 1 ? '' : 's'}.${result.graph ? ' The dependency graph is included.' : ''}`
}

/**
 * @param {NaxControlPlaneClient} client
 * @param {unknown} error
 * @returns {Promise<string[]>}
 */
async function workflowCandidates(client, error) {
  if (!expectedApplicationError(error)) throw error
  const code = String(/** @type {{ code?: unknown }} */ (error).code || '')
  if (code !== 'not_found' && code !== 'workflow_not_found' && !code.startsWith('unknown_')) return []
  try {
    const result = await client.listWorkflows({ limit: 100 })
    return result.workflows.map((workflow) => workflow.workflowId)
  } catch (_candidateError) {
    return []
  }
}

/**
 * @param {{ server: import('@modelcontextprotocol/server').McpServer, client?: NaxControlPlaneClient, resolveClient?: import('../routing').McpClientResolver }} input
 */
function registerWorkflowTools({ server, client, resolveClient }) {
  const resolve = mcpClientResolver({ client, resolveClient })
  server.registerTool('workflow_list', TOOL_SPECS.workflow_list, async ({ scope_id: scopeId, source, limit, cursor }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      const result = await resolved.client.listWorkflows({
        ...(source ? { source } : {}),
        ...(limit ? { limit } : {}),
        ...(cursor !== undefined ? { cursor: String(cursor) } : {}),
      })
      /** @type {import('../../contracts').ControlPlaneNextAction[]} */
      const nextActions = []
      const first = result.workflows[0]
      if (first) nextActions.push({ kind: 'tool', tool: 'workflow_get', arguments: { workflow_id: first.workflowId } })
      if (result.nextCursor) {
        nextActions.push({
          kind: 'tool',
          tool: 'workflow_list',
          arguments: {
            ...(source ? { source } : {}),
            limit: limit || 50,
            cursor: result.nextCursor,
          },
        })
      }
      return successResult({ summary: workflowListSummary(result), data: result, context, nextActions })
    } catch (error) {
      return errorResult(error, { toolName: 'workflow_list', context })
    }
  })

  server.registerTool('workflow_get', TOOL_SPECS.workflow_get, async ({ scope_id: scopeId, workflow_id: workflowId, include_graph: includeGraph }) => {
    /** @type {ControlPlaneContext | undefined} */
    let context
    /** @type {NaxControlPlaneClient | undefined} */
    let selectedClient
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}) })
      context = resolved.context
      selectedClient = resolved.client
      const result = await selectedClient.getWorkflow(workflowId, { includeGraph: includeGraph === true })
      /** @type {import('../../contracts').ControlPlaneNextAction[]} */
      const nextActions = []
      if (context.capabilities.workflow_plan.available) {
        nextActions.push({ kind: 'tool', tool: 'workflow_plan', arguments: { workflow_id: result.workflow.workflowId } })
      }
      if (!includeGraph) {
        nextActions.push({ kind: 'tool', tool: 'workflow_get', arguments: { workflow_id: result.workflow.workflowId, include_graph: true } })
      }
      return successResult({ summary: workflowReadSummary(result), data: result, context, nextActions })
    } catch (error) {
      const candidates = selectedClient ? await workflowCandidates(selectedClient, error) : []
      return errorResult(error, { toolName: 'workflow_get', context, candidates })
    }
  })
}

module.exports = {
  registerWorkflowTools,
  workflowCandidates,
  workflowListSummary,
  workflowReadSummary,
}
