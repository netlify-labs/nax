const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { resolveGitHubToken } = require('./github-token')
const { homeDir, tildify } = require('./paths')
const { runFile } = require('./process')

const TOKEN_VAR = 'NETLIFY_AGENT_INIT_GIT_TOKEN'

/**
 * A GIT_ASKPASS helper that answers git's prompts from the environment, so the
 * token never appears in a command line, a remote URL or .git/config.
 * @param {string} dir
 */
function writeAskpass(dir) {
  const file = path.join(dir, 'askpass.sh')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'case "$1" in',
    '  Username*) echo x-access-token ;;',
    `  *) printf '%s' "$${TOKEN_VAR}" ;;`,
    'esac',
    '',
  ].join('\n'), { mode: 0o700 })
  return file
}

/** @param {string} ref */
function isSha(ref) {
  return /^[0-9a-f]{40}$/i.test(ref)
}

/**
 * Shallow-clones one repository outside the working tree.
 * @param {import('./config').RepositorySpec} spec
 * @param {{ env?: NodeJS.ProcessEnv, runFile?: import('./process').RunFile, baseUrl?: string, dryRun?: boolean }} [options]
 * @returns {import('./record').SetupStep}
 */
function cloneRepository(spec, { env = process.env, runFile: run = runFile, baseUrl = 'https://github.com', dryRun = false } = {}) {
  const started = Date.now()
  const [owner, name] = spec.repo.split('/')
  const dest = spec.path
    ? path.resolve(spec.path.replace(/^~(?=$|\/)/, homeDir(env)))
    : path.join(homeDir(env), 'repos', owner, name)
  const base = { kind: 'repository', repo: spec.repo, ref: spec.ref || null, path: tildify(dest, env) }

  if (fs.existsSync(path.join(dest, '.git'))) return { ...base, status: 'exists', ms: Date.now() - started }
  if (dryRun) return { ...base, status: 'would-clone' }

  const { token, tried } = resolveGitHubToken(spec.auth, env)
  if (spec.auth?.env && !token) {
    return { ...base, status: 'error', error: `${spec.auth.env} is not set, so ${spec.repo} can't be cloned` }
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'netlify-agent-init-git-'))
  try {
    /** @type {NodeJS.ProcessEnv} */
    const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0' }
    if (token) {
      gitEnv.GIT_ASKPASS = writeAskpass(work)
      gitEnv[TOKEN_VAR] = token.value
    }
    const url = `${baseUrl}/${owner}/${name}.git`
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    /** @type {import('./process').ProcessResult} */
    let result
    if (spec.ref && isSha(spec.ref)) {
      result = run('git', ['init', '--quiet', dest], { env: gitEnv })
      if (result.status === 0) result = run('git', ['remote', 'add', 'origin', url], { cwd: dest, env: gitEnv })
      if (result.status === 0) result = run('git', ['fetch', '--quiet', '--depth', '1', 'origin', spec.ref], { cwd: dest, env: gitEnv })
      if (result.status === 0) result = run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: dest, env: gitEnv })
    } else {
      const args = ['clone', '--quiet', '--depth', '1']
      if (spec.ref) args.push('--branch', spec.ref)
      args.push(url, dest)
      result = run('git', args, { env: gitEnv })
    }

    if (result.status !== 0) {
      fs.rmSync(dest, { recursive: true, force: true })
      const hint = token ? ` (check ${token.name} can read ${spec.repo})` : ` (private repo? set one of ${tried.join(', ')})`
      return { ...base, status: 'error', error: `git could not clone ${spec.repo}${hint}: ${result.stderr.trim().split('\n').pop()}`, token: token ? token.name : null }
    }
    return { ...base, status: 'cloned', token: token ? token.name : null, ms: Date.now() - started }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

module.exports = {
  TOKEN_VAR,
  cloneRepository,
  writeAskpass,
}
