// Verifies the run lock: one owner per run directory, pid-liveness staleness, owner-checked release.
// Uses real temp directories and a real exited child process for the dead-pid case.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { acquireRunLock, readRunLockOwner, runLockDir } = require('../../src/storage/local/run-lock')

function runDir() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-lock-')), '.nax', 'workflows', 'run-1')
}

/** @param {() => unknown} fn @returns {Error & { code?: string, owner?: Record<string, unknown> }} */
function thrown(fn) {
  try {
    fn()
  } catch (error) {
    return /** @type {Error & { code?: string }} */ (error)
  }
  throw new Error('expected a throw')
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(child.stdout)
}

test('acquire writes owner.json with pid, hostname, nonce, startedAt, command and runId', () => {
  const dir = runDir()
  const lock = acquireRunLock(dir, { runId: 'run-1', command: 'nax run --resume run-1' })
  const owner = readRunLockOwner(dir)
  assert.equal(owner?.pid, process.pid)
  assert.equal(owner?.hostname, os.hostname())
  assert.equal(owner?.runId, 'run-1')
  assert.equal(owner?.command, 'nax run --resume run-1')
  assert.match(String(owner?.nonce), /^[0-9a-f-]{36}$/)
  assert.ok(owner?.startedAt)
  assert.equal(lock.release(), true)
  assert.equal(fs.existsSync(runLockDir(dir)), false)
})

test('a live owner makes a second acquire fail with run_locked naming the owner', () => {
  const dir = runDir()
  const lock = acquireRunLock(dir, { runId: 'run-1', command: 'first' })
  const error = thrown(() => acquireRunLock(dir, { runId: 'run-1', command: 'second' }))
  assert.equal(error.code, 'run_locked')
  assert.match(error.message, new RegExp(`pid ${process.pid}`))
  assert.match(error.message, /--force-unlock/)
  lock.release()
})

test('a lock held by a dead pid on this host is stale and taken over', () => {
  const dir = runDir()
  fs.mkdirSync(runLockDir(dir), { recursive: true })
  fs.writeFileSync(path.join(runLockDir(dir), 'owner.json'), JSON.stringify({ pid: deadPid(), hostname: os.hostname(), nonce: 'old', startedAt: '2026-09-25T00:00:00.000Z', command: 'crashed', runId: 'run-1' }))
  const lock = acquireRunLock(dir, { runId: 'run-1', command: 'resume' })
  assert.equal(readRunLockOwner(dir)?.pid, process.pid)
  lock.release()
})

test('a lock from another host is never stale; --force-unlock takes it over', () => {
  const dir = runDir()
  fs.mkdirSync(runLockDir(dir), { recursive: true })
  fs.writeFileSync(path.join(runLockDir(dir), 'owner.json'), JSON.stringify({ pid: deadPid(), hostname: 'other-host', nonce: 'x', startedAt: '2026-09-25T00:00:00.000Z', command: 'remote', runId: 'run-1' }))
  const error = thrown(() => acquireRunLock(dir, { runId: 'run-1', command: 'resume' }))
  assert.equal(error.code, 'run_locked')
  assert.match(error.message, /other-host/)
  const lock = acquireRunLock(dir, { runId: 'run-1', command: 'resume', forceUnlock: true })
  assert.equal(readRunLockOwner(dir)?.hostname, os.hostname())
  lock.release()
})

test('release leaves a lock another owner took over, and warns', () => {
  const dir = runDir()
  const lock = acquireRunLock(dir, { runId: 'run-1', command: 'first' })
  fs.writeFileSync(path.join(runLockDir(dir), 'owner.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), nonce: 'someone-else' }))
  const originalWarn = console.warn
  /** @type {unknown[][]} */
  const warnings = []
  console.warn = (...args) => { warnings.push(args) }
  try {
    assert.equal(lock.release(), false)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(fs.existsSync(runLockDir(dir)), true)
  assert.match(String(warnings[0]?.[0]), /run lock/)
  assert.equal(lock.release(), false)
})

test('runLockHolder reports a live owner and ignores a stale or missing lock', () => {
  const { runLockHolder } = require('../../src/storage/local/run-lock')
  const dir = runDir()
  assert.equal(runLockHolder(dir), null)
  const lock = acquireRunLock(dir, { runId: 'run-1', command: 'nax run --resume run-1' })
  assert.equal(runLockHolder(dir)?.pid, process.pid)
  lock.release()
  fs.mkdirSync(runLockDir(dir), { recursive: true })
  fs.writeFileSync(path.join(runLockDir(dir), 'owner.json'), JSON.stringify({ pid: deadPid(), hostname: os.hostname(), nonce: 'old' }))
  assert.equal(runLockHolder(dir), null)
})

test('a stale lock is not taken over while another live process holds the takeover', () => {
  const dir = runDir()
  const stale = { pid: deadPid(), hostname: os.hostname(), nonce: 'old' }
  fs.mkdirSync(runLockDir(dir), { recursive: true })
  fs.writeFileSync(path.join(runLockDir(dir), 'owner.json'), JSON.stringify(stale))
  fs.mkdirSync(`${runLockDir(dir)}.takeover`)
  fs.writeFileSync(path.join(`${runLockDir(dir)}.takeover`, 'owner.json'), JSON.stringify({ pid: process.ppid, hostname: os.hostname(), nonce: 'busy' }))
  assert.equal(thrown(() => acquireRunLock(dir, { runId: 'run-1' })).code, 'run_locked')
  assert.equal(readRunLockOwner(dir)?.nonce, 'old', 'the stale lock is left for the live takeover')
})

test('a takeover left by a crashed process is cleared, then the stale lock is taken over', () => {
  const dir = runDir()
  fs.mkdirSync(runLockDir(dir), { recursive: true })
  fs.writeFileSync(path.join(runLockDir(dir), 'owner.json'), JSON.stringify({ pid: deadPid(), hostname: os.hostname(), nonce: 'old' }))
  fs.mkdirSync(`${runLockDir(dir)}.takeover`)
  fs.writeFileSync(path.join(`${runLockDir(dir)}.takeover`, 'owner.json'), JSON.stringify({ pid: deadPid(), hostname: os.hostname(), nonce: 'crashed-takeover' }))
  const lock = acquireRunLock(dir, { runId: 'run-1' })
  assert.equal(readRunLockOwner(dir)?.pid, process.pid)
  assert.equal(fs.existsSync(`${runLockDir(dir)}.takeover`), false)
  lock.release()
})
