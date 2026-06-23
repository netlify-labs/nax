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
    ...overrides,
  }
}

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
    ...overrides,
  }
}

module.exports = {
  hostedPlaceholderCapabilities,
  localDashboardCapabilities,
}
