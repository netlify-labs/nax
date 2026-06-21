const { isHumanReviewStep, loadStepPrompt } = require('./flows')

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

function uniqueRunAgents(runs = []) {
  const seen = new Set()
  const agents = []
  for (const run of Array.isArray(runs) ? runs : []) {
    const agent = String(run?.agent || '').trim()
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    agents.push(agent)
  }
  return agents
}

function stepSelectedAgents(step = {}, runState = null) {
  if (!runState) return null
  const savedSteps = Array.isArray(runState?.steps) ? runState.steps : []
  const saved = savedSteps.find((candidate) => candidate.id === step.id)
  if (!saved) return null

  const selected = uniqueRunAgents(saved.runs)
  if (selected.length > 0) return selected

  const savedAgents = filteredAgents(saved.agents)
  return savedAgents.length > 0 ? savedAgents : null
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
  return uniqueRunAgents(step.runs)
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

/**
 * Convert a Nax workflow definition into React Flow nodes and edges.
 *
 * @typedef {{
 *   flow?: import('./types').WorkflowFlow,
 *   selectedAgents?: string[] | null,
 *   runState?: import('./types').WorkflowRunState | null,
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
      agents: filteredAgents(step.agents, selected),
    }))
    .filter((item) => isHumanReviewStep(item.step) || item.agents.length > 0)
  const runnableIds = new Set(runnableSteps.map((item) => item.step.id))

  const nodes = runnableSteps.map(({ step, index, agents }, graphIndex) => {
    const prompt = stepPrompt(step, flow)
    return {
      id: step.id,
      type: 'workflowStep',
      position: {
        x: 0,
        y: graphIndex * 220,
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
        input: Array.isArray(step.input) ? step.input.map((input) => ({ ...input })) : [],
        status: stepStatus(step, runState),
        runs: stepRuns(step, runState).map((run) => ({ ...run })),
        sourceLabel: flow.sourceLabel || flow.source || '',
        selectedAgents: stepSelectedAgents(step, runState) || undefined,
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
      selectedAgents: selected ? [...selected] : [],
      hasRunState: Boolean(runState),
    },
  }
}

module.exports = {
  flowToGraph,
}
