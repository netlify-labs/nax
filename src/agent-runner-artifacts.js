const fs = require('fs')
const path = require('path')
const {
  ID_FORMAT,
  buildAgentRunnerJson,
  buildAgentRunnerMarkdown,
  buildAgentRunnerUsageJson,
} = require('./agent-run-results')
const { agentSessionDir } = require('./agent-session-artifacts')

/**
 * Persisted Agent Runner artifact result.
 * @typedef {{
 *   dir: string,
 *   runner: import('./types').AgentRunner,
 *   sessions: import('./types').AgentSession[],
 * }} AgentRunnerArtifactResult
 *
 * Agent Runner artifact write options.
 * @typedef {{
 *   projectRoot?: string,
 *   dryRun?: boolean,
 * }} AgentRunnerArtifactOptions
 *
 * Agent Runner artifact input.
 * @typedef {import('./types').AgentRunner & {
 *   projectRoot?: string,
 *   run?: import('./types').AgentRun,
 *   session?: import('./types').AgentSession,
 *   sessionId?: string,
 * }} AgentRunnerArtifactInput
 */

/** @param {string} dir */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** @param {string} projectRoot */
function agentRunnersRoot(projectRoot) {
  return path.join(projectRoot, '.nax', 'agent-runners')
}

/** @param {string} parentDir @param {string} targetPath */
function isInsideDir(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath)
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

/** @param {string} runnerId */
function validateAgentRunnerId(runnerId) {
  const value = String(runnerId || '').trim()
  if (!ID_FORMAT.test(value)) {
    throw new Error(`Invalid Netlify agent runner ID: ${value || '(empty)'}`)
  }
  return value
}

/** @param {string} projectRoot @param {string} runnerId */
function agentRunnerDir(projectRoot, runnerId) {
  const root = path.resolve(agentRunnersRoot(projectRoot))
  const resolved = path.resolve(root, validateAgentRunnerId(runnerId))
  if (!isInsideDir(root, resolved)) {
    throw new Error('Agent runner artifact path escaped the agent-runners directory.')
  }
  return resolved
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

/** @param {string} filePath */
function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} projectRoot @param {string} runnerId */
function updateLatestAgentRunnerSymlink(projectRoot, runnerId) {
  if (!runnerId) return false
  const root = agentRunnersRoot(projectRoot)
  ensureDir(root)
  const latest = path.join(root, 'latest')
  const tmp = path.join(root, `latest.tmp-${process.pid}-${Date.now()}`)
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
    fs.symlinkSync(runnerId, tmp, 'dir')
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
      console.error(`nax agent runner latest symlink failed: ${error.message}`)
    }
    return false
  }
}

/** @param {string} projectRoot @param {string} sessionId */
function sessionSummary(projectRoot, sessionId) {
  const dir = agentSessionDir(projectRoot, sessionId)
  const session = readJsonIfExists(path.join(dir, 'agent-session.json'))
  return session ? { ...session, dir } : null
}

/**
 * @param {AgentRunnerArtifactInput} [input]
 * @param {AgentRunnerArtifactOptions} [options]
 * @returns {AgentRunnerArtifactResult | null}
 */
function persistAgentRunnerArtifact(input = {}, options = {}) {
  const projectRoot = input.projectRoot || options.projectRoot
  const rawRunnerId = input.runnerId || input.run?.runnerId || input.session?.runnerId
  if (!projectRoot || !rawRunnerId) return null
  const runnerId = validateAgentRunnerId(rawRunnerId)
  const dir = agentRunnerDir(projectRoot, runnerId)
  const sessionsDir = path.join(dir, 'sessions')
  const existing = readJsonIfExists(path.join(dir, 'agent-runner.json')) || {}
  const sessionIds = new Set([...(existing.sessionIds || [])])
  if (input.session?.sessionId) sessionIds.add(input.session.sessionId)
  if (input.sessionId) sessionIds.add(input.sessionId)
  const sessions = [...sessionIds]
    .map((sessionId) => sessionSummary(projectRoot, sessionId) || (input.session?.sessionId === sessionId ? input.session : null))
    .filter(Boolean)
    .sort((a, b) => String(a.updatedAt || a.createdAt || '').localeCompare(String(b.updatedAt || b.createdAt || '')))
  const latestSession = input.session || sessions[sessions.length - 1] || null
  const runner = buildAgentRunnerJson({
    runnerId,
    agent: input.agent || latestSession?.agent || existing.agent || '',
    status: input.status || latestSession?.status || existing.status || '',
    createdAt: existing.createdAt || input.createdAt || latestSession?.createdAt || '',
    updatedAt: input.updatedAt || latestSession?.updatedAt || new Date().toISOString(),
    latestSessionId: latestSession?.sessionId || existing.latestSessionId || '',
    sessions,
    source: input.source || latestSession?.source || existing.source || null,
    links: input.links || latestSession?.links || existing.links || {},
  })
  if (options.dryRun) return { dir, runner, sessions }
  ensureDir(sessionsDir)
  writeJson(path.join(dir, 'agent-runner.json'), runner)
  writeJson(path.join(dir, 'usage.json'), buildAgentRunnerUsageJson(runner))
  writeAtomic(path.join(dir, 'summary.md'), buildAgentRunnerMarkdown({ ...runner, sessions }))
  for (const session of sessions) {
    writeJson(path.join(sessionsDir, `${session.sessionId}.json`), {
      sessionId: session.sessionId,
      path: `../../agent-sessions/${session.sessionId}/summary.md`,
      status: session.status || '',
      usage: session.usage || null,
    })
  }
  updateLatestAgentRunnerSymlink(projectRoot, runnerId)
  return { dir, runner, sessions }
}

/** @param {string} dir @returns {import('./types').AgentRunner | null} */
function readAgentRunnerArtifact(dir) {
  const filePath = path.join(dir, 'agent-runner.json')
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} projectRoot */
function listAgentRunnerArtifacts(projectRoot) {
  const root = agentRunnersRoot(projectRoot)
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name)
      const runner = readAgentRunnerArtifact(dir)
      return runner ? { ...runner, dir } : null
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
}

module.exports = {
  agentRunnerDir,
  agentRunnersRoot,
  listAgentRunnerArtifacts,
  persistAgentRunnerArtifact,
  updateLatestAgentRunnerSymlink,
}
