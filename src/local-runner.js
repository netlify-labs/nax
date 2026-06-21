const { execFile, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
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
const NETLIFY_CONFIG_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.netlify',
  '.nax',
  '.next',
  '.nuxt',
  '.output',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
])

let buildInfoModulePromise

async function loadBuildInfoModule() {
  buildInfoModulePromise = buildInfoModulePromise || import('@netlify/build-info/node')
  return buildInfoModulePromise
}

function shellWords(value) {
  const words = []
  let current = ''
  let quote = ''
  let escaped = false
  for (const char of String(value || '')) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = ''
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}

function readNetlifyBuildCommand(configPath) {
  if (!fs.existsSync(configPath)) return ''
  const text = fs.readFileSync(configPath, 'utf8')
  const buildMatch = text.match(/(?:^|\n)\s*\[build]\s*\n([\s\S]*?)(?=\n\s*\[[^\]]+]\s*(?:\n|$)|$)/)
  const buildBlock = buildMatch ? buildMatch[1] : text
  const commandMatch = buildBlock.match(/(?:^|\n)\s*command\s*=\s*(["'])([\s\S]*?)\1/)
  return commandMatch ? commandMatch[2] : ''
}

function readRootNetlifyBuildCommand(projectRoot) {
  return readNetlifyBuildCommand(path.join(projectRoot, 'netlify.toml'))
}

function readNetlifyState(dir) {
  const statePath = path.join(dir, '.netlify', 'state.json')
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    return {
      siteId: state.siteId || '',
      statePath,
    }
  } catch {
    return {
      siteId: '',
      statePath,
    }
  }
}

function filterOutGitignored(paths, cwd) {
  if (!paths.length) return paths
  const result = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd,
    input: Buffer.from(paths.join('\0') + '\0'),
    timeout: 5000,
  })
  // 0 = at least one path matched, 1 = none matched, 128 = error (not a git repo, etc.)
  if (result.error || (result.status !== 0 && result.status !== 1)) return paths
  const stdout = result.stdout ? result.stdout.toString('utf8') : ''
  const ignored = new Set(stdout.split('\0').filter(Boolean))
  return paths.filter((candidate) => !ignored.has(candidate))
}

/** @param {any} projectRoot @param {Record<string, any>} param1 */
function findNetlifyConfigPaths(projectRoot, { maxDepth = 6 } = {}) {
  const root = path.resolve(projectRoot || process.cwd())
  const configs = []
  const visit = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile() && entry.name === 'netlify.toml') {
        configs.push(fullPath)
        continue
      }
      if (!entry.isDirectory()) continue
      if (NETLIFY_CONFIG_SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      visit(fullPath, depth + 1)
    }
  }
  visit(root, 0)
  return filterOutGitignored(configs, root)
}

function listNetlifyFilterCandidates(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd())
  return findNetlifyConfigPaths(root)
    .map((configPath) => {
      const configDir = path.dirname(configPath)
      const state = readNetlifyState(configDir)
      const buildCommand = readNetlifyBuildCommand(configPath)
      return {
        configPath,
        configDir,
        source: path.relative(root, configPath) || 'netlify.toml',
        dir: path.relative(root, configDir) || '.',
        siteId: state.siteId,
        statePath: state.statePath,
        stateSource: state.siteId ? path.relative(root, state.statePath) : '',
        filter: inferNetlifyFilterFromCommand(buildCommand),
        buildCommand,
      }
    })
}

/** @param {Record<string, any>} param0 */
async function detectJavascriptWorkspace({ projectRoot, projectDir, getBuildInfo } = {}) {
  const root = path.resolve(projectRoot || process.cwd())
  const baseDir = path.resolve(projectDir || root)
  try {
    const buildInfo = getBuildInfo || (await loadBuildInfoModule()).getBuildInfo
    const info = await buildInfo({
      projectDir: baseDir,
      rootDir: root,
    })
    return {
      isWorkspace: Boolean(info?.jsWorkspaces),
      workspace: info?.jsWorkspaces || null,
      packageManager: info?.packageManager || null,
      error: '',
    }
  } catch (error) {
    return {
      isWorkspace: false,
      workspace: null,
      packageManager: null,
      error: error?.message || String(error || 'Failed to detect JavaScript workspace.'),
    }
  }
}

