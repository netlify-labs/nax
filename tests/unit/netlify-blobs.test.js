// @ts-nocheck
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  deleteBlob,
  getBlob,
  isRetryableBlobResult,
  runBlobCommand,
  sanitizeDetail,
  setBlob,
} = require('../../src/netlify-blobs')

test('setBlob writes payload through --input tempfile and removes it after upload', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-blob-test-'))
  let inputPath = ''
  const calls = []

  const result = setBlob({
    store: 'nax-run',
    key: 'step-prior-results',
    value: 'large payload',
    siteId: 'site-1',
    token: 'token-1',
    cwd: tmp,
    tmpDir: tmp,
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      inputPath = args[args.indexOf('--input') + 1]
      assert.equal(fs.readFileSync(inputPath, 'utf8'), 'large payload')
      return { status: 0, stdout: 'ok', stderr: '' }
    },
  })

  assert.equal(result.status, 0)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args.slice(0, 5), ['blobs:set', 'nax-run', 'step-prior-results', '--input', inputPath])
  assert.equal(calls[0].args.includes('--force'), true)
  assert.equal(calls[0].args.includes('--auth'), true)
  assert.equal(calls[0].options.env.NETLIFY_SITE_ID, 'site-1')
  assert.equal(fs.existsSync(path.dirname(inputPath)), false)
})

test('blob commands retry transient failures with bounded attempts', () => {
  const calls = []
  const retries = []

  const result = runBlobCommand({
    operation: 'get',
    store: 'nax-run',
    key: 'step-prior-results',
    args: ['blobs:get', 'nax-run', 'step-prior-results'],
    attempts: 3,
    delayMs: 10,
    sleep: () => {},
    jitter: () => 0,
    onRetry: (event) => retries.push(event),
    runCommand() {
      calls.push(calls.length + 1)
      if (calls.length === 1) return { status: 1, stdout: '', stderr: 'HTTP 503 temporary failure' }
      return { status: 0, stdout: 'payload', stderr: '' }
    },
  })

  assert.equal(result.stdout, 'payload')
  assert.equal(calls.length, 2)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].nextAttempt, 2)
  assert.equal(retries[0].attempts, 3)
})

test('blob commands do not retry permanent auth errors and redact token detail', () => {
  let calls = 0

  assert.throws(
    () => runBlobCommand({
      operation: 'delete',
      store: 'nax-run',
      key: 'step-prior-results',
      args: ['blobs:delete', 'nax-run', 'step-prior-results', '--auth', 'secret-token'],
      attempts: 3,
      runCommand() {
        calls += 1
        return { status: 1, stdout: '', stderr: 'Unauthorized --auth secret-token' }
      },
    }),
    (error) => {
      assert.equal(error.retryable, false)
      assert.match(error.message, /Unauthorized --auth \[redacted\]/)
      assert.doesNotMatch(error.message, /secret-token/)
      return true
    },
  )

  assert.equal(calls, 1)
})

test('getBlob and deleteBlob build CLI commands with shared auth and site env', () => {
  const calls = []
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: 'payload', stderr: '' }
  }

  assert.equal(getBlob({ store: 's', key: 'k', siteId: 'site', token: 'tok', runCommand }), 'payload')
  deleteBlob({ store: 's', key: 'k', siteId: 'site', token: 'tok', runCommand })

  assert.deepEqual(calls[0].args, ['blobs:get', 's', 'k', '--auth', 'tok'])
  assert.deepEqual(calls[1].args, ['blobs:delete', 's', 'k', '--force', '--auth', 'tok'])
  assert.equal(calls[0].options.env.NETLIFY_SITE_ID, 'site')
  assert.equal(calls[1].options.env.NETLIFY_SITE_ID, 'site')
})

test('retryability classifier separates transient and permanent blob failures', () => {
  assert.equal(isRetryableBlobResult({ stderr: 'HTTP 429 rate limit' }), true)
  assert.equal(isRetryableBlobResult({ stderr: 'socket hang up' }), true)
  assert.equal(isRetryableBlobResult({ stderr: 'Forbidden' }), false)
  assert.equal(sanitizeDetail('NETLIFY_AUTH_TOKEN=abc123'), 'NETLIFY_AUTH_TOKEN=[redacted]')
})
