// @ts-nocheck
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  deleteBlob,
  getBlob,
  blobFailureHint,
  isRetryableBlobResult,
  runBlobCommand,
  sanitizeDetail,
  setBlob,
} = require('../../src/integrations/netlify/blobs')

test('setBlob writes payload through a tempfile and removes it after upload', () => {
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
      inputPath = args.at(-1)
      assert.equal(fs.readFileSync(inputPath, 'utf8'), 'large payload')
      return { status: 0, stdout: 'ok', stderr: '' }
    },
  })

  assert.equal(result.status, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, process.execPath)
  assert.deepEqual(calls[0].args.slice(0, 5), ['-e', calls[0].args[1], 'set', 'nax-run', 'step-prior-results'])
  assert.equal(calls[0].args.at(-1), inputPath)
  assert.equal(calls[0].args.includes('--auth'), false)
  assert.equal(calls[0].args.includes('token-1'), false)
  assert.equal(calls[0].options.env.NETLIFY_SITE_ID, 'site-1')
  assert.equal(calls[0].options.env.NETLIFY_AUTH_TOKEN, 'token-1')
  assert.match(calls[0].options.env.NAX_BLOBS_CLIENT_MODULE, /@netlify[\\/]blobs/)
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

test('getBlob and deleteBlob build client helper commands with shared auth env and no auth argv', () => {
  const calls = []
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: 'payload', stderr: '' }
  }

  assert.equal(getBlob({ store: 's', key: 'k', siteId: 'site', token: 'tok', runCommand }), 'payload')
  deleteBlob({ store: 's', key: 'k', siteId: 'site', token: 'tok', runCommand })

  assert.equal(calls[0].command, process.execPath)
  assert.equal(calls[1].command, process.execPath)
  assert.deepEqual(calls[0].args.slice(0, 5), ['-e', calls[0].args[1], 'get', 's', 'k'])
  assert.deepEqual(calls[1].args.slice(0, 5), ['-e', calls[1].args[1], 'delete', 's', 'k'])
  assert.equal(calls[0].args.includes('tok'), false)
  assert.equal(calls[1].args.includes('tok'), false)
  assert.equal(calls[0].options.env.NETLIFY_SITE_ID, 'site')
  assert.equal(calls[1].options.env.NETLIFY_SITE_ID, 'site')
  assert.equal(calls[0].options.env.NETLIFY_AUTH_TOKEN, 'tok')
  assert.equal(calls[1].options.env.NETLIFY_AUTH_TOKEN, 'tok')
  assert.match(calls[0].options.env.NAX_BLOBS_CLIENT_MODULE, /@netlify[\\/]blobs/)
  assert.match(calls[1].options.env.NAX_BLOBS_CLIENT_MODULE, /@netlify[\\/]blobs/)
})

test('retryability classifier separates transient and permanent blob failures', () => {
  assert.equal(isRetryableBlobResult({ stderr: 'HTTP 429 rate limit' }), true)
  assert.equal(isRetryableBlobResult({ stderr: 'socket hang up' }), true)
  assert.equal(isRetryableBlobResult({ stderr: 'Forbidden' }), false)
  assert.equal(sanitizeDetail('NETLIFY_AUTH_TOKEN=abc123'), 'NETLIFY_AUTH_TOKEN=[redacted]')
})

test('blob errors explain Netlify CLI top-level-await crashes with fix checks', () => {
  assert.throws(
    () => runBlobCommand({
      operation: 'set',
      store: 'nax-run',
      key: 'full-prompt',
      args: ['blobs:set', 'nax-run', 'full-prompt', '--input', '/tmp/prompt.md'],
      cwd: '/repo/clients/frontend',
      cliPath: 'netlify',
      env: { NETLIFY_SITE_ID: 'site-1' },
      attempts: 1,
      runCommand() {
        return {
          status: 1,
          stdout: '',
          stderr: 'Warning: Detected unsettled top-level await at file:///netlify-cli/bin/run.js:86\nawait main()\n^',
        }
      },
    }),
    (error) => {
      assert.match(error.message, /Netlify CLI crashed before it returned a blob result/)
      assert.match(error.message, /cd \/repo\/clients\/frontend && netlify status/)
      assert.match(error.message, /Selected site id: site-1/)
      assert.match(error.message, /--netlify-config/)
      return true
    },
  )

  assert.match(
    blobFailureHint({
      result: { stderr: 'Unauthorized' },
      cwd: '/repo/clients/frontend',
      siteId: 'site-1',
    }),
    /NETLIFY_AUTH_TOKEN/,
  )
})
