const fs = require('node:fs')
const path = require('node:path')

const { checkSource, displaySource } = require('./config')
const { runFile } = require('./process')
const { resolveSource } = require('./skills/sources')

/** Written into every folder `files` fills, so a later install knows it may replace it. */
const MARKER = '.netlify-agent-kit'

/** @param {Error | unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * How a file source appears in logs and the record. An env source names the variable,
 * and its URL is shortened like any other.
 * @param {import('./config').FileSpec} entry
 * @param {string | undefined} [resolved]
 */
function displayFileSource(entry, resolved) {
  if (typeof entry.from === 'string') return displaySource(entry.from)
  return resolved ? `$${entry.from.env} (${displaySource(resolved)})` : `$${entry.from.env}`
}

/**
 * Whether git tracks anything at or under a path. Outside a git checkout nothing is tracked.
 * @param {string} cwd
 * @param {string} to
 * @param {import('./process').RunFile} run
 */
function isTracked(cwd, to, run) {
  const result = run('git', ['ls-files', '--', to], { cwd })
  return result.status === 0 && result.stdout.trim() !== ''
}

/**
 * Fills one folder in the repo from a source: a zip URL, GitHub, npm or a local folder.
 * The folder must be one git doesn't track, so nothing it puts there shows up in a diff,
 * and it's replaced only if an earlier install created it.
 * @param {import('./config').FileSpec} entry
 * @param {{
 *   cwd: string,
 *   env?: NodeJS.ProcessEnv,
 *   dryRun?: boolean,
 *   runFile?: import('./process').RunFile,
 *   sources?: import('./skills/sources').SourceOptions,
 * }} options
 * @returns {Promise<{ step: import('./record').InstallStep, createdPaths: string[], installed: boolean }>}
 */
async function installFiles(entry, { cwd, env = process.env, dryRun = false, runFile: run = runFile, sources = {} }) {
  const started = Date.now()
  const from = typeof entry.from === 'string' ? entry.from : env[entry.from.env] || ''
  const shown = displayFileSource(entry, from || undefined)
  const base = { kind: 'files', from: shown, to: entry.to }
  const fail = (error) => ({ step: { ...base, status: 'error', error, ms: Date.now() - started }, createdPaths: [], installed: false })

  if (!from) {
    const name = typeof entry.from === 'string' ? '' : entry.from.env
    if (entry.optional) return { step: { ...base, status: 'skipped', reason: `${name} is not set` }, createdPaths: [], installed: false }
    return fail(`${name} is not set`)
  }
  if (typeof entry.from !== 'string') {
    const errors = []
    checkSource(from, `$${entry.from.env}`, errors, [])
    if (errors.length > 0) return fail(errors[0])
  }

  const dest = path.resolve(cwd, entry.to)
  if (isTracked(cwd, entry.to, run)) return fail(`git tracks files in ${entry.to}; pick a folder git doesn't track`)
  if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARKER))) {
    return fail(`${entry.to} already exists and wasn't created by netlify-agent-kit; not replacing it`)
  }
  if (dryRun) return { step: { ...base, status: 'would-install' }, createdPaths: [], installed: false }

  try {
    const source = await resolveSource({ from, path: entry.path, registry: entry.registry, auth: entry.auth }, { env, cwd, runFile: run, ...sources })
    try {
      if (!fs.existsSync(source.dir) || !fs.statSync(source.dir).isDirectory()) {
        return fail(`${entry.path || 'the source'} is not a folder`)
      }
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.cpSync(source.dir, dest, { recursive: true })
      fs.writeFileSync(path.join(dest, MARKER), `${JSON.stringify({ source: shown }, null, 2)}\n`)
      const count = countFiles(dest) - 1
      return {
        step: { ...base, status: 'ok', files: count, token: source.tokenEnv, ms: Date.now() - started },
        createdPaths: [dest],
        installed: true,
      }
    } finally {
      source.cleanup()
    }
  } catch (error) {
    return fail(messageOf(error))
  }
}

/** @param {string} dir */
function countFiles(dir) {
  let count = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1
  }
  return count
}

module.exports = {
  MARKER,
  displayFileSource,
  installFiles,
}
