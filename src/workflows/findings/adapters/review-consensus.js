// Maps the review flow's `## 2. Structured Consensus` JSON onto the stable Finding shape.
// Tolerant by design: deviations become diagnostics instead of exceptions.

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const PRIORITY_SEVERITIES = { p0: 'critical', p1: 'high', p2: 'medium', p3: 'low', p4: 'info' }
const BUCKETS = [
  ['consensus_findings', 'consensus'],
  ['contested_findings', 'contested'],
  ['merge_dependent_findings', 'merge_dependent'],
]
const TITLE_LIMIT = 100

/**
 * @typedef {import('../extract').StructuredBlock} StructuredBlock
 * @typedef {{
 *   localId: string,
 *   rank: number | null,
 *   bucket: string,
 *   title: string,
 *   category: string,
 *   severity: string,
 *   severityRaw?: string,
 *   status: string,
 *   file: string,
 *   line: number | null,
 *   lineEnd: number | null,
 *   claim: string,
 *   evidence: string,
 *   suggestedFix: string,
 *   confidence: string,
 *   agents: string[],
 * }} AdaptedFinding
 * @typedef {{ code: string, message: string }} AdapterDiagnostic
 * @typedef {{ findings: AdaptedFinding[], diagnostics: AdapterDiagnostic[] }} AdapterResult
 * @typedef {{ knownAgents?: string[] }} AdapterOptions
 */

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value)
}

/**
 * First sentence of the claim, cut to TITLE_LIMIT characters on a word boundary.
 * @param {string} claim
 */
function titleFromClaim(claim) {
  const sentence = (claim.match(/^[\s\S]*?[.!?](?=\s|$)/) || [claim])[0].replace(/\s+/g, ' ').trim()
  if (sentence.length <= TITLE_LIMIT) return sentence
  const cut = sentence.slice(0, TITLE_LIMIT + 1)
  const boundary = cut.lastIndexOf(' ')
  return (boundary > 0 ? cut.slice(0, boundary) : sentence.slice(0, TITLE_LIMIT)).trim()
}

/** @param {unknown} value @returns {{ severity: string, severityRaw?: string }} */
function normalizeSeverity(value) {
  const raw = text(value)
  const lower = raw.toLowerCase()
  if (SEVERITIES.includes(lower)) return { severity: lower }
  if (Object.prototype.hasOwnProperty.call(PRIORITY_SEVERITIES, lower)) {
    return { severity: PRIORITY_SEVERITIES[/** @type {keyof typeof PRIORITY_SEVERITIES} */ (lower)] }
  }
  return { severity: 'info', severityRaw: raw }
}

/** @param {unknown} value @returns {{ line: number | null, lineEnd: number | null }} */
function normalizeLine(value) {
  if (Number.isInteger(value)) return { line: /** @type {number} */ (value), lineEnd: null }
  const match = text(value).match(/^(\d+)(?:\s*-\s*(\d+))?$/)
  if (!match) return { line: null, lineEnd: null }
  return { line: Number(match[1]), lineEnd: match[2] ? Number(match[2]) : null }
}

/**
 * Adapts structured blocks from one synthesize result into findings.
 * @param {StructuredBlock[]} blocks
 * @param {AdapterOptions} [options]
 * @returns {AdapterResult}
 */
function reviewConsensusAdapter(blocks, { knownAgents = [] } = {}) {
  /** @type {AdapterDiagnostic[]} */
  const diagnostics = []
  const block = blocks.find((candidate) => candidate.kind === 'consensus') || blocks[0]
  if (!block) {
    return { findings: [], diagnostics: [{ code: 'no_structured_block', message: 'No "## 2. Structured Consensus" JSON block was found.' }] }
  }
  if (block.parseError) {
    return { findings: [], diagnostics: [{ code: 'structured_block_parse_error', message: `${block.heading} JSON could not be parsed: ${block.parseError}` }] }
  }
  const json = block.json && typeof block.json === 'object' && !Array.isArray(block.json) ? /** @type {Record<string, unknown>} */ (block.json) : null
  if (!json || !Array.isArray(json.consensus_findings)) {
    return { findings: [], diagnostics: [{ code: 'unrecognized_shape', message: `${block.heading} is not a review consensus object with consensus_findings.` }] }
  }

  const known = new Set(knownAgents)
  /** @type {AdaptedFinding[]} */
  const findings = []
  for (const [field, bucket] of BUCKETS) {
    const items = Array.isArray(json[field]) ? /** @type {unknown[]} */ (json[field]) : []
    items.forEach((value, index) => {
      const item = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
      const localId = text(item.id) || `${bucket}-${index + 1}`
      const claim = text(item.claim)
      const { severity, severityRaw } = normalizeSeverity(item.severity)
      if (severityRaw !== undefined) {
        diagnostics.push({ code: 'unknown_severity', message: `${localId}: severity "${severityRaw}" is not one of ${SEVERITIES.join(', ')}; using info.` })
      }
      const agents = Array.isArray(item.agents) ? item.agents.map(text).filter(Boolean) : []
      const unknownAgents = known.size > 0 ? agents.filter((agent) => !known.has(agent)) : []
      if (unknownAgents.length > 0) {
        diagnostics.push({ code: 'unknown_agent_attribution', message: `${localId}: agents ${unknownAgents.join(', ')} are not in the source lineups.` })
      }
      findings.push({
        localId,
        rank: bucket === 'consensus' ? index + 1 : null,
        bucket,
        title: text(item.title) || titleFromClaim(claim) || localId,
        category: text(item.category),
        severity,
        ...(severityRaw !== undefined ? { severityRaw } : {}),
        status: text(item.status),
        file: text(item.file),
        ...normalizeLine(item.line),
        claim,
        evidence: text(item.evidence),
        suggestedFix: text(item.suggested_fix ?? item.suggestedFix),
        confidence: text(item.confidence),
        agents,
      })
    })
  }
  return { findings, diagnostics }
}

module.exports = {
  reviewConsensusAdapter,
  titleFromClaim,
}