function inferNetlifyFilterFromCommand(command) {
  const filters = []
  const words = shellWords(command)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word === '--filter' || word === '-F') {
      if (words[index + 1]) filters.push(words[index + 1])
      index += 1
      continue
    }
    if (word.startsWith('--filter=')) {
      const value = word.slice('--filter='.length)
      if (value) filters.push(value)
    }
  }
  const unique = [...new Set(filters)]
  return unique.length === 1 ? unique[0] : ''
}

/** @param {Record<string, any>} param0 */
function resolveNetlifyFilter({ projectRoot, filter } = {}) {
  if (filter) return { filter: String(filter), source: 'option' }
  const root = path.resolve(projectRoot || process.cwd())
  const matches = listNetlifyFilterCandidates(root)
    .filter((candidate) => candidate.filter)
  const uniqueFilters = [...new Set(matches.map((candidate) => candidate.filter))]
  if (uniqueFilters.length !== 1) return { filter: '', source: '' }
  return { filter: uniqueFilters[0], source: matches[0].source }
}

function findNetlifyTargetCandidate({ projectRoot, filter, netlifyConfig } = {}) {
  const root = path.resolve(projectRoot || process.cwd())
  const candidates = listNetlifyFilterCandidates(root)
  const requestedConfig = String(netlifyConfig || '').trim()
  if (requestedConfig) {
    const requestedPath = path.isAbsolute(requestedConfig)
      ? path.resolve(requestedConfig)
      : path.resolve(root, requestedConfig)
    const byConfig = candidates.filter((candidate) =>
      candidate.source === requestedConfig ||
      path.resolve(candidate.configPath) === requestedPath ||
      path.resolve(candidate.configDir) === requestedPath)
    if (byConfig.length === 1) return byConfig[0]
  }

  const requestedFilter = String(filter || '').trim()
  if (requestedFilter) {
    const byFilter = candidates.filter((candidate) => candidate.filter === requestedFilter)
    if (byFilter.length === 1) return byFilter[0]
  }

  const inferred = resolveNetlifyFilter({ projectRoot: root })
  if (inferred.source) {
    const bySource = candidates.filter((candidate) => candidate.source === inferred.source)
    if (bySource.length === 1) return bySource[0]
  }

  return candidates.length === 1 ? candidates[0] : null
}

function nestedNetlifySiteError(projectRoot, candidate) {
  const root = path.resolve(projectRoot || process.cwd())
  const stateSource = path.relative(root, candidate.statePath || path.join(candidate.configDir, '.netlify', 'state.json'))
  return [
    `Selected Netlify config ${candidate.source} is nested, but no linked Netlify site was found at ${stateSource}.`,
    'Refusing to use root .netlify/state.json because it may point to a different Netlify site.',
    `Run "cd ${candidate.dir} && netlify link" or pass "--site-id <site-id>" explicitly.`,
  ].join(' ')
}

/** @param {Record<string, any>} param0 */
function resolveNetlifyProjectTarget({
  projectRoot,
  filter,
  netlifyConfig,
  siteId: explicitSiteId,
  env = process.env,
} = {}) {
  const root = path.resolve(projectRoot || process.cwd())
  const candidate = findNetlifyTargetCandidate({ projectRoot: root, filter, netlifyConfig })
  const requestedFilter = String(filter || '').trim()
  const resolvedFilter = requestedFilter
    ? { filter: requestedFilter, source: 'option' }
    : (candidate?.filter
        ? { filter: candidate.filter, source: candidate.source }
        : resolveNetlifyFilter({ projectRoot: root }))
  const selectedSiteId = String(explicitSiteId || env.NETLIFY_SITE_ID || '').trim()
  if (selectedSiteId) {
    return {
      ...buildNetlifyEnv({ projectRoot: root, siteId: selectedSiteId, env }),
      filter: resolvedFilter.filter,
      filterSource: resolvedFilter.source,
      netlifyFilter: resolvedFilter,
      configDir: candidate?.configDir || '',
      configSource: candidate?.source || String(netlifyConfig || ''),
      siteSource: explicitSiteId ? 'option' : 'env',
    }
  }

  if (candidate?.siteId) {
    return {
      ...buildNetlifyEnv({ projectRoot: root, siteId: candidate.siteId, env }),
      filter: resolvedFilter.filter,
      filterSource: resolvedFilter.source,
      netlifyFilter: resolvedFilter,
      configDir: candidate.configDir,
      configSource: candidate.source,
      siteSource: candidate.stateSource,
    }
  }

  if (candidate && candidate.dir && candidate.dir !== '.') {
    throw new Error(nestedNetlifySiteError(root, candidate))
  }

  const netlify = buildNetlifyEnv({ projectRoot: root, env })
  return {
    ...netlify,
    filter: resolvedFilter.filter,
    filterSource: resolvedFilter.source,
    netlifyFilter: resolvedFilter,
    configDir: candidate?.configDir || '',
    configSource: candidate?.source || String(netlifyConfig || ''),
    siteSource: readNetlifyState(root).siteId ? path.join('.netlify', 'state.json') : '',
  }
}

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
  const detail = (result.stderr || result.stdout || result.error?.message || '').toString().trim()
  const timedOut = result.error?.code === 'ETIMEDOUT' || (result.error?.killed && result.signal)
  const timeoutDetail = timedOut && result.timeoutMs
    ? `timed out after ${Math.round(result.timeoutMs / 1000)}s`
    : ''
  const signalDetail = result.signal && !detail.includes(result.signal) ? result.signal : ''
  return redactCommandDetail(command, args, [detail, timeoutDetail, signalDetail].filter(Boolean).join('; '))
}

