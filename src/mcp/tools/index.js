const { registerContextTool } = require('./context')
const { registerControlTools } = require('./controls')
const { registerPlanTools } = require('./plans')
const { registerRunTools } = require('./runs')
const { registerWorkflowTools } = require('./workflows')

/**
 * @param {{
 *   server: import('@modelcontextprotocol/server').McpServer,
 *   client?: import('../../contracts').NaxControlPlaneClient,
 *   resolveClient?: import('../routing').McpClientResolver,
 * }} input
 */
function registerDiscoveryTools(input) {
  registerContextTool(input)
  registerWorkflowTools(input)
}

/**
 * Registers the read-only MCP surface available before planning and mutation
 * tools are installed.
 *
 * @param {{
 *   server: import('@modelcontextprotocol/server').McpServer,
 *   client?: import('../../contracts').NaxControlPlaneClient,
 *   resolveClient?: import('../routing').McpClientResolver,
 * }} input
 */
function registerReadTools(input) {
  registerDiscoveryTools(input)
  registerRunTools(input)
}

/**
 * Registers the public MCP control-plane surface in entity-first workflow
 * order: discover, plan/start, then observe.
 *
 * @param {{
 *   server: import('@modelcontextprotocol/server').McpServer,
 *   client?: import('../../contracts').NaxControlPlaneClient,
 *   resolveClient?: import('../routing').McpClientResolver,
 * }} input
 */
function registerControlPlaneTools(input) {
  registerDiscoveryTools(input)
  registerPlanTools(input)
  registerRunTools(input)
  registerControlTools(input)
}

module.exports = {
  registerControlPlaneTools,
  registerControlTools,
  registerDiscoveryTools,
  registerPlanTools,
  registerReadTools,
  registerRunTools,
}
