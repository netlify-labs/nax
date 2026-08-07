const { DEFAULT_AGENT_PROVIDERS } = require('../constants')

/**
 * Parsed agent-provider override for one workflow step.
 * @typedef {{
 *   error: string,
 *   stepId?: never,
 *   agents?: never,
 * } | {
 *   error?: undefined,
 *   stepId: string,
 *   agents: string[],
 * }} StepAgentParseResult
 *
 * Agent lists keyed by workflow step id.
 * @typedef {Record<string, string[]>} StepAgentMap
 *
 * Raw step agent override input accepted from CLI flags and config.
 * @typedef {string | string[] | Record<string, unknown>} StepAgentInput
 *
 * User-selected agent filters for a workflow run.
 * @typedef {{
 *   agents?: unknown,
 *   stepAgents?: StepAgentInput,
 * }} AgentSelection
 *
 * Agent names that are valid for flow declarations.
 * @typedef {{
 *   knownAgents?: unknown,
 * }} AgentSelectionValidationOptions
 *
 * Structured validation failure for agent selection.
 * @typedef {{
 *   code: string,
 *   message: string,
 * }} AgentSelectionValidationError
 */

/** @param {unknown} value @returns {string[]} */
function normalizeAgentList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const agent = String(item || '').trim()
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    out.push(agent)
  }
  return out
}

/** @param {unknown} entry @returns {StepAgentParseResult} */
function parseStepAgentEntry(entry) {
  const text = String(entry || '')
  const index = text.indexOf('=')
  if (index === -1) {
    return {
      error: `Step agent override "${text}" must use step=agent,agent syntax.`,
    }
  }
  const stepId = text.slice(0, index).trim()
  if (!stepId) {
    return {
      error: `Step agent override "${text}" is missing a step id.`,
    }
  }
  return {
    stepId,
    agents: normalizeAgentList(text.slice(index + 1)),
  }
}

/** @param {unknown} value @returns {StepAgentMap} */
function normalizeStepAgents(value) {
  if (!value) {
    /** @type {StepAgentMap} */
    const empty = {}
    return empty
  }
  /** @type {StepAgentMap} */
  const out = {}
  if (typeof value === 'string') {
    const parsed = parseStepAgentEntry(value)
    if (!parsed.error) out[parsed.stepId] = parsed.agents
    return out
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseStepAgentEntry(entry)
      if (!parsed.error) out[parsed.stepId] = parsed.agents
    }
    return out
  }
  if (typeof value === 'object') {
    for (const [stepId, agents] of Object.entries(value)) {
      const id = String(stepId || '').trim()
      if (!id) continue
      out[id] = normalizeAgentList(agents)
    }
  }
  return out
}

/** @param {unknown} entries @returns {StepAgentMap} */
function parseStepAgentsEntries(entries) {
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    return normalizeStepAgents(entries)
  }
  const values = Array.isArray(entries) ? entries : entries ? [entries] : []
  /** @type {StepAgentMap} */
  const out = {}
  for (const entry of values) {
    const parsed = parseStepAgentEntry(entry)
    if (parsed.error) throw new Error(parsed.error)
    out[parsed.stepId] = parsed.agents
  }
  return out
}

/** @param {unknown} stepAgents @returns {string[]} */
function stepAgentsToEntries(stepAgents) {
  return Object.entries(normalizeStepAgents(stepAgents))
    .map(([stepId, agents]) => `${stepId}=${agents.join(',')}`)
}

/** @param {import('../../types').WorkflowFlow} [flow] @returns {Set<string>} */
function flowAgentSet(flow = {}) {
  const agents = new Set()
  for (const agent of normalizeAgentList(flow.defaults?.agents)) agents.add(agent)
  for (const step of flow.steps || []) {
    for (const agent of normalizeAgentList(step.agents)) agents.add(agent)
  }
  return agents
}

/**
 * @param {import('../../types').WorkflowFlow} [flow]
 * @param {AgentSelectionValidationOptions} [options]
 * @returns {AgentSelectionValidationError[]}
 */
