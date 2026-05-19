const { execFile, spawnSync } = require('child_process')
const { readLinkedSiteId, readNetlifyCliToken } = require('./init')

const TERMINAL_SUCCESS_STATES = new Set(['completed', 'done'])
const TERMINAL_FAILURE_STATES = new Set(['failed', 'cancelled', 'canceled'])
const SESSION_FAILURE_STATES = new Set(['failed', 'error', 'cancelled', 'canceled'])
const RUNNER_ERROR_STATES = new Set(['error'])
const RETRYABLE_CAPACITY_ERROR = /^The (?:Claude Code|Gemini|Codex) model is currently at capacity\. Retrying automatically\.\.\.$/
const RETRYABLE_ARGUMENT_LIMIT_ERROR = /fork\/exec\s+\/opt\/build-bin\/agent-runner:\s+argument list too long/i

function formatCommandForError(command, args) {
  const redacted = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    redacted.push(arg)
    if (arg === '--prompt' || arg === '-p' || arg === '--data') {
      index += 1
      redacted.push('<redacted>')
    }
  }
  return `${command} ${redacted.join(' ')}`
}

function run(command, args, { cwd, env = process.env, allowFailure = false, timeout = 30000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || result.signal || '').trim()
    throw new Error(`${formatCommandForError(command, args)} failed${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function runAsync(command, args, { cwd, env = process.env, allowFailure = false, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const result = {
        status: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error,
        signal: error?.signal || '',
      }
      if (!allowFailure && error) {
        const detail = (result.stderr || result.stdout || result.error?.message || result.signal || '').trim()
        reject(new Error(`${formatCommandForError(command, args)} failed${detail ? `: ${detail}` : ''}`))
        return
      }
      resolve(result)
    })
  })
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

function isTerminalFailureState(state, runner = {}) {
  if (TERMINAL_FAILURE_STATES.has(state)) return true
  if (!RUNNER_ERROR_STATES.has(state)) return false
  return Boolean(runner.done_at || runner.latest_session_state === 'error')
}

function isRetryableCapacityFailure(run) {
  return RETRYABLE_CAPACITY_ERROR.test(String(run?.resultText || '').trim())
}

function isRetryableArgumentLimitFailure(run) {
  return RETRYABLE_ARGUMENT_LIMIT_ERROR.test(String(run?.resultText || ''))
}

function compactPromptForArgumentLimitRetry(runState) {
  const compactPromptText = String(runState?.compactPromptText || '').trim()
  const promptText = String(runState?.promptText || '')
  if (!compactPromptText || compactPromptText.length >= promptText.length) return ''
  return compactPromptText
}

function appendAutoRetryMetadata(runState, rawRetry, {
  autoRetryCount,
  promptShrinkRetryCount,
  promptText,
  retryReason,
} = {}) {
  const retryEntry = {
    ...rawRetry,
    retryReason,
    promptLength: promptText ? promptText.length : String(runState.promptText || '').length,
  }
  return {
    ...runState,
    status: 'submitted',
    resultText: '',
    ...(promptText ? { promptText } : {}),
    ...(autoRetryCount !== undefined ? { autoRetryCount } : {}),
    ...(promptShrinkRetryCount !== undefined ? { promptShrinkRetryCount } : {}),
    raw: {
      ...runState.raw,
      autoRetries: [
        ...(Array.isArray(runState.raw?.autoRetries) ? runState.raw.autoRetries : []),
        retryEntry,
      ],
    },
  }
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

  const result = runCommand('netlify', args, { cwd: projectRoot, env, timeout: 120000 })
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

async function createAgentRunAsync({
  projectRoot,
  promptText,
  agent,
  branch,
  siteId,
  env,
  runCommand = runAsync,
} = {}) {
  const args = ['agents:create', '--json', '--agent', agent, '--project', siteId]
  if (branch) args.push('--branch', branch)
  args.push('--prompt', promptText)

  const result = await runCommand('netlify', args, { cwd: projectRoot, env, timeout: 120000 })
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
    timeout: 120000,
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

async function createAgentSessionAsync({
  projectRoot,
  runnerId,
  promptText,
  agent,
  env,
  runCommand = runAsync,
} = {}) {
  const data = JSON.stringify({
    agent_runner_id: runnerId,
    body: {
      prompt: promptText,
      agent,
    },
  })
  const result = await runCommand('netlify', ['api', 'createAgentRunnerSession', '--data', data], {
    cwd: projectRoot,
    env,
    timeout: 120000,
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

async function submitLocalAgentRun({ run, projectRoot, branch, siteId, env, runCommand }) {
  const created = run.existingRunnerId
    ? await createAgentSessionAsync({
        projectRoot,
        runnerId: run.existingRunnerId,
        promptText: run.promptText,
        agent: run.agent,
        env,
        runCommand,
      })
    : await createAgentRunAsync({
        projectRoot,
        promptText: run.promptText,
        agent: run.agent,
        branch,
        siteId,
        env,
        runCommand,
      })

  return {
    ...run,
    status: 'submitted',
    runnerId: created.runnerId,
    raw: {
      ...run.raw,
      [run.existingRunnerId ? 'session' : 'create']: created.raw,
    },
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
  const sessionState = String(session.state || '').toLowerCase()

  if (SESSION_FAILURE_STATES.has(sessionState)) {
    return {
      ...run,
      status: 'failed',
      resultText: session.error_message || session.error || session.result || runner.error_message || runner.error || '',
      rawResult: {
        runner,
        sessions: sessions.raw,
        latestSession: session,
      },
    }
  }

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

function normalizeFailedRun({ run, shown, sessions }) {
  const session = sessions?.latest && Object.keys(sessions.latest).length > 0
    ? sessions.latest
    : latestSessionFromRunner(shown.raw)
  const runner = shown.raw || {}

  return {
    ...run,
    status: 'failed',
    resultText: session.error_message || session.error || session.result || shown.error || runner.error_message || runner.error || '',
    rawResult: {
      runner,
      sessions: sessions?.raw || null,
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
  const capacityRetryCounts = new Map(runs.map((item) => [item.runnerId, Number(item.autoRetryCount || 0)]))
  const promptShrinkRetryCounts = new Map(runs.map((item) => [item.runnerId, Number(item.promptShrinkRetryCount || 0)]))
  const retryFailedRun = async (runState, failedRun) => {
    const capacityRetryCount = capacityRetryCounts.get(runState.runnerId) || 0
    const promptShrinkRetryCount = promptShrinkRetryCounts.get(runState.runnerId) || 0
    let promptText = ''
    let message = ''
    let retryMetadata = {}

    if (isRetryableCapacityFailure(failedRun) && capacityRetryCount < 1) {
      promptText = runState.promptText
      message = `${runState.agent} ${runState.runnerId}: retrying once after transient capacity error`
      retryMetadata = {
        autoRetryCount: capacityRetryCount + 1,
        retryReason: 'capacity',
      }
    } else if (isRetryableArgumentLimitFailure(failedRun) && promptShrinkRetryCount < 1) {
      promptText = compactPromptForArgumentLimitRetry(runState)
      if (!promptText) return false
      message = `${runState.agent} ${runState.runnerId}: retrying once with compact prompt after argument limit error`
      retryMetadata = {
        promptShrinkRetryCount: promptShrinkRetryCount + 1,
        retryReason: 'argument-list-too-long',
      }
    } else {
      return false
    }

    const retried = await createAgentSessionAsync({
      projectRoot,
      runnerId: runState.runnerId,
      promptText,
      agent: runState.agent,
      env,
      runCommand,
    })
    const retriedRun = appendAutoRetryMetadata(runState, retried.raw, {
      ...retryMetadata,
      promptText,
    })
    if (retryMetadata.autoRetryCount !== undefined) {
      capacityRetryCounts.set(runState.runnerId, retryMetadata.autoRetryCount)
    }
    if (retryMetadata.promptShrinkRetryCount !== undefined) {
      promptShrinkRetryCounts.set(runState.runnerId, retryMetadata.promptShrinkRetryCount)
    }
    pending.set(runState.runnerId, retriedRun)
    onProgress({
      message,
      run: retriedRun,
      state: retried.state || 'submitted',
      terminal: false,
      terminalSuccess: false,
      terminalFailure: false,
      retry: true,
    })
    return true
  }

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
      const terminalSuccess = TERMINAL_SUCCESS_STATES.has(state)
      const terminalFailure = isTerminalFailureState(state, shown.raw)
      const terminal = terminalSuccess || terminalFailure
      onProgress({
        message: shown.commandError
          ? `${runState.agent} ${runState.runnerId}: poll failed, retrying`
          : `${runState.agent} ${runState.runnerId}: ${state || 'unknown'}`,
        run: runState,
        state,
        error: shown.error,
        terminal,
        terminalSuccess,
        terminalFailure,
      })

      if (shown.commandError) continue

      if (terminalSuccess) {
        const sessions = listAgentSessions({
          projectRoot,
          runnerId: runState.runnerId,
          env,
          runCommand,
        })
        const normalized = normalizeCompletedRun({ run: runState, shown, sessions })
        if (normalized.status === 'failed' && await retryFailedRun(runState, normalized)) continue
        completed.set(runState.runnerId, normalized)
        pending.delete(runState.runnerId)
      } else if (terminalFailure) {
        const sessions = listAgentSessions({
          projectRoot,
          runnerId: runState.runnerId,
          env,
          runCommand,
        })
        const failedRun = normalizeFailedRun({ run: runState, shown, sessions })
        if (await retryFailedRun(runState, failedRun)) continue
        completed.set(runState.runnerId, failedRun)
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
  createAgentRunAsync,
  createAgentSession,
  createAgentSessionAsync,
  currentGitBranch,
  formatCommandForError,
  latestSessionFromList,
  latestSessionFromRunner,
  listAgentSessions,
  normalizeCompletedRun,
  parseJson,
  run,
  runAsync,
  showAgentRun,
  submitLocalAgentRun,
  waitForLocalAgentRuns,
}
