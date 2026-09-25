// Handoff target that turns selected findings into labeled GitHub issues via the gh CLI.
// Idempotent: each issue body carries a finding marker, and existing markers are skipped.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { runGh } = require('../../integrations/github/gh-cli')
const { findingMarker, parseFindingMarkers } = require('../../integrations/github/comment-markers')

const FINDING_LABEL = 'nax-finding'
const ISSUE_SCAN_LIMIT = 1000
const SEVERITY_LABEL_COLORS = { critical: 'b60205', high: 'd93f0b', medium: 'fbca04', low: '0e8a16', info: 'c5def5' }

/**
 * @typedef {import('../findings').Finding} Finding
 * @typedef {import('../findings').FindingsArtifact} FindingsArtifact
 * @typedef {import('./index').HandoffAction} HandoffAction
 * @typedef {import('./index').HandoffPlan} HandoffPlan
 * @typedef {import('./index').HandoffApplyResult} HandoffApplyResult
 * @typedef {(args: string[], options?: { allowFailure?: boolean, errorPrefix?: string, attempts?: number }) => { status: number, stdout: string, stderr?: string, detail?: string }} GhRunner
 * @typedef {{ repo: string, artifact: FindingsArtifact, labels?: string[], gh?: GhRunner }} GithubIssuesContext
 */

/** @param {Record<string, unknown>} context @returns {GithubIssuesContext} */
function githubContext(context) {
  return /** @type {GithubIssuesContext} */ (/** @type {unknown} */ (context))
}

/** @param {GithubIssuesContext} context @returns {GhRunner} */
function ghRunner(context) {
  return context.gh || ((args, options = {}) => runGh(args, options))
}

/** @param {Finding} finding @param {GithubIssuesContext} context */
function locationMarkdown(finding, context) {
  if (!finding.file) return ''
  const label = `${finding.file}${finding.line ? `:${finding.line}${finding.lineEnd ? `-${finding.lineEnd}` : ''}` : ''}`
  const sha = context.artifact.target.sha
  if (!sha) return `\`${label}\``
  const anchor = finding.line ? `#L${finding.line}${finding.lineEnd ? `-L${finding.lineEnd}` : ''}` : ''
  return `[${label}](https://github.com/${context.repo}/blob/${sha}/${finding.file}${anchor})`
}

/**
 * Markdown issue body for a finding, ending with the idempotency marker.
 * @param {Finding} finding
 * @param {GithubIssuesContext} context
 */
function findingIssueBody(finding, context) {
  const { artifact } = context
  const facts = [
    `**Severity:** ${finding.severity}`,
    finding.category ? `**Category:** ${finding.category}` : '',
    finding.status ? `**Status:** ${finding.status}` : '',
    finding.confidence ? `**Confidence:** ${finding.confidence}` : '',
  ].filter(Boolean).join(' · ')
  const location = locationMarkdown(finding, context)
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
    findingMarker(finding.key),
  ]
  return sections.filter(Boolean).join('\n\n')
}

/**
 * Plans one issue per selected finding, skipping findings whose marker already exists.
 * @param {Finding[]} findings
 * @param {Record<string, unknown>} rawContext
 * @returns {HandoffPlan}
 */
function plan(findings, rawContext) {
  const context = githubContext(rawContext)
  const gh = ghRunner(context)
  const listed = gh([
    'issue', 'list', '--repo', context.repo, '--label', FINDING_LABEL, '--state', 'all',
    '--limit', String(ISSUE_SCAN_LIMIT), '--json', 'number,url,body',
  ], { errorPrefix: 'Could not list existing nax-finding issues' })
  /** @type {Array<{ url?: string, body?: string }>} */
  const issues = JSON.parse(listed.stdout || '[]')
  /** @type {Map<string, string>} */
  const existing = new Map()
  for (const issue of issues) {
    for (const key of parseFindingMarkers(issue.body || '')) existing.set(key, String(issue.url || ''))
  }
  /** @type {HandoffPlan} */
  const result = { actions: [], skipped: [] }
  for (const finding of findings) {
    const existingUrl = existing.get(finding.key)
    if (existingUrl !== undefined) {
      result.skipped.push({ key: finding.key, reason: 'already exists', existingUrl })
      continue
    }
    result.actions.push({
      type: 'create-issue',
      key: finding.key,
      title: finding.title,
      body: findingIssueBody(finding, context),
      labels: [...new Set([FINDING_LABEL, `severity:${finding.severity}`, ...(context.labels || [])])],
    })
  }
  return result
}

/** @param {string} label */
function labelColor(label) {
  const severity = label.startsWith('severity:') ? label.slice('severity:'.length) : ''
  return SEVERITY_LABEL_COLORS[/** @type {keyof typeof SEVERITY_LABEL_COLORS} */ (severity)] || '5319e7'
}

/**
 * Ensures labels exist, then creates issues sequentially, stopping at the first failure.
 * @param {HandoffAction[]} actions
 * @param {Record<string, unknown>} rawContext
 * @returns {HandoffApplyResult}
 */
function apply(actions, rawContext) {
  const context = githubContext(rawContext)
  const gh = ghRunner(context)
  /** @type {HandoffApplyResult} */
  const result = { applied: [], failed: [], warnings: [] }
  const unavailable = new Set()
  for (const label of [...new Set(actions.flatMap((action) => action.labels))]) {
    const created = gh(['label', 'create', label, '--repo', context.repo, '--color', labelColor(label), '--force'], { allowFailure: true, attempts: 1 })
    if (created.status !== 0) {
      unavailable.add(label)
      result.warnings.push(`Label "${label}" could not be created (${created.detail || created.stderr || 'unknown error'}); issues are created without it.`)
    }
  }
  for (const action of actions) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-finding-issue-'))
    const bodyFile = path.join(tmpDir, 'body.md')
    try {
      fs.writeFileSync(bodyFile, action.body)
      const args = ['issue', 'create', '--repo', context.repo, '--title', action.title, '--body-file', bodyFile]
      for (const label of action.labels.filter((candidate) => !unavailable.has(candidate))) args.push('--label', label)
      const created = gh(args, { allowFailure: true })
      if (created.status !== 0) {
        result.failed.push({ key: action.key, error: created.detail || created.stderr || `gh exited ${created.status}` })
        break
      }
      result.applied.push({ key: action.key, url: created.stdout.trim() })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
  return result
}

/** @type {import('./index').HandoffTarget} */
const githubIssuesTarget = { id: 'github-issues', plan, apply }

module.exports = {
  FINDING_LABEL,
  findingIssueBody,
  githubIssuesTarget,
}
