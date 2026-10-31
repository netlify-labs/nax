const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { normalizeConfig } = require('../src/config')
const { MARKER, installFiles } = require('../src/files')
const { install } = require('../src/install')
const { readRecord } = require('../src/record')
const { SETUP_ENV, git, makeEnv, makeRepo, tempDir } = require('./helpers')

const HIDDEN = 'https://brand.example.com/k9Xq2secretpath/acme-brand.zip'

/** A folder of brand files. */
function brandDir() {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'BRAND.md'), '# Acme brand\n')
  fs.writeFileSync(path.join(dir, 'brand.json'), '{ "name": "Acme" }\n')
  fs.writeFileSync(path.join(dir, 'assets', 'logo.svg'), '<svg/>\n')
  return dir
}

/** @param {string} dir */
function zipOf(dir) {
  const out = path.join(tempDir(), 'out.zip')
  execFileSync('zip', ['-q', '-r', out, '.'], { cwd: dir })
  return fs.readFileSync(out)
}

/** @param {Buffer} body */
function fakeFetch(body) {
  /** @type {string[]} */
  const urls = []
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input) => {
    urls.push(String(input))
    return new Response(body, { status: 200 })
  }
  return { fetch, urls }
}

test('config: files need a source and a folder inside the repo', () => {
  const ok = normalizeConfig({ files: [{ from: { env: 'BRAND_ZIP_URL' }, to: 'context/brand/', optional: true }] }, 'test')
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.config.files, [{ from: { env: 'BRAND_ZIP_URL' }, to: 'context/brand', path: undefined, registry: undefined, auth: undefined, optional: true }])

  for (const to of ['/etc/brand', '../outside', 'a/../../b', '.git/hooks', '.', '']) {
    const { errors } = normalizeConfig({ files: [{ from: './brand', to }] }, 'test')
    assert.match(errors.join('\n'), /must be a folder inside the repo/, `to: ${JSON.stringify(to)}`)
  }
  assert.match(normalizeConfig({ files: [{ from: 'ftp://x/y.zip', to: 'b' }] }, 'test').errors.join('\n'), /must start with/)
  assert.match(normalizeConfig({ files: [{ from: { nope: 1 }, to: 'b' }] }, 'test').errors.join('\n'), /from must be a source/)
})

test('a local folder fills an untracked folder, with a marker, and replaces its own earlier copy', async () => {
  const repo = makeRepo()
  const src = brandDir()
  const entry = { from: src, to: 'context/brand', optional: false }
  const first = await installFiles(entry, { cwd: repo, env: makeEnv() })
  assert.equal(first.step.status, 'ok')
  assert.equal(first.step.files, 3)
  assert.equal(fs.readFileSync(path.join(repo, 'context/brand/BRAND.md'), 'utf8'), '# Acme brand\n')
  assert.equal(fs.existsSync(path.join(repo, 'context/brand', MARKER)), true)

  fs.rmSync(path.join(src, 'assets'), { recursive: true })
  const second = await installFiles(entry, { cwd: repo, env: makeEnv() })
  assert.equal(second.step.status, 'ok')
  assert.equal(fs.existsSync(path.join(repo, 'context/brand/assets')), false, 'stale files from the earlier copy are gone')
})

test('an env source is skipped when optional and unset, and an error when required', async () => {
  const repo = makeRepo()
  const optional = await installFiles({ from: { env: 'BRAND_ZIP_URL' }, to: 'context/brand', optional: true }, { cwd: repo, env: makeEnv() })
  assert.deepEqual([optional.step.status, optional.step.reason], ['skipped', 'BRAND_ZIP_URL is not set'])
  assert.equal(fs.existsSync(path.join(repo, 'context/brand')), false)

  const required = await installFiles({ from: { env: 'BRAND_ZIP_URL' }, to: 'context/brand', optional: false }, { cwd: repo, env: makeEnv() })
  assert.deepEqual([required.step.status, required.step.error], ['error', 'BRAND_ZIP_URL is not set'])

  const bad = await installFiles({ from: { env: 'BRAND_ZIP_URL' }, to: 'b', optional: true }, { cwd: repo, env: makeEnv({ BRAND_ZIP_URL: 'http://x.example/a.zip' }) })
  assert.match(String(bad.step.error), /use an https:\/\/ URL/)
})

