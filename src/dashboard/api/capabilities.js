/** @typedef {import('../../contracts').DashboardCapabilities} DashboardCapabilities */
const { AGENT_CONFIGURATION_CATALOG } = require('../../core/agents/configuration')

function dashboardAgentCatalog() {
  return {
    ...AGENT_CONFIGURATION_CATALOG,
    providers: AGENT_CONFIGURATION_CATALOG.providers.map((provider) => ({
      ...provider,
      defaultModel: provider.defaultModel || '',
    })),
  }
}

/**
 * @param {Partial<DashboardCapabilities>} [overrides]
 * @returns {DashboardCapabilities}
 */
function localDashboardCapabilities(overrides = {}) {
  return {
    deploymentMode: 'local',
    canListWorkflows: true,
    canReadRuns: true,
    canReadRunDetails: true,
    canReadEventsJson: true,
    canStreamRunEvents: true,
    canStartRuns: true,
    canDryRun: true,
    canCancelRuns: true,
    canSubmitFollowups: true,
    canReviewGates: true,
    canOpenLocalFiles: true,
    canServeStaticAssets: true,
    requiresAuth: true,
    agentConfiguration: {
      catalog: dashboardAgentCatalog(),
      transports: {
        auto: { models: true, efforts: true },
        'netlify-api': { models: true, efforts: true },
        github: { models: false, efforts: false },
      },
    },
    ...overrides,
  }
}

/**
 * @param {Partial<DashboardCapabilities>} [overrides]
 * @returns {DashboardCapabilities}
 */
function hostedPlaceholderCapabilities(overrides = {}) {
  return {
    deploymentMode: 'web',
    canListWorkflows: false,
    canReadRuns: false,
    canReadRunDetails: false,
    canReadEventsJson: false,
    canStreamRunEvents: false,
    canStartRuns: false,
    canDryRun: false,
    canCancelRuns: false,
    canSubmitFollowups: false,
    canReviewGates: false,
    canOpenLocalFiles: false,
    canServeStaticAssets: false,
    requiresAuth: true,
    agentConfiguration: {
      catalog: dashboardAgentCatalog(),
      transports: {
        auto: { models: true, efforts: true },
        'netlify-api': { models: true, efforts: true },
        github: { models: false, efforts: false },
      },
    },
    ...overrides,
  }
}

module.exports = {
  hostedPlaceholderCapabilities,
  localDashboardCapabilities,
}
