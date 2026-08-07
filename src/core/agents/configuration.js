/**
 * Agent Runner provider, model, and reasoning-effort configuration.
 *
 * Synced from netlify-react-ui AgentConfigModal/models.ts
 * at commit 0a61ba66 on 2026-08-06.
 *
 * Keep this module's exported catalog serializable. The CLI, dashboard API,
 * and dashboard client all consume the same data.
 */

/**
 * @typedef {'claude' | 'codex' | 'gemini' | 'opencode'} AgentProvider
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   wireValue?: string,
 * }} AgentEffortOption
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   efforts: AgentEffortOption[],
 *   aliasFor?: string,
 *   upstreamDefaultEffort?: string,
 * }} AgentModelDefinition
 *
 * @typedef {{
 *   id: AgentProvider,
 *   label: string,
 *   defaultModel?: string,
 *   models: AgentModelDefinition[],
 * }} AgentProviderDefinition
 *
 * @typedef {{
 *   provenance: {
 *     source: string,
 *     commit: string,
 *     syncedAt: string,
 *   },
 *   providers: AgentProviderDefinition[],
 * }} AgentConfigurationCatalog
 *
 * @typedef {Record<string, string>} ProviderSettingMap
 * @typedef {Record<string, ProviderSettingMap>} StepProviderSettingMap
 *
 * @typedef {{
 *   models?: unknown,
 *   efforts?: unknown,
 * }} AgentConfigurationScope
 *
 * @typedef {{
 *   defaults?: AgentConfigurationScope,
 *   step?: AgentConfigurationScope,
 *   globalCli?: AgentConfigurationScope,
 *   stepCli?: AgentConfigurationScope,
 * }} AgentConfigurationScopes
 *
 * @typedef {{
 *   agent: AgentProvider,
 *   model?: string,
 *   effort?: string,
 *   warnings: string[],
 * }} ResolvedAgentRunConfig
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 * }} ConfigurationOption
 *
 * @typedef {Error & { code?: string }} AgentConfigurationError
 */

const AUTO_CONFIGURATION_VALUE = 'auto'

/** @type {AgentProvider[]} */
const SUPPORTED_AGENT_PROVIDERS = ['claude', 'gemini', 'codex', 'opencode']

/** @type {AgentEffortOption[]} */
const LOW_MEDIUM_HIGH_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]

