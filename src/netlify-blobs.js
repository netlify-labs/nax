// @ts-nocheck
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const DEFAULT_BLOB_RETRY_ATTEMPTS = 3
const DEFAULT_BLOB_RETRY_DELAY_MS = 750

function sleepSync(ms) {
  if (!ms) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function normalizeResult(result = {}) {
  return {
    status: result.status,
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
    error: result.error || null,
    signal: result.signal || '',
  }
}

function sanitizeDetail(value) {
  return String(value || '')
    .replace(/(--auth\s+)(\S+)/gi, '$1[redacted]')
    .replace(/(NETLIFY_AUTH_TOKEN=)(\S+)/gi, '$1[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)(\S+)/gi, '$1[redacted]')
}

function resultDetail(result = {}) {
  return sanitizeDetail(result.stderr || result.stdout || result.error?.message || result.signal || '')
}

function isRetryableBlobResult(result = {}) {
  const detail = resultDetail(result)
  const code = String(result.error?.code || '').toUpperCase()
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) return true
  if (/auth|unauthori[sz]ed|forbidden|invalid\s+(?:site|store|key)|not\s+found|bad request|malformed/i.test(detail)) return false
  if (/(?:\b408\b|\b409\b|\b425\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/.test(detail)) return true
  return /timed?\s*out|timeout|econnreset|etimedout|econnrefused|eai_again|network|socket hang up|connection reset|rate limit|temporar/i.test(detail)
}

function blobError(operation, store, key, result) {
  const detail = resultDetail(result)
  const message = `Netlify blob ${operation} failed for ${store}/${key}${detail ? `: ${detail}` : ''}`
  const error = new Error(message)
  error.result = result
  error.retryable = isRetryableBlobResult(result)
  return error
}

function retryAttempts(value) {
  const parsed = Number.parseInt(value || process.env.NAX_BLOB_RETRY_ATTEMPTS || `${DEFAULT_BLOB_RETRY_ATTEMPTS}`, 10)
  return Number.isFinite(parsed) ? Math.max(1, parsed) : DEFAULT_BLOB_RETRY_ATTEMPTS
}

function retryDelay(baseDelayMs, attempt, jitter = Math.random) {
  const base = Math.max(0, Number(baseDelayMs) || 0) * (2 ** Math.max(0, attempt - 1))
  if (!base) return 0
  return Math.round(base + Math.floor(jitter() * Math.max(1, base * 0.25)))
}

function runBlobCommand({
  operation,
  args,
  store,
  key,
  cwd,
  env = process.env,
  timeout = 120000,
  attempts,
  delayMs = DEFAULT_BLOB_RETRY_DELAY_MS,
  sleep = sleepSync,
  jitter = Math.random,
  onRetry = () => {},
  runCommand = spawnSync,
  cliPath = 'netlify',
} = {}) {
  const totalAttempts = retryAttempts(attempts)
  let last = null
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const result = normalizeResult(runCommand(cliPath, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout,
    }))
    last = result
    if (result.status === 0) return result
    const retryable = isRetryableBlobResult(result)
    if (attempt >= totalAttempts || !retryable) break
    const nextDelayMs = retryDelay(delayMs, attempt, jitter)
    onRetry({
      operation,
      store,
      key,
      attempt,
      nextAttempt: attempt + 1,
      attempts: totalAttempts,
      delayMs: nextDelayMs,
      error: blobError(operation, store, key, result),
    })
    if (nextDelayMs > 0) sleep(nextDelayMs)
  }
  throw blobError(operation, store, key, last || {})
}

function blobEnv({ env = process.env, siteId } = {}) {
  return {
    ...env,
    ...(siteId ? { NETLIFY_SITE_ID: siteId } : {}),
  }
}

function withAuth(args, token) {
  return token ? [...args, '--auth', token] : args
}

function writeTempBlobInput(value, tmpDir = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'nax-blob-'))
  const filePath = path.join(dir, 'payload.md')
  fs.writeFileSync(filePath, String(value || ''), 'utf8')
  return { dir, filePath }
}

function removeTempDir(dir) {
  if (!dir) return
  fs.rmSync(dir, { recursive: true, force: true })
}

function setBlob({
  store,
  key,
  value,
  siteId,
  token,
  cwd,
  env,
  cliPath,
  runCommand,
  attempts,
  delayMs,
  sleep,
  jitter,
  onRetry,
  tmpDir,
} = {}) {
  const temp = writeTempBlobInput(value, tmpDir)
  try {
    const args = withAuth(['blobs:set', store, key, '--input', temp.filePath, '--force'], token)
    return runBlobCommand({
      operation: 'set',
      args,
      store,
      key,
      cwd,
      env: blobEnv({ env, siteId }),
      cliPath,
      runCommand,
      attempts,
      delayMs,
      sleep,
      jitter,
      onRetry,
    })
  } finally {
    removeTempDir(temp.dir)
  }
}

function getBlob({
  store,
  key,
  siteId,
  token,
  cwd,
  env,
  cliPath,
  runCommand,
  attempts,
  delayMs,
  sleep,
  jitter,
  onRetry,
} = {}) {
  // Used by the credentialed roundtrip probe and debugging paths. Hosted agent
  // prompts still fetch with the runner-local CLI command embedded in the prompt.
  const args = withAuth(['blobs:get', store, key], token)
  const result = runBlobCommand({
    operation: 'get',
    args,
    store,
    key,
    cwd,
    env: blobEnv({ env, siteId }),
    cliPath,
    runCommand,
    attempts,
    delayMs,
    sleep,
    jitter,
    onRetry,
  })
  return result.stdout
}

function deleteBlob({
  store,
  key,
  siteId,
  token,
  cwd,
  env,
  cliPath,
  runCommand,
  attempts,
  delayMs,
  sleep,
  jitter,
  onRetry,
  allowFailure = false,
} = {}) {
  const args = withAuth(['blobs:delete', store, key, '--force'], token)
  try {
    return runBlobCommand({
      operation: 'delete',
      args,
      store,
      key,
      cwd,
      env: blobEnv({ env, siteId }),
      cliPath,
      runCommand,
      attempts,
      delayMs,
      sleep,
      jitter,
      onRetry,
    })
  } catch (error) {
    if (!allowFailure) throw error
    return {
      status: 1,
      stdout: '',
      stderr: error.message,
      error,
      detail: error.message,
    }
  }
}

module.exports = {
  DEFAULT_BLOB_RETRY_ATTEMPTS,
  DEFAULT_BLOB_RETRY_DELAY_MS,
  deleteBlob,
  getBlob,
  isRetryableBlobResult,
  resultDetail,
  retryDelay,
  runBlobCommand,
  sanitizeDetail,
  setBlob,
}
