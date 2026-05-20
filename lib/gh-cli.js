const { spawnSync } = require('child_process')

const DEFAULT_GH_RETRY_ATTEMPTS = 5
const DEFAULT_GH_RETRY_DELAY_MS = 5000
let ghAuthValidated = false

function sleepSync(ms) {
  if (!ms) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function normalizeResult(result) {
  return {
    status: result.status,
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
    error: result.error,
    signal: result.signal || '',
  }
}

function resultDetail(result) {
  return (result.stderr || result.stdout || result.error?.message || result.signal || '').toString().trim()
}

function isGitHubAuthError(detail) {
  return /(?:not authenticated|not logged in|authentication required|requires authentication|bad credentials|http 401|gh auth login)/i.test(String(detail || ''))
}

function isRetryableGhError(result) {
  const detail = resultDetail(result)
  if (!detail || isGitHubAuthError(detail)) return false
  if (result.error?.code === 'ENOENT') return false
  return /(?:http 5\d\d|timed? out|timeout|econnreset|etimedout|eai_again|enotfound|network|tls|socket hang up|connection reset|secondary rate limit|rate limit exceeded)/i.test(detail)
}

function formatGhError(args, result, prefix) {
  const detail = resultDetail(result)
  const base = prefix || `gh ${args.join(' ')} failed`
  if (isGitHubAuthError(detail)) {
    const auth = 'GitHub CLI is not authenticated or lacks required access. Run gh auth login, or set GH_TOKEN with the required repo permissions.'
    return `${base}: ${auth}${detail ? ` (${detail})` : ''}`
  }
  return `${base}${detail ? `: ${detail}` : ''}`
}

function runGh(args, {
  cwd,
  input,
  env = process.env,
  allowFailure = false,
  timeout = 30000,
  attempts = DEFAULT_GH_RETRY_ATTEMPTS,
  delayMs = DEFAULT_GH_RETRY_DELAY_MS,
  sleep = sleepSync,
  runCommand = spawnSync,
  errorPrefix,
} = {}) {
  let lastResult = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = normalizeResult(runCommand('gh', args, {
      cwd,
      input,
      env,
      encoding: 'utf8',
      timeout,
    }))
    lastResult = result
    if (result.status === 0) return result
    if (attempt >= attempts || !isRetryableGhError(result)) break
    sleep(delayMs * (2 ** (attempt - 1)))
  }

  if (allowFailure) {
    return {
      ...lastResult,
      detail: resultDetail(lastResult),
    }
  }

  throw new Error(formatGhError(args, lastResult, errorPrefix))
}

function assertGhAuthenticated({ cwd, env = process.env, runCommand = spawnSync, force = false } = {}) {
  if (ghAuthValidated && !force) return
  runGh(['auth', 'status'], {
    cwd,
    env,
    attempts: 1,
    runCommand,
    errorPrefix: 'GitHub CLI authentication check failed',
  })
  ghAuthValidated = true
}

function resetGhAuthCache() {
  ghAuthValidated = false
}

module.exports = {
  DEFAULT_GH_RETRY_ATTEMPTS,
  DEFAULT_GH_RETRY_DELAY_MS,
  assertGhAuthenticated,
  formatGhError,
  isGitHubAuthError,
  isRetryableGhError,
  resetGhAuthCache,
  runGh,
}
