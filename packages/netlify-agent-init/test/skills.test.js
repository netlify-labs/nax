const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const test = require('node:test')

const { runFile } = require('../src/process')
const { installSkills, isOurInstall, stampFrontmatter } = require('../src/skills/install')
const { buildNpmrc, resolveSource } = require('../src/skills/sources')
const { makeEnv, makeRepo, tempDir, writeSkill } = require('./helpers')

test('installs named skills from a local source into .claude/skills and .agents/skills, stamped', () => {
  const source = tempDir()
  writeSkill(source, 'alpha')
  writeSkill(source, 'beta')
  const repo = makeRepo()
  const env = makeEnv()
  const result = installSkills({ sourceDir: source, from: './skills', names: ['alpha'], cwd: repo, env })
  assert.deepEqual(result.installed, ['alpha'])
  assert.deepEqual(result.targets, ['.claude/skills', '.agents/skills'])
  for (const target of result.targets) {
    const skill = path.join(repo, target, 'alpha')
    assert.equal(fs.existsSync(path.join(skill, 'references', 'notes.md')), true)
    assert.equal(isOurInstall(skill), true)
  }
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'skills', 'beta')), false)
})

test('a source folder with its own SKILL.md is one skill', async () => {
  const parent = tempDir()
  const single = writeSkill(parent, 'style-guide')
  const resolved = await resolveSource({ from: single }, { cwd: parent })
  const repo = makeRepo()
  const result = installSkills({ sourceDir: resolved.dir, from: single, cwd: repo, env: makeEnv() })
  assert.deepEqual(result.installed, ['style-guide'])
})

test('never installs over a committed skill or a user-level ~/.claude/skills skill', () => {
  const source = tempDir()
  writeSkill(source, 'committed')
  writeSkill(source, 'preinstalled')
  const repo = makeRepo()
  writeSkill(path.join(repo, '.claude', 'skills'), 'committed', 'ours')
  const env = makeEnv()
  writeSkill(path.join(env.HOME, '.claude', 'skills'), 'preinstalled')
  const result = installSkills({ sourceDir: source, from: 'x', cwd: repo, env })
  assert.deepEqual(result.installed, [])
  assert.deepEqual(result.skipped.map((s) => s.reason), ['already in .claude/skills', 'already in ~/.claude/skills'])
  assert.match(fs.readFileSync(path.join(repo, '.claude', 'skills', 'committed', 'SKILL.md'), 'utf8'), /ours/)
  assert.equal(fs.existsSync(path.join(repo, '.agents', 'skills', 'committed')), false)
})

test('a second run recognises its own installs and still reports their paths', () => {
  const source = tempDir()
  writeSkill(source, 'alpha')
  const repo = makeRepo()
  const env = makeEnv()
  installSkills({ sourceDir: source, from: 'x', cwd: repo, env })
  const again = installSkills({ sourceDir: source, from: 'x', cwd: repo, env })
  assert.deepEqual(again.installed, [])
  assert.equal(again.skipped[0].reason, 'already installed by an earlier setup run')
  assert.equal(again.createdPaths.length, 2)
})

test('also installs into other agent folders that already exist in the repo, and reports missing names', () => {
  const source = tempDir()
  writeSkill(source, 'alpha')
  const repo = makeRepo()
  fs.mkdirSync(path.join(repo, '.codex'))
  const result = installSkills({ sourceDir: source, from: 'x', names: ['alpha', 'ghost'], cwd: repo, env: makeEnv() })
  assert.deepEqual(result.targets, ['.claude/skills', '.agents/skills', '.codex/skills'])
  assert.deepEqual(result.missing, ['ghost'])
})

test('stampFrontmatter adds installed-by and source once', () => {
  const once = stampFrontmatter('---\nname: a\n---\nbody\n', 'npm:x@1.0.0')
  const twice = stampFrontmatter(once, 'npm:x@1.0.0')
  assert.equal(twice, once)
  assert.match(once, /installed-by: netlify-agent-init\nsource: "npm:x@1\.0\.0"\n---\nbody/)
})

