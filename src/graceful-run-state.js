const { onAnyExit, onShutdown } = require('@davidwells/graceful-exit')
const { saveRunState } = require('./run-state')

let activeRunState = null
let activeInterruptHandler = null
let installed = false

function persistActiveRunState(reason, now = new Date()) {
  if (!activeRunState || activeRunState.status === 'completed') return null
  if (activeInterruptHandler) {
    try {
      activeInterruptHandler({ runState: activeRunState, reason })
    } catch (error) {
      activeRunState.interruptCleanupWarning = error?.message || String(error)
    }
  }
  activeRunState.status = 'interrupted'
  activeRunState.interruptedAt = now.toISOString()
  activeRunState.interruptReason = reason
  return saveRunState(activeRunState)
}

function installGracefulRunStateHandlers() {
  if (installed) return
  installed = true

  onShutdown('nax-run-state', () => {
    persistActiveRunState('shutdown')
  })
  onAnyExit(() => {
    persistActiveRunState('process-exit')
  })
}

/** @param {Record<string, unknown>} runState @param {{ onInterrupt?: (event: { runState: Record<string, unknown>, reason: string }) => void }} [options] */
function trackRunState(runState, { onInterrupt } = {}) {
  installGracefulRunStateHandlers()
  activeRunState = runState
  activeInterruptHandler = typeof onInterrupt === 'function' ? onInterrupt : null
  return runState
}

/** @param {Record<string, unknown> | null | undefined} runState @param {{ completed?: boolean }} [options] */
function clearTrackedRunState(runState, { completed = false } = {}) {
  if (runState && activeRunState !== runState) return
  if (completed && activeRunState) {
    activeRunState.status = 'completed'
    saveRunState(activeRunState)
  }
  activeRunState = null
  activeInterruptHandler = null
}

module.exports = {
  _private: {
    persistActiveRunState,
  },
  clearTrackedRunState,
  installGracefulRunStateHandlers,
  trackRunState,
}
