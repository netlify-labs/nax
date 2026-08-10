const crypto = require('node:crypto')

const { PACKAGE_VERSION } = require('../../core/artifact-metadata')
const {
  ensureStableProjectIdentity,
  removeDashboardInstance,
  writeDashboardInstance,
} = require('../../runtime/local/mcp-instance-registry')

/**
 * Advertises one running dashboard to local MCP adapters.
 * @param {{
 *   projectRoot: string,
 *   origin: string,
 *   token: string,
 *   pid?: number,
 *   instanceId?: string,
 *   version?: string,
 *   now?: () => string,
 *   registry?: { env?: NodeJS.ProcessEnv, tempDir?: string, userId?: string },
 * }} input
 */
function advertiseDashboardInstance({
  projectRoot,
  origin,
  token,
  pid = process.pid,
  instanceId = `instance_${crypto.randomUUID().replaceAll('-', '')}`,
  version = PACKAGE_VERSION,
  now = () => new Date().toISOString(),
  registry = {},
}) {
  const identity = ensureStableProjectIdentity(projectRoot)
  const record = {
    v: 1,
    instanceId,
    pid,
    projectId: identity.projectId,
    projectRoot: identity.projectRoot,
    origin,
    token,
    startedAt: now(),
    version,
  }
  const registryPath = writeDashboardInstance(record, registry)
  let closed = false
  return {
    instanceId,
    projectId: identity.projectId,
    projectRoot: identity.projectRoot,
    registryPath,
    close() {
      if (closed) return false
      closed = true
      return removeDashboardInstance(identity.projectRoot, instanceId, registry)
    },
  }
}

module.exports = {
  advertiseDashboardInstance,
}
