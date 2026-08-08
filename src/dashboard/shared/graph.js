const { isHumanReviewStep, loadStepPrompt } = require('../../workflows/catalog/flows')
const { publicInstances, publicRunInstance } = require('../api/instances')

const WORKFLOW_NODE_LAYOUT = {
  width: 300,
  verticalGap: 36,
  headerHeight: 74,
  titleLineHeight: 20,
  descriptionCharsPerLine: 38,
  descriptionLineHeight: 19,
  descriptionPaddingTop: 12,
  agentRowPadding: 24,
  agentRowGap: 8,
  agentChipHeight: 28,
  agentChipGap: 8,
  agentChipBaseWidth: 40,
  agentChipCharacterWidth: 7,
  footerHeight: 38,
}

function normalizeSelectedAgents(selectedAgents) {
  if (!Array.isArray(selectedAgents)) return null
  const normalized = selectedAgents.map((agent) => String(agent || '').trim()).filter(Boolean)
  return normalized.length > 0 ? new Set(normalized) : null
}

function filteredAgents(agents = [], selectedAgents = null) {
  const normalized = Array.isArray(agents) ? agents.map(String).filter(Boolean) : []
  if (!selectedAgents) return normalized
  return normalized.filter((agent) => selectedAgents.has(agent))
}

/** @param {Array<Record<string, unknown>>} instances @param {Set<string>|null} selectedAgents */
function filteredInstances(instances = [], selectedAgents = null) {
  if (!selectedAgents) return instances
  return instances.filter((instance) => selectedAgents.has(String(instance.agent || '')))
}

/** @param {Array<Record<string, unknown>>} instances */
function providersForInstances(instances = []) {
  return [...new Set(instances.map((instance) => String(instance.agent || '')).filter(Boolean))]
}

/** @param {unknown} value @returns {Record<string, string>} */
function stringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
}

/** @param {Record<string, unknown>} flow @param {Record<string, unknown>} step */
function instancesForDefinitionStep(flow, step) {
  const defaults = flow.defaults && typeof flow.defaults === 'object' && !Array.isArray(flow.defaults)
    ? /** @type {Record<string, unknown>} */ (flow.defaults)
    : {}
  return publicInstances(step.lineup || step.agents, {
    models: { ...stringMap(defaults.models), ...stringMap(step.models) },
    efforts: { ...stringMap(defaults.efforts), ...stringMap(step.efforts) },
  })
}

function stepStatus(step = {}, runState = null) {
  const savedSteps = Array.isArray(runState?.steps) ? runState.steps : []
  const saved = savedSteps.find((candidate) => candidate.id === step.id)
  return saved?.status || 'definition'
}

function stepRuns(step = {}, runState = null) {
  const savedSteps = Array.isArray(runState?.steps) ? runState.steps : []
  const saved = savedSteps.find((candidate) => candidate.id === step.id)
  return Array.isArray(saved?.runs) ? saved.runs : []
}

function uniqueRunInstances(runs = []) {
  const seen = new Set()
  const instances = []
  for (const run of Array.isArray(runs) ? runs : []) {
    const instance = publicRunInstance(run)
    if (!instance || seen.has(instance.id)) continue
    seen.add(instance.id)
    instances.push({ ...instance, status: String(run?.status || '') })
  }
  return instances
}

function stepSelectedInstances(flow = {}, step = {}, runState = null) {
  if (!runState) return instancesForDefinitionStep(flow, step)
  const savedSteps = Array.isArray(runState?.steps) ? runState.steps : []
  const saved = savedSteps.find((candidate) => candidate.id === step.id)
  if (!saved) return null

  const selected = uniqueRunInstances(saved.runs)
  if (selected.length > 0) return selected

  const savedInstances = publicInstances(saved.lineup || saved.agents, {
    models: saved.models,
    efforts: saved.efforts,
  })
  return savedInstances.length > 0 ? savedInstances : null
}

function stepPrompt(step = {}, flow = {}) {
  try {
    const prompt = loadStepPrompt(flow, step)
    return {
      promptMarkdown: prompt.body || '',
      promptPath: prompt.path || '',
      promptTitle: prompt.title || step.title || step.id || '',
    }
  } catch (_err) {
    return {
      promptMarkdown: '',
      promptPath: '',
      promptTitle: step.title || step.id || '',
    }
  }
}

function edgeKind(step = {}) {
  if (isHumanReviewStep(step)) return 'human-review'
  if (step.submit === 'follow-up') return 'follow-up'
  if (step.action === 'comment') return 'comment'
  return 'sequence'
}

function edgeLabel(step = {}) {
  if (isHumanReviewStep(step)) return 'human review'
  if (step.submit === 'follow-up') return 'follow-up session'
  if (step.submit === 'new-run') return 'new agent run'
  return step.submit || ''
}

