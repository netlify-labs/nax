// Detects stalled runs: an active run whose event log has gone quiet longer
// than the threshold. Presentation metadata only — never a status change.
const fs = require('fs')
const path = require('path')
const { isActiveProjectedStatus } = require('../api/run-state-projection')

const DEFAULT_STALLED_AFTER_MINUTES = 10

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} threshold in ms; 0 disables stalled detection
 */
function stalledThresholdMs(env = process.env) {
  const raw = String(env.NAX_STALLED_AFTER_MINUTES ?? '').trim()
  if (raw === '') return DEFAULT_STALLED_AFTER_MINUTES * 60 * 1000
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_STALLED_AFTER_MINUTES * 60 * 1000
  return minutes * 60 * 1000
}

/**
 * @param {{ dir?: string, updatedAt?: string }} runState
 * @param {string} projectedStatus final projected status (post reconciliation)
 * @param {{ now?: number, thresholdMs?: number, stat?: typeof fs.statSync }} [options]
 * @returns {{ lastEventAt?: string, stalled?: boolean }}
 */
function livenessFields(runState, projectedStatus, { now = Date.now(), thresholdMs = stalledThresholdMs(), stat = fs.statSync } = {}) {
  if (!runState?.dir || !isActiveProjectedStatus(projectedStatus)) return {}
  let lastEventMs = 0
  try {
    lastEventMs = stat(path.join(String(runState.dir), 'events.jsonl')).mtimeMs
  } catch {
    lastEventMs = Date.parse(String(runState.updatedAt || '')) || 0
  }
  if (!lastEventMs) return {}
  return {
    lastEventAt: new Date(lastEventMs).toISOString(),
    stalled: thresholdMs > 0 && now - lastEventMs > thresholdMs,
  }
}

module.exports = {
  livenessFields,
  stalledThresholdMs,
}
