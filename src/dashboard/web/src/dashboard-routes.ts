import type { DashboardCapabilities } from './types'

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
  canStartRuns: true,
  canDryRun: true,
  canOpenLocalFiles: true,
  canStreamRunEvents: true,
  requiresAuth: true,
}

function decodeSegment(value: string | undefined): string {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseDashboardPath(pathname: string): DashboardRouteState {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return { kind: 'home' }
  if (segments[0] === 'workflows') {
    if (segments.length === 1) return { kind: 'workflows' }
    const workflowId = decodeSegment(segments[1])
    if (segments[2] === 'steps' && segments[3]) {
      return { kind: 'workflow-step', workflowId, stepId: decodeSegment(segments[3]) }
    }
    if (segments[2] === 'prompts') {
      const stepId = decodeSegment(segments[3])
      return stepId
        ? { kind: 'workflow-prompts', workflowId, stepId }
        : { kind: 'workflow-prompts', workflowId }
    }
    return { kind: 'workflow', workflowId }
  }
  if (segments[0] === 'runs') {
    if (segments.length === 1) return { kind: 'runs' }
    const runId = decodeSegment(segments[1])
    if (segments[2] === 'details') return { kind: 'run-details', runId }
    if (segments[2] === 'steps' && segments[3]) {
      const stepId = decodeSegment(segments[3])
      if (segments[4] === 'agents' && segments[5]) {
        return { kind: 'run-agent', runId, stepId, agent: decodeSegment(segments[5]) }
      }
      return { kind: 'run-step', runId, stepId }
    }
    return { kind: 'run', runId }
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
