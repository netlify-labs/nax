// Implements `nax handoff --findings` (print a run's findings) and `nax handoff --to <target>`
// (select findings, plan, confirm, and send them to an outbound target such as GitHub issues).
const { readFindings } = require('../../workflows/findings')
const { resolveFindingsRun } = require('../../workflows/findings/runs')
const { candidateFindings, defaultPreselection, handoffTarget, selectFindings } = require('../../workflows/handoff-targets')

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
 * @typedef {{
 *   projectRoot: string,
 *   runId?: string,
 *   to: string,
 *   select?: string[],
 *   limit?: number,
 *   minSeverity?: string,
 *   includeContested?: boolean,
 *   includeRejected?: boolean,
 *   labels?: string[],
 *   repo?: string,
 *   dry?: boolean,
 *   force?: boolean,
 *   json?: boolean,
 * }} FindingsTargetOptions
 * @typedef {FindingsHandoffDependencies & {
 *   isTTY?: boolean,
 *   pickFindings?: (options: Array<{ value: string, label: string, hint: string }>, initialValues: string[]) => Promise<string[]>,
 *   confirm?: (message: string) => Promise<boolean>,
 *   resolveRepo?: () => string,
 *   gh?: import('../../workflows/handoff-targets/github-issues').GhRunner,
 * }} FindingsTargetDependencies
 */

/** @param {import('../../workflows/findings').Finding} finding */
function findingChoiceLabel(finding) {
  return `${finding.localId} [${finding.severity}] ${finding.title}`
}

async function clackPickFindings(/** @type {Array<{ value: string, label: string, hint: string }>} */ options, /** @type {string[]} */ initialValues) {
  const clack = await import('@clack/prompts')
  const picked = await clack.multiselect({ message: 'Select findings to hand off', options, initialValues, required: false })
  if (clack.isCancel(picked)) return []
  return /** @type {string[]} */ (picked)
}

async function clackConfirm(/** @type {string} */ message) {
  const clack = await import('@clack/prompts')
  const confirmed = await clack.confirm({ message, initialValue: true })
  return !clack.isCancel(confirmed) && confirmed === true
}

/**
 * Handler for `nax handoff [run-id] --to <target>`: select findings, plan, confirm, apply.
 * @param {FindingsTargetOptions} options
 * @param {FindingsTargetDependencies} [deps]
 * @returns {Promise<number>} exit code
 */
async function handleFindingsTarget(options, {
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  pickFindings = clackPickFindings,
  confirm = clackConfirm,
  resolveRepo = () => require('../../workflows/catalog/prompts').resolveRepo(),
  gh,
} = {}) {
  const fail = (/** @type {string} */ message) => {
    stderr(message)
    process.exitCode = 1
    return 1
  }
  const target = handoffTarget(options.to)
  const state = resolveFindingsRun(options.projectRoot, options.runId || '')
  const artifact = state ? readFindings(state) : null
  if (!state || !artifact) return fail('No saved workflow run has findings. Run a flow that declares findings, such as `nax run review`.')

  const filters = { minSeverity: options.minSeverity, includeContested: options.includeContested, includeRejected: options.includeRejected }
  /** @type {import('../../workflows/findings').Finding[]} */
  let selected
  if ((options.select && options.select.length > 0) || Number(options.limit || 0) > 0) {
    const selection = selectFindings(artifact.findings, { ...filters, select: options.select, limit: options.limit })
    if (selection.unknown.length > 0) return fail(`Unknown finding ids: ${selection.unknown.join(', ')}. Run nax handoff --findings to list ids.`)
    selected = selection.selected
  } else if (isTTY) {
    const candidates = candidateFindings(artifact.findings, filters)
    const picked = await pickFindings(
      candidates.map((finding) => ({ value: finding.localId, label: findingChoiceLabel(finding), hint: finding.file })),
      defaultPreselection(candidates).map((finding) => finding.localId),
    )
    selected = candidates.filter((finding) => picked.includes(finding.localId))
  } else {
    return fail(`nax handoff --to ${options.to} needs --select <ids> or --limit <n> when not running in a terminal.`)
  }
  if (selected.length === 0) {
    stdout('No findings selected; nothing to hand off.')
    return 0
  }

  const context = {
    projectRoot: options.projectRoot,
    artifact,
    labels: options.labels || [],
    ...(target.needsRepo ? { repo: options.repo || resolveRepo() } : {}),
    ...(gh ? { gh } : {}),
  }
  const planned = target.plan(selected, context)
  const summary = { target: target.id, runId: artifact.runId, planned: planned.actions.map(({ key, title, labels }) => ({ key, title, labels })), skipped: planned.skipped }
  if (options.dry) {
    stdout(options.json ? JSON.stringify({ ...summary, applied: [] }, null, 2) : formatPlan(summary))
    return 0
  }
  if (planned.actions.length > 0 && !options.force) {
    if (!isTTY) return fail(`${formatPlan(summary)}\n\nRe-run with --force to apply this plan, or --dry to only preview.`)
    if (!await confirm(target.describe(planned.actions.length, context))) return fail('Cancelled.')
  }
  const result = planned.actions.length > 0 ? target.apply(planned.actions, context) : { applied: [], failed: [], warnings: [] }
  for (const warning of result.warnings) stderr(`Warning: ${warning}`)
  if (options.json) {
    stdout(JSON.stringify({ ...summary, applied: result.applied, failed: result.failed }, null, 2))
  } else {
    for (const item of result.applied) stdout(`Created ${item.url}  (${item.key})`)
    for (const item of planned.skipped) stdout(`Skipped ${item.key}: ${item.reason}${item.existingUrl ? ` ${item.existingUrl}` : ''}`)
    for (const item of result.failed) stderr(`Failed ${item.key}: ${item.error}`)
  }
  if (result.failed.length > 0) {
    process.exitCode = 1
    return 1
  }
  return 0
}

/** @param {{ target: string, runId: string, planned: Array<{ key: string, title: string, labels: string[] }>, skipped: Array<{ key: string, reason: string, existingUrl?: string }> }} summary */
function formatPlan(summary) {
  const lines = [`Plan for ${summary.target} from run ${summary.runId}:`]
  for (const item of summary.planned) lines.push(`  create  ${item.title}  [${item.labels.join(', ')}]  (${item.key})`)
  for (const item of summary.skipped) lines.push(`  skip    ${item.key}: ${item.reason}${item.existingUrl ? ` ${item.existingUrl}` : ''}`)
  if (summary.planned.length === 0 && summary.skipped.length === 0) lines.push('  nothing to do')
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
  formatPlan,
  handleFindingsHandoff,
  handleFindingsTarget,
}
