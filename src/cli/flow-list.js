const path = require('path')
const { makeBox, makeStackedBoxes } = require('@davidwells/box-logger')
const { titleCase } = require('../prompts')

const MUTED_COLOR = '#64748b'
const TEAL_COLOR = '#0d9488'
const AD_HOC_RUN_TARGET = '__ad_hoc_agent_run__'

const BUNDLED_WORKFLOW_HINTS = {
  review: 'Review, cross-review, synthesize',
  ideas: 'Generate and rank project ideas',
  'do-next': 'Pick the next development task',
  'security-audit': 'Find and rank security issues',
  'performance-audit': 'Find bottlenecks and measurement gaps',
  'analytics-audit': 'Find missing telemetry',
  'seo-audit': 'Find metadata and crawlability gaps',
  'accessibility-audit': 'Find WCAG accessibility issues',
  'mobile-responsiveness': 'Check mobile layout and touch targets',
  'e2e-tests': 'Add Playwright tests for critical flows',
  'unit-tests': 'Add focused unit tests',
  documentation: 'Improve README and architecture docs',
  'error-handling': 'Improve errors, logging, and retries',
  'ux-copy-polish': 'Polish UX states and copy',
}

const AD_HOC_RUN_CHOICE = {
  value: AD_HOC_RUN_TARGET,
  label: 'Start a single Netlify agent with a custom prompt',
}

/**
 * Flow step fields serialized by `nax list --json`.
 * @typedef {import('../types').WorkflowStep & {
 *   autoArchive?: boolean | null,
 *   isArchivable?: boolean,
 * }} FlowListStep
 *
 * Flow fields rendered by list and picker views.
 * @typedef {import('../types').WorkflowFlow & {
 *   steps?: FlowListStep[],
 * }} FlowListFlow
 *
 * Options for formatting human flow lists.
 * @typedef {{
 *   columns?: number,
 *   verbose?: boolean,
 *   baseDir?: string,
 * }} FormatFlowListOptions
 *
 * Options for formatting one flow list box.
 * @typedef {{
 *   width?: number,
 *   verbose?: boolean,
 *   baseDir?: string,
 * }} FormatFlowListBoxOptions
 *
 * Workflow picker label options.
 * @typedef {{
 *   includeAdHoc?: boolean,
 * }} WorkflowPickerLabelOptions
 */

/**
 * Wraps prose to a target width.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function wordWrap(text, width) {
  if (!text) return ''
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Resolves a path-like value or returns an empty string.
 * @param {string | null | undefined} value
 * @param {string} [baseDir]
 * @returns {string}
 */
function absolutePathOrEmpty(value, baseDir = '') {
  if (!value) return ''
  const raw = String(value)
  if (path.isAbsolute(raw)) return raw
  return path.resolve(baseDir || process.cwd(), raw)
}

/**
 * Converts one flow to the stable `nax list --json` item shape.
 * @param {FlowListFlow} [flow]
 * @returns {import('../types').JsonMap}
 */
function flowListJsonItem(flow = {}) {
  const flowDir = absolutePathOrEmpty(flow.dir)
  return {
    id: flow.id || '',
    title: flow.title || '',
    description: flow.description || '',
    source: flow.source || '',
    sourceLabel: flow.sourceLabel || '',
    sourceDir: absolutePathOrEmpty(flow.sourceDir),
    sourcePriority: flow.sourcePriority ?? null,
    dir: flowDir,
    file: absolutePathOrEmpty(flow.file, flowDir),
    defaults: flow.defaults || {},
    options: flow.options || {},
    steps: Array.isArray(flow.steps)
      ? flow.steps.map((step) => ({
        id: step.id || '',
        title: step.title || '',
        description: step.description || '',
        prompt: absolutePathOrEmpty(step.prompt, flowDir),
        action: step.action || '',
        submit: step.submit || '',
        agents: Array.isArray(step.agents) ? step.agents : [],
        input: Array.isArray(step.input) ? step.input : [],
        waitFor: step.waitFor || '',
        autoArchive: step.autoArchive,
        isArchivable: step.isArchivable,
      }))
      : [],
  }
}

/**
 * Formats flows as a stable JSON document.
 * @param {FlowListFlow[]} [flows]
 * @returns {string}
 */
function formatFlowListJson(flows = []) {
  const items = Array.isArray(flows) ? flows.map(flowListJsonItem) : []
  return JSON.stringify({ count: items.length, items }, null, 2)
}

/**
 * Returns title-cased unique agent models used by a flow.
 * @param {FlowListFlow} [flow]
 * @returns {string[]}
 */
function flowListModels(flow = {}) {
  const models = []
  const seen = new Set()
  for (const step of flow.steps || []) {
    for (const agent of step.agents || []) {
      if (seen.has(agent)) continue
      seen.add(agent)
      models.push(titleCase(agent))
    }
  }
  return models
}

