const { DEFAULT_FOLLOWUP_AGENTS } = require('../../core/constants')
const {
  SUPPORTED_AGENT_PROVIDERS,
  normalizeProviderEffortMap,
  normalizeProviderModelMap,
  resolveAgentRunConfig,
} = require('../../core/agents/configuration')

const SUPPORTED_FOLLOWUP_AGENTS = SUPPORTED_AGENT_PROVIDERS

class FollowupPlanError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message)
    this.name = 'FollowupPlanError'
    this.code = code
    this.statusCode = statusCode
  }
}

function normalizeAgent(agent) {
  return String(agent || '').trim().toLowerCase()
}

function normalizeAgents(agents = []) {
  if (!Array.isArray(agents)) return []
  const seen = new Set()
  const normalized = []
  for (const value of agents) {
    const agent = normalizeAgent(value)
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    normalized.push(agent)
  }
  return normalized
}

/** @param {string[]} agents @param {string[]} [supportedAgents] */
function assertSupportedAgents(agents, supportedAgents = SUPPORTED_FOLLOWUP_AGENTS) {
  const supported = new Set(supportedAgents.map(normalizeAgent))
  for (const agent of agents) {
    if (!supported.has(agent)) {
      throw new FollowupPlanError('invalid_agent', `Unsupported follow-up agent "${agent}".`)
    }
  }
}

function defaultAgentsForTarget(target = {}, fallbackAgents = DEFAULT_FOLLOWUP_AGENTS) {
  const agent = normalizeAgent(target.agent)
  return agent ? [agent] : normalizeAgents(fallbackAgents)
}

function submissionLabel(agent, mode) {
  const label = agent ? `${agent.slice(0, 1).toUpperCase()}${agent.slice(1)}` : 'Agent'
  return `${label}: ${mode === 'continue-runner' ? 'follow-up session' : 'fresh runner'}`
}

/**
 * @param {{
 *   requestedMode?: 'follow-up-thread' | 'fresh-runner' | string,
 *   target?: import('../../types').JsonMap | null,
 *   agents?: string[],
 *   fallbackAgents?: string[],
 *   supportedAgents?: string[],
 *   models?: import('../../types').StringMap,
 *   efforts?: import('../../types').StringMap,
 *   sourceArtifactIds?: string[],
 *   targetSha?: string,
 *   targetBranch?: string,
 * }} [options]
 */
function buildFollowupSubmissionPlan({
  requestedMode = 'follow-up-thread',
  target = null,
  agents,
  fallbackAgents = DEFAULT_FOLLOWUP_AGENTS,
  supportedAgents = SUPPORTED_FOLLOWUP_AGENTS,
  models = {},
  efforts = {},
  sourceArtifactIds = [],
  targetSha = '',
  targetBranch = '',
} = {}) {
  const selectedAgents = normalizeAgents(agents && agents.length > 0 ? agents : defaultAgentsForTarget(target || {}, fallbackAgents))
  if (selectedAgents.length === 0) {
    throw new FollowupPlanError('missing_agents', 'Select at least one agent for the follow-up.')
  }
  assertSupportedAgents(selectedAgents, supportedAgents)
  const requestedModels = normalizeProviderModelMap(models)
  const requestedEfforts = normalizeProviderEffortMap(efforts)

  const targetAgent = normalizeAgent(target?.agent)
  const targetModels = targetAgent && target?.model ? { [targetAgent]: String(target.model) } : {}
  const targetEfforts = targetAgent && target?.effort ? { [targetAgent]: String(target.effort) } : {}
  const targetRunnerId = String(target?.runnerId || '').trim()
  const canContinue = requestedMode === 'follow-up-thread' && targetRunnerId && targetAgent
  const submissions = selectedAgents.map((agent) => {
    const mode = canContinue && agent === targetAgent ? 'continue-runner' : 'fresh-runner'
    const configuration = resolveAgentRunConfig(agent, {
      defaults: {
        models: targetModels,
        efforts: targetEfforts,
      },
      globalCli: {
        models: requestedModels,
        efforts: requestedEfforts,
      },
    })
    return {
      id: [mode, agent, targetRunnerId || target?.id || 'fresh'].filter(Boolean).join(':'),
      mode,
      agent,
      ...(configuration.model ? { model: configuration.model } : {}),
      ...(configuration.effort ? { effort: configuration.effort } : {}),
      warnings: configuration.warnings,
      runnerId: mode === 'continue-runner' ? targetRunnerId : '',
      sessionId: mode === 'continue-runner' ? String(target?.sessionId || '') : '',
      sourceTargetId: String(target?.id || ''),
      sourceArtifactIds: [...sourceArtifactIds],
      target: {
        sha: targetSha || '',
        branch: targetBranch || '',
        source: 'workflow-target',
      },
      label: submissionLabel(agent, mode),
    }
  })

  return {
    mode: requestedMode,
    targetId: String(target?.id || ''),
    targetAgent,
    submissions,
    summary: submissions.map((submission) => submission.label),
  }
}

module.exports = {
  FollowupPlanError,
  SUPPORTED_FOLLOWUP_AGENTS,
  buildFollowupSubmissionPlan,
  defaultAgentsForTarget,
  normalizeAgents,
}