function explicitInputSteps(step = {}) {
  if (!Array.isArray(step.input)) return []
  const out = []
  const seen = new Set()
  for (const input of step.input) {
    const source = String(input?.step || '').trim()
    if (!source || seen.has(source)) continue
    seen.add(source)
    out.push(source)
  }
  return out
}

function createEdge({ source, target, step, implicit = false }) {
  const kind = edgeKind(step)
  return {
    id: `edge:${source}:${target}`,
    source,
    target,
    type: 'smoothstep',
    animated: kind === 'follow-up',
    data: {
      kind,
      implicit,
      submit: step.submit || '',
      action: step.action || '',
      waitFor: step.waitFor || '',
    },
  }
}

function flowAgents(steps = []) {
  const seen = new Set()
  const agents = []
  for (const step of steps) {
    for (const agent of step.agents || []) {
      if (seen.has(agent)) continue
      seen.add(agent)
      agents.push(agent)
    }
  }
  return agents
}

function agentsForSavedStep(step = {}) {
  const declared = filteredAgents(step.agents)
  if (declared.length > 0) return declared
  return providersForInstances(uniqueRunInstances(step.runs))
}

function hasPath(edges, source, target, ignoredEdgeId, visited = new Set()) {
  if (source === target) return true
  if (visited.has(source)) return false
  visited.add(source)
  for (const edge of edges) {
    if (edge.id === ignoredEdgeId || edge.source !== source) continue
    if (hasPath(edges, edge.target, target, ignoredEdgeId, visited)) return true
  }
  return false
}

function reduceTransitiveEdges(edges = []) {
  return edges.filter((edge) => !hasPath(edges, edge.source, edge.target, edge.id))
}

/** @param {string} value */
function titleCase(value) {
  return value.replace(/(^|-)([a-z])/g, (_match, prefix, char) => `${prefix}${char.toUpperCase()}`)
}

/**
 * @param {string} text
 * @param {number} charsPerLine
 * @returns {number}
 */
function estimatedLineCount(text, charsPerLine) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return 0
  return Math.max(1, Math.ceil(normalized.length / charsPerLine))
}

/**
 * @param {string} agent
 * @returns {number}
 */
function estimatedAgentChipWidth(agent) {
  return WORKFLOW_NODE_LAYOUT.agentChipBaseWidth + titleCase(String(agent || '')).length * WORKFLOW_NODE_LAYOUT.agentChipCharacterWidth
}

/**
 * @param {string[]} agents
 * @returns {number}
 */
function estimatedAgentRowCount(agents = []) {
  const availableWidth = WORKFLOW_NODE_LAYOUT.width - WORKFLOW_NODE_LAYOUT.agentRowPadding
  const chipWidths = agents.length > 0 ? agents.map(estimatedAgentChipWidth) : [118]
  let rows = 1
  let rowWidth = 0

  for (const chipWidth of chipWidths) {
    const nextWidth = rowWidth > 0
      ? rowWidth + WORKFLOW_NODE_LAYOUT.agentChipGap + chipWidth
      : chipWidth
    if (rowWidth > 0 && nextWidth > availableWidth) {
      rows += 1
      rowWidth = chipWidth
    } else {
      rowWidth = nextWidth
    }
  }

  return rows
}

/**
 * Estimate the custom React Flow node height before the browser measures it.
 * React Flow positions nodes from the supplied coordinates; it does not reserve
 * spacing for taller custom-node content by itself.
 *
 * @param {import('../../types').WorkflowStep | Record<string, unknown>} step
 * @param {string[]} agents
 * @returns {number}
 */
function estimatedWorkflowNodeHeight(step = {}, agents = []) {
  const title = String(step.title || step.id || '')
  const description = String(step.description || '')
  const titleLines = estimatedLineCount(title, 30) || 1
  const descriptionLines = estimatedLineCount(description, WORKFLOW_NODE_LAYOUT.descriptionCharsPerLine)
  const agentRows = estimatedAgentRowCount(agents)

  const titleOverflowHeight = Math.max(0, titleLines - 1) * WORKFLOW_NODE_LAYOUT.titleLineHeight
  const descriptionHeight = descriptionLines > 0
    ? WORKFLOW_NODE_LAYOUT.descriptionPaddingTop + descriptionLines * WORKFLOW_NODE_LAYOUT.descriptionLineHeight
    : 0
  const agentRowsHeight = WORKFLOW_NODE_LAYOUT.agentRowPadding +
    agentRows * WORKFLOW_NODE_LAYOUT.agentChipHeight +
    Math.max(0, agentRows - 1) * WORKFLOW_NODE_LAYOUT.agentRowGap

  return Math.ceil(
    WORKFLOW_NODE_LAYOUT.headerHeight +
    titleOverflowHeight +
    descriptionHeight +
    agentRowsHeight +
    WORKFLOW_NODE_LAYOUT.footerHeight,
  )
}

