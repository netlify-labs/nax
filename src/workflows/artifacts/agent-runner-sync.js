const { listAgentRunnerArtifacts, persistAgentRunnerArtifact } = require('./agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('./agent-session-artifacts')
const { listAgentSessions } = require('../../integrations/netlify/local-runner')

/**
 * Remote Agent Runner session payload fields used for local artifact sync.
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   sessionId?: string,
 *   session_id?: string,
 *   state?: string,
 *   status?: string,
 *   result?: string,
 *   error_message?: string,
 *   error?: string,
 *   agent_config?: { agent?: string },
 *   created_at?: string,
 *   createdAt?: string,
 *   updated_at?: string,
 *   updatedAt?: string,
 *   completed_at?: string,
 *   completedAt?: string,
 * }} RemoteAgentSession
 *
 * Persist one remote Agent Runner session locally.
 * @typedef {{
 *   projectRoot: string,
 *   runner: import('../../types').AgentRunner,
 *   session: RemoteAgentSession,
 *   source?: import('../../types').JsonMap,
 * }} PersistRemoteSessionInput
 *
 * Synchronize remote sessions for one local Agent Runner artifact.
 * @typedef {{
 *   projectRoot?: string,
 *   runner?: import('../../types').AgentRunner,
 *   env?: NodeJS.ProcessEnv,
 *   runCommand?: import('../../types').RunCommand,
 * }} SyncAgentRunnerInput
 */

function sessionsFromListPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.sessions)) return payload.sessions
  return []
}

function sessionTime(session = {}) {
  return session.updated_at || session.updatedAt || session.completed_at || session.completedAt || session.created_at || session.createdAt || ''
}

function normalizeRemoteSessionStatus(session = {}) {
  const state = String(session.state || session.status || '').toLowerCase()
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(state)) return 'completed'
  if (['error', 'errored', 'failed', 'failure'].includes(state)) return 'failed'
  if (state === 'canceled') return 'cancelled'
  return state || (session.result ? 'completed' : '')
}

function sessionId(session = {}) {
  return String(session.id || session.sessionId || session.session_id || '')
}

function sessionUrl(agentRunUrl, id) {
  if (!agentRunUrl || !id) return ''
  return agentRunUrl.includes('?') ? `${agentRunUrl}&session=${id}` : `${agentRunUrl}?session=${id}`
}

/** @param {PersistRemoteSessionInput} param0 */
function persistRemoteSession({ projectRoot, runner, session, source }) {
  const id = sessionId(session)
  if (!id) return null
  const agentRunUrl = runner.links?.agentRunUrl || ''
  return persistAgentSessionArtifact({
    projectRoot,
    session,
    runnerId: runner.runnerId,
    agent: runner.agent || session.agent_config?.agent || '',
    sessionId: id,
    status: normalizeRemoteSessionStatus(session),
    resultText: session.result || session.error_message || session.error || '',
    fileChanges: runner.fileChanges || null,
    links: {
      ...(runner.links || {}),
      ...(agentRunUrl ? { sessionUrl: sessionUrl(agentRunUrl, id) } : {}),
    },
    rawResult: {
      session,
    },
    source: source || runner.source || null,
    createdAt: session.created_at || session.createdAt || runner.createdAt || '',
    updatedAt: sessionTime(session) || runner.updatedAt || '',
  })
}

/** @param {SyncAgentRunnerInput} param0 */
function syncAgentRunner({ projectRoot, runner, env, runCommand } = {}) {
  if (!projectRoot) throw new Error('Project root is required to sync Agent Runner artifacts.')
  if (!runner?.runnerId) throw new Error('Agent Runner ID is required to sync remote sessions.')
  const remote = listAgentSessions({
    projectRoot,
    runnerId: runner.runnerId,
    env,
    runCommand,
  })
  if (remote.commandError) {
    throw new Error(`Could not sync Agent Runner ${runner.runnerId}: ${remote.error || 'Netlify API request failed.'}`)
  }

  const remoteSessions = sessionsFromListPayload(remote.raw)
  const persisted = remoteSessions
    .map((session) => persistRemoteSession({ projectRoot, runner, session }))
    .filter(Boolean)
  let runnerArtifact = null
  for (const entry of persisted) {
    runnerArtifact = persistAgentRunnerArtifact({
      projectRoot,
      runnerId: runner.runnerId,
      agent: runner.agent || entry.session.agent || '',
      status: entry.session.status || runner.status || '',
      session: entry.session,
      source: runner.source || entry.session.source || null,
      links: runner.links || entry.session.links || {},
      createdAt: runner.createdAt || entry.session.createdAt || '',
      updatedAt: entry.session.updatedAt || runner.updatedAt || '',
    })
  }

  return {
    runnerId: runner.runnerId,
    remoteSessionCount: remoteSessions.length,
    syncedSessionCount: persisted.length,
    sessionIds: persisted.map((entry) => entry.session.sessionId),
    sessions: persisted.map((entry) => entry.session),
    runner: runnerArtifact?.runner || null,
    dir: runnerArtifact?.dir || '',
  }
}

/** @param {{ projectRoot?: string, env?: NodeJS.ProcessEnv, runCommand?: import('../../types').RunCommand }} param0 */
function syncLastAgentRunner({ projectRoot, env, runCommand } = {}) {
  const [runner] = listAgentRunnerArtifacts(projectRoot)
  if (!runner) {
    throw new Error(`No local Agent Runner artifacts found under ${projectRoot}/.nax/agent-runners.`)
  }
  return syncAgentRunner({ projectRoot, runner, env, runCommand })
}

module.exports = {
  normalizeRemoteSessionStatus,
  persistRemoteSession,
  sessionId,
  sessionsFromListPayload,
  syncAgentRunner,
  syncLastAgentRunner,
}
