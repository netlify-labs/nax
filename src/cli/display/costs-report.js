// Builds the nax costs report: credits-led usage rows over recent workflow
// run states plus a grand total, for table and --json output.
const { addUsage, formatUsageSummary, hasUsage, usageSummariesForRunState } = require('../../workflows/results/agent-run-results')

/**
 * @typedef {{
 *   runId: string,
 *   flowId: string,
 *   flowTitle: string,
 *   status: string,
 *   createdAt: string,
 *   usage: import('../../types').UsageSummary,
 *   summary: string,
 * }} CostsReportRow
 *
 * @typedef {{
 *   runs: CostsReportRow[],
 *   total: import('../../types').UsageSummary,
 *   totalSummary: string,
 *   shownCount: number,
 *   totalCount: number,
 * }} CostsReport
 */

/**
 * @param {Array<Record<string, unknown>>} runStates
 * @param {{ limit?: number }} [options]
 * @returns {CostsReport}
 */
function buildCostsReport(runStates = [], { limit = 20 } = {}) {
  const sorted = [...runStates].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  const selected = sorted.slice(0, Math.max(1, limit))
  let total = {}
  const runs = selected.map((state) => {
    const usage = usageSummariesForRunState(state).total
    if (hasUsage(usage)) total = addUsage(total, usage)
    return {
      runId: String(state.runId || ''),
      flowId: String(state.flowId || ''),
      flowTitle: String(state.flowTitle || state.flowId || state.runId || ''),
      status: String(state.status || ''),
      createdAt: String(state.createdAt || ''),
      usage,
      summary: formatUsageSummary(usage),
    }
  })
  return {
    runs,
    total,
    totalSummary: formatUsageSummary(total),
    shownCount: runs.length,
    totalCount: runStates.length,
  }
}

/**
 * @param {CostsReport} report
 * @returns {string[]}
 */
function formatCostsTable(report) {
  const lines = []
  for (const run of report.runs) {
    const usagePart = run.summary || 'no usage reported'
    lines.push(`${run.createdAt.slice(0, 10)}  ${run.flowTitle} (${run.status}) — ${usagePart}`)
    lines.push(`  ${run.runId}`)
  }
  lines.push('')
  lines.push(`Total (${report.shownCount} runs): ${report.totalSummary || 'no usage reported'}`)
  return lines
}

module.exports = {
  buildCostsReport,
  formatCostsTable,
}
