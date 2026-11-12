// Persists nax acp sessions under <projectRoot>/.nax/acp-sessions so ACP clients can reload them.
// Each record holds the session's site, config, durable runner handle, and transcript.
const fs = require('fs')
const path = require('path')
const { ensureNaxGitignore } = require('../../storage/local/nax-gitignore')

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * @typedef {{ role: 'user' | 'agent', text: string }} AcpTranscriptEntry
 *
 * @typedef {{
 *   version: 1,
 *   sessionId: string,
 *   cwd: string,
 *   projectRoot: string,
 *   repoRoot?: string,
 *   siteId: string,
 *   branch: string,
 *   config: import('./session-config').AcpSessionConfig,
 *   handle: string | null,
 *   transcript: AcpTranscriptEntry[],
 *   createdAt: string,
 *   updatedAt: string,
 * }} AcpSessionRecord
 */

/**
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {string}
 */
function acpSessionPath(projectRoot, sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid ACP session id "${sessionId}".`)
  return path.join(projectRoot, '.nax', 'acp-sessions', `${sessionId}.json`)
}

/**
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {AcpSessionRecord | null}
 */
function loadAcpSession(projectRoot, sessionId) {
  const filePath = acpSessionPath(projectRoot, sessionId)
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * @param {AcpSessionRecord} record
 * @returns {void}
 */
function saveAcpSession(record) {
  const filePath = acpSessionPath(record.projectRoot, record.sessionId)
  ensureNaxGitignore({ projectRoot: record.projectRoot })
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`)
  fs.renameSync(tempPath, filePath)
}

module.exports = {
  acpSessionPath,
  loadAcpSession,
  saveAcpSession,
}
