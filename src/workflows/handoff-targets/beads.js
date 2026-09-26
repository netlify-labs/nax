// Handoff target that turns selected findings into beads (br issues) in the project's .beads workspace.
// Idempotent: each bead carries external ref nax:<finding key>, and existing refs are skipped.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { findingMarkdown, plainLocation } = require('./finding-body')

const FINDING_LABEL = 'nax-finding'
const SEVERITY_PRIORITY = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/**
 * @typedef {import('../findings').Finding} Finding
 * @typedef {import('../findings').FindingsArtifact} FindingsArtifact
 * @typedef {import('./index').HandoffAction} HandoffAction
 * @typedef {import('./index').HandoffPlan} HandoffPlan
 * @typedef {import('./index').HandoffApplyResult} HandoffApplyResult
 * @typedef {(args: string[]) => { status: number | null, stdout: string, stderr: string, error?: Error }} BrRunner
 * @typedef {{ projectRoot: string, artifact: FindingsArtifact, labels?: string[], br?: BrRunner }} BeadsContext
 */

/** @param {Record<string, unknown>} context @returns {BeadsContext} */
function beadsContext(context) {
  return /** @type {BeadsContext} */ (/** @type {unknown} */ (context))
}

/** @param {BeadsContext} context @returns {BrRunner} */
function brRunner(context) {
  return context.br || ((args) => {
    const result = spawnSync('br', args, { cwd: context.projectRoot, encoding: 'utf8' })
    return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), ...(result.error ? { error: result.error } : {}) }
  })
}

/** @param {string} message */
function beadsUnavailable(message) {
  return Object.assign(new Error(message), { code: 'beads_unavailable' })
}

/** External ref that makes bead creation idempotent. @param {string} key */
function findingExternalRef(key) {
  return `nax:${key}`
}

/**
 * Plans one bead per selected finding, skipping findings whose external ref already exists.
 * @param {Finding[]} findings
 * @param {Record<string, unknown>} rawContext
 * @returns {HandoffPlan}
 */
function plan(findings, rawContext) {
  const context = beadsContext(rawContext)
  if (!fs.existsSync(path.join(context.projectRoot, '.beads'))) {
    throw beadsUnavailable(`No .beads workspace in ${context.projectRoot}. Run br init there first, or hand findings off with --to github-issues.`)
  }
  const br = brRunner(context)
  const version = br(['--version'])
  if (version.error || version.status !== 0) {
    throw beadsUnavailable('br (beads_rust) was not found on PATH. Install br, or hand findings off with --to github-issues.')
  }
  const listed = br(['list', '--json', '--all', '--limit', '0'])
  if (listed.status !== 0) throw beadsUnavailable(`br list failed: ${listed.stderr.trim() || `exit ${listed.status}`}`)
  /** @type {{ issues?: Array<{ id?: string, external_ref?: string }> }} */
  const payload = JSON.parse(listed.stdout || '{}')
  /** @type {Map<string, string>} */
  const existing = new Map()
  for (const issue of payload.issues || []) {
    if (issue.external_ref) existing.set(issue.external_ref, String(issue.id || ''))
  }
  /** @type {HandoffPlan} */
  const result = { actions: [], skipped: [] }
  for (const finding of findings) {
    const existingId = existing.get(findingExternalRef(finding.key))
    if (existingId !== undefined) {
      result.skipped.push({ key: finding.key, reason: 'already exists', existingUrl: existingId })
      continue
    }
    result.actions.push({
      type: 'create-bead',
      key: finding.key,
      title: finding.title,
      body: findingMarkdown(finding, context.artifact, { location: plainLocation(finding) }),
      labels: [...new Set([FINDING_LABEL, `severity:${finding.severity}`, ...(context.labels || [])])],
      issueType: finding.category === 'defect' ? 'bug' : 'task',
      priority: SEVERITY_PRIORITY[/** @type {keyof typeof SEVERITY_PRIORITY} */ (finding.severity)] ?? 2,
    })
  }
  return result
}

/**
 * Creates beads sequentially with argv-only br calls, stopping at the first failure.
 * @param {HandoffAction[]} actions
 * @param {Record<string, unknown>} rawContext
 * @returns {HandoffApplyResult}
 */
function apply(actions, rawContext) {
  const context = beadsContext(rawContext)
  const br = brRunner(context)
  /** @type {HandoffApplyResult} */
  const result = { applied: [], failed: [], warnings: [] }
  for (const action of actions) {
    const created = br([
      'create', action.title,
      '-t', action.issueType || 'task',
      '-p', String(action.priority ?? 2),
      '-d', action.body,
      '-l', action.labels.join(','),
      '--external-ref', findingExternalRef(action.key),
      '--silent',
    ])
    if (created.status !== 0) {
      result.failed.push({ key: action.key, error: created.stderr.trim() || `br exited ${created.status}` })
      break
    }
    result.applied.push({ key: action.key, url: created.stdout.trim() })
  }
  return result
}

/** @type {import('./index').HandoffTarget} */
const beadsTarget = {
  id: 'beads',
  needsRepo: false,
  describe: (count) => `Create ${count} bead${count === 1 ? '' : 's'} in this project's .beads workspace?`,
  plan,
  apply,
}

module.exports = {
  beadsTarget,
  findingExternalRef,
}
