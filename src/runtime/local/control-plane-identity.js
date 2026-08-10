const crypto = require('node:crypto')

const {
  canonicalProjectRoot,
  ensureStableProjectIdentity,
  runtimeUserId,
} = require('./mcp-instance-registry')

/**
 * @typedef {{
 *   scope: import('../../contracts').ControlPlaneScope,
 *   actor: import('../../contracts').ControlPlaneActor,
 * }} LocalControlPlaneIdentity
 */

/** @param {string} prefix @param {string[]} parts */
function opaqueIdentity(prefix, parts) {
  return `${prefix}_${crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

/**
 * Produces the same stable authorization identity for every local adapter that
 * acts on behalf of the current OS user in one Nax project.
 *
 * @param {string} projectRoot
 * @param {{ userId?: string }} [options]
 * @returns {LocalControlPlaneIdentity}
 */
function localControlPlaneIdentity(projectRoot, options = {}) {
  const identity = ensureStableProjectIdentity(canonicalProjectRoot(projectRoot))
  const user = options.userId || runtimeUserId()
  return {
    scope: Object.freeze({
      scopeId: opaqueIdentity('scope', [identity.projectId]),
      projectId: identity.projectId,
    }),
    actor: Object.freeze({
      actorId: opaqueIdentity('actor', [identity.projectId, user]),
      kind: /** @type {const} */ ('local-session'),
      authenticated: true,
      authorizationVersion: 'local-dashboard-v1',
    }),
  }
}

module.exports = {
  localControlPlaneIdentity,
  opaqueIdentity,
}
