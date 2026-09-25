const { onAnyExit, onShutdown } = require('@davidwells/graceful-exit')
const { saveRunState } = require('./run-state')
const { acquireRunLock } = require('./run-lock')

let activeRunState = null
let activeInterruptHandler = null
/** Run locks this process holds, by run directory. Dashboard and MCP execute runs in-process. */
/** @type {Map<string, import('./run-lock').RunLock>} */
const heldRunLocks = new Map()
let installed = false
const SETTLED_RUN_STATUSES = new Set(['completed', 'failed', 'awaiting_review'])

function persistInterruptedState(reason, now = new Date()) {
  if (!activeRunState || SETTLED_RUN_STATUSES.has(String(activeRunState.status || ''))) return null
  activeRunState.status = 'interrupted'
  activeRunState.interruptedAt = now.toISOString()
  activeRunState.interruptReason = reason
  return saveRunState(activeRunState)
}

function persistActiveRunState(reason, now = new Date()) {
  if (!activeRunState || SETTLED_RUN_STATUSES.has(String(activeRunState.status || ''))) return null
  if (
    activeInterruptHandler
    && activeInterruptHandler.constructor?.name !== 'AsyncFunction'
  ) {
    try {
      const pending = activeInterruptHandler({ runState: activeRunState, reason })
      if (pending && typeof pending.then === 'function') {
        activeRunState.interruptCleanupWarning = 'Interrupt cleanup did not finish before process exit.'
      }
    } catch (error) {
      activeRunState.interruptCleanupWarning = error?.message || String(error)
      activeRunState.interruptCleanupStack = error?.stack || ''
      console.warn('interrupt cleanup failed', error)
    }
  } else if (activeInterruptHandler) {
    activeRunState.interruptCleanupWarning =
      'Async interrupt cleanup could not run during the synchronous process-exit fallback.'
  }
  return persistInterruptedState(reason, now)
}

async function persistActiveRunStateAsync(reason, now = new Date()) {
  if (!activeRunState || SETTLED_RUN_STATUSES.has(String(activeRunState.status || ''))) return null
  if (activeInterruptHandler) {
    try {
      await activeInterruptHandler({ runState: activeRunState, reason })
    } catch (error) {
      activeRunState.interruptCleanupWarning = error?.message || String(error)
      activeRunState.interruptCleanupStack = error?.stack || ''
      console.warn('interrupt cleanup failed', error)
    }
  }
  return persistInterruptedState(reason, now)
}

function installGracefulRunStateHandlers() {
  if (installed) return
  installed = true

  onShutdown('nax-run-state', () => persistActiveRunStateAsync('shutdown'))
  onAnyExit(() => {
    persistActiveRunState('process-exit')
    for (const dir of [...heldRunLocks.keys()]) releaseRunLock(dir)
  })
}

/** @param {string} dir */
function releaseRunLock(dir) {
  const lock = heldRunLocks.get(dir)
  heldRunLocks.delete(dir)
  lock?.release()
}

/**
 * Holds the run lock for a tracked run so only one process executes it at a time. Tracking a run
 * this process already holds keeps its lock.
 * @param {Record<string, unknown>} runState @param {{ forceUnlock?: boolean }} options
 */
function holdRunLock(runState, { forceUnlock = false }) {
  const dir = runState?.dir ? String(runState.dir) : ''
  if (!dir || heldRunLocks.has(dir)) return
  heldRunLocks.set(dir, acquireRunLock(dir, { runId: String(runState.runId || ''), command: `nax ${process.argv.slice(2).join(' ')}`.trim(), forceUnlock }))
}

/**
 * Graceful run-state interrupt event.
 * @typedef {{
 *   runState: Record<string, unknown>,
 *   reason: string,
 * }} RunStateInterruptEvent
 *
 * Graceful run-state tracking options.
 * @typedef {{
 *   onInterrupt?: (event: RunStateInterruptEvent) => void | Promise<void>,
 *   forceUnlock?: boolean,
 * }} TrackRunStateOptions
 */

/** @param {Record<string, unknown>} runState @param {TrackRunStateOptions} [options] */
function trackRunState(runState, { onInterrupt, forceUnlock = false } = {}) {
  installGracefulRunStateHandlers()
  holdRunLock(runState, { forceUnlock })
  activeRunState = runState
  activeInterruptHandler = typeof onInterrupt === 'function' ? onInterrupt : null
  return runState
}

/** @param {Record<string, unknown>} runState @param {{ now?: Date }} [options] */
function markRunCompleted(runState, { now = new Date() } = {}) {
  runState.status = 'completed'
  runState.completedAt = now.toISOString()
  return saveRunState(runState)
}

/** @param {Record<string, unknown> | null | undefined} runState */
function clearTrackedRunState(runState) {
  if (runState?.dir) releaseRunLock(String(runState.dir))
  if (runState && activeRunState !== runState) return
  activeRunState = null
  activeInterruptHandler = null
}

module.exports = {
  clearTrackedRunState,
  installGracefulRunStateHandlers,
  markRunCompleted,
  persistActiveRunState,
  persistActiveRunStateAsync,
  trackRunState,
}
