const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** @param {string} prefix */
function tempDir(prefix = 'nai-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

/**
 * A git repo with one commit.
 * @param {Record<string, string>} [files]
 */
function makeRepo(files = { 'README.md': '# test\n' }) {
  const dir = tempDir('nai-repo-')
  git(dir, ['init', '--quiet', '-b', 'main'])
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '--quiet', '-m', 'init'])
  return dir
}

/**
 * Writes a skill folder.
 * @param {string} dir
 * @param {string} name
 * @param {string} [body]
 */
function writeSkill(dir, name, body = 'Do the thing.') {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`)
  fs.writeFileSync(path.join(skillDir, 'references', 'notes.md'), 'notes\n')
  return skillDir
}

/**
 * An environment with an isolated HOME. ~/.local/bin is on PATH unless onPath is false.
 * @param {Record<string, string>} [extra]
 * @param {{ onPath?: boolean }} [options]
 * @returns {NodeJS.ProcessEnv & { HOME: string, PATH: string }}
 */
function makeEnv(extra = {}, { onPath = true } = {}) {
  const home = tempDir('nai-home-')
  const localBin = path.join(home, '.local', 'bin')
  fs.mkdirSync(localBin, { recursive: true })
  const basePath = process.env.PATH || ''
  return {
    PATH: onPath ? `${localBin}${path.delimiter}${basePath}` : basePath,
    HOME: home,
    ...extra,
  }
}

const SETUP_ENV = { NETLIFY: 'true', CONTEXT: 'dev-server', BUILD_ID: 'b', DEPLOY_ID: 'd', NETLIFY_BUILD_BASE: '/opt/build/repo' }

module.exports = {
  SETUP_ENV,
  git,
  makeEnv,
  makeRepo,
  tempDir,
  writeSkill,
}
