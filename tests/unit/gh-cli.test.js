const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assertGhAuthenticated,
  isGitHubAuthError,
  resetGhAuthCache,
  runGh,
} = require('../../src/integrations/github/gh-cli')

test('runGh retries transient failures with exponential backoff', () => {
  const calls = []
  const delays = []
  const result = runGh(['issue', 'create'], {
    delayMs: 10,
    sleep: (ms) => delays.push(ms),
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      if (calls.length < 3) return { status: 1, stdout: '', stderr: 'HTTP 502: gateway' }
      return { status: 0, stdout: 'https://github.com/o/r/issues/1\n', stderr: '' }
    },
  })

  assert.equal(result.stdout, 'https://github.com/o/r/issues/1\n')
  assert.equal(calls.length, 3)
  assert.deepEqual(delays, [10, 20])
  assert.deepEqual(calls[0].args, ['issue', 'create'])
})

test('runGh does not retry auth failures and prints setup help', () => {
  const calls = []
  const delays = []

  assert.throws(() => runGh(['repo', 'view'], {
    delayMs: 10,
    sleep: (ms) => delays.push(ms),
    runCommand() {
      calls.push(true)
      return { status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' }
    },
  }), /Run gh auth login/)

  assert.equal(calls.length, 1)
  assert.deepEqual(delays, [])
})

test('runGh allowFailure retries then returns command detail', () => {
  const calls = []
  const result = runGh(['pr', 'list'], {
    allowFailure: true,
    attempts: 2,
    delayMs: 0,
    runCommand() {
      calls.push(true)
      return { status: 1, stdout: '', stderr: 'HTTP 503: unavailable' }
    },
  })

  assert.equal(calls.length, 2)
  assert.equal(result.status, 1)
  assert.equal(result.detail, 'HTTP 503: unavailable')
})

test('isGitHubAuthError recognizes common gh auth messages', () => {
  assert.equal(isGitHubAuthError('HTTP 401: Bad credentials'), true)
  assert.equal(isGitHubAuthError('run gh auth login to authenticate'), true)
  assert.equal(isGitHubAuthError('HTTP 502: gateway'), false)
})

test('assertGhAuthenticated caches successful auth checks for the process', () => {
  resetGhAuthCache()
  const calls = []

  assertGhAuthenticated({
    runCommand(command, args) {
      calls.push({ command, args })
      return { status: 0, stdout: 'github.com\n', stderr: '' }
    },
  })
  assertGhAuthenticated({
    runCommand(command, args) {
      calls.push({ command, args })
      return { status: 1, stdout: '', stderr: 'should not run' }
    },
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['auth', 'status'])
  resetGhAuthCache()
})