function flowDeclaredAgentValidationErrors(flow = {}, { knownAgents = DEFAULT_AGENT_PROVIDERS } = {}) {
  const errors = []
  const known = new Set(normalizeAgentList(knownAgents))
  const knownLabel = [...known].join(', ') || 'none'
  for (const agent of normalizeAgentList(flow.defaults?.agents)) {
    if (!known.has(agent)) {
      errors.push({
        code: 'unknown_flow_agent',
        message: `Unknown agent "${agent}" in defaults.agents for flow "${flow.id}". Known agents: ${knownLabel}.`,
      })
    }
  }
  for (const step of flow.steps || []) {
    for (const agent of normalizeAgentList(step.agents)) {
      if (!known.has(agent)) {
        errors.push({
          code: 'unknown_step_agent',
          message: `Unknown agent "${agent}" in step "${step.id}" for flow "${flow.id}". Known agents: ${knownLabel}.`,
        })
      }
    }
  }
  return errors
}

/**
 * @param {import('../../types').WorkflowFlow} [flow]
 * @param {AgentSelection} [selection]
 * @param {AgentSelectionValidationOptions} [options]
 * @returns {AgentSelectionValidationError[]}
 */
function selectionValidationErrors(flow = {}, selection = {}, options = {}) {
  const errors = flowDeclaredAgentValidationErrors(flow, options)
  const flowAgents = flowAgentSet(flow)
  for (const agent of normalizeAgentList(selection.agents)) {
    if (!flowAgents.has(agent)) {
      errors.push({ code: 'invalid_agent', message: `Unknown agent "${agent}" for flow "${flow.id}".` })
    }
  }

  const steps = new Map((flow.steps || []).map((step) => [step.id, step]))
  for (const [stepId, agents] of Object.entries(normalizeStepAgents(selection.stepAgents))) {
    const step = steps.get(stepId)
    if (!step) {
      errors.push({ code: 'invalid_step_agents', message: `Unknown step "${stepId}" in flow "${flow.id}".` })
      continue
    }
    const stepAgents = new Set(normalizeAgentList(step.agents))
    for (const agent of agents) {
      if (!stepAgents.has(agent)) {
        errors.push({
          code: 'invalid_step_agent',
          message: `Agent "${agent}" is not configured for step "${stepId}" in flow "${flow.id}".`,
        })
      }
    }
  }
  return errors
}

/**
 * @param {import('../../types').WorkflowFlow} flow
 * @param {AgentSelection} [selection]
 * @param {AgentSelectionValidationOptions} [options]
 * @returns {void}
 */
function assertValidAgentSelection(flow, selection = {}, options = {}) {
  const errors = selectionValidationErrors(flow, selection, options)
  if (errors.length > 0) {
    /** @type {Error & { code?: string }} */
    const error = new Error(errors[0].message)
    error.code = errors[0].code
    throw error
  }
}

/**
 * @param {import('../../types').WorkflowFlow} [flow]
 * @param {AgentSelection} [selection]
 * @returns {import('../../types').WorkflowFlow}
 */
function applyAgentSelection(flow = {}, selection = {}) {
  const globalAgents = normalizeAgentList(selection.agents)
  const globalSelected = globalAgents.length > 0 ? new Set(globalAgents) : null
  const stepAgents = normalizeStepAgents(selection.stepAgents)
  const hasStepOverride = (stepId) => Object.prototype.hasOwnProperty.call(stepAgents, stepId)

  if (!globalSelected && Object.keys(stepAgents).length === 0) return flow

  return {
    ...flow,
    defaults: {
      ...flow.defaults,
      agents: globalSelected
        ? normalizeAgentList(flow.defaults?.agents).filter((agent) => globalSelected.has(agent))
        : normalizeAgentList(flow.defaults?.agents),
    },
    steps: (flow.steps || []).map((step) => {
      const originalAgents = normalizeAgentList(step.agents)
      const agents = hasStepOverride(step.id)
        ? stepAgents[step.id].filter((agent) => originalAgents.includes(agent))
        : globalSelected
          ? originalAgents.filter((agent) => globalSelected.has(agent))
          : originalAgents
      return {
        ...step,
        agents,
      }
    }),
  }
}

module.exports = {
  applyAgentSelection,
  assertValidAgentSelection,
  flowAgentSet,
  flowDeclaredAgentValidationErrors,
  normalizeAgentList,
  normalizeStepAgents,
  parseStepAgentsEntries,
  selectionValidationErrors,
  stepAgentsToEntries,
}