/**
 * Convert a Nax workflow definition into React Flow nodes and edges.
 *
 * @typedef {{
 *   flow?: import('../../types').WorkflowFlow,
 *   selectedAgents?: string[] | null,
 *   runState?: import('../../types').WorkflowRunState | null,
 * }} FlowToGraphOptions
 *
 * @param {FlowToGraphOptions} [options]
 */
function flowToGraph(options = {}) {
  const { flow = {}, selectedAgents, runState = null } = options
  const steps = Array.isArray(flow.steps) ? flow.steps : []
  const definedStepIds = new Set(steps.map((step) => String(step?.id || '')).filter(Boolean))
  const savedOnlySteps = Array.isArray(runState?.steps)
    ? runState.steps
        .filter((step) => {
          const id = String(step?.id || '')
          return id && !definedStepIds.has(id)
        })
        .map((step) => ({
          id: step.id || '',
          title: step.title || step.id || '',
          description: step.description || '',
          action: step.action || 'agent-run',
          submit: step.submit || '',
          waitFor: step.waitFor || '',
          agents: agentsForSavedStep(step),
          lineup: uniqueRunInstances(step.runs),
          input: Array.isArray(step.input) ? step.input.map((input) => ({ ...input })) : [],
          source: step.source || null,
          savedOnly: true,
        }))
    : []
  const selected = normalizeSelectedAgents(selectedAgents)
  const graphSteps = [...steps, ...savedOnlySteps]
  const runnableSteps = graphSteps
    .map((step, index) => ({
      step,
      index,
      instances: filteredInstances(instancesForDefinitionStep(flow, step), selected),
    }))
    .map((item) => ({ ...item, agents: providersForInstances(item.instances) }))
    .filter((item) => isHumanReviewStep(item.step) || item.instances.length > 0)
  const runnableIds = new Set(runnableSteps.map((item) => item.step.id))

  let nextNodeY = 0
  const nodes = runnableSteps.map(({ step, index, agents, instances }, graphIndex) => {
    const prompt = stepPrompt(step, flow)
    const y = nextNodeY
    nextNodeY += estimatedWorkflowNodeHeight(step, agents) + WORKFLOW_NODE_LAYOUT.verticalGap
    return {
      id: step.id,
      type: 'workflowStep',
      position: {
        x: 0,
        y,
      },
      data: {
        kind: 'workflow-step',
        flowId: flow.id || '',
        stepId: step.id || '',
        index,
        graphIndex,
        number: graphIndex + 1,
        title: step.title || step.id || `Step ${graphIndex + 1}`,
        description: step.description || '',
        action: step.action || '',
        submit: step.submit || '',
        submitLabel: edgeLabel(step),
        waitFor: step.waitFor || '',
        agents,
        instances,
        input: Array.isArray(step.input) ? step.input.map((input) => ({ ...input })) : [],
        status: stepStatus(step, runState),
        runs: stepRuns(step, runState).map((run) => ({ ...run })),
        sourceLabel: flow.sourceLabel || flow.source || '',
        selectedAgents: stepSelectedInstances(flow, step, runState) || undefined,
        inheritedFromStepId: step.submit === 'follow-up' ? explicitInputSteps(step)[0] || '' : '',
        ...prompt,
      },
    }
  })

  const candidateEdges = []
  const seenEdges = new Set()
  for (let i = 0; i < runnableSteps.length; i += 1) {
    const { step } = runnableSteps[i]
    const explicitSources = explicitInputSteps(step).filter((source) => runnableIds.has(source))
    const sources = explicitSources.length > 0
      ? explicitSources
      : i > 0
        ? [runnableSteps[i - 1].step.id]
        : []

    for (const source of sources) {
      const edge = createEdge({
        source,
        target: step.id,
        step,
        implicit: explicitSources.length === 0,
      })
      if (seenEdges.has(edge.id)) continue
      seenEdges.add(edge.id)
      candidateEdges.push(edge)
    }
  }
  const edges = reduceTransitiveEdges(candidateEdges)

  return {
    nodes,
    edges,
    metadata: {
      flowId: flow.id || '',
      title: flow.title || flow.id || '',
      description: flow.description || '',
      source: flow.source || '',
      sourceLabel: flow.sourceLabel || flow.source || '',
      stepCount: steps.length,
      renderedStepCount: nodes.length,
      agents: flowAgents(runnableSteps.map((item) => ({ ...item.step, agents: item.agents }))),
      selectedAgents: selected
        ? runnableSteps.flatMap((item) => item.instances)
        : [],
      hasRunState: Boolean(runState),
    },
  }
}

module.exports = {
  flowToGraph,
}