/** @param {any} command @param {any} args @param {Record<string, any>} param2 */
function run(command, args, { cwd, env = process.env, allowFailure = false, timeout = 30000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
  })
  const normalized = { ...result, timeoutMs: timeout }
  if (!allowFailure && normalized.status !== 0) {
    const detail = resultDetail(command, args, normalized)
    throw new Error(`${formatCommandForError(command, args)} failed${detail ? `: ${detail}` : ''}`)
  }
  return result
}

/** @param {any} command @param {any} args @param {Record<string, any>} param2 */
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
        timeoutMs: timeout,
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

/** @param {any} fn @param {Record<string, any>} param1 */
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

/** @param {Record<string, any>} param0 */
function buildNetlifyEnv({ env = process.env, projectRoot, siteId: explicitSiteId } = {}) {
  const token = readNetlifyCliToken({ env })
  const siteId = explicitSiteId || readLinkedSiteId(projectRoot, env)
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
  if (runState?.promptDelivery?.mode === 'blob' || runState?.blobRef) {
    return String(runState?.promptText || '')
  }
  const compactPromptText = String(runState?.compactPromptText || '').trim()
  const promptText = String(runState?.promptText || '')
  if (!compactPromptText || compactPromptText.length >= promptText.length) return ''
  return compactPromptText
}

/** @param {any} runState @param {any} rawRetry @param {Record<string, any>} param2 */
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

