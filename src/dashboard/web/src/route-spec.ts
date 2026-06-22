export const dashboardRouteSpec = {
  home: {
    id: 'dashboard.home',
    path: '/',
    fullPath: '/',
  },
  workflows: {
    id: 'dashboard.workflows',
    path: 'workflows',
    fullPath: '/workflows',
  },
  workflow: {
    id: 'dashboard.workflow',
    path: 'workflows/$workflowId',
    fullPath: '/workflows/$workflowId',
  },
  workflowStep: {
    id: 'dashboard.workflow-step',
    path: 'workflows/$workflowId/steps/$stepId',
    fullPath: '/workflows/$workflowId/steps/$stepId',
  },
  workflowPrompts: {
    id: 'dashboard.workflow-prompts',
    path: 'workflows/$workflowId/prompts',
    fullPath: '/workflows/$workflowId/prompts',
  },
  workflowPromptStep: {
    id: 'dashboard.workflow-prompt-step',
    path: 'workflows/$workflowId/prompts/$stepId',
    fullPath: '/workflows/$workflowId/prompts/$stepId',
  },
  runs: {
    id: 'dashboard.runs',
    path: 'runs',
    fullPath: '/runs',
  },
  run: {
    id: 'dashboard.run',
    path: 'runs/$runId',
    fullPath: '/runs/$runId',
  },
  runDetails: {
    id: 'dashboard.run-details',
    path: 'runs/$runId/details',
    fullPath: '/runs/$runId/details',
  },
  runStep: {
    id: 'dashboard.run-step',
    path: 'runs/$runId/steps/$stepId',
    fullPath: '/runs/$runId/steps/$stepId',
  },
  runAgent: {
    id: 'dashboard.run-agent',
    path: 'runs/$runId/steps/$stepId/agents/$agent',
    fullPath: '/runs/$runId/steps/$stepId/agents/$agent',
  },
} as const

export const dashboardRouteSpecs = Object.values(dashboardRouteSpec)

function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

export function workflowPath(workflowId: string): string {
  return `/workflows/${encodePathSegment(workflowId)}`
}

export function workflowStepPath(workflowId: string, stepId: string): string {
  return `${workflowPath(workflowId)}/steps/${encodePathSegment(stepId)}`
}

export function workflowPromptsPath(workflowId: string): string {
  return `${workflowPath(workflowId)}/prompts`
}

export function workflowPromptPath(workflowId: string, stepId: string): string {
  return `${workflowPromptsPath(workflowId)}/${encodePathSegment(stepId)}`
}

export function runPath(runId: string): string {
  return `/runs/${encodePathSegment(runId)}`
}

export function runDetailsPath(runId: string): string {
  return `${runPath(runId)}/details`
}

export function runStepPath(runId: string, stepId: string): string {
  return `${runPath(runId)}/steps/${encodePathSegment(stepId)}`
}

export function runAgentPath(runId: string, stepId: string, agent: string): string {
  return `${runStepPath(runId, stepId)}/agents/${encodePathSegment(agent)}`
}
