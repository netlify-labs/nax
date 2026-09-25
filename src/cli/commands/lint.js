// Implements `nax lint`: validates discovered flows and reports every diagnostic in one pass.
// Emits a human report (TTY-colored) or stable JSON on stdout and sets the exit code.
const { discoverFlowEntries, invalidFlowSummary } = require('../../workflows/catalog/flows')

/**
 * @typedef {import('../../workflows/catalog/flows').FlowEntry} FlowEntry
 * @typedef {{ stepId: string, code: string, message: string, hint: string }} LintDiagnostic
 * @typedef {{
 *   id: string,
 *   file: string,
 *   status: 'valid' | 'invalid' | 'load-failed' | 'unknown',
 *   errors: LintDiagnostic[],
 *   warnings: LintDiagnostic[],
 *   stepIds: string[],
 *   shadowed: Array<{ file: string, status: string }>,
 * }} LintFlowResult
 * @typedef {{ flows: LintFlowResult[], summary: { total: number, invalid: number, warnings: number } }} LintReport
 * @typedef {{
 *   projectRoot?: string,
 *   flowsDir?: string | string[],
 *   flowsDirs?: string | string[],
 *   flows?: string[],
 *   json?: boolean,
 *   strict?: boolean,
 * }} LintOptions
 * @typedef {{ stdout?: (text: string) => void, isTTY?: boolean }} LintDependencies
 */

/** @param {FlowEntry} entry @returns {LintFlowResult} */
function lintResultForEntry(entry) {
  const errors = entry.status === 'valid' ? [] : invalidFlowSummary(entry).diagnostics
  return {
    id: entry.id,
    file: entry.file,
    status: entry.status,
    errors,
    warnings: entry.validation.warnings,
    stepIds: entry.stepIds,
    shadowed: entry.shadowed.map((candidate) => ({ file: candidate.file, status: candidate.status })),
  }
}

/** @param {string} id @returns {LintFlowResult} */
function unknownFlowResult(id) {
  return {
    id,
    file: '',
    status: 'unknown',
    errors: [{ stepId: '', code: 'unknown_flow', message: `Unknown flow "${id}".`, hint: 'Run nax lint with no arguments to see every discovered flow.' }],
    warnings: [],
    stepIds: [],
    shadowed: [],
  }
}

/**
 * Builds the lint report for the requested flow ids (all winning entries when none are given).
 * @param {LintOptions} [options]
 * @returns {Promise<LintReport>}
 */
async function buildLintReport(options = {}) {
  const entries = await discoverFlowEntries({
    projectRoot: options.projectRoot,
    flowsDir: options.flowsDir,
    flowsDirs: options.flowsDirs,
  })
  const requested = (options.flows || []).map(String).filter(Boolean)
  const flows = requested.length > 0
    ? requested.map((id) => {
      const entry = entries.find((candidate) => candidate.id === id)
      return entry ? lintResultForEntry(entry) : unknownFlowResult(id)
    })
    : entries.map(lintResultForEntry)
  return {
    flows,
    summary: {
      total: flows.length,
      invalid: flows.filter((flow) => flow.errors.length > 0).length,
      warnings: flows.reduce((count, flow) => count + flow.warnings.length, 0),
    },
  }
}

/** @param {number} count @param {string} noun */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** @param {LintFlowResult} flow @param {LintDiagnostic} diagnostic */
function diagnosticScope(flow, diagnostic) {
  if (!diagnostic.stepId) return 'flow'
  const index = flow.stepIds.indexOf(diagnostic.stepId)
  return index === -1 ? diagnostic.stepId : `steps[${index}] ${diagnostic.stepId}`
}

/**
 * Formats the human-readable lint report.
 * @param {LintReport} report
 * @param {{ color?: boolean }} [options]
 * @returns {string}
 */
function formatLintReport(report, { color = false } = {}) {
  const paint = (/** @type {string} */ code, /** @type {string} */ text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
  const lines = []
  for (const flow of report.flows) {
    if (flow.errors.length === 0 && flow.warnings.length === 0) {
      lines.push(`${paint('32', '✔')} ${flow.id}`)
    } else {
      const mark = flow.errors.length > 0 ? paint('31', '✖') : paint('33', '⚠')
      lines.push(`${mark} ${flow.id} (${plural(flow.errors.length, 'error')}, ${plural(flow.warnings.length, 'warning')})`)
    }
    for (const diagnostic of [...flow.errors, ...flow.warnings]) {
      lines.push(`  ${diagnosticScope(flow, diagnostic)} ${diagnostic.code}: ${diagnostic.message}`)
      if (diagnostic.hint) lines.push(`    fix: ${diagnostic.hint}`)
    }
    for (const candidate of flow.shadowed) {
      lines.push(`  info: shadows ${candidate.file} (${candidate.status})`)
    }
  }
  const { total, invalid, warnings } = report.summary
  lines.push('')
  lines.push(`${plural(total, 'flow')} checked: ${invalid} invalid, ${plural(warnings, 'warning')}`)
  return lines.join('\n')
}

/**
 * Exit code for a lint report: 1 on any error, or on warnings in strict mode.
 * @param {LintReport} report
 * @param {{ strict?: boolean }} [options]
 */
function lintExitCode(report, { strict = false } = {}) {
  if (report.summary.invalid > 0) return 1
  if (strict && report.summary.warnings > 0) return 1
  return 0
}

/**
 * `nax lint [flows...] [--json] [--strict]` handler.
 * @param {LintOptions} [options]
 * @param {LintDependencies} [deps]
 * @returns {Promise<number>}
 */
async function handleLint(options = {}, { stdout = (text) => process.stdout.write(`${text}\n`), isTTY = Boolean(process.stdout.isTTY) } = {}) {
  const report = await buildLintReport(options)
  stdout(options.json ? JSON.stringify(report, null, 2) : formatLintReport(report, { color: isTTY }))
  const exitCode = lintExitCode(report, { strict: options.strict })
  process.exitCode = exitCode
  return exitCode
}

module.exports = {
  buildLintReport,
  formatLintReport,
  handleLint,
  lintExitCode,
}
