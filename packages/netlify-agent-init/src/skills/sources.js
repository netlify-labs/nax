const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const { parseGitHubSpec, parseNpmSpec } = require('../config')
const { resolveGitHubToken } = require('../github-token')
const { runFile } = require('../process')

/**
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   fetch?: typeof globalThis.fetch,
 *   runFile?: import('../process').RunFile,
 *   githubApiBase?: string,
 *   codeloadBase?: string,
 * }} SourceOptions
 *
 * @typedef {{ dir: string, cleanup: () => void, tokenEnv: string | null }} ResolvedSource
 */

class SourceError extends Error {}

/**
 * The .npmrc for a private registry. It contains the variable's name, which npm
 * expands at run time, so the token is never written to disk.
 * @param {{ packageName: string, registry?: string, tokenEnv?: string }} options
 */
function buildNpmrc({ packageName, registry, tokenEnv }) {
  const lines = []
  const registryUrl = registry || 'https://registry.npmjs.org/'
  if (registry) {
    const scope = packageName.startsWith('@') ? packageName.split('/')[0] : null
    lines.push(scope ? `${scope}:registry=${registryUrl}` : `registry=${registryUrl}`)
  }
  if (tokenEnv) {
    const url = new URL(registryUrl)
    const prefix = `//${url.host}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`
    lines.push(`${prefix}:_authToken=\${${tokenEnv}}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * @param {string} archive
 * @param {string} dest
 * @param {import('../process').RunFile} run
 */
function extractTarball(archive, dest, run) {
  fs.mkdirSync(dest, { recursive: true })
  const result = run('tar', ['-xzf', archive, '-C', dest])
  if (result.status !== 0) throw new SourceError(`could not extract ${path.basename(archive)}: ${result.stderr.trim()}`)
}

/**
 * @param {import('../config').SkillSpec} skill
 * @param {SourceOptions} options
 * @returns {Promise<ResolvedSource>}
 */
async function resolveNpmSource(skill, { env = process.env, runFile: run = runFile }) {
  const spec = parseNpmSpec(skill.from)
  if (!spec) throw new SourceError(`invalid npm source "${skill.from}"`)
  if (skill.auth?.env && !env[skill.auth.env]) {
    throw new SourceError(`${skill.auth.env} is not set, so ${spec.name} can't be downloaded`)
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'netlify-agent-init-npm-'))
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true })
  try {
    const npmrc = path.join(work, '.npmrc')
    fs.writeFileSync(npmrc, buildNpmrc({ packageName: spec.name, registry: skill.registry, tokenEnv: skill.auth?.env }))
    const packEnv = { ...env, npm_config_userconfig: npmrc }
    const packed = run('npm', ['pack', `${spec.name}@${spec.version}`, '--json', '--pack-destination', work], { cwd: work, env: packEnv })
    if (packed.status !== 0) {
      const detail = (packed.stderr || packed.stdout).trim().split('\n').slice(-2).join(' ')
      const hint = skill.auth?.env ? ` (check ${skill.auth.env} can read it)` : ''
      throw new SourceError(`npm pack ${spec.name}@${spec.version} failed${hint}: ${detail}`)
    }
    const [info] = JSON.parse(packed.stdout)
    const extracted = path.join(work, 'extracted')
    extractTarball(path.join(work, info.filename), extracted, run)
    return { dir: path.join(extracted, 'package', skill.path || ''), cleanup, tokenEnv: skill.auth?.env || null }
  } catch (error) {
    cleanup()
    throw error
  }
}

/**
 * Downloads a GitHub tarball. With a token, the API endpoint is used and the token
 * only travels in the Authorization header.
 * @param {import('../config').SkillSpec} skill
 * @param {SourceOptions} options
 * @returns {Promise<ResolvedSource>}
 */
async function resolveGitHubSource(skill, {
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  runFile: run = runFile,
  githubApiBase = 'https://api.github.com',
  codeloadBase = 'https://codeload.github.com',
}) {
  const spec = parseGitHubSpec(skill.from)
  if (!spec) throw new SourceError(`invalid GitHub source "${skill.from}"`)
  const { token, tried } = resolveGitHubToken(skill.auth, env)
  if (skill.auth?.env && !token) throw new SourceError(`${skill.auth.env} is not set, so ${spec.owner}/${spec.repo} can't be downloaded`)

  const url = token
    ? `${githubApiBase}/repos/${spec.owner}/${spec.repo}/tarball/${encodeURIComponent(spec.ref)}`
    : `${codeloadBase}/${spec.owner}/${spec.repo}/tar.gz/${encodeURIComponent(spec.ref)}`
  /** @type {Record<string, string>} */
  const headers = { 'User-Agent': 'netlify-agent-init', Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token.value}`

  const response = await fetchImpl(url, { headers, redirect: 'follow' })
  if (!response.ok || !response.body) {
    const hint = token
      ? ` (check ${token.name} can read ${spec.owner}/${spec.repo})`
      : ` (private repo? set one of ${tried.join(', ')})`
    throw new SourceError(`GitHub returned ${response.status} for ${spec.owner}/${spec.repo}#${spec.ref}${hint}`)
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'netlify-agent-init-gh-'))
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true })
  try {
    const archive = path.join(work, 'source.tar.gz')
    await pipeline(Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body)), fs.createWriteStream(archive))
    const extracted = path.join(work, 'extracted')
    extractTarball(archive, extracted, run)
    const [top] = fs.readdirSync(extracted)
    if (!top) throw new SourceError(`the tarball for ${spec.owner}/${spec.repo} was empty`)
    return { dir: path.join(extracted, top, skill.path || ''), cleanup, tokenEnv: token ? token.name : null }
  } catch (error) {
    cleanup()
    throw error
  }
}

/**
 * @param {import('../config').SkillSpec} skill
 * @param {SourceOptions} options
 * @returns {Promise<ResolvedSource>}
 */
async function resolveSource(skill, options = {}) {
  if (skill.from.startsWith('npm:')) return resolveNpmSource(skill, options)
  if (skill.from.startsWith('github:')) return resolveGitHubSource(skill, options)
  const dir = path.resolve(options.cwd || process.cwd(), skill.from, skill.path || '')
  if (!fs.existsSync(dir)) throw new SourceError(`${skill.from} does not exist`)
  return { dir, cleanup: () => {}, tokenEnv: null }
}

module.exports = {
  SourceError,
  buildNpmrc,
  resolveGitHubSource,
  resolveNpmSource,
  resolveSource,
}
