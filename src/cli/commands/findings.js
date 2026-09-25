// Implements `nax handoff --findings`: prints a saved run's findings as a table or JSON.
// Read-only: findings are computed in memory when findings.json does not exist yet.
const { readFindings } = require('../../workflows/findings')
const { resolveFindingsRun } = require('../../workflows/findings/runs')

/**
 * @typedef {import('../../workflows/findings').FindingsArtifact} FindingsArtifact
 * @typedef {{ projectRoot: string, runId?: string, json?: boolean }} FindingsHandoffOptions
 * @typedef {{ stdout?: (text: string) => void, stderr?: (text: string) => void }} FindingsHandoffDependencies
 */

/** @param {string} value @param {number} width */
function pad(value, width) {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

/**
 * Formats findings as a ranked plain-text table.
 * @param {FindingsArtifact} artifact
 * @returns {string}
 */
function formatFindingsTable(artifact) {
  const lines = [`Findings for ${artifact.flowId} run ${artifact.runId} (${artifact.adapter})`, '']
  const rows = artifact.findings.map((finding) => ({
    rank: finding.rank === null ? '-' : String(finding.rank),
    severity: finding.severity,
    title: finding.title,
    location: finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '',
    extra: [finding.bucket !== 'consensus' ? finding.bucket : '', finding.status, finding.agents.join(',')].filter(Boolean).join(' · '),
  }))
  for (const row of rows) {
    lines.push(`${pad(row.rank, 4)}${pad(row.severity, 10)}${row.title}`)
    const detail = [row.location, row.extra].filter(Boolean).join('  ')
    if (detail) lines.push(`${' '.repeat(14)}${detail}`)
  }
  const consensus = artifact.findings.filter((finding) => finding.bucket === 'consensus').length
  lines.push('')
  lines.push(`${consensus} consensus finding${consensus === 1 ? '' : 's'}, ${artifact.findings.length - consensus} other, ${artifact.diagnostics.length} diagnostic${artifact.diagnostics.length === 1 ? '' : 's'}`)
  for (const diagnostic of artifact.diagnostics) {
    lines.push(`  ${diagnostic.stepId}${diagnostic.instanceId ? ` ${diagnostic.instanceId}` : ''} ${diagnostic.code}: ${diagnostic.message}`)
  }
  return lines.join('\n')
}

/**
 * Handler for `nax handoff [run-id] --findings [--json]`.
 * @param {FindingsHandoffOptions} options
 * @param {FindingsHandoffDependencies} [deps]
 * @returns {number} exit code
 */
function handleFindingsHandoff(options, {
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  const state = resolveFindingsRun(options.projectRoot, options.runId || '')
  const artifact = state ? readFindings(state) : null
  if (!state || !artifact) {
    stderr(options.runId
      ? `Run "${options.runId}" has no findings. Its flow must declare findings (for example the bundled review flow).`
      : 'No saved workflow run has findings. Run a flow that declares findings, such as `nax run review`.')
    process.exitCode = 1
    return 1
  }
  stdout(options.json ? JSON.stringify(artifact, null, 2) : formatFindingsTable(artifact))
  return 0
}

module.exports = {
  formatFindingsTable,
  handleFindingsHandoff,
}
