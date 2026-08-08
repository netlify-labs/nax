const {
  normalizeProviderEffortMap,
  normalizeProviderModelMap,
  normalizeStepProviderEffortMap,
  normalizeStepProviderModelMap,
} = require('../../core/agents/configuration')
const {
  agentInstanceId,
  formatAgentInstanceSpec,
  parseAgentInstanceList,
  resolveLineup,
} = require('../../core/agents/instances')

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {string} code @param {string} message */
function instanceContractError(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Dashboard mutations deliberately accept object descriptors only. This prevents a second,
 * provider-only request contract from diverging from the CLI/workflow lineup pipeline.
 * @param {unknown} value
 * @param {{ path?: string, requestedTransport?: string }} [options]
 * @returns {import('../../types').AgentInstance[]}
 */
function normalizeDashboardInstances(value, { path = 'agents', requestedTransport = 'auto' } = {}) {
  if (!Array.isArray(value)) {
    throw instanceContractError('invalid_instance_contract', `${path} must be an array of agent instance objects.`)
  }
  const entries = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw instanceContractError(
        'invalid_instance_contract',
        `${path}[${index}] must be an object such as { agent, model, effort }; provider-only arrays are no longer accepted.`,
      )
    }
    const entry = objectValue(item)
    return {
      agent: String(entry.agent || ''),
      ...(entry.model !== undefined ? { model: String(entry.model) } : {}),
      ...(entry.effort !== undefined ? { effort: String(entry.effort) } : {}),
      ...(entry.label !== undefined ? { label: String(entry.label) } : {}),
    }
  })
  return resolveLineup(entries, { requestedTransport }).instances
}

/**
 * @param {unknown} value
 * @param {{ requestedTransport?: string }} [options]
 * @returns {Record<string, import('../../types').AgentInstance[]>}
 */
function normalizeDashboardStepInstances(value, { requestedTransport = 'auto' } = {}) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw instanceContractError('invalid_instance_contract', 'stepAgents must map step ids to arrays of agent instance objects.')
  }
  /** @type {Record<string, import('../../types').AgentInstance[]>} */
  const out = {}
  for (const [stepId, instances] of Object.entries(value)) {
    out[stepId] = normalizeDashboardInstances(instances, {
      path: `stepAgents.${stepId}`,
      requestedTransport,
    })
  }
  return out
}

/** @param {import('../../types').AgentInstance[]} instances @returns {string[]} */
function dashboardInstancesToCli(instances) {
  return instances.map(formatAgentInstanceSpec)
}

/**
 * @param {Record<string, import('../../types').AgentInstance[]>} stepInstances
 * @returns {Record<string, string[]>}
 */
function dashboardStepInstancesToCli(stepInstances) {
  return Object.fromEntries(
    Object.entries(stepInstances).map(([stepId, instances]) => [stepId, dashboardInstancesToCli(instances)]),
  )
}

/**
 * Permissive reader for durable pre-instance options. New mutation input never uses this path.
 * @param {unknown} value
 * @returns {Array<string|Record<string, unknown>>}
 */
function durableLineup(value) {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) return [objectValue(entry)]
      return parseAgentInstanceList(entry)
    })
  }
  return parseAgentInstanceList(value)
}

/**
 * @param {unknown} lineup
 * @param {{ models?: unknown, efforts?: unknown }} [configuration]
 * @returns {import('../../types').AgentInstance[]}
 */
function publicInstances(lineup, { models, efforts } = {}) {
  const entries = durableLineup(lineup)
  if (entries.length === 0) return []
  // Durable records can predate the current lineup rules (e.g. a repeated provider). On this read
  // path a rejection must degrade the single row to an empty lineup, not fail the whole collection.
  try {
    return resolveLineup(entries, {
      requestedTransport: 'auto',
      models: normalizeProviderModelMap(models),
      efforts: normalizeProviderEffortMap(efforts),
    }).instances
  } catch (_error) {
    return []
  }
}

/**
 * @param {Record<string, unknown>} options
 * @returns {{ agents: import('../../types').AgentInstance[], stepAgents: Record<string, import('../../types').AgentInstance[]> }}
 */
function publicOptionInstances(options = {}) {
  const models = normalizeProviderModelMap(options.models)
  const efforts = normalizeProviderEffortMap(options.efforts)
  const stepModels = normalizeStepProviderModelMap(options.stepModels)
  const stepEfforts = normalizeStepProviderEffortMap(options.stepEfforts)
  const agents = publicInstances(options.agents, { models, efforts })
  const rawStepAgents = objectValue(options.stepAgents)
  /** @type {Record<string, import('../../types').AgentInstance[]>} */
  const stepAgents = {}
  for (const [stepId, lineup] of Object.entries(rawStepAgents)) {
    stepAgents[stepId] = publicInstances(lineup, {
      models: { ...models, ...(stepModels[stepId] || {}) },
      efforts: { ...efforts, ...(stepEfforts[stepId] || {}) },
    })
  }
  return { agents, stepAgents }
}

/**
 * @param {Record<string, unknown>} run
 * @returns {import('../../types').AgentInstance | null}
 */
function publicRunInstance(run = {}) {
  const agent = String(run.agent || '').trim()
  if (!agent) return null
  const model = String(run.model || '').trim() || undefined
  const effort = String(run.effort || '').trim() || undefined
  const resolvedFrom = ['latest', 'default', 'open', 'pinned'].includes(String(run.resolvedFrom || ''))
    ? String(run.resolvedFrom)
    : model
      ? 'pinned'
      : 'open'
  return {
    agent,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    id: String(run.instanceId || '') || agentInstanceId(agent, model, effort),
    resolvedFrom: /** @type {import('../../types').InstanceProvenance} */ (resolvedFrom),
    ...(run.instanceLabel ? { label: String(run.instanceLabel) } : {}),
  }
}

module.exports = {
  dashboardInstancesToCli,
  dashboardStepInstancesToCli,
  normalizeDashboardInstances,
  normalizeDashboardStepInstances,
  publicInstances,
  publicOptionInstances,
  publicRunInstance,
}
