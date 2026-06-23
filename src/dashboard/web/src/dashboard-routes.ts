import type { DashboardCapabilities } from './types'
import { dashboardRouteSpec } from './route-spec'

export type DashboardRouteState =
  | { kind: 'home' }
  | { kind: 'workflows' }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'workflow-step'; workflowId: string; stepId: string }
  | { kind: 'workflow-prompts'; workflowId: string; stepId?: string }
  | { kind: 'runs' }
  | { kind: 'run'; runId: string }
  | { kind: 'run-details'; runId: string }
  | { kind: 'run-step'; runId: string; stepId: string }
  | { kind: 'run-agent'; runId: string; stepId: string; agent: string }

export const defaultDashboardCapabilities: DashboardCapabilities = {
  deploymentMode: 'local',
  canListWorkflows: true,
  canReadRuns: true,
  canReadRunDetails: true,
  canReadEventsJson: true,
  canStartRuns: true,
  canDryRun: true,
  canCancelRuns: true,
  canSubmitFollowups: true,
  canReviewGates: true,
  canOpenLocalFiles: true,
  canStreamRunEvents: true,
  canServeStaticAssets: true,
  requiresAuth: true,
}

export type DashboardRouteMatch = {
  fullPath?: string
  params?: Record<string, unknown>
}

function routeParam(match: DashboardRouteMatch, key: string): string {
  const value = match.params?.[key]
  return typeof value === 'string' ? value : ''
}

export function dashboardRouteStateFromMatches(matches: readonly DashboardRouteMatch[]): DashboardRouteState {
  const match = [...matches].reverse().find((candidate) => typeof candidate.fullPath === 'string') || null
  if (!match) return { kind: 'home' }
  switch (match.fullPath) {
    case dashboardRouteSpec.home.fullPath:
      return { kind: 'home' }
    case dashboardRouteSpec.workflows.fullPath:
      return { kind: 'workflows' }
    case dashboardRouteSpec.workflow.fullPath:
      return { kind: 'workflow', workflowId: routeParam(match, 'workflowId') }
    case dashboardRouteSpec.workflowStep.fullPath:
      return {
        kind: 'workflow-step',
        workflowId: routeParam(match, 'workflowId'),
        stepId: routeParam(match, 'stepId'),
      }
    case dashboardRouteSpec.workflowPrompts.fullPath:
      return { kind: 'workflow-prompts', workflowId: routeParam(match, 'workflowId') }
    case dashboardRouteSpec.workflowPromptStep.fullPath:
      return {
        kind: 'workflow-prompts',
        workflowId: routeParam(match, 'workflowId'),
        stepId: routeParam(match, 'stepId'),
      }
    case dashboardRouteSpec.runs.fullPath:
      return { kind: 'runs' }
    case dashboardRouteSpec.run.fullPath:
      return { kind: 'run', runId: routeParam(match, 'runId') }
    case dashboardRouteSpec.runDetails.fullPath:
      return { kind: 'run-details', runId: routeParam(match, 'runId') }
    case dashboardRouteSpec.runStep.fullPath:
      return {
        kind: 'run-step',
        runId: routeParam(match, 'runId'),
        stepId: routeParam(match, 'stepId'),
      }
    case dashboardRouteSpec.runAgent.fullPath:
      return {
        kind: 'run-agent',
        runId: routeParam(match, 'runId'),
        stepId: routeParam(match, 'stepId'),
        agent: routeParam(match, 'agent'),
      }
  }
  return { kind: 'home' }
}

export function routeWorkflowId(route: DashboardRouteState): string {
  return 'workflowId' in route ? route.workflowId : ''
}

export function routeRunId(route: DashboardRouteState): string {
  return 'runId' in route ? route.runId : ''
}

export function routeWorkflowStepId(route: DashboardRouteState): string {
  return route.kind === 'workflow-step' ? route.stepId : ''
}

export function routePromptStepId(route: DashboardRouteState): string {
  return route.kind === 'workflow-prompts' ? route.stepId || '' : ''
}

export function routeRunStepId(route: DashboardRouteState): string {
  return route.kind === 'run-step' || route.kind === 'run-agent' ? route.stepId : ''
}