/** @type {AgentConfigurationCatalog} */
const AGENT_CONFIGURATION_CATALOG = {
  provenance: {
    source: 'netlify-react-ui AgentConfigModal/models.ts',
    commit: '0a61ba66',
    syncedAt: '2026-08-06',
  },
  providers: [
    {
      id: 'claude',
      label: 'Claude',
      defaultModel: 'claude-fable-5',
      models: [
        { id: 'claude-opus-5', label: 'Opus 5', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'claude-opus-4-8', label: 'Opus 4.8', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'claude-fable-5', label: 'Fable 5', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: LOW_MEDIUM_HIGH_EFFORTS },
      ],
    },
    {
      id: 'gemini',
      label: 'Gemini',
      defaultModel: 'gemini-3.1-pro-preview',
      models: [
        { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', efforts: LOW_MEDIUM_HIGH_EFFORTS },
      ],
    },
    {
      id: 'codex',
      label: 'Codex',
      defaultModel: 'gpt-5.6-sol',
      models: [
        { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', efforts: LOW_MEDIUM_HIGH_EFFORTS },
        { id: 'gpt-5.4-mini', label: 'GPT 5.4 Mini', efforts: LOW_MEDIUM_HIGH_EFFORTS },
      ],
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      defaultModel: 'moonshotai/kimi-k3',
      models: [
        {
          id: 'moonshotai/kimi-k3',
          label: 'Kimi K3',
          efforts: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' },
            { id: 'max', label: 'Max' },
          ],
          upstreamDefaultEffort: 'max',
        },
        {
          id: 'moonshotai/kimi-k2.7-code',
          label: 'Kimi K2.7 Code',
          efforts: [],
        },
        {
          id: 'z-ai/glm-5.2',
          label: 'GLM 5.2',
          efforts: [
            { id: 'high', label: 'High' },
            { id: 'max', label: 'Max', wireValue: 'xhigh' },
          ],
          upstreamDefaultEffort: 'high',
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          label: 'DeepSeek V4 Pro',
          efforts: [
            { id: 'high', label: 'High' },
            { id: 'max', label: 'Max', wireValue: 'xhigh' },
          ],
          upstreamDefaultEffort: 'high',
        },
        {
          id: '~deepseek/deepseek-v4-flash-latest',
          label: 'DeepSeek V4 Flash Latest',
          efforts: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' },
            { id: 'max', label: 'Max' },
          ],
          aliasFor: 'deepseek/deepseek-v4-flash-0731',
          upstreamDefaultEffort: 'high',
        },
        {
          id: 'x-ai/grok-4.5',
          label: 'Grok 4.5',
          efforts: LOW_MEDIUM_HIGH_EFFORTS,
          upstreamDefaultEffort: 'high',
        },
        {
          id: 'minimax/minimax-m3',
          label: 'MiniMax M3',
          efforts: [],
        },
      ],
    },
  ],
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {AgentConfigurationError}
 */
function configurationError(code, message) {
  /** @type {AgentConfigurationError} */
  const error = new Error(message)
  error.code = code
  return error
}

/** @param {unknown} value @returns {string} */
function normalizedSetting(value) {
  const setting = typeof value === 'string' ? value.trim() : ''
  return setting.toLowerCase() === AUTO_CONFIGURATION_VALUE ? AUTO_CONFIGURATION_VALUE : setting
}

/** @param {unknown} value @returns {AgentProvider | undefined} */
function normalizeAgentProvider(value) {
  const agent = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SUPPORTED_AGENT_PROVIDERS.includes(/** @type {AgentProvider} */ (agent))
    ? /** @type {AgentProvider} */ (agent)
    : undefined
}

/**
 * @param {unknown} value
 * @param {'model' | 'effort'} settingName
 * @returns {ProviderSettingMap}
 */
function normalizeProviderSettingMap(value, settingName) {
  if (value === undefined || value === null || value === '') return {}

  /** @type {Array<[string, unknown]>} */
  let entries
  if (typeof value === 'string' || Array.isArray(value)) {
    const rawEntries = Array.isArray(value) ? value : [value]
    entries = rawEntries.map((rawEntry) => {
      const entry = typeof rawEntry === 'string' ? rawEntry.trim() : ''
      const separator = entry.indexOf('=')
      if (separator <= 0 || separator === entry.length - 1 || entry.includes(',')) {
        const providerFlag = settingName === 'model' ? '--agents' : '--efforts agent=effort'
        throw configurationError(
          `invalid_${settingName}_mapping`,
          `Invalid ${settingName} mapping "${entry}". Use agent=${settingName}; provider lists belong in ${providerFlag}.`,
        )
      }
      return [entry.slice(0, separator), entry.slice(separator + 1)]
    })
  } else if (typeof value === 'object') {
    entries = Object.entries(value)
  } else {
    throw configurationError(
      `invalid_${settingName}_map`,
      `${settingName === 'model' ? 'Models' : 'Efforts'} must be a provider-keyed map.`,
    )
  }

  /** @type {ProviderSettingMap} */
  const result = {}
  for (const [rawAgent, rawSetting] of entries) {
    const agent = normalizeAgentProvider(rawAgent)
    if (!agent) {
      throw configurationError(
        'unsupported_agent',
        `Unsupported agent provider "${String(rawAgent).trim()}". Supported agents: ${SUPPORTED_AGENT_PROVIDERS.join(', ')}.`,
      )
    }
    if (Object.prototype.hasOwnProperty.call(result, agent)) {
      throw configurationError(
        `duplicate_${settingName}_assignment`,
        `Duplicate ${settingName} assignment for agent "${agent}".`,
      )
    }
    const setting = normalizedSetting(rawSetting)
    if (!setting) {
      throw configurationError(
        `missing_${settingName}_value`,
        `Missing ${settingName} value for agent "${agent}". Use "${agent}=auto" to clear it explicitly.`,
      )
    }
    result[agent] = setting
  }
  return result
}

/** @param {unknown} value @returns {ProviderSettingMap} */
function normalizeProviderModelMap(value) {
  return normalizeProviderSettingMap(value, 'model')
}

/** @param {unknown} value @returns {ProviderSettingMap} */
function normalizeProviderEffortMap(value) {
  return normalizeProviderSettingMap(value, 'effort')
}

/**
 * @param {unknown} value
 * @param {'model' | 'effort'} settingName
 * @returns {StepProviderSettingMap}
 */
function normalizeStepProviderSettingMap(value, settingName) {
  if (value === undefined || value === null || value === '') return {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    /** @type {StepProviderSettingMap} */
    const result = {}
    for (const [rawStepId, rawMap] of Object.entries(value)) {
      const stepId = rawStepId.trim()
      if (!stepId) {
        throw configurationError(`missing_step_${settingName}_id`, `Missing step id for ${settingName} configuration.`)
      }
      result[stepId] = normalizeProviderSettingMap(rawMap, settingName)
    }
    return result
  }

  const entries = Array.isArray(value) ? value : [value]
  /** @type {StepProviderSettingMap} */
  const result = {}
  for (const rawEntry of entries) {
    const entry = typeof rawEntry === 'string' ? rawEntry.trim() : ''
    const colon = entry.indexOf(':')
    const equals = entry.indexOf('=')
    if (colon <= 0 || equals <= colon + 1 || equals === entry.length - 1 || entry.includes(',')) {
      const providerFlag = settingName === 'model' ? '--step-agents' : '--step-efforts step:agent=effort'
      throw configurationError(
        `invalid_step_${settingName}_mapping`,
        `Invalid step ${settingName} mapping "${entry}". Use step:agent=${settingName}; step provider lists belong in ${providerFlag}.`,
      )
    }
    const stepId = entry.slice(0, colon).trim()
    const assignment = entry.slice(colon + 1)
    const normalized = normalizeProviderSettingMap(assignment, settingName)
    if (!result[stepId]) result[stepId] = {}
    for (const [agent, setting] of Object.entries(normalized)) {
      if (Object.prototype.hasOwnProperty.call(result[stepId], agent)) {
        throw configurationError(
          `duplicate_step_${settingName}_assignment`,
          `Duplicate ${settingName} assignment for step "${stepId}" and agent "${agent}".`,
        )
      }
      result[stepId][agent] = setting
    }
  }
  return result
}

/** @param {unknown} value @returns {StepProviderSettingMap} */
function normalizeStepProviderModelMap(value) {
  return normalizeStepProviderSettingMap(value, 'model')
}

/** @param {unknown} value @returns {StepProviderSettingMap} */
function normalizeStepProviderEffortMap(value) {
  return normalizeStepProviderSettingMap(value, 'effort')
}

/** @param {unknown} value @returns {string[]} */
function providerModelMapToEntries(value) {
  return Object.entries(normalizeProviderModelMap(value)).map(([agent, model]) => `${agent}=${model}`)
}

/** @param {unknown} value @returns {string[]} */
function providerEffortMapToEntries(value) {
  return Object.entries(normalizeProviderEffortMap(value)).map(([agent, effort]) => `${agent}=${effort}`)
}

/** @param {unknown} value @returns {string[]} */
function stepProviderModelMapToEntries(value) {
  return Object.entries(normalizeStepProviderModelMap(value)).flatMap(([stepId, models]) =>
    Object.entries(models).map(([agent, model]) => `${stepId}:${agent}=${model}`))
}

/** @param {unknown} value @returns {string[]} */
function stepProviderEffortMapToEntries(value) {
  return Object.entries(normalizeStepProviderEffortMap(value)).flatMap(([stepId, efforts]) =>
    Object.entries(efforts).map(([agent, effort]) => `${stepId}:${agent}=${effort}`))
}

/** @param {AgentProvider} agent @returns {AgentProviderDefinition} */
function providerDefinition(agent) {
  const provider = AGENT_CONFIGURATION_CATALOG.providers.find((candidate) => candidate.id === agent)
  if (!provider) {
    throw configurationError(
      'unsupported_agent',
      `Unsupported agent provider "${agent}". Supported agents: ${SUPPORTED_AGENT_PROVIDERS.join(', ')}.`,
    )
  }
  return provider
}

/** @param {string} model @returns {{ provider: AgentProviderDefinition, model: AgentModelDefinition } | undefined} */
function catalogModel(model) {
  for (const provider of AGENT_CONFIGURATION_CATALOG.providers) {
    const definition = provider.models.find((candidate) => candidate.id === model)
    if (definition) return { provider, model: definition }
  }
  return undefined
}

/**
 * Validate and translate one resolved configuration.
 *
 * @param {{ agent?: string, model?: string, effort?: string }} config
 * @returns {ResolvedAgentRunConfig}
 */
function validateAgentConfig(config) {
  const agent = normalizeAgentProvider(config.agent)
  if (!agent) {
    throw configurationError(
      'unsupported_agent',
      `Unsupported agent provider "${config.agent}". Supported agents: ${SUPPORTED_AGENT_PROVIDERS.join(', ')}.`,
    )
  }

  const model = normalizedSetting(config.model)
  const effort = normalizedSetting(config.effort)
  const resolvedModel = !model || model === AUTO_CONFIGURATION_VALUE ? undefined : model
  const resolvedEffort = !effort || effort === AUTO_CONFIGURATION_VALUE ? undefined : effort
  /** @type {string[]} */
  const warnings = []

  if (!resolvedModel && resolvedEffort) {
    throw configurationError(
      'effort_requires_model',
      `Agent "${agent}" cannot use effort "${resolvedEffort}" while its model is Auto.`,
    )
  }
  if (!resolvedModel) return { agent, warnings }

  const known = catalogModel(resolvedModel)
  if (!known) {
    warnings.push(
      `Model "${resolvedModel}" is not in NAX's ${AGENT_CONFIGURATION_CATALOG.provenance.syncedAt} catalog; passing it through for the backend to validate.`,
    )
    if (resolvedEffort) {
      warnings.push(
        `Effort "${resolvedEffort}" for unknown model "${resolvedModel}" is being passed through unchanged.`,
      )
    }
    return {
      agent,
      model: resolvedModel,
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
      warnings,
    }
  }

  if (known.provider.id !== agent) {
    throw configurationError(
      'model_provider_mismatch',
      `Model "${resolvedModel}" belongs to ${known.provider.label}, not ${providerDefinition(agent).label}.`,
    )
  }
  if (!resolvedEffort) return { agent, model: resolvedModel, warnings }

  const effortDefinition = known.model.efforts.find(
    (candidate) => candidate.id === resolvedEffort || candidate.wireValue === resolvedEffort,
  )
  if (!effortDefinition) {
    const available = known.model.efforts.map((candidate) => candidate.label).join(', ') || 'Auto only'
    throw configurationError(
      'unsupported_model_effort',
      `Model "${resolvedModel}" does not support effort "${resolvedEffort}". Available efforts: ${available}.`,
    )
  }

  return {
    agent,
    model: resolvedModel,
    effort: effortDefinition.wireValue || effortDefinition.id,
    warnings,
  }
}

/**
 * Resolve model and effort using defaults < step < global CLI < step CLI.
 *
 * @param {string} rawAgent
 * @param {AgentConfigurationScopes} [scopes]
 * @returns {ResolvedAgentRunConfig}
 */
function resolveAgentRunConfig(rawAgent, scopes = {}) {
  const agent = normalizeAgentProvider(rawAgent)
  if (!agent) {
    throw configurationError(
      'unsupported_agent',
      `Unsupported agent provider "${rawAgent}". Supported agents: ${SUPPORTED_AGENT_PROVIDERS.join(', ')}.`,
    )
  }

  /** @type {string | undefined} */
  let model
  /** @type {string | undefined} */
  let effort
  const orderedScopes = [scopes.defaults, scopes.step, scopes.globalCli, scopes.stepCli]

  for (const scope of orderedScopes) {
    if (!scope) continue
    const models = normalizeProviderModelMap(scope.models)
    const efforts = normalizeProviderEffortMap(scope.efforts)
    const hasModel = Object.prototype.hasOwnProperty.call(models, agent)
    const hasEffort = Object.prototype.hasOwnProperty.call(efforts, agent)

    if (hasModel) {
      const nextModel = models[agent]
      model = nextModel === AUTO_CONFIGURATION_VALUE ? undefined : nextModel
      if (!hasEffort) effort = undefined
    }
    if (hasEffort) {
      const nextEffort = efforts[agent]
      effort = nextEffort === AUTO_CONFIGURATION_VALUE ? undefined : nextEffort
    }
  }

  return validateAgentConfig({ agent, model, effort })
}

/**
 * @param {string} rawAgent
 * @param {{ includeModel?: string }} [options]
 * @returns {ConfigurationOption[]}
 */
function getAgentModelOptions(rawAgent, { includeModel } = {}) {
  const agent = normalizeAgentProvider(rawAgent)
  if (!agent) return [{ id: AUTO_CONFIGURATION_VALUE, label: 'Auto' }]
  const options = [
    { id: AUTO_CONFIGURATION_VALUE, label: 'Auto' },
    ...providerDefinition(agent).models.map((model) => ({ id: model.id, label: model.label })),
  ]
  const extra = normalizedSetting(includeModel)
  if (extra && extra !== AUTO_CONFIGURATION_VALUE && !options.some((option) => option.id === extra)) {
    options.push({ id: extra, label: extra })
  }
  return options
}

/**
 * @param {string} rawAgent
 * @param {string | undefined} rawModel
 * @param {{ includeEffort?: string }} [options]
 * @returns {ConfigurationOption[]}
 */
function getAgentEffortOptions(rawAgent, rawModel, { includeEffort } = {}) {
  const options = [{ id: AUTO_CONFIGURATION_VALUE, label: 'Auto' }]
  const agent = normalizeAgentProvider(rawAgent)
  const model = normalizedSetting(rawModel)
  if (!agent || !model || model === AUTO_CONFIGURATION_VALUE) return options
  const known = catalogModel(model)
  if (known?.provider.id === agent) {
    options.push(...known.model.efforts.map((effort) => ({ id: effort.id, label: effort.label })))
  }
  const extra = normalizedSetting(includeEffort)
  if (extra && extra !== AUTO_CONFIGURATION_VALUE) {
    const displayId = extra === 'xhigh' && known?.model.efforts.some((effort) => effort.wireValue === 'xhigh')
      ? 'max'
      : extra
    if (!options.some((option) => option.id === displayId)) {
      options.push({ id: displayId, label: displayId })
    }
  }
  return options
}

/**
 * @param {string} rawAgent
 * @param {string | undefined} rawModel
 * @returns {string | undefined}
 */
function getEffortAvailabilityNotice(rawAgent, rawModel) {
  const agent = normalizeAgentProvider(rawAgent)
  const model = normalizedSetting(rawModel)
  if (!agent || !model || model === AUTO_CONFIGURATION_VALUE) {
    return 'Choose a model to configure reasoning effort. Auto omits both fields.'
  }
  const known = catalogModel(model)
  if (!known) return 'This model is not in the current NAX catalog. Unknown effort values pass through with a warning.'
  if (known.provider.id !== agent) return `This model belongs to ${known.provider.label}.`
  if (known.model.efforts.length === 0) return 'This model does not expose configurable reasoning effort.'
  return undefined
}

/**
 * Best (flagship) model for a provider: the first model in the catalog, which is ordered
 * capability-first. Returns Auto when the provider exposes no models.
 * @param {string} rawAgent
 * @returns {string}
 */
function getBestModelForProvider(rawAgent) {
  const agent = normalizeAgentProvider(rawAgent)
  if (!agent) return AUTO_CONFIGURATION_VALUE
  const provider = providerDefinition(agent)
  if (provider.defaultModel) return provider.defaultModel
  const [best] = provider.models
  return best ? best.id : AUTO_CONFIGURATION_VALUE
}

/**
 * Highest reasoning effort for a model: the last catalog effort, which is ordered
 * ascending. Returns Auto when the model exposes no configurable effort.
 * @param {string} rawAgent
 * @param {string | undefined} rawModel
 * @returns {string}
 */
function getHighestEffortForModel(rawAgent, rawModel) {
  const agent = normalizeAgentProvider(rawAgent)
  const model = normalizedSetting(rawModel)
  if (!agent || !model || model === AUTO_CONFIGURATION_VALUE) return AUTO_CONFIGURATION_VALUE
  const known = catalogModel(model)
  if (known?.provider.id !== agent || known.model.efforts.length === 0) return AUTO_CONFIGURATION_VALUE
  return known.model.efforts[known.model.efforts.length - 1].id
}

/**
 * @param {string} rawAgent
 * @returns {string}
 */
function getAgentProviderLabel(rawAgent) {
  const agent = normalizeAgentProvider(rawAgent)
  return agent ? providerDefinition(agent).label : String(rawAgent || 'Unknown')
}

/**
 * @param {{ agent?: string, model?: string, effort?: string }} config
 * @returns {string}
 */
function formatAgentConfigLabel(config) {
  const agent = normalizeAgentProvider(config.agent)
  const providerLabel = agent ? providerDefinition(agent).label : String(config.agent || 'Unknown')
  const model = normalizedSetting(config.model)
  if (!model || model === AUTO_CONFIGURATION_VALUE) return `${providerLabel} · Auto`

  const known = catalogModel(model)
  const modelLabel = known?.provider.id === agent ? known.model.label : model
  const effort = normalizedSetting(config.effort)
  if (!effort || effort === AUTO_CONFIGURATION_VALUE) return `${providerLabel} · ${modelLabel} · Auto`
  const effortDefinition = known?.model.efforts.find(
    (candidate) => candidate.id === effort || candidate.wireValue === effort,
  )
  return `${providerLabel} · ${modelLabel} · ${effortDefinition?.label || effort}`
}

module.exports = {
  AGENT_CONFIGURATION_CATALOG,
  AUTO_CONFIGURATION_VALUE,
  SUPPORTED_AGENT_PROVIDERS,
  catalogModel,
  formatAgentConfigLabel,
  getAgentEffortOptions,
  getAgentModelOptions,
  getAgentProviderLabel,
  getBestModelForProvider,
  getEffortAvailabilityNotice,
  getHighestEffortForModel,
  normalizeAgentProvider,
  normalizeProviderEffortMap,
  normalizeProviderModelMap,
  normalizeStepProviderEffortMap,
  normalizeStepProviderModelMap,
  providerEffortMapToEntries,
  providerModelMapToEntries,
  resolveAgentRunConfig,
  stepProviderEffortMapToEntries,
  stepProviderModelMapToEntries,
  validateAgentConfig,
}