test('a zip from an env URL installs, and the record shows the variable and host but not the secret path', async () => {
  const repo = makeRepo()
  const { fetch, urls } = fakeFetch(zipOf(brandDir()))
  const env = makeEnv({ BRAND_ZIP_URL: HIDDEN })
  const result = await installFiles({ from: { env: 'BRAND_ZIP_URL' }, to: 'context/brand', optional: true }, { cwd: repo, env, sources: { fetch } })
  assert.equal(result.step.status, 'ok')
  assert.deepEqual(urls, [HIDDEN])
  assert.equal(result.step.from, '$BRAND_ZIP_URL (https://brand.example.com/…/acme-brand.zip)')
  assert.equal(fs.existsSync(path.join(repo, 'context/brand/assets/logo.svg')), true)
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'context/brand', MARKER), 'utf8'), /k9Xq2secretpath/)
})

test('never writes into a folder git tracks, or one it did not create', async () => {
  const repo = makeRepo({ 'context/BRAND.md': '# neutral\n' })
  const tracked = await installFiles({ from: brandDir(), to: 'context', optional: false }, { cwd: repo, env: makeEnv() })
  assert.match(String(tracked.step.error), /git tracks files in context/)
  assert.equal(fs.readFileSync(path.join(repo, 'context/BRAND.md'), 'utf8'), '# neutral\n')

  fs.mkdirSync(path.join(repo, 'mine'))
  fs.writeFileSync(path.join(repo, 'mine/notes.md'), 'keep\n')
  const theirs = await installFiles({ from: brandDir(), to: 'mine', optional: false }, { cwd: repo, env: makeEnv() })
  assert.match(String(theirs.step.error), /wasn't created by netlify-agent-kit/)
  assert.equal(fs.readFileSync(path.join(repo, 'mine/notes.md'), 'utf8'), 'keep\n')
})

test('install fills the folder, hides it from git and lists it in the guide', async () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: 'x', netlifyAgent: { files: [{ from: { env: 'BRAND_ZIP_URL' }, to: 'context/brand', optional: true }] } }),
  })
  const { fetch } = fakeFetch(zipOf(brandDir()))
  const env = makeEnv({ ...SETUP_ENV, BRAND_ZIP_URL: HIDDEN })
  const { exitCode } = await install({ cwd: repo, env, log: () => {}, deps: { sources: { fetch } } })
  assert.equal(exitCode, 0)
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'nothing installed shows up in git status')
  const guide = fs.readFileSync(path.join(repo, '.claude/skills/netlify-agent-kit/SKILL.md'), 'utf8')
  assert.match(guide, /Folders filled for this run, hidden from git: `context\/brand\/`/)
  const record = readRecord(env)
  const step = record?.steps.find((s) => s.kind === 'files')
  assert.equal(step?.status, 'ok')
  assert.doesNotMatch(JSON.stringify(record), /k9Xq2secretpath/)
})

test('install without the variable leaves the repo as it was', async () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: 'x', netlifyAgent: { files: [{ from: { env: 'BRAND_ZIP_URL' }, to: 'context/brand', optional: true }] } }),
  })
  const env = makeEnv(SETUP_ENV)
  const { exitCode } = await install({ cwd: repo, env, log: () => {} })
  assert.equal(exitCode, 0)
  assert.equal(fs.existsSync(path.join(repo, 'context/brand')), false)
  const guide = fs.readFileSync(path.join(repo, '.claude/skills/netlify-agent-kit/SKILL.md'), 'utf8')
  assert.doesNotMatch(guide, /Folders filled/)
})
