// Decides when a finished agent run opens a pull request and reports its code changes.
// Landing outcomes come from the Agent Runner SDK and are stored on `run.raw.landing`.

/**
 * @param {import('../../types').AgentRun} run
 * @param {{ pr?: boolean }} [options]
 * @returns {boolean}
 */
function shouldLandRun(run, options = {}) {
  return run.status === 'completed' && run.fileChanges?.hasChanges === true && options.pr !== false
}

/**
 * @param {import('../../types').AgentRun} run
 * @returns {string}
 */
function describeRunChanges(run) {
  if (!run.fileChanges?.hasChanges) return 'Code changes: none'
  const landing = /** @type {{ kind?: string, reason?: string, failure?: { message?: string } }} */ (
    /** @type {Record<string, unknown>} */ (run.raw || {}).landing || {}
  )
  if (run.prUrl && landing.kind !== 'failed') return `Code changes: yes\nPull request: ${run.prUrl}`
  const runUrl = run.links?.agentRunUrl || run.links?.sessionUrl || ''
  if (landing.kind === 'failed' || landing.kind === 'unsupported') {
    const reason = landing.kind === 'failed' ? landing.failure?.message || 'unknown error' : landing.reason || 'unsupported'
    return [
      'Code changes: yes',
      `Could not open a pull request: ${reason}`,
      ...(runUrl ? [`Open it from the run page: ${runUrl}`] : []),
    ].join('\n')
  }
  return [
    'Code changes: yes (no pull request opened)',
    `Open one with: nax salvage --runner ${run.runnerId} --pr`,
  ].join('\n')
}

module.exports = {
  describeRunChanges,
  shouldLandRun,
}
