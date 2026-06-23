const fs = require('fs')
const path = require('path')
const {
  buildAgentSessionJson,
  buildAgentSessionMarkdown,
  buildAgentSessionResultMarkdown,
  buildAgentSessionUsageJson,
  sessionArtifactId,
} = require('../../agent-run-results')

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

/** @param {string} dir */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** @param {string} projectRoot */
function agentSessionsRoot(projectRoot) {
  return path.join(projectRoot, '.nax', 'agent-sessions')
}

/** @param {string} projectRoot @param {string} sessionId */
function agentSessionDir(projectRoot, sessionId) {
  return path.join(agentSessionsRoot(projectRoot), sessionId)
}

/** @param {string} target @param {unknown} value */
function writeJson(target, value) {
  writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`)
}

/** @param {string} filePath */
function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

/** @param {string} target @param {unknown} content */
function writeAtomic(target, content) {
  ensureDir(path.dirname(target))
  const next = String(content)
  if (readFileIfExists(target) === next) return false
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, target)
  return true
}

/** @param {string} projectRoot @param {string} sessionId */
function updateLatestAgentSessionSymlink(projectRoot, sessionId) {
  if (!sessionId) return false
  const root = agentSessionsRoot(projectRoot)
  ensureDir(root)
  const latest = path.join(root, 'latest')
  const tmp = path.join(root, `latest.tmp-${process.pid}-${Date.now()}`)
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
    fs.symlinkSync(sessionId, tmp, 'dir')
    fs.rmSync(latest, { recursive: true, force: true })
    fs.renameSync(tmp, latest)
    return true
  } catch (error) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures.
    }
    if (process.env.NAX_DEBUG_ARTIFACTS) {
      console.error(`nax agent session latest symlink failed: ${error.message}`)
    }
    return false
  }
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
  const filePath = path.join(dir, 'agent-session.json')
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
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
