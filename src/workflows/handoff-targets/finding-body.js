// Markdown description of one finding, shared by handoff targets (GitHub issues, beads).
// Callers supply how the file location renders and any trailing marker lines.

/**
 * @param {import('../findings').Finding} finding
 * @param {import('../findings').FindingsArtifact} artifact
 * @param {{ location?: string, trailer?: string[] }} [options]
 * @returns {string}
 */
function findingMarkdown(finding, artifact, { location = '', trailer = [] } = {}) {
  const facts = [
    `**Severity:** ${finding.severity}`,
    finding.category ? `**Category:** ${finding.category}` : '',
    finding.status ? `**Status:** ${finding.status}` : '',
    finding.confidence ? `**Confidence:** ${finding.confidence}` : '',
  ].filter(Boolean).join(' · ')
  const sections = [
    facts,
    location ? `**Location:** ${location}` : '',
    finding.agents.length > 0 ? `**Reported by:** ${finding.agents.join(', ')}` : '',
    finding.claim ? `### Claim\n\n${finding.claim}` : '',
    finding.evidence ? `### Evidence\n\n${finding.evidence}` : '',
    finding.suggestedFix ? `### Suggested fix\n\n${finding.suggestedFix}` : '',
    '---',
    [
      `From nax ${artifact.flowId} run \`${artifact.runId}\`${finding.rank !== null ? ` (consensus rank ${finding.rank})` : ` (${finding.bucket})`}.`,
      artifact.source.resultUrl ? `Consensus result: ${artifact.source.resultUrl}` : '',
    ].filter(Boolean).join(' '),
    ...trailer,
  ]
  return sections.filter(Boolean).join('\n\n')
}

/** @param {import('../findings').Finding} finding */
function plainLocation(finding) {
  if (!finding.file) return ''
  return `\`${finding.file}${finding.line ? `:${finding.line}${finding.lineEnd ? `-${finding.lineEnd}` : ''}` : ''}\``
}

module.exports = {
  findingMarkdown,
  plainLocation,
}
