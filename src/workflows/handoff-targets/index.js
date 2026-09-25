// Routes selected findings to outbound handoff targets (GitHub issues, ...).
// Every target plans its actions first so dry runs and tests share the same path as apply.
const { githubIssuesTarget } = require('./github-issues')
const { beadsTarget } = require('./beads')

const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical']
const HIDDEN_STATUSES = new Set(['rejected', 'dropped'])
const DEFAULT_PRESELECT_RANK = 5

/**
 * @typedef {import('../findings').Finding} Finding
 * @typedef {import('../findings').FindingsArtifact} FindingsArtifact
 * @typedef {{
 *   minSeverity?: string,
 *   includeContested?: boolean,
 *   includeRejected?: boolean,
 * }} FindingFilterOptions
 * @typedef {FindingFilterOptions & { select?: string[], limit?: number }} FindingSelectionOptions
 * @typedef {{ key: string, reason: string, existingUrl?: string }} SkippedAction
 * @typedef {{ type: string, key: string, title: string, body: string, labels: string[], issueType?: string, priority?: number }} HandoffAction
 * @typedef {{ key: string, url: string }} AppliedAction
 * @typedef {{ actions: HandoffAction[], skipped: SkippedAction[] }} HandoffPlan
 * @typedef {{ applied: AppliedAction[], failed: Array<{ key: string, error: string }>, warnings: string[] }} HandoffApplyResult
 * @typedef {{
 *   id: string,
 *   needsRepo: boolean,
 *   describe: (count: number, context: Record<string, unknown>) => string,
 *   plan: (findings: Finding[], context: Record<string, unknown>) => HandoffPlan,
 *   apply: (actions: HandoffAction[], context: Record<string, unknown>) => HandoffApplyResult,
 * }} HandoffTarget
 */

/** @type {Record<string, HandoffTarget>} */
const HANDOFF_TARGETS = {
  'github-issues': githubIssuesTarget,
  beads: beadsTarget,
}

/** @param {string} severity */
function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(String(severity || '').toLowerCase())
  return index === -1 ? 0 : index
}

/**
 * Findings a user may pick: consensus by default, open-ish statuses, at or above minSeverity, rank order.
 * @param {Finding[]} findings
 * @param {FindingFilterOptions} [options]
 * @returns {Finding[]}
 */
function candidateFindings(findings, { minSeverity = 'low', includeContested = false, includeRejected = false } = {}) {
  const floor = severityRank(minSeverity)
  return findings
    .filter((finding) => includeContested || finding.bucket === 'consensus')
    .filter((finding) => includeRejected || !HIDDEN_STATUSES.has(String(finding.status || '').toLowerCase()))
    .filter((finding) => severityRank(finding.severity) >= floor)
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
}

/**
 * Candidates preselected in interactive pickers: ranked within the top five.
 * @param {Finding[]} candidates
 * @returns {Finding[]}
 */
function defaultPreselection(candidates) {
  return candidates.filter((finding) => finding.rank !== null && finding.rank <= DEFAULT_PRESELECT_RANK)
}

/**
 * Resolves an explicit `--select` id list or a `--limit` over candidates.
 * @param {Finding[]} findings
 * @param {FindingSelectionOptions} options
 * @returns {{ selected: Finding[], unknown: string[] }}
 */
function selectFindings(findings, options) {
  if (options.select && options.select.length > 0) {
    const byId = new Map(findings.map((finding) => [finding.localId, finding]))
    return {
      selected: options.select.map((id) => byId.get(id)).filter((finding) => finding !== undefined),
      unknown: options.select.filter((id) => !byId.has(id)),
    }
  }
  const candidates = candidateFindings(findings, options)
  const limit = Number(options.limit || 0)
  return { selected: limit > 0 ? candidates.slice(0, limit) : candidates, unknown: [] }
}

/** @param {string} targetId @returns {HandoffTarget} */
function handoffTarget(targetId) {
  const target = HANDOFF_TARGETS[targetId]
  if (!target) {
    throw Object.assign(new Error(`Unknown handoff target "${targetId}". Available targets: ${Object.keys(HANDOFF_TARGETS).join(', ')}.`), { code: 'unknown_handoff_target' })
  }
  return target
}

module.exports = {
  HANDOFF_TARGETS,
  candidateFindings,
  defaultPreselection,
  handoffTarget,
  selectFindings,
  severityRank,
}
