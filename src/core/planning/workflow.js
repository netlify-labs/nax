const {
  normalizeProviderEffortMap,
  normalizeProviderModelMap,
  normalizeStepProviderEffortMap,
  normalizeStepProviderModelMap,
} = require('../agents/configuration')
const { resolveLineup } = require('../agents/instances')

/**
 * Resolve one workflow step with every declaration and caller override applied
 * in the same precedence order used by CLI previews and execution.
 *
 * @param {import('../../types').WorkflowFlow} flow
 * @param {import('../../types').WorkflowStep} step
 * @param {import('../../types').JsonMap} [options]
 * @param {string} [requestedTransport]
 */
function resolvedLineupForStep(flow, step, options = {}, requestedTransport) {
  const models = normalizeProviderModelMap(options.models)
  const efforts = normalizeProviderEffortMap(options.efforts)
  const stepModels = normalizeStepProviderModelMap(options.stepModels)
  const stepEfforts = normalizeStepProviderEffortMap(options.stepEfforts)
  const transport = requestedTransport ||
    (typeof options.transport === 'string' ? options.transport : '') ||
    flow.defaults?.transport ||
    'auto'
  return resolveLineup(Array.isArray(step.lineup) ? step.lineup : step.agents || [], {
    requestedTransport: transport,
    models: {
      ...normalizeProviderModelMap(flow.defaults?.models),
      ...normalizeProviderModelMap(step.models),
      ...models,
      ...(stepModels[String(step.id || '')] || {}),
    },
    efforts: {
      ...normalizeProviderEffortMap(flow.defaults?.efforts),
      ...normalizeProviderEffortMap(step.efforts),
      ...efforts,
      ...(stepEfforts[String(step.id || '')] || {}),
    },
  })
}

/**
 * Select one exact step or a suffix of a workflow. This is intentionally
 * presentation-free so CLI, dashboard, MCP, desktop, and hosted runtimes use
 * one range contract.
 *
 * @param {import('../../types').WorkflowFlow} flow
 * @param {{ step?: unknown, onlyStep?: unknown, fromStep?: unknown }} [options]
 * @returns {import('../../types').WorkflowStep[]}
 */
function findStepRange(flow, options = {}) {
  const allSteps = Array.isArray(flow.steps) ? flow.steps : []
  const onlyStep = String(options.onlyStep || options.step || '').trim()
  const fromStep = String(options.fromStep || '').trim()
  if (onlyStep && fromStep) {
    throw Object.assign(new Error('onlyStep and fromStep are mutually exclusive.'), { code: 'invalid_step_range' })
  }
  if (onlyStep) {
    const selected = allSteps.filter((step) => step.id === onlyStep)
    if (selected.length === 0) {
      throw Object.assign(new Error(`Unknown step "${onlyStep}" in flow "${flow.id}"`), {
        code: 'invalid_step',
        details: { workflowId: String(flow.id || ''), stepId: onlyStep },
      })
    }
    return selected
  }
  if (fromStep) {
    const index = allSteps.findIndex((step) => step.id === fromStep)
    if (index === -1) {
      throw Object.assign(new Error(`Unknown from-step "${fromStep}" in flow "${flow.id}"`), {
        code: 'invalid_from_step',
        details: { workflowId: String(flow.id || ''), stepId: fromStep },
      })
    }
    return allSteps.slice(index)
  }
  return allSteps
}

module.exports = {
  findStepRange,
  resolvedLineupForStep,
}
