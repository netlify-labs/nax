const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { cloneRepository, writeAskpass } = require('../src/repositories')
const { git, makeEnv, makeRepo, tempDir } = require('./helpers')

/** Creates <base>/acme/tokens.git with a v1.0.0 tag. */
function makeRemote() {
  const source = makeRepo({ 'tokens.json': '{"color":"teal"}\n' })
  git(source, ['tag', 'v1.0.0'])
  const sha = git(source, ['rev-parse', 'HEAD']).trim()
  const base = tempDir()
  fs.mkdirSync(path.join(base, 'acme'))
  git(base, ['clone', '--quiet', '--bare', source, path.join(base, 'acme', 'tokens.git')])
  return { base: `file://${base}`, sha }
}

test('clones a tag into ~/repos/<owner>/<name>, outside the working tree', () => {
  const { base } = makeRemote()
  const env = makeEnv()
  const step = cloneRepository({ repo: 'acme/tokens', ref: 'v1.0.0' }, { env, baseUrl: base })
  assert.equal(step.status, 'cloned')
  assert.equal(step.path, '~/repos/acme/tokens')
  assert.equal(fs.existsSync(path.join(env.HOME, 'repos', 'acme', 'tokens', 'tokens.json')), true)
  assert.equal(cloneRepository({ repo: 'acme/tokens', ref: 'v1.0.0' }, { env, baseUrl: base }).status, 'exists')
})

test('clones an exact commit SHA', () => {
  const { base, sha } = makeRemote()
  const env = makeEnv()
  const step = cloneRepository({ repo: 'acme/tokens', ref: sha, path: '~/ref/tokens' }, { env, baseUrl: base })
  assert.equal(step.status, 'cloned', String(step.error))
  assert.equal(git(path.join(env.HOME, 'ref', 'tokens'), ['rev-parse', 'HEAD']).trim(), sha)
})

test('the token stays out of the remote URL and .git/config; failures name the variable', () => {
  const { base } = makeRemote()
  const env = { ...makeEnv(), ACME_TOKEN: 'ghp_SECRETVALUE' }
  const step = cloneRepository({ repo: 'acme/tokens', ref: 'v1.0.0', auth: { env: 'ACME_TOKEN' } }, { env, baseUrl: base })
  assert.equal(step.status, 'cloned')
  assert.equal(step.token, 'ACME_TOKEN')
  const config = fs.readFileSync(path.join(env.HOME, 'repos', 'acme', 'tokens', '.git', 'config'), 'utf8')
  assert.equal(config.includes('SECRETVALUE'), false)
  assert.equal(JSON.stringify(step).includes('SECRETVALUE'), false)

  const missing = cloneRepository({ repo: 'acme/other', auth: { env: 'NOT_SET' } }, { env: makeEnv(), baseUrl: base })
  assert.equal(missing.status, 'error')
  assert.match(String(missing.error), /NOT_SET is not set/)

  const bad = cloneRepository({ repo: 'acme/nope', ref: 'v1' }, { env: makeEnv(), baseUrl: base })
  assert.equal(bad.status, 'error')
  assert.match(String(bad.error), /private repo\? set one of NETLIFY_AGENT_INIT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN/)
})

test('the askpass helper reads the token from the environment and never contains it', () => {
  const dir = tempDir()
  const file = writeAskpass(dir)
  const content = fs.readFileSync(file, 'utf8')
  assert.match(content, /NETLIFY_AGENT_INIT_GIT_TOKEN/)
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '700')
})
