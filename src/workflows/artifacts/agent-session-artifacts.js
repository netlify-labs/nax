const fs = require('fs')
const path = require('path')
const { ensureNaxGitignore } = require('../../storage/local/nax-gitignore')
const { ensureDir, readJsonIfExists, updateLatestSymlink, writeAtomic, writeJson } = require('../../storage/local/artifact-fs')
const {
  buildAgentSessionJson,
  buildAgentSessionMarkdown,
  buildAgentSessionResultMarkdown,
  buildAgentSessionUsageJson,
  sessionArtifactId,
} = require('../results/agent-run-results')

/**
 * Persisted Agent Runner session artifact result.
 * @typedef {{
 *   dir: string,
 *   session: import('../../types').AgentSession,
 * }} AgentSessionArtifactResult
 *
 * Agent session artifact write options.
 * @typedef {{
 *   projectRoot?: string,
 *   dryRun?: boolean,
 * }} AgentSessionArtifactOptions
 *
 * Input accepted when materializing a session artifact.
 * @typedef {import('../../types').AgentRun & {
 *   projectRoot?: string,
 *   run?: import('../../types').AgentRun,
 *   runner?: import('../../types').JsonMap,
 *   session?: import('../../types').JsonMap,
 * }} AgentSessionArtifactInput
 */

/** @param {string} projectRoot */
function agentSessionsRoot(projectRoot) {
  return path.join(projectRoot, '.nax', 'agent-sessions')
}

/** @param {string} projectRoot @param {string} sessionId */
function agentSessionDir(projectRoot, sessionId) {
  return path.join(agentSessionsRoot(projectRoot), sessionId)
}

/** @param {string} projectRoot @param {string} sessionId */
function updateLatestAgentSessionSymlink(projectRoot, sessionId) {
  if (!sessionId) return false
  const root = agentSessionsRoot(projectRoot)
  ensureDir(root)
  return updateLatestSymlink(root, sessionId, 'nax agent session latest symlink')
}

/**
 * @param {AgentSessionArtifactInput} [input]
 * @param {AgentSessionArtifactOptions} [options]
 * @returns {AgentSessionArtifactResult | null}
 */
function persistAgentSessionArtifact(input = {}, options = {}) {
  const projectRoot = input.projectRoot || options.projectRoot
  if (!projectRoot) return null
  const session = buildAgentSessionJson(input)
  session.sessionId = sessionArtifactId(session)
  const dir = agentSessionDir(projectRoot, session.sessionId)
  if (options.dryRun) return { dir, session }
  ensureNaxGitignore({ projectRoot })
  ensureDir(dir)
  writeJson(path.join(dir, 'agent-session.json'), session)
  writeJson(path.join(dir, 'usage.json'), buildAgentSessionUsageJson(session))
  writeAtomic(path.join(dir, 'summary.md'), buildAgentSessionMarkdown(session))
  const resultMarkdown = buildAgentSessionResultMarkdown(session)
  const resultPath = path.join(dir, 'result.md')
  if (resultMarkdown.trim()) {
    writeAtomic(resultPath, resultMarkdown)
  } else if (fs.existsSync(resultPath)) {
    fs.rmSync(resultPath, { force: true })
  }
  updateLatestAgentSessionSymlink(projectRoot, session.sessionId)
  return { dir, session }
}

/** @param {string} dir @returns {import('../../types').AgentSession | null} */
function readAgentSessionArtifact(dir) {
  return readJsonIfExists(path.join(dir, 'agent-session.json'))
}

/** @param {string} projectRoot */
function listAgentSessionArtifacts(projectRoot) {
  const root = agentSessionsRoot(projectRoot)
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name)
      const session = readAgentSessionArtifact(dir)
      return session ? { ...session, dir } : null
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
}

module.exports = {
  agentSessionDir,
  agentSessionsRoot,
  listAgentSessionArtifacts,
  persistAgentSessionArtifact,
  updateLatestAgentSessionSymlink,
}