/** @param {Record<string, any>} param0 */
function createAgentRun({
  projectRoot,
  promptText,
  agent,
  branch,
  siteId,
  netlifyFilter,
  env,
  runCommand = run,
} = {}) {
  const args = ['agents:create', '--json', '--agent', agent, '--project', siteId]
  if (branch) args.push('--branch', branch)
  if (netlifyFilter) args.push('--filter', netlifyFilter)
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

/** @param {Record<string, any>} param0 */
async function createAgentRunAsync({
  projectRoot,
  promptText,
  agent,
  branch,
  siteId,
  netlifyFilter,
  env,
  runCommand = runAsync,
  retryAttempts = DEFAULT_SUBMISSION_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_SUBMISSION_RETRY_DELAY_MS,
  onRetry = () => {},
  sleepFn,
} = {}) {
  const args = ['agents:create', '--json', '--agent', agent, '--project', siteId]
  if (branch) args.push('--branch', branch)
  if (netlifyFilter) args.push('--filter', netlifyFilter)
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

/** @param {Record<string, any>} param0 */
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

/** @param {Record<string, any>} param0 */
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

/** @param {Record<string, any>} param0 */
async function submitLocalAgentRun({
  run,
  projectRoot,
  branch,
  siteId,
  netlifyFilter,
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
        netlifyFilter,
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

/** @param {Record<string, any>} param0 */
function showAgentRun({ projectRoot, runnerId, siteId, netlifyFilter, env, runCommand = run } = {}) {
  const args = ['agents:show', runnerId, '--json', '--project', siteId]
  if (netlifyFilter) args.push('--filter', netlifyFilter)
  const result = runCommand('netlify', args, {
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

/** @param {Record<string, any>} param0 */
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

/** @param {Record<string, any>} param0 */
function stopAgentRun({ projectRoot, runnerId, env, runCommand = run } = {}) {
  if (!runnerId) throw new Error('Netlify agent runner ID is required to stop a run.')
  const data = JSON.stringify({ agent_runner_id: runnerId })
  const result = runCommand('netlify', ['api', 'deleteAgentRunner', '--data', data], {
    cwd: projectRoot,
    env,
    allowFailure: true,
  })
  if (result.status === 0) {
    return {
      stopped: true,
      error: '',
      commandError: false,
    }
  }
  const detail = (result.stderr || result.stdout || result.error?.message || '').toString().replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (/TextHTTPError:\s*Accepted/i.test(detail) || /^Accepted$/i.test(detail)) {
    return {
      stopped: true,
      accepted: true,
      error: '',
      commandError: false,
    }
  }
  return {
    stopped: false,
    error: detail,
    commandError: true,
  }
}

/** @param {Record<string, any>} param0 */
function archiveAgentRun({ projectRoot, runnerId, env, runCommand = run } = {}) {
  if (!runnerId) throw new Error('Netlify agent runner ID is required to archive a run.')
  const data = JSON.stringify({ agent_runner_id: runnerId })
  const result = runCommand('netlify', ['api', 'archiveAgentRunner', '--data', data], {
    cwd: projectRoot,
    env,
    allowFailure: true,
  })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').toString().replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (/TextHTTPError:\s*Accepted/i.test(detail) || /^Accepted$/i.test(detail)) {
      return {
        archived: true,
        accepted: true,
        error: '',
        commandError: false,
      }
    }
    return {
      archived: false,
      error: detail,
      commandError: true,
    }
  }
  return {
    archived: true,
    error: '',
    commandError: false,
  }
}

/** @param {Record<string, any>} param0 */
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

/** @param {Record<string, any>} param0 */
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

/** @param {Record<string, any>} param0 */
async function waitForLocalAgentRuns({
  projectRoot,
  runs,
  siteId,
  netlifyFilter,
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

    onProgress({
      message,
      run: runState,
      state: 'retrying',
      terminal: false,
      terminalSuccess: false,
      terminalFailure: false,
      retry: true,
      retryReason: retryMetadata.retryReason,
    })
    const retried = await createAgentSessionAsync({
      projectRoot,
      runnerId: runState.runnerId,
      promptText,
      agent: runState.agent,
      env,
      runCommand,
      onRetry: ({ error, nextAttempt, attempts, delayMs }) => {
        onProgress({
          message: `${runState.agent} ${runState.runnerId}: retry submission failed, retrying ${nextAttempt}/${attempts} in ${Math.round(delayMs / 1000)}s — ${error.message}`,
          run: runState,
          state: 'retrying',
          error: error.message,
          terminal: false,
          terminalSuccess: false,
          terminalFailure: false,
          retry: true,
          retryReason: retryMetadata.retryReason,
        })
      },
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
      message: `${runState.agent} ${runState.runnerId}: retry submitted`,
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
        netlifyFilter,
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
        currentTask: shown.raw?.current_task || shown.raw?.currentTask || '',
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
  archiveAgentRun,
  buildNetlifyEnv,
  createAgentRun,
  createAgentRunAsync,
  createAgentSession,
  createAgentSessionAsync,
  compactPromptForArgumentLimitRetry,
  currentGitBranch,
  stopAgentRun,
  detectJavascriptWorkspace,
  formatCommandForError,
  findNetlifyConfigPaths,
  inferNetlifyFilterFromCommand,
  listNetlifyFilterCandidates,
  latestSessionFromList,
  latestSessionFromRunner,
  listAgentSessions,
  normalizeCompletedRun,
  normalizeAgentRunResult,
  parseJson,
  readNetlifyState,
  readRootNetlifyBuildCommand,
  resolveNetlifyFilter,
  resolveNetlifyProjectTarget,
  run,
  runAsync,
  showAgentRun,
  submitLocalAgentRun,
  waitForLocalAgentRuns,
}
