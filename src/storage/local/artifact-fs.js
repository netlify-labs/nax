// Atomic filesystem helpers shared by local artifact writers.
// Covers idempotent JSON/text writes and latest-symlink rotation.
const fs = require('fs')
const path = require('path')

/** @param {string} dir */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** @param {string} filePath */
function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

/** @param {string} filePath */
function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} target @param {unknown} content */
function writeAtomic(target, content) {
  ensureDir(path.dirname(target))
  const next = String(content)
  if (readFileIfExists(target) === next) return false
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, target)
  return true
}

/** @param {string} target @param {unknown} value */
function writeJson(target, value) {
  return writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Replaces the `latest` symlink inside a directory.
 * @param {string} dir
 * @param {string} linkTarget
 * @param {string} [label] debug-log prefix; silent when omitted
 */
function updateLatestSymlink(dir, linkTarget, label = '') {
  const latest = path.join(dir, 'latest')
  const tmp = path.join(dir, `latest.tmp-${process.pid}-${Date.now()}`)
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
    fs.symlinkSync(linkTarget, tmp, 'dir')
    fs.rmSync(latest, { recursive: true, force: true })
    fs.renameSync(tmp, latest)
    return true
  } catch (error) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures.
    }
    if (label && process.env.NAX_DEBUG_ARTIFACTS) {
      console.error(`${label} failed: ${error.message}`)
    }
    return false
  }
}

module.exports = {
  ensureDir,
  readFileIfExists,
  readJsonIfExists,
  updateLatestSymlink,
  writeAtomic,
  writeJson,
}