test('npm sources use a throwaway .npmrc that names the variable, never the token', async () => {
  const fixture = tempDir()
  writeSkill(path.join(fixture, 'skills'), 'remote-skill')
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: '@acme/agent-skills', version: '2.1.0' }))
  const tarballDir = tempDir()
  const [info] = JSON.parse(execFileSync('npm', ['pack', fixture, '--json', '--pack-destination', tarballDir], { encoding: 'utf8' }))

  /** @type {{ npmrc?: string, userconfig?: string }} */
  const seen = {}
  /** @type {import('../src/process').RunFile} */
  const fakeRun = (command, args, options) => {
    if (command === 'npm') {
      seen.userconfig = options.env.npm_config_userconfig
      seen.npmrc = fs.readFileSync(seen.userconfig, 'utf8')
      const dest = args[args.indexOf('--pack-destination') + 1]
      fs.copyFileSync(path.join(tarballDir, info.filename), path.join(dest, info.filename))
      return { status: 0, stdout: JSON.stringify([{ filename: info.filename }]), stderr: '' }
    }
    return runFile(command, args, options)
  }

  const env = { ...makeEnv(), ACME_NPM_TOKEN: 'npm_SECRETVALUE' }
  const resolved = await resolveSource(
    { from: 'npm:@acme/agent-skills@2.1.0', path: 'skills', registry: 'https://npm.pkg.github.com', auth: { env: 'ACME_NPM_TOKEN' } },
    { env, runFile: fakeRun },
  )
  assert.equal(fs.existsSync(path.join(resolved.dir, 'remote-skill', 'SKILL.md')), true)
  assert.equal(seen.npmrc, '@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${ACME_NPM_TOKEN}\n')
  assert.equal(seen.npmrc.includes('SECRETVALUE'), false)
  assert.equal(resolved.tokenEnv, 'ACME_NPM_TOKEN')
  resolved.cleanup()
  assert.equal(fs.existsSync(seen.userconfig), false)
})

test('npm sources fail clearly when the named variable is missing', async () => {
  await assert.rejects(
    resolveSource({ from: 'npm:@acme/x@1.0.0', auth: { env: 'NOPE_TOKEN' } }, { env: makeEnv() }),
    /NOPE_TOKEN is not set/,
  )
})

test('buildNpmrc without a registry only adds the auth line', () => {
  assert.equal(buildNpmrc({ packageName: 'x', tokenEnv: 'T' }), '//registry.npmjs.org/:_authToken=${T}\n')
})

/**
 * Serves a GitHub-style tarball. Records each request's URL and Authorization header.
 * @returns {Promise<{ base: string, requests: { url: string, auth: string | undefined }[], close: () => void }>}
 */
function startGitHubStub() {
  const root = tempDir()
  writeSkill(path.join(root, 'acme-skills-abc123', 'skills'), 'gh-skill')
  const archive = path.join(tempDir(), 'source.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', root, 'acme-skills-abc123'])
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization })
    const isApi = req.url.startsWith('/api/repos/')
    if (isApi && req.headers.authorization !== 'Bearer ghp_SECRETVALUE') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/gzip' })
    fs.createReadStream(archive).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
      resolve({ base: `http://127.0.0.1:${port}`, requests, close: () => server.close() })
    })
  })
}

test('private GitHub sources send the token only in the Authorization header', async () => {
  const stub = await startGitHubStub()
  try {
    const env = { ...makeEnv(), ACME_GH_TOKEN: 'ghp_SECRETVALUE' }
    const resolved = await resolveSource(
      { from: 'github:acme/skills#9f3c2e1', path: 'skills', auth: { env: 'ACME_GH_TOKEN' } },
      { env, githubApiBase: `${stub.base}/api`, codeloadBase: `${stub.base}/codeload` },
    )
    assert.equal(fs.existsSync(path.join(resolved.dir, 'gh-skill', 'SKILL.md')), true)
    assert.equal(resolved.tokenEnv, 'ACME_GH_TOKEN')
    assert.equal(stub.requests[0].url, '/api/repos/acme/skills/tarball/9f3c2e1')
    assert.equal(stub.requests[0].auth, 'Bearer ghp_SECRETVALUE')
    assert.equal(stub.requests.some((r) => r.url.includes('SECRETVALUE')), false)
    resolved.cleanup()
  } finally {
    stub.close()
  }
})

test('public GitHub sources use codeload without a token, and the default token chain applies', async () => {
  const stub = await startGitHubStub()
  try {
    const opts = { githubApiBase: `${stub.base}/api`, codeloadBase: `${stub.base}/codeload` }
    const pub = await resolveSource({ from: 'github:acme/skills#v1.0.0', path: 'skills' }, { env: makeEnv(), ...opts })
    assert.equal(stub.requests[0].url, '/codeload/acme/skills/tar.gz/v1.0.0')
    assert.equal(stub.requests[0].auth, undefined)
    pub.cleanup()

    const viaDefault = await resolveSource({ from: 'github:acme/skills#v1.0.0', path: 'skills' }, { env: { ...makeEnv(), GH_TOKEN: 'ghp_SECRETVALUE' }, ...opts })
    assert.equal(viaDefault.tokenEnv, 'GH_TOKEN')
    viaDefault.cleanup()
  } finally {
    stub.close()
  }
})

test('a rejected GitHub token names the variable, not the value', async () => {
  const stub = await startGitHubStub()
  try {
    const env = { ...makeEnv(), ACME_GH_TOKEN: 'wrong-SECRETVALUE' }
    await assert.rejects(
      resolveSource({ from: 'github:acme/skills#v1', auth: { env: 'ACME_GH_TOKEN' } }, { env, githubApiBase: `${stub.base}/api` }),
      /** @param {Error} error */ (error) => /GitHub returned 404.*check ACME_GH_TOKEN/.test(error.message) && !error.message.includes('SECRETVALUE'),
    )
  } finally {
    stub.close()
  }
})
