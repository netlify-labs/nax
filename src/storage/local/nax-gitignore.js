const fs = require('fs')
const path = require('path')
const { artifactMeta } = require('../../core/artifact-metadata')

/**
 * @param {string} content
 * @returns {boolean}
 */
function hasNaxGitignoreEntry(content) {
  return content
    .split(/\r?\n/)
    .some((line) => {
      const entry = line.trim()
      return entry === '.nax' || entry === '.nax/' || entry === '/.nax' || entry === '/.nax/' || entry === '.nax/**' || entry === '/.nax/**'
    })
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function naxStatePath(projectRoot) {
  return path.join(projectRoot, '.nax', 'state.json')
}

/**
 * @param {string} filePath
 * @returns {{ version?: number, gitignore?: { checkedAt?: string, status?: string, path?: string }, [key: string]: unknown }}
 */
function readNaxState(filePath) {
  if (!fs.existsSync(filePath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {string} filePath
 * @param {{ status: 'created' | 'updated' | 'exists', gitignorePath: string }} state
 */
function writeGitignoreState(filePath, state) {
  const current = readNaxState(filePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify({
    ...current,
    ...artifactMeta(),
    version: 1,
    gitignore: {
      checkedAt: new Date().toISOString(),
      status: state.status,
      path: state.gitignorePath,
    },
  }, null, 2)}\n`)
}

/**
 * Ensures local nax artifacts are ignored by git.
 * @param {{ projectRoot?: string, dryRun?: boolean }} [input]
 * @returns {{ path: string, status: 'created' | 'updated' | 'exists' | 'skipped' }}
 */
function ensureNaxGitignore({ projectRoot, dryRun = false } = {}) {
  if (!projectRoot) return { path: '', status: 'skipped' }
  const gitignorePath = path.join(projectRoot, '.gitignore')
  const statePath = naxStatePath(projectRoot)
  const localState = readNaxState(statePath)
  if (localState.gitignore?.checkedAt) return { path: gitignorePath, status: 'skipped' }

  const exists = fs.existsSync(gitignorePath)
  const current = exists ? fs.readFileSync(gitignorePath, 'utf8') : ''
  if (hasNaxGitignoreEntry(current)) {
    if (!dryRun) writeGitignoreState(statePath, { status: 'exists', gitignorePath })
    return { path: gitignorePath, status: 'exists' }
  }

  const status = exists ? 'updated' : 'created'
  if (!dryRun) {
    const next = exists && current.trim()
      ? `${current.replace(/\s*$/, '\n\n')}# Added by nax\n.nax/\n`
      : '.nax/\n'
    fs.writeFileSync(gitignorePath, next)
    writeGitignoreState(statePath, { status, gitignorePath })
  }

  return { path: gitignorePath, status }
}

module.exports = {
  ensureNaxGitignore,
  hasNaxGitignoreEntry,
  naxStatePath,
  readNaxState,
}
