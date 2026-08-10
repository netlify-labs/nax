const fs = require('node:fs')
const path = require('node:path')

const { canonicalProjectRoot } = require('./mcp-instance-registry')

const AUDIT_VERSION = 1

/** @param {string} projectRoot */
function localControlPlaneAuditPath(projectRoot) {
  return path.join(canonicalProjectRoot(projectRoot), '.nax', 'audit', 'mcp.jsonl')
}

/**
 * @param {string} projectRoot
 * @returns {import('../../contracts').ControlPlaneAuditSink}
 */
function createLocalControlPlaneAuditSink(projectRoot) {
  const filePath = localControlPlaneAuditPath(projectRoot)
  return Object.freeze({
    record(event) {
      const directory = path.dirname(filePath)
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { fs.chmodSync(directory, 0o700) } catch (_error) { /* unsupported on some platforms */ }
      const line = `${JSON.stringify({ version: AUDIT_VERSION, ...event })}\n`
      const fd = fs.openSync(filePath, 'a', 0o600)
      try {
        fs.writeSync(fd, line, null, 'utf8')
      } finally {
        fs.closeSync(fd)
      }
      try { fs.chmodSync(filePath, 0o600) } catch (_error) { /* unsupported on some platforms */ }
    },
  })
}

module.exports = {
  AUDIT_VERSION,
  createLocalControlPlaneAuditSink,
  localControlPlaneAuditPath,
}
