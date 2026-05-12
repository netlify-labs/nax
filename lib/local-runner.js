const { spawnSync } = require('child_process')
const { readLinkedSiteId, readNetlifyCliToken } = require('./init')

const TERMINAL_SUCCESS_STATES = new Set(['completed', 'done'])
const TERMINAL_FAILURE_STATES = new Set(['failed', 'error', 'cancelled', 'canceled'])

function run(command, args, { cwd, env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function parseJson(value, label) {
  try {
    return JSON.parse(value || '{}')
  } catch (error) {
    throw new Error(`Could not parse ${label} JSON: ${error.message}`)
  }
}

function buildNetlifyEnv({ env = process.env, projectRoot } = {}) {
  const token = readNetlifyCliToken({ env })
  const siteId = readLinkedSiteId(projectRoot, env)
  if (!siteId) {
    throw new Error(`No Netlify site is linked in ${projectRoot}. Run nax init first.`)
  }

  return {
    siteId,
    env: {
      ...env,
      NETLIFY_SITE_ID: siteId,
      ...(token.token ? { NETLIFY_AUTH_TOKEN: token.token } : {}),
    },
  }
}

function currentGitBranch(projectRoot) {
  const result = run('git', ['branch', '--show-current'], {
    cwd: projectRoot,
    allowFailure: true,
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

function latestSessionFromList(payload) {
  if (Array.isArray(payload)) return payload[payload.length - 1] || {}
  if (Array.isArray(payload?.sessions)) return payload.sessions[payload.sessions.length - 1] || {}
  return {}
}

function latestSessionFromRunner(runner) {
  return runner?.latest_session && typeof runner.latest_session === 'object'
    ? runner.latest_session
    : {}
}

function createAgentRun({
  projectRoot,
  promptText,
  agent,
  branch,
  siteId,
  env,
  runCommand = run,
} = {}) {
  const args = ['agents:create', '--json', '--agent', agent, '--project', siteId]
  if (branch) args.push('--branch', branch)
  args.push('--prompt', promptText)

  const result = runCommand('netlify', args, { cwd: projectRoot, env })
  const raw = parseJson(result.stdout, 'agents:create')
  const runnerId = raw.id || ''
  if (!runnerId) {
    throw new Error(`Netlify agent run was created but no runner ID was returned for ${agent}.`)
  }
  return {
    runnerId,
    state: raw.state || 'running',
    raw,
  }
}

function createAgentSession({
  projectRoot,
  runnerId,
  promptText,
  agent,
  env,
  runCommand = run,
} = {}) {
  const data = JSON.stringify({
    agent_runner_id: runnerId,
    body: {
      prompt: promptText,
      agent,
    },
  })
  const result = runCommand('netlify', ['api', 'createAgentRunnerSession', '--data', data], {
    cwd: projectRoot,
    env,
  })
  const raw = parseJson(result.stdout, 'createAgentRunnerSession')
  const state = raw.state || ''
  if (!state) {
    throw new Error(`Netlify follow-up session was submitted but no state was returned for ${agent}.`)
  }
  return {
    runnerId,
    state,
    raw,
  }
}

function showAgentRun({ projectRoot, runnerId, siteId, env, runCommand = run } = {}) {
  const result = runCommand('netlify', ['agents:show', runnerId, '--json', '--project', siteId], {
    cwd: projectRoot,
    env,
    allowFailure: true,
  })
  if (result.status !== 0) {
    return {
      state: '',
      raw: {},
      error: (result.stderr || result.stdout || '').trim(),
      commandError: true,
    }
  }
  let raw
  try {
    raw = parseJson(result.stdout, 'agents:show')
  } catch (error) {
    return {
      state: '',
      raw: {},
      error: error.message,
      commandError: true,
    }
  }
  return {
    state: raw.state || '',
    raw,
    error: raw.error || raw.error_message || '',
    commandError: false,
  }
}

function listAgentSessions({ projectRoot, runnerId, env, runCommand = run } = {}) {
  const data = JSON.stringify({ agent_runner_id: runnerId })
  const result = runCommand('netlify', ['api', 'listAgentRunnerSessions', '--data', data], {
    cwd: projectRoot,
    env,
    allowFailure: true,
  })
  if (result.status !== 0 || !result.stdout.trim()) return { raw: null, latest: {} }
  const raw = parseJson(result.stdout, 'listAgentRunnerSessions')
  return {
    raw,
    latest: latestSessionFromList(raw),
  }
}

function normalizeCompletedRun({ run, shown, sessions }) {
  const session = sessions.latest && Object.keys(sessions.latest).length > 0
    ? sessions.latest
    : latestSessionFromRunner(shown.raw)
  const runner = shown.raw || {}

  return {
    ...run,
    status: 'completed',
    resultText: session.result || runner.result || '',
    deployUrl: session.deploy_url || runner.deploy_url || '',
    prUrl: session.pull_request_url || runner.pr_url || '',
    rawResult: {
      runner,
      sessions: sessions.raw,
      latestSession: session,
    },
  }
}

async function waitForLocalAgentRuns({
  projectRoot,
  runs,
  siteId,
  env,
  timeoutMinutes = 25,
  initialDelayMs = 50000,
  pollIntervalMs = 15000,
  onProgress = () => {},
  runCommand = run,
} = {}) {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000
  const pending = new Map(runs.map((item) => [item.runnerId, item]))
  const completed = new Map()

  if (pending.size > 0 && initialDelayMs > 0) {
    onProgress({ message: `Waiting ${Math.round(initialDelayMs / 1000)}s before first local agent poll...` })
    await new Promise((resolve) => setTimeout(resolve, initialDelayMs))
  }

  while (pending.size > 0 && Date.now() < deadline) {
    for (const runState of [...pending.values()]) {
      const shown = showAgentRun({
        projectRoot,
        runnerId: runState.runnerId,
        siteId,
        env,
        runCommand,
      })
      const state = String(shown.state || '').toLowerCase()
      onProgress({
        message: shown.commandError
          ? `${runState.agent} ${runState.runnerId}: poll failed, retrying`
          : `${runState.agent} ${runState.runnerId}: ${state || 'unknown'}`,
        run: runState,
        state,
        error: shown.error,
      })

      if (shown.commandError) continue

      if (TERMINAL_SUCCESS_STATES.has(state)) {
        const sessions = listAgentSessions({
          projectRoot,
          runnerId: runState.runnerId,
          env,
          runCommand,
        })
        completed.set(runState.runnerId, normalizeCompletedRun({ run: runState, shown, sessions }))
        pending.delete(runState.runnerId)
      } else if (TERMINAL_FAILURE_STATES.has(state)) {
        const session = latestSessionFromRunner(shown.raw)
        completed.set(runState.runnerId, {
          ...runState,
          status: 'failed',
          resultText: session.result || shown.error || '',
          rawResult: shown.raw,
        })
        pending.delete(runState.runnerId)
      }
    }

    if (pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }

  for (const runState of pending.values()) {
    completed.set(runState.runnerId, {
      ...runState,
      status: 'timeout',
      resultText: '',
    })
  }

  return runs.map((runState) => completed.get(runState.runnerId) || runState)
}

module.exports = {
  buildNetlifyEnv,
  createAgentRun,
  createAgentSession,
  currentGitBranch,
  latestSessionFromList,
  latestSessionFromRunner,
  listAgentSessions,
  normalizeCompletedRun,
  parseJson,
  run,
  showAgentRun,
  waitForLocalAgentRuns,
}
