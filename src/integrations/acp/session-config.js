// ACP session config options for nax acp: one grouped agent/model picker, effort, how changes land, and the site in monorepos.
// Values come from the shared agent catalog so ACP clients see the same choices as the CLI and dashboard.
const {
  AUTO_CONFIGURATION_VALUE,
  SUPPORTED_AGENT_PROVIDERS,
  getAgentEffortOptions,
  getAgentModelOptions,
  getAgentProviderLabel,
  normalizeAgentProvider,
} = require('../../core/agents/configuration')

const CHOOSE_SITE = 'choose'

const CHANGES_OPTIONS = [
  { value: 'apply', name: 'Apply locally', description: 'Apply each turn\'s diff to the local workspace' },
  { value: 'pr', name: 'Pull request', description: 'Open or update a pull request; leave the local workspace untouched' },
]

/**
 * @typedef {{
 *   agent: string,
 *   model: string,
 *   effort: string,
 *   changes: 'apply' | 'pr',
 *   site: string,
 * }} AcpSessionConfig
 *
 * @typedef {{ siteId: string, label: string, dir: string }} AcpSiteChoice
 *
 * @typedef {{ value: string, name: string, description?: string }} AcpSelectOption
 *
 * @typedef {{ group: string, name: string, options: AcpSelectOption[] }} AcpSelectGroup
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description?: string,
 *   category?: string,
 *   type: 'select',
 *   currentValue: string,
 *   options: AcpSelectOption[] | AcpSelectGroup[],
 * }} AcpConfigOption
 */

/** @returns {AcpSessionConfig} */
function defaultSessionConfig() {
  return {
    agent: 'claude',
    model: AUTO_CONFIGURATION_VALUE,
    effort: AUTO_CONFIGURATION_VALUE,
    changes: 'apply',
    site: '',
  }
}

/**
 * @param {string} agent
 * @param {string} model
 * @returns {string}
 */
function modelValue(agent, model) {
  return `${agent}:${model}`
}

/**
 * Lists the session's config options; the site option appears only when the repository links several sites.
 * @param {AcpSessionConfig} config
 * @param {AcpSiteChoice[]} [sites]
 * @returns {AcpConfigOption[]}
 */
function sessionConfigOptions(config, sites = []) {
  /** @type {AcpConfigOption[]} */
  const siteOption = sites.length > 1
    ? [{
        id: 'site',
        name: 'Netlify site',
        description: 'The linked site whose agent runners work on this repository',
        type: 'select',
        currentValue: config.site || CHOOSE_SITE,
        options: [
          { value: CHOOSE_SITE, name: 'Choose a site…' },
          ...sites.map((site) => ({ value: site.siteId, name: site.label })),
        ],
      }]
    : []
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelValue(config.agent, config.model),
      options: SUPPORTED_AGENT_PROVIDERS.map((agent) => {
        const label = getAgentProviderLabel(agent)
        return {
          group: agent,
          name: label,
          options: getAgentModelOptions(agent, { includeModel: agent === config.agent ? config.model : undefined })
            .map((option) => ({
              value: modelValue(agent, option.id),
              name: option.id === AUTO_CONFIGURATION_VALUE ? `${label} Auto` : option.label,
            })),
        }
      }),
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: config.effort,
      options: getAgentEffortOptions(config.agent, config.model, { includeEffort: config.effort })
        .map((option) => ({ value: option.id, name: option.label })),
    },
    {
      id: 'changes',
      name: 'Changes',
      description: 'Where the agent runner\'s changes go after each turn',
      type: 'select',
      currentValue: config.changes,
      options: CHANGES_OPTIONS,
    },
    ...siteOption,
  ]
}

/**
 * Returns the config after an ACP client selects a value, rejecting values nax does not offer.
 * @param {AcpSessionConfig} config
 * @param {string} configId
 * @param {string} value
 * @param {AcpSiteChoice[]} [sites]
 * @returns {AcpSessionConfig}
 */
function updateSessionConfig(config, configId, value, sites = []) {
  if (configId === 'model') {
    const separator = value.indexOf(':')
    const rawAgent = separator === -1 ? value : value.slice(0, separator)
    const model = separator === -1 ? AUTO_CONFIGURATION_VALUE : value.slice(separator + 1) || AUTO_CONFIGURATION_VALUE
    const agent = normalizeAgentProvider(rawAgent)
    if (!agent) {
      throw new Error(`Unsupported agent provider "${rawAgent}". Supported agents: ${SUPPORTED_AGENT_PROVIDERS.join(', ')}.`)
    }
    return { ...config, agent, model, effort: AUTO_CONFIGURATION_VALUE }
  }
  if (configId === 'effort') {
    const offered = getAgentEffortOptions(config.agent, config.model).map((option) => option.id)
    if (!offered.includes(value)) {
      throw new Error(`Unsupported effort "${value}" for ${config.agent} ${config.model}. Available: ${offered.join(', ')}.`)
    }
    return { ...config, effort: value }
  }
  if (configId === 'changes') {
    if (value !== 'apply' && value !== 'pr') {
      throw new Error(`Unsupported changes value "${value}". Use apply or pr.`)
    }
    return { ...config, changes: value }
  }
  if (configId === 'site') {
    if (value === CHOOSE_SITE) return { ...config, site: '' }
    if (!sites.some((site) => site.siteId === value)) throw new Error(`Unknown Netlify site "${value}" for this repository.`)
    return { ...config, site: value }
  }
  throw new Error(`Unknown session config option "${configId}".`)
}

module.exports = {
  defaultSessionConfig,
  sessionConfigOptions,
  updateSessionConfig,
}
