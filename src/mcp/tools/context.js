const { errorResult } = require('../errors')
const { successResult } = require('../results')
const { TOOL_SPECS } = require('../schemas')
const { mcpClientResolver } = require('../routing')

/** @typedef {import('../../contracts').NaxControlPlaneClient} NaxControlPlaneClient */

/** @param {import('../../contracts').ControlPlaneContext} context */
function contextSummary(context) {
  const target = context.target
    ? `${context.target.siteName} (${context.target.siteId}) on branch ${context.target.branch || context.currentBranch}`
    : `project ${context.scope.projectId} with no verified Netlify target`
  const available = Object.values(context.capabilities).filter((capability) => capability.available).length
  return `NAX ${context.runtime} is connected to ${target}.\nScope: ${context.scope.scopeId}. ${available} capabilities are available.`
}

/**
 * @param {{ server: import('@modelcontextprotocol/server').McpServer, client?: NaxControlPlaneClient, resolveClient?: import('../routing').McpClientResolver }} input
 */
function registerContextTool({ server, client, resolveClient }) {
  const resolve = mcpClientResolver({ client, resolveClient })
  const spec = TOOL_SPECS.context_get
  server.registerTool('context_get', spec, async ({ scope_id: scopeId, project_ref: projectRef }) => {
    try {
      const resolved = await resolve({ ...(scopeId ? { scopeId } : {}), ...(projectRef ? { projectRef } : {}) })
      const context = resolved.context
      /** @type {import('../../contracts').ControlPlaneNextAction[]} */
      const nextActions = []
      if (context.capabilities.workflow_list.available) nextActions.push({ kind: 'tool', tool: 'workflow_list', arguments: { limit: 50 } })
      if (context.capabilities.run_list.available) nextActions.push({ kind: 'tool', tool: 'run_list', arguments: { limit: 20 } })
      return successResult({
        summary: contextSummary(context),
        data: context,
        context,
        nextActions,
      })
    } catch (error) {
      return errorResult(error, { toolName: 'context_get' })
    }
  })
}

module.exports = {
  contextSummary,
  registerContextTool,
}
