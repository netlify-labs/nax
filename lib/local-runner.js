const { execFile, spawnSync } = require('child_process')
const { readLinkedSiteId, readNetlifyCliToken } = require('./init')
const { normalizeAgentRunResult } = require('./agent-run-results')

const TERMINAL_SUCCESS_STATES = new Set(['completed', 'done'])
const TERMINAL_FAILURE_STATES = new Set(['failed', 'cancelled', 'canceled'])
const SESSION_FAILURE_STATES = new Set(['failed', 'error', 'cancelled', 'canceled'])
const RUNNER_ERROR_STATES = new Set(['error'])
const RETRYABLE_CAPACITY_ERROR = /^The (?:Claude Code|Gemini|Codex) model is currently at capacity\. Retrying automatically\.\.\.$/
const RETRYABLE_ARGUMENT_LIMIT_ERROR = /fork\/exec\s+\/opt\/build-bin\/agent-runner:\s+argument list too long/i
const SENSITIVE_ARGS = new Set(['--prompt', '-p', '--data'])
const DEFAULT_SUBMISSION_RETRY_ATTEMPTS = 5
const DEFAULT_SUBMISSION_RETRY_DELAY_MS = 5000

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

function redactCommandDetail(command, args, detail) {
  let redacted = String(detail || '')
  for (let index = 0; index < args.length; index += 1) {
    if (!SENSITIVE_ARGS.has(args[index])) continue
    const value = args[index + 1]
    if (!value) continue
    redacted = redacted.split(String(value)).join('<redacted>')
    index += 1
  }
  return redacted
}

function resultDetail(command, args, result) {
  const detail = (result.stderr || result.stdout || result.error?.message || result.signal || '').toString().trim()
  return redactCommandDetail(command, args, detail)
}

