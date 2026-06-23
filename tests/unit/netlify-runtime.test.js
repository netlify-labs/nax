const test = require('node:test')
const assert = require('node:assert/strict')

const { classifyNetlifyRuntime, isNetlifyAgentRunner, isTruthy } = require('../../src/netlify/runtime')
const { handleCi } = require('../../src/cli/ci')

test('classifyNetlifyRuntime detects local environments', () => {
  assert.deepEqual(classifyNetlifyRuntime({}), {
    label: 'local',
    isNetlify: false,
    isNetlifyBuild: false,
    isAgentRunner: false,
    reason: 'NETLIFY is not set',
  })
})

test('classifyNetlifyRuntime detects Netlify build CI with deploy metadata', () => {
  const runtime = classifyNetlifyRuntime({
    NETLIFY: 'true',
    CONTEXT: 'production',
    BUILD_ID: 'build-1',
  })

  assert.equal(runtime.label, 'netlify-build')
  assert.equal(runtime.isNetlifyBuild, true)
  assert.equal(runtime.isAgentRunner, false)
  assert.match(runtime.reason, /build\/deploy metadata/)
})

test('classifyNetlifyRuntime detects Netlify agent runners', () => {
  const env = {
    NETLIFY: 'true',
    CONTEXT: 'dev-server',
  }

  const runtime = classifyNetlifyRuntime(env)
  assert.equal(runtime.label, 'agent-runner')
  assert.equal(runtime.isNetlify, true)
  assert.equal(runtime.isNetlifyBuild, false)
  assert.equal(runtime.isAgentRunner, true)
  assert.equal(isNetlifyAgentRunner(env), true)
})

test('classifyNetlifyRuntime treats unknown Netlify contexts as build CI', () => {
  const runtime = classifyNetlifyRuntime({
    NETLIFY: 'true',
    CONTEXT: 'deploy-preview',
  })

  assert.equal(runtime.label, 'netlify-build')
  assert.equal(runtime.isNetlifyBuild, true)
  assert.equal(runtime.isAgentRunner, false)
})

test('isTruthy accepts Netlify-style truthy values only', () => {
  assert.equal(isTruthy(true), true)
  assert.equal(isTruthy('true'), true)
  assert.equal(isTruthy('1'), true)
  assert.equal(isTruthy('TRUE'), false)
  assert.equal(isTruthy('0'), false)
})

test('handleCi skips command outside Netlify agent runners', () => {
  const calls = []
  const logs = []
  const result = handleCi(['npm test'], {}, {
    env: {},
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 0 }
    },
    log(message) {
      logs.push(message)
    },
  })

  assert.equal(result.skipped, true)
  assert.equal(result.status, 0)
  assert.deepEqual(calls, [])
  assert.match(logs[0], /nax ci: skipped npm test/)
})

test('handleCi runs shell command inside Netlify agent runners', () => {
  const calls = []
  const result = handleCi(['npm test && npm run build'], {}, {
    cwd: '/tmp/project',
    env: { NETLIFY: 'true', CONTEXT: 'dev-server' },
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return { status: 7, signal: null }
    },
    log() {},
  })

  assert.equal(result.skipped, false)
  assert.equal(result.status, 7)
  assert.equal(calls[0].command, 'npm test && npm run build')
  assert.deepEqual(calls[0].args, [])
  assert.equal(calls[0].options.cwd, '/tmp/project')
  assert.equal(calls[0].options.shell, true)
  assert.equal(calls[0].options.stdio, 'inherit')
})
