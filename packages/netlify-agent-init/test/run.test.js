const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { run } = require('../src/run')
const { SETUP_ENV, makeEnv } = require('./helpers')

test('run is skipped outside agent runners', () => {
  const calls = []
  const result = run('echo hi', { env: { NETLIFY: 'true', CONTEXT: 'production' }, runShell: (cmd) => { calls.push(cmd); return 0 } })
  assert.equal(result.skipped, true)
  assert.equal(calls.length, 0)
})

test('run executes in agent runners with ~/.local/bin first on PATH and returns the exit code', () => {
  const base = makeEnv()
  const env = { ...base, ...SETUP_ENV }
  /** @type {NodeJS.ProcessEnv} */
  let seenEnv = {}
  const result = run('exit 3', { env, runShell: (_cmd, options) => { seenEnv = options.env; return 3 } })
  assert.equal(result.skipped, false)
  assert.equal(result.exitCode, 3)
  assert.equal(String(seenEnv.PATH).split(path.delimiter)[0], path.join(base.HOME, '.local', 'bin'))
})
