const { DEFAULT_FOLLOWUP_MODELS, DEFAULT_MODELS } = require('../../core/constants')

const SUPPORTED_FOLLOWUP_AGENTS = DEFAULT_MODELS

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

function normalizeModels(models = []) {
  if (!Array.isArray(models)) return []
  const seen = new Set()
  const normalized = []
  for (const model of models) {
    const agent = normalizeAgent(model)
    if (!agent || seen.has(agent)) continue
    seen.add(agent)
    normalized.push(agent)
  }
  return normalized
}

function assertSupportedModels(models, supportedAgents = SUPPORTED_FOLLOWUP_AGENTS) {
  const supported = new Set(supportedAgents.map(normalizeAgent))
  for (const model of models) {
    if (!supported.has(model)) {
      throw new FollowupPlanError('invalid_model', `Unsupported follow-up model "${model}".`)
    }
  }
}

function defaultModelsForTarget(target = {}, fallbackModels = DEFAULT_FOLLOWUP_MODELS) {
  const agent = normalizeAgent(target.agent)
  return agent ? [agent] : normalizeModels(fallbackModels)
}

function submissionLabel(agent, mode) {
  const label = agent ? `${agent.slice(0, 1).toUpperCase()}${agent.slice(1)}` : 'Agent'
  return `${label}: ${mode === 'continue-runner' ? 'follow-up session' : 'fresh runner'}`
}

/**
 * @param {{
 *   requestedMode?: 'follow-up-thread' | 'fresh-runner' | string,
 *   target?: import('../../types').JsonMap | null,
 *   models?: string[],
 *   fallbackModels?: string[],
 *   supportedAgents?: string[],
 *   sourceArtifactIds?: string[],
 *   targetSha?: string,
 *   targetBranch?: string,
 * }} [options]
 */
function buildFollowupSubmissionPlan({
  requestedMode = 'follow-up-thread',
  target = null,
  models,
  fallbackModels = DEFAULT_FOLLOWUP_MODELS,
  supportedAgents = SUPPORTED_FOLLOWUP_AGENTS,
  sourceArtifactIds = [],
  targetSha = '',
  targetBranch = '',
} = {}) {
  const selectedModels = normalizeModels(models && models.length > 0 ? models : defaultModelsForTarget(target || {}, fallbackModels))
  if (selectedModels.length === 0) {
    throw new FollowupPlanError('missing_models', 'Select at least one model for the follow-up.')
  }
  assertSupportedModels(selectedModels, supportedAgents)

  const targetAgent = normalizeAgent(target?.agent)
  const targetRunnerId = String(target?.runnerId || '').trim()
  const canContinue = requestedMode === 'follow-up-thread' && targetRunnerId && targetAgent
  const submissions = selectedModels.map((agent) => {
    const mode = canContinue && agent === targetAgent ? 'continue-runner' : 'fresh-runner'
    return {
      id: [mode, agent, targetRunnerId || target?.id || 'fresh'].filter(Boolean).join(':'),
      mode,
      agent,
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
  defaultModelsForTarget,
  normalizeModels,
}
