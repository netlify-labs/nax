const { DEFAULT_MODELS } = require('../constants')

/**
 * Parsed model override for one workflow step.
 * @typedef {{
 *   error: string,
 *   stepId?: never,
 *   agents?: never,
 * } | {
 *   error?: undefined,
 *   stepId: string,
 *   agents: string[],
 * }} StepModelParseResult
 *
 * Agent lists keyed by workflow step id.
 * @typedef {Record<string, string[]>} StepModelMap
 *
 * Raw step model override input accepted from CLI flags and config.
 * @typedef {string | string[] | Record<string, unknown>} StepModelInput
 *
 * User-selected agent filters for a workflow run.
 * @typedef {{
 *   models?: unknown,
 *   stepModels?: StepModelInput,
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

/** @param {unknown} entry @returns {StepModelParseResult} */
function parseStepModelEntry(entry) {
  const text = String(entry || '')
  const index = text.indexOf('=')
  if (index === -1) {
    return {
      error: `Step model override "${text}" must use step=agent,agent syntax.`,
    }
  }
  const stepId = text.slice(0, index).trim()
  if (!stepId) {
    return {
      error: `Step model override "${text}" is missing a step id.`,
    }
  }
  return {
    stepId,
    agents: normalizeAgentList(text.slice(index + 1)),
  }
}

/** @param {unknown} value @returns {StepModelMap} */
function normalizeStepModels(value) {
  if (!value) {
    /** @type {StepModelMap} */
    const empty = {}
    return empty
  }
  /** @type {StepModelMap} */
  const out = {}
  if (typeof value === 'string') {
    const parsed = parseStepModelEntry(value)
    if (!parsed.error) out[parsed.stepId] = parsed.agents
    return out
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseStepModelEntry(entry)
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

/** @param {unknown} entries @returns {StepModelMap} */
function parseStepModelsEntries(entries) {
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    return normalizeStepModels(entries)
  }
  const values = Array.isArray(entries) ? entries : entries ? [entries] : []
  /** @type {StepModelMap} */
  const out = {}
  for (const entry of values) {
    const parsed = parseStepModelEntry(entry)
    if (parsed.error) throw new Error(parsed.error)
    out[parsed.stepId] = parsed.agents
  }
  return out
}

/** @param {unknown} stepModels @returns {string[]} */
function stepModelsToEntries(stepModels) {
  return Object.entries(normalizeStepModels(stepModels))
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
function flowDeclaredAgentValidationErrors(flow = {}, { knownAgents = DEFAULT_MODELS } = {}) {
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
  for (const model of normalizeAgentList(selection.models)) {
    if (!flowAgents.has(model)) {
      errors.push({ code: 'invalid_model', message: `Unknown model "${model}" for flow "${flow.id}".` })
    }
  }

  const steps = new Map((flow.steps || []).map((step) => [step.id, step]))
  for (const [stepId, agents] of Object.entries(normalizeStepModels(selection.stepModels))) {
    const step = steps.get(stepId)
    if (!step) {
      errors.push({ code: 'invalid_step_models', message: `Unknown step "${stepId}" in flow "${flow.id}".` })
      continue
    }
    const stepAgents = new Set(normalizeAgentList(step.agents))
    for (const agent of agents) {
      if (!stepAgents.has(agent)) {
        errors.push({
          code: 'invalid_step_model',
          message: `Model "${agent}" is not configured for step "${stepId}" in flow "${flow.id}".`,
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
  const globalAgents = normalizeAgentList(selection.models)
  const globalSelected = globalAgents.length > 0 ? new Set(globalAgents) : null
  const stepModels = normalizeStepModels(selection.stepModels)
  const hasStepOverride = (stepId) => Object.prototype.hasOwnProperty.call(stepModels, stepId)

  if (!globalSelected && Object.keys(stepModels).length === 0) return flow

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
        ? stepModels[step.id].filter((agent) => originalAgents.includes(agent))
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
  normalizeStepModels,
  parseStepModelsEntries,
  selectionValidationErrors,
  stepModelsToEntries,
}