function run(command, args, { cwd, env = process.env, allowFailure = false, timeout = 30000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
  })
  if (!allowFailure && result.status !== 0) {
    const detail = resultDetail(command, args, result)
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
        const detail = resultDetail(command, args, result)
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableSubmissionError(error) {
  const text = String(error?.message || error || '').toLowerCase()
  return [
    'could not parse',
    'timeout',
    'timed out',
    'etimedout',
    'econnreset',
    'econnrefused',
    'eai_again',
    'enotfound',
    'socket hang up',
    'network',
    'temporarily unavailable',
    'too many requests',
    'rate limit',
    '429',
    '500',
    '502',
    '503',
    '504',
    'gateway',
    'bad gateway',
    'service unavailable',
    'internal server error',
  ].some((needle) => text.includes(needle))
}

async function withSubmissionRetry(fn, {
  attempts = DEFAULT_SUBMISSION_RETRY_ATTEMPTS,
  delayMs = DEFAULT_SUBMISSION_RETRY_DELAY_MS,
  onRetry = () => {},
  sleepFn = sleep,
} = {}) {
  const totalAttempts = Math.max(1, Number(attempts) || 1)
  const baseDelayMs = Math.max(0, Number(delayMs) || 0)
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= totalAttempts || !isRetryableSubmissionError(error)) throw error
      const nextDelayMs = baseDelayMs * (2 ** (attempt - 1))
      onRetry({
        error,
        attempt,
        nextAttempt: attempt + 1,
        attempts: totalAttempts,
        delayMs: nextDelayMs,
      })
      if (nextDelayMs > 0) await sleepFn(nextDelayMs)
    }
  }
  throw new Error('Submission retry failed unexpectedly.')
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
  retryAttempts = DEFAULT_SUBMISSION_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_SUBMISSION_RETRY_DELAY_MS,
  onRetry = () => {},
  sleepFn,
} = {}) {
  const args = ['agents:create', '--json', '--agent', agent, '--project', siteId]
  if (branch) args.push('--branch', branch)
  args.push('--prompt', promptText)

  return withSubmissionRetry(async () => {
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
  }, {
    attempts: retryAttempts,
    delayMs: retryDelayMs,
    onRetry,
    sleepFn,
  })
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
  retryAttempts = DEFAULT_SUBMISSION_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_SUBMISSION_RETRY_DELAY_MS,
  onRetry = () => {},
  sleepFn,
} = {}) {
  const data = JSON.stringify({
    agent_runner_id: runnerId,
    body: {
      prompt: promptText,
      agent,
    },
  })
  const args = ['api', 'createAgentRunnerSession', '--data', data]
  return withSubmissionRetry(async () => {
    const result = await runCommand('netlify', args, {
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
  }, {
    attempts: retryAttempts,
    delayMs: retryDelayMs,
    onRetry,
    sleepFn,
  })
}

async function submitLocalAgentRun({
  run,
  projectRoot,
  branch,
  siteId,
  env,
  runCommand,
  retryAttempts = DEFAULT_SUBMISSION_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_SUBMISSION_RETRY_DELAY_MS,
  onRetry = () => {},
  sleepFn,
}) {
  const created = run.existingRunnerId
    ? await createAgentSessionAsync({
        projectRoot,
        runnerId: run.existingRunnerId,
        promptText: run.promptText,
        agent: run.agent,
        env,
        runCommand,
        retryAttempts,
        retryDelayMs,
        onRetry,
        sleepFn,
      })
    : await createAgentRunAsync({
        projectRoot,
        promptText: run.promptText,
        agent: run.agent,
        branch,
        siteId,
        env,
        runCommand,
        retryAttempts,
        retryDelayMs,
        onRetry,
        sleepFn,
      })

  return {
    ...run,
    status: 'submitted',
    runnerId: created.runnerId,
    sessionId: run.existingRunnerId ? (created.raw.id || run.sessionId || '') : (run.sessionId || ''),
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
  if (result.status !== 0) {
    return {
      raw: null,
      latest: {},
      error: (result.stderr || result.stdout || result.error?.message || '').trim(),
      commandError: true,
    }
  }
  if (!result.stdout.trim()) return { raw: null, latest: {}, error: '', commandError: false }
  let raw
  try {
    raw = parseJson(result.stdout, 'listAgentRunnerSessions')
  } catch (error) {
    return {
      raw: null,
      latest: {},
      error: error.message,
      commandError: true,
    }
  }
  return {
    raw,
    latest: latestSessionFromList(raw),
    error: '',
    commandError: false,
  }
}

function normalizeCompletedRun({ run, shown, sessions }) {
  const session = sessions.latest && Object.keys(sessions.latest).length > 0
    ? sessions.latest
    : latestSessionFromRunner(shown.raw)
  const runner = shown.raw || {}
  const sessionState = String(session.state || '').toLowerCase()

  if (SESSION_FAILURE_STATES.has(sessionState)) {
    return normalizeAgentRunResult({
      run,
      runner,
      session,
      status: 'failed',
      resultText: session.error_message || session.error || session.result || runner.error_message || runner.error || '',
      rawResult: {
        runner,
        sessions: sessions.raw,
        latestSession: session,
      },
    })
  }

  return normalizeAgentRunResult({
    run,
    runner,
    session,
    status: 'completed',
    resultText: session.result || runner.result || '',
    rawResult: {
      runner,
      sessions: sessions.raw,
      latestSession: session,
    },
  })
}

function normalizeFailedRun({ run, shown, sessions }) {
  const session = sessions?.latest && Object.keys(sessions.latest).length > 0
    ? sessions.latest
    : latestSessionFromRunner(shown.raw)
  const runner = shown.raw || {}

  return normalizeAgentRunResult({
    run,
    runner,
    session,
    status: 'failed',
    resultText: session.error_message || session.error || session.result || shown.error || runner.error_message || runner.error || '',
    rawResult: {
      runner,
      sessions: sessions?.raw || null,
      latestSession: session,
    },
  })
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
  onTerminalRun = () => {},
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
    onProgress({ message: `Waiting ${Math.round(initialDelayMs / 1000)}s before first Netlify API agent poll...` })
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
        if (sessions.commandError) {
          onProgress({
            message: `${runState.agent} ${runState.runnerId}: session list failed, retrying`,
            run: runState,
            state,
            error: sessions.error,
            terminal: false,
            terminalSuccess: false,
            terminalFailure: false,
          })
          continue
        }
        const normalized = normalizeCompletedRun({ run: runState, shown, sessions })
        onTerminalRun(normalized)
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
        if (sessions.commandError) {
          onProgress({
            message: `${runState.agent} ${runState.runnerId}: session list failed, retrying`,
            run: runState,
            state,
            error: sessions.error,
            terminal: false,
            terminalSuccess: false,
            terminalFailure: false,
          })
          continue
        }
        const failedRun = normalizeFailedRun({ run: runState, shown, sessions })
        onTerminalRun(failedRun)
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
    const timeoutRun = {
      ...runState,
      status: 'timeout',
      resultText: '',
    }
    onTerminalRun(timeoutRun)
    completed.set(runState.runnerId, timeoutRun)
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
  normalizeAgentRunResult,
  parseJson,
  run,
  runAsync,
  showAgentRun,
  submitLocalAgentRun,
  waitForLocalAgentRuns,
}
