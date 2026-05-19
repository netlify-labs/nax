const { onAnyExit, onShutdown } = require('@davidwells/graceful-exit')
const { saveRunState } = require('./run-state')

let activeRunState = null
let installed = false

function persistActiveRunState(reason, now = new Date()) {
  if (!activeRunState || activeRunState.status === 'completed') return null
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

function trackRunState(runState) {
  installGracefulRunStateHandlers()
  activeRunState = runState
  return runState
}

function clearTrackedRunState(runState, { completed = false } = {}) {
  if (runState && activeRunState !== runState) return
  if (completed && activeRunState) {
    activeRunState.status = 'completed'
    saveRunState(activeRunState)
  }
  activeRunState = null
}

module.exports = {
  _private: {
    persistActiveRunState,
  },
  clearTrackedRunState,
  installGracefulRunStateHandlers,
  trackRunState,
}
