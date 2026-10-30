const fs = require('node:fs')
const path = require('node:path')

const { runFile } = require('./process')

const BLOCK_START = '# >>> netlify-agent-kit (managed, local to this clone) >>>'
const BLOCK_END = '# <<< netlify-agent-kit <<<'

/**
 * @typedef {{ ok: true, file: string, root: string } | { ok: false, reason: string }} ExcludeLocation
 */

/**
 * Finds .git/info/exclude for the checkout containing cwd. Handles worktrees and
 * submodules, where .git is a file rather than a folder.
 * @param {string} cwd
 * @param {{ runFile?: import('./process').RunFile }} [deps]
 * @returns {ExcludeLocation}
 */
function findExcludeFile(cwd, { runFile: run = runFile } = {}) {
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd })
  if (top.status !== 0) return { ok: false, reason: 'not a git checkout (or git is not installed)' }
  const gitPath = run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd })
  if (gitPath.status !== 0) return { ok: false, reason: 'git could not locate info/exclude' }
  return {
    ok: true,
    file: path.resolve(cwd, gitPath.stdout.trim()),
    root: top.stdout.trim(),
  }
}

/**
 * Turns absolute paths inside the checkout into anchored exclude patterns.
 * @param {string} root
 * @param {string[]} absolutePaths
 * @returns {string[]}
 */
function toPatterns(root, absolutePaths) {
  const realRoot = safeRealpath(root)
  const patterns = new Set()
  for (const absolute of absolutePaths) {
    const resolved = path.resolve(absolute)
    let relative = path.relative(root, resolved)
    if (relative.startsWith('..')) relative = path.relative(realRoot, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    const posix = relative.split(path.sep).join('/')
    let isDir = false
    try {
      isDir = fs.lstatSync(resolved).isDirectory()
    } catch {
      isDir = false
    }
    patterns.add(`/${posix}${isDir ? '/' : ''}`)
  }
  return [...patterns].sort()
}

/** @param {string} target */
function safeRealpath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

/**
 * Removes any existing managed block.
 * @param {string} content
 */
function stripBlock(content) {
  const start = content.indexOf(BLOCK_START)
  if (start === -1) return content
  const end = content.indexOf(BLOCK_END, start)
  const after = end === -1 ? '' : content.slice(end + BLOCK_END.length).replace(/^\n/, '')
  return content.slice(0, start).replace(/\n*$/, start > 0 ? '\n' : '') + after
}

/**
 * Rewrites the managed block with the given patterns. Lines outside the block are kept.
 * @param {string} file
 * @param {string[]} patterns
 */
function writeManagedBlock(file, patterns) {
  let content = ''
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    content = ''
  }
  let next = stripBlock(content)
  if (patterns.length > 0) {
    if (next && !next.endsWith('\n')) next += '\n'
    next += [BLOCK_START, ...patterns, BLOCK_END].join('\n') + '\n'
  }
  if (next === content) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, next)
  return true
}

/**
 * Adds paths created inside the checkout to .git/info/exclude.
 * @param {string} cwd
 * @param {string[]} absolutePaths
 * @param {{ runFile?: import('./process').RunFile }} [deps]
 * @returns {{ status: 'ok' | 'skipped', file?: string, patterns: string[], reason?: string }}
 */
function excludePaths(cwd, absolutePaths, deps = {}) {
  const location = findExcludeFile(cwd, deps)
  if (location.ok === false) {
    return { status: 'skipped', patterns: [], reason: location.reason }
  }
  const patterns = toPatterns(location.root, absolutePaths)
  writeManagedBlock(location.file, patterns)
  return { status: 'ok', file: location.file, patterns }
}

module.exports = {
  BLOCK_END,
  BLOCK_START,
  excludePaths,
  findExcludeFile,
  stripBlock,
  toPatterns,
  writeManagedBlock,
}
