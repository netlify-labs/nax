const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { displaySource, normalizeConfig } = require('../src/config')
const { install } = require('../src/install')
const { readRecord } = require('../src/record')
const { resolveSource } = require('../src/skills/sources')
const { SETUP_ENV, git, makeEnv, makeRepo, tempDir, writeSkill } = require('./helpers')

const HIDDEN = 'https://skills.example.com/s/k9Xq2secretpath/gtm-skills.zip'

/**
 * Zips a folder's contents, the way `zip -r` from inside it would.
 * @param {string} dir
 */
function zipOf(dir) {
  const out = path.join(tempDir(), 'out.zip')
  execFileSync('zip', ['-q', '-r', out, '.'], { cwd: dir })
  return fs.readFileSync(out)
}

/**
 * A fetch that serves one archive and records each request.
 * @param {Buffer} body
 * @param {number} [status]
 */
function fakeFetch(body, status = 200) {
  /** @type {Array<{ url: string, auth: string | undefined }>} */
  const requests = []
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init) => {
    const headers = /** @type {Record<string, string>} */ (init?.headers || {})
    requests.push({ url: String(input), auth: headers.Authorization })
    return new Response(status === 200 ? body : null, { status })
  }
  return { fetch, requests }
}

test('a zip of skill folders installs each skill', async () => {
  const src = tempDir()
  writeSkill(src, 'using-gtm-platform')
  writeSkill(src, 'building-on-gtm-services')
  const { fetch } = fakeFetch(zipOf(src))
  const resolved = await resolveSource({ from: HIDDEN }, { env: makeEnv(), fetch })
  assert.deepEqual(fs.readdirSync(resolved.dir).sort(), ['building-on-gtm-services', 'using-gtm-platform'])
  resolved.cleanup()
  assert.equal(fs.existsSync(resolved.dir), false)
})

test('a zip with SKILL.md at its root is one skill named after the file', async () => {
  const src = tempDir()
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: house-style\ndescription: x\n---\nBody.\n')
  const { fetch } = fakeFetch(zipOf(src))
  const resolved = await resolveSource({ from: 'https://example.com/files/house-style.skill' }, { env: makeEnv(), fetch })
  assert.equal(fs.existsSync(path.join(resolved.dir, 'house-style', 'SKILL.md')), true)
  resolved.cleanup()
})

test('auth sends a bearer token, and failures name the host and file but not the path or token', async () => {
  const src = tempDir()
  writeSkill(src, 'alpha')
  const ok = fakeFetch(zipOf(src))
  const env = { ...makeEnv(), SKILLS_TOKEN: 'tok-SECRETVALUE' }
  const resolved = await resolveSource({ from: HIDDEN, auth: { env: 'SKILLS_TOKEN' } }, { env, fetch: ok.fetch })
  assert.equal(ok.requests[0].auth, 'Bearer tok-SECRETVALUE')
  resolved.cleanup()

  const missing = fakeFetch(Buffer.alloc(0), 404)
  await assert.rejects(
    resolveSource({ from: HIDDEN }, { env: makeEnv(), fetch: missing.fetch }),
    /** @param {Error} error */ (error) => error.message === 'https://skills.example.com/…/gtm-skills.zip returned 404',
  )
})

test('config accepts https zip URLs, rejects http, and logs only the host and file', () => {
  assert.deepEqual(normalizeConfig({ skills: [{ from: HIDDEN }] }, 'test').errors, [])
  const { errors } = normalizeConfig({ skills: [{ from: 'http://skills.example.com/s/k9Xq2secretpath/a.zip' }] }, 'test')
  assert.match(errors.join('\n'), /use an https:\/\/ URL/)
  assert.equal(errors.join('\n').includes('k9Xq2secretpath'), false)
  assert.equal(displaySource(HIDDEN), 'https://skills.example.com/…/gtm-skills.zip')
  assert.equal(displaySource('npm:hyperframes@0.8.217'), 'npm:hyperframes@0.8.217')
})

/**
 * A committed repo whose only config is one skills entry.
 * @param {Record<string, unknown>} entry
 */
function repoWithSkills(entry) {
  const repo = makeRepo()
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ private: true, netlifyAgent: { skills: [entry] } }))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'config'])
  return repo
}

test('config accepts an env source for skills and rejects a malformed one', () => {
  const ok = normalizeConfig({ skills: [{ from: { env: 'TEAM_SKILLS_ZIP_URL' }, optional: true, names: ['alpha'] }] }, 'test')
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.warnings, [])
  assert.deepEqual(ok.config.skills, [{ from: { env: 'TEAM_SKILLS_ZIP_URL' }, path: undefined, names: ['alpha'], registry: undefined, auth: undefined, optional: true }])
  assert.equal('optional' in normalizeConfig({ skills: [{ from: './skills' }] }, 'test').config.skills[0], false)
  for (const from of [{ nope: 1 }, { env: '' }, 7, null]) {
    assert.match(normalizeConfig({ skills: [{ from }] }, 'test').errors.join('\n'), /skills\[0\]\.from is required/, JSON.stringify(from))
  }
})

