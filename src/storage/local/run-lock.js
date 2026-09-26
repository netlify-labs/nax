// Directory locks with owner metadata: the short per-write state lock and the run lock that makes a
// process the single executor of a run (fresh run, resume or retry) until it settles or exits.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { randomUUID } = require('crypto')

const RUN_LOCK_DIR = 'run.lock'
const OWNER_FILE = 'owner.json'
const ORPHANED_TAKEOVER_MS = 60 * 1000

/**
 * @typedef {{
 *   pid: number,
 *   hostname: string,
 *   nonce: string,
 *   startedAt: string,
 *   command: string,
 *   runId: string,
 * }} RunLockOwner
 * @typedef {{ owner: RunLockOwner, release: () => boolean }} RunLock
 */

/**
 * Creates a lock directory atomically and records its owner. mkdir is the lock; the owner file is
 * metadata that release and staleness checks read.
 * @param {string} lockDir
 * @param {Record<string, unknown>} owner
 * @returns {boolean} false when another owner holds the lock
 */
function createLockDir(lockDir, owner) {
  try {
    fs.mkdirSync(lockDir)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'EEXIST') return false
    throw error
  }
  try {
    fs.writeFileSync(path.join(lockDir, OWNER_FILE), JSON.stringify(owner, null, 2) + '\n')
  } catch {
    // The directory itself is the lock; owner metadata is diagnostic when it cannot be written.
  }
  return true
}

/** @param {string} lockDir @returns {Partial<RunLockOwner> | null} */
function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, OWNER_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** @param {string} runDir @returns {string} */
function runLockDir(runDir) {
  return path.join(runDir, RUN_LOCK_DIR)
}

/** @param {string} runDir @returns {Partial<RunLockOwner> | null} */
function readRunLockOwner(runDir) {
  return readLockOwner(runLockDir(runDir))
}

/** @param {number} pid @returns {boolean} */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ESRCH'
  }
}

/**
 * A lock is stale only when its owner ran on this host and that process is gone. Locks from
 * another host are never assumed stale; there is no age-based expiry because runs last long.
 * @param {Partial<RunLockOwner> | null} owner @param {string} hostname
 */
function isStaleOwner(owner, hostname) {
  return Boolean(owner && owner.hostname === hostname && Number.isInteger(owner.pid) && !processIsAlive(Number(owner.pid)))
}

/** @param {Partial<RunLockOwner> | null} owner @returns {string} */
function describeRunLockOwner(owner) {
  if (!owner) return 'an unknown owner (owner.json unreadable)'
  return `pid ${owner.pid} on ${owner.hostname}${owner.command ? ` (${owner.command})` : ''}${owner.startedAt ? ` since ${owner.startedAt}` : ''}`
}

/** @param {string} dir @returns {number} */
function ageMs(dir) {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Claims the takeover mutex beside a lock. A takeover left by a process that died on this host is
 * cleared once. Returns the mutex path, or null when another process is taking over.
 * @param {string} lockDir @param {RunLockOwner} owner @returns {string | null}
 */
function acquireTakeover(lockDir, owner) {
  const takeover = `${lockDir}.takeover`
  if (createLockDir(takeover, owner)) return takeover
  const current = readLockOwner(takeover)
  // A takeover lasts milliseconds; one with no owner file is a crash between mkdir and the write.
  const orphaned = !current && ageMs(takeover) > ORPHANED_TAKEOVER_MS
  if (!orphaned && !isStaleOwner(current, owner.hostname)) return null
  fs.rmSync(takeover, { recursive: true, force: true })
  return createLockDir(takeover, owner) ? takeover : null
}

/** @param {Partial<RunLockOwner> | null} left @param {Partial<RunLockOwner> | null} right */
function sameOwner(left, right) {
  if (!left || !right) return left === right
  return left.nonce === right.nonce && left.pid === right.pid && left.hostname === right.hostname
}

/**
 * The owner of a run's lock when one is held by a live (or unverifiable remote) process.
 * @param {string} runDir
 * @returns {Partial<RunLockOwner> | null}
 */
function runLockHolder(runDir) {
  if (!fs.existsSync(runLockDir(runDir))) return null
  const owner = readRunLockOwner(runDir)
  return isStaleOwner(owner, os.hostname()) ? null : (owner || {})
}

/**
 * Makes this process the only executor of a run. Throws `run_locked` when a live owner holds it.
 * @param {string} runDir
 * @param {{ runId?: string, command?: string, forceUnlock?: boolean }} [options]
 * @returns {RunLock}
 */
function acquireRunLock(runDir, { runId = '', command = '', forceUnlock = false } = {}) {
  const lockDir = runLockDir(runDir)
  const hostname = os.hostname()
  /** @type {RunLockOwner} */
  const owner = { pid: process.pid, hostname, nonce: randomUUID(), startedAt: new Date().toISOString(), command, runId }
  fs.mkdirSync(runDir, { recursive: true })
  const locked = (/** @type {Partial<RunLockOwner> | null} */ current) => {
    const error = /** @type {Error & { code: string, owner: Partial<RunLockOwner> | null }} */ (new Error(`Run ${runId || path.basename(runDir)} is already being executed by ${describeRunLockOwner(current)}. Wait for it to finish, or rerun with --force-unlock if that process is gone.`))
    error.code = 'run_locked'
    error.owner = current
    return error
  }
  if (!createLockDir(lockDir, owner)) {
    const current = readLockOwner(lockDir)
    if (!forceUnlock && !isStaleOwner(current, hostname)) throw locked(current)
    // Only the holder of the takeover mutex may remove a lock, and only after re-checking that it
    // still belongs to the owner judged stale. mkdir of the run lock stays the only way to acquire.
    const takeover = acquireTakeover(lockDir, owner)
    if (!takeover) throw locked(current)
    try {
      const recheck = readLockOwner(lockDir)
      if (fs.existsSync(lockDir) && !sameOwner(recheck, current)) throw locked(recheck)
      fs.rmSync(lockDir, { recursive: true, force: true })
    } finally {
      fs.rmSync(takeover, { recursive: true, force: true })
    }
    if (!createLockDir(lockDir, owner)) return acquireRunLock(runDir, { runId, command, forceUnlock: false })
  }
  let released = false
  return {
    owner,
    release: () => {
      if (released) return false
      released = true
      const current = readLockOwner(lockDir)
      if (!current || current.nonce !== owner.nonce || current.pid !== owner.pid || current.hostname !== owner.hostname) {
        console.warn('run lock not released', `${lockDir} is now held by ${describeRunLockOwner(current)}`)
        return false
      }
      fs.rmSync(lockDir, { recursive: true, force: true })
      return true
    },
  }
}

module.exports = {
  acquireRunLock,
  createLockDir,
  describeRunLockOwner,
  readRunLockOwner,
  runLockDir,
  runLockHolder,
}
