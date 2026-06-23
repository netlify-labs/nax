const path = require('path')
const { listFlows } = require('../../src/workflows/catalog/flows')

/**
 * Markdown Magic transform input.
 * @typedef {{
 *   content: string,
 *   options: Record<string, string | number | boolean | string[] | undefined>,
 *   srcPath?: string,
 * }} TransformApi
 *
 * Renderable workflow table row.
 * @typedef {{
 *   id: string,
 *   title: string,
 *   description: string,
 *   path: string,
 *   steps: string,
 *   agents: string,
 * }} WorkflowTableRow
 */

/**
 * Escapes a Markdown table cell.
 * @param {string} value
 * @returns {string}
 */
function tableCell(value) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

/**
 * Formats workflow agents as a comma-separated stable list.
 * @param {import('../../src/types').WorkflowFlow} flow
 * @returns {string}
 */
function workflowAgents(flow) {
  const agents = new Set()
  for (const agent of flow.defaults?.agents || []) {
    if (agent) agents.add(agent)
  }
  for (const step of flow.steps || []) {
    for (const agent of step.agents || []) {
      if (agent) agents.add(agent)
    }
  }
  return Array.from(agents).sort().join(', ')
}

/**
 * Formats the workflow step summary.
 * @param {import('../../src/types').WorkflowFlow} flow
 * @returns {string}
 */
function workflowSteps(flow) {
  const steps = flow.steps || []
  const count = steps.length
  const label = count === 1 ? 'step' : 'steps'
  return `${count} ${label}`
}

/**
 * Converts a loaded workflow into a table row.
 * @param {import('../../src/types').WorkflowFlow} flow
 * @returns {WorkflowTableRow}
 */
function workflowTableRow(flow) {
  const flowPath = flow.file ? path.relative(process.cwd(), flow.file) : path.join('workflows', String(flow.id || ''), 'flow.yml')
  return {
    id: String(flow.id || ''),
    title: String(flow.title || flow.id || ''),
    description: String(flow.description || ''),
    path: flowPath,
    steps: workflowSteps(flow),
    agents: workflowAgents(flow),
  }
}

/**
 * Renders the bundled workflow inventory as a Markdown table.
 * @param {WorkflowTableRow[]} rows
 * @returns {string}
 */
function renderWorkflowTable(rows) {
  const lines = [
    '| Workflow | Description | Steps | Agents | Definition |',
    '| --- | --- | ---: | --- | --- |',
  ]
  for (const row of rows) {
    lines.push([
      `\`${tableCell(row.id)}\``,
      tableCell(row.description || row.title),
      tableCell(row.steps),
      tableCell(row.agents || '-'),
      `[${tableCell(row.path)}](./${tableCell(path.relative('workflows', row.path))})`,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  return lines.join('\n')
}

/**
 * Markdown Magic transform for the bundled workflow inventory table.
 * @param {TransformApi} _api
 * @returns {Promise<string>}
 */
async function workflowTable(_api) {
  const flows = await listFlows()
  const rows = flows.map(workflowTableRow)
  return renderWorkflowTable(rows)
}

module.exports = workflowTable