test('skills from an env URL install, and the logs, record and skills name the variable and host but not the secret path', async () => {
  const src = tempDir()
  writeSkill(src, 'house-style')
  writeSkill(src, 'api-rules')
  const { fetch, requests } = fakeFetch(zipOf(src))
  const repo = repoWithSkills({ from: { env: 'TEAM_SKILLS_ZIP_URL' }, optional: true })
  const env = { ...makeEnv(), ...SETUP_ENV, TEAM_SKILLS_ZIP_URL: HIDDEN }
  /** @type {string[]} */
  const lines = []
  const { record } = await install({ cwd: repo, env, log: (line) => lines.push(line), deps: { sources: { fetch } } })
  assert.deepEqual(record.errors, [])
  assert.deepEqual(requests.map((request) => request.url), [HIDDEN])
  const step = record.steps.find((s) => s.kind === 'skills')
  assert.equal(step.from, '$TEAM_SKILLS_ZIP_URL (https://skills.example.com/…/gtm-skills.zip)')
  assert.deepEqual(step.installed, ['api-rules', 'house-style'])
  assert.equal(record.steps.some((s) => s.kind === 'secrets'), false, 'an optional source is not a required secret')
  const installed = fs.readFileSync(path.join(repo, '.agents', 'skills', 'house-style', 'SKILL.md'), 'utf8')
  assert.match(installed, /source: "\$TEAM_SKILLS_ZIP_URL \(https:\/\/skills\.example\.com\/…\/gtm-skills\.zip\)"/)
  const guide = fs.readFileSync(path.join(repo, '.claude', 'skills', 'netlify-agent-kit', 'SKILL.md'), 'utf8')
  assert.match(guide, /`api-rules`, `house-style`/)
  for (const text of [installed, guide, lines.join('\n'), JSON.stringify(readRecord(env))]) {
    assert.equal(text.includes('k9Xq2secretpath'), false)
  }
  assert.equal(git(repo, ['status', '--porcelain']), '')
})

test('an unset env source for skills is skipped when optional, and an error when required', async () => {
  const never = async () => { throw new Error('no request expected') }
  const optionalRepo = repoWithSkills({ from: { env: 'TEAM_SKILLS_ZIP_URL' }, optional: true })
  const optional = await install({ cwd: optionalRepo, env: { ...makeEnv(), ...SETUP_ENV }, log: () => {}, deps: { sources: { fetch: never } } })
  const skipped = optional.record.steps.find((s) => s.kind === 'skills')
  assert.deepEqual([skipped.status, skipped.reason, skipped.from], ['skipped', 'TEAM_SKILLS_ZIP_URL is not set', '$TEAM_SKILLS_ZIP_URL'])
  assert.deepEqual(optional.record.errors, [])
  assert.deepEqual(optional.record.warnings, [])
  assert.equal(git(optionalRepo, ['status', '--porcelain']), '')

  const requiredRepo = repoWithSkills({ from: { env: 'TEAM_SKILLS_ZIP_URL' } })
  const required = await install({ cwd: requiredRepo, env: { ...makeEnv(), ...SETUP_ENV }, log: () => {}, deps: { sources: { fetch: never } } })
  assert.deepEqual(required.record.errors, ['skills $TEAM_SKILLS_ZIP_URL: TEAM_SKILLS_ZIP_URL is not set'])
  assert.deepEqual(required.record.steps.find((s) => s.kind === 'secrets').missing, ['TEAM_SKILLS_ZIP_URL'])
  assert.equal(required.exitCode, 0)
})

test('an env source for skills holding an unusable value fails without printing it', async () => {
  const repo = repoWithSkills({ from: { env: 'TEAM_SKILLS_ZIP_URL' } })
  const env = { ...makeEnv(), ...SETUP_ENV, TEAM_SKILLS_ZIP_URL: 'http://skills.example.com/s/k9Xq2secretpath/a.zip' }
  const { record } = await install({ cwd: repo, env, log: () => {}, deps: { sources: { fetch: async () => { throw new Error('no request expected') } } } })
  assert.deepEqual(record.errors, ['skills $TEAM_SKILLS_ZIP_URL (http://skills.example.com/…/a.zip): $TEAM_SKILLS_ZIP_URL: use an https:// URL to a .zip'])
  assert.equal(JSON.stringify(record).includes('k9Xq2secretpath'), false)
})

test('install from a zip URL keeps the secret path out of the record, the skills and git', async () => {
  const src = tempDir()
  writeSkill(src, 'using-gtm-platform')
  const { fetch } = fakeFetch(zipOf(src))
  const repo = makeRepo()
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ private: true, netlifyAgent: { skills: [{ from: HIDDEN }] } }))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'config'])
  const env = { ...makeEnv(), ...SETUP_ENV }
  const { record } = await install({ cwd: repo, env, log: () => {}, deps: { sources: { fetch } } })
  assert.deepEqual(record.errors, [])
  const installed = fs.readFileSync(path.join(repo, '.claude', 'skills', 'using-gtm-platform', 'SKILL.md'), 'utf8')
  assert.match(installed, /installed-by: netlify-agent-kit/)
  assert.equal(installed.includes('k9Xq2secretpath'), false)
  assert.equal(JSON.stringify(readRecord(env)).includes('k9Xq2secretpath'), false)
  assert.equal(git(repo, ['status', '--porcelain']), '')
})