/**
 * Formats a flow directory relative to the invocation directory when possible.
 * @param {FlowListFlow} [flow]
 * @param {string} [baseDir]
 * @returns {string}
 */
function formatFlowDirectory(flow = {}, baseDir = process.cwd()) {
  if (!flow.dir) return ''
  const absoluteDir = absolutePathOrEmpty(flow.dir)
  const relative = path.relative(baseDir || process.cwd(), absoluteDir)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return `./${relative}`
  return absoluteDir
}

/**
 * Formats one flow box descriptor for stacked box rendering.
 * @param {FlowListFlow} [flow]
 * @param {FormatFlowListBoxOptions} [options]
 * @returns {import('../types').JsonMap}
 */
function formatFlowListBox(flow = {}, { width = 100, verbose = false, baseDir = process.cwd() } = {}) {
  const innerWidth = Math.max(20, width - 6)
  const id = flow.id || 'workflow'
  const title = flow.title || id
  const lines = []
  if (flow.description) lines.push(wordWrap(flow.description, innerWidth))
  if (verbose) {
    const steps = Array.isArray(flow.steps) ? flow.steps.length : 0
    const models = flowListModels(flow).join(', ') || 'none'
    const directory = formatFlowDirectory(flow, baseDir)
    if (lines.length > 0) lines.push('')
    lines.push(`Steps:      ${steps}`)
    lines.push(`Models:     ${models}`)
    if (directory) lines.push(`Location:   ${directory}`)
  }
  return {
    title: {
      left: `${id} - ${title}`,
      right: flow.sourceLabel || flow.source || '',
      truncate: true,
    },
    content: lines.join('\n'),
  }
}

/**
 * Formats available flows for human CLI output.
 * @param {FlowListFlow[]} [flows]
 * @param {FormatFlowListOptions} [options]
 * @returns {string}
 */
function formatFlowList(flows = [], { columns = process.stdout.columns || 100, verbose = false, baseDir = process.cwd() } = {}) {
  const width = Math.min(120, Math.max(72, Math.floor(columns * 0.95)))
  if (flows.length === 0) {
    return makeBox({
      title: 'Workflows',
      content: 'No workflows found.',
      borderStyle: 'rounded',
      borderColor: MUTED_COLOR,
      width,
    })
  }
  return makeStackedBoxes(flows.map((flow) => formatFlowListBox(flow, { width, verbose, baseDir })), {
    borderText: `Workflows (${flows.length})`,
    borderStyle: 'rounded',
    borderColor: TEAL_COLOR,
    disableTitleSeparator: true,
    maxWidth: width,
  })
}

/**
 * Trims sentence punctuation from picker hints.
 * @param {string} [description]
 * @returns {string}
 */
function trimWorkflowHint(description = '') {
  return String(description || '').replace(/\.+$/, '')
}

/**
 * Compacts a flow description for a picker hint.
 * @param {string} [description]
 * @param {number} [maxLength]
 * @returns {string}
 */
function compactWorkflowDescription(description = '', maxLength = 48) {
  const normalized = String(description || '').replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length <= maxLength) return trimWorkflowHint(normalized)
  const clipped = normalized.slice(0, maxLength + 1)
  const lastSpace = clipped.lastIndexOf(' ')
  const prefix = (lastSpace > 24 ? clipped.slice(0, lastSpace) : normalized.slice(0, maxLength)).replace(/[.,;:!?-]+$/, '')
  return `${prefix}...`
}

/**
 * Formats one workflow picker hint.
 * @param {FlowListFlow} [flow]
 * @returns {string}
 */
function workflowPickerHint(flow = {}) {
  if (flow.source === 'bundled' && BUNDLED_WORKFLOW_HINTS[flow.id]) return BUNDLED_WORKFLOW_HINTS[flow.id]
  return compactWorkflowDescription(flow.description)
}

/**
 * Formats one workflow picker label.
 * @param {FlowListFlow} [flow]
 * @param {WorkflowPickerLabelOptions} [options]
 * @returns {string}
 */
function workflowPickerLabel(flow = {}, { includeAdHoc = true } = {}) {
  if (!includeAdHoc) return flow.source === 'project' ? `${flow.title} (local)` : flow.title || ''
  return `${flow.source === 'project' ? 'Workflow' : 'NAX Workflow'} - ${flow.title || ''}`
}

module.exports = {
  AD_HOC_RUN_CHOICE,
  AD_HOC_RUN_TARGET,
  BUNDLED_WORKFLOW_HINTS,
  absolutePathOrEmpty,
  compactWorkflowDescription,
  flowListJsonItem,
  flowListModels,
  formatFlowDirectory,
  formatFlowList,
  formatFlowListBox,
  formatFlowListJson,
  trimWorkflowHint,
  workflowPickerHint,
  workflowPickerLabel,
}
