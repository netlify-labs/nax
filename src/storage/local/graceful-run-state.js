const { onAnyExit, onShutdown } = require('@davidwells/graceful-exit')
const { saveRunState } = require('./run-state')

let activeRunState = null
let activeInterruptHandler = null
let installed = false

function persistInterruptedState(reason, now = new Date()) {
  if (!activeRunState || activeRunState.status === 'completed') return null
  activeRunState.status = 'interrupted'
  activeRunState.interruptedAt = now.toISOString()
  activeRunState.interruptReason = reason
  return saveRunState(activeRunState)
}

function persistActiveRunState(reason, now = new Date()) {
  if (!activeRunState || activeRunState.status === 'completed') return null
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
  if (!activeRunState || activeRunState.status === 'completed') return null
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
  })
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
 * }} TrackRunStateOptions
 */

/** @param {Record<string, unknown>} runState @param {TrackRunStateOptions} [options] */
function trackRunState(runState, { onInterrupt } = {}) {
  installGracefulRunStateHandlers()
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
