/** @typedef {import('../contracts').ControlPlaneContext} ControlPlaneContext */
/** @typedef {import('../contracts').NaxControlPlaneClient} NaxControlPlaneClient */

/**
 * @typedef {{
 *   scopeId?: string,
 *   projectRef?: string,
 * }} McpProjectSelection
 *
 * @typedef {{
 *   client: NaxControlPlaneClient,
 *   context: ControlPlaneContext,
 *   projectRoot?: string,
 * }} McpResolvedClient
 *
 * @typedef {(selection?: McpProjectSelection) => Promise<McpResolvedClient>} McpClientResolver
 */

/**
 * Adapts the original single-project client seam to the routed tool seam.
 * @param {NaxControlPlaneClient} client
 * @returns {McpClientResolver}
 */
function fixedClientResolver(client) {
  return async () => ({ client, context: await client.getContext() })
}

/**
 * @param {{ client?: NaxControlPlaneClient, resolveClient?: McpClientResolver }} input
 * @returns {McpClientResolver}
 */
function mcpClientResolver({ client, resolveClient }) {
  if (resolveClient) return resolveClient
  if (client) return fixedClientResolver(client)
  throw new TypeError('An MCP control-plane client or client resolver is required.')
}

module.exports = {
  fixedClientResolver,
  mcpClientResolver,
}
