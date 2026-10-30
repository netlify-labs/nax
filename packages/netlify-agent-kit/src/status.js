const { detect } = require('./detect')
const { readRecord } = require('./record')

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ detect: import('./detect').Detection, lastRecord: import('./record').InstallRecord | null }}
 */
function status({ env = process.env } = {}) {
  return { detect: detect(env), lastRecord: readRecord(env) }
}

/**
 * @param {ReturnType<typeof status>} result
 * @returns {string}
 */
function formatStatus(result) {
  const lines = [`environment: ${result.detect.label} (${result.detect.reason}); install ${result.detect.active ? 'runs here' : 'skips here'}`]
  const record = result.lastRecord
  if (!record) {
    lines.push('last install: none recorded on this machine')
    return lines.join('\n')
  }
  lines.push(`last install: ${record.at} (${record.detect.label}), ${record.steps.length} step(s), ${record.errors.length} error(s), ${Math.round(record.ms / 100) / 10}s`)
  for (const step of record.steps) {
    const label = [step.kind, step.name || step.repo || step.from || step.command].filter(Boolean).join(' ')
    const detail = step.error ? `: ${step.error}` : ''
    lines.push(`  ${step.status === 'error' ? '✗' : '✓'} ${label} (${step.status})${detail}`)
  }
  for (const warning of record.warnings) lines.push(`  ! ${warning}`)
  return lines.join('\n')
}

module.exports = {
  formatStatus,
  status,
}
