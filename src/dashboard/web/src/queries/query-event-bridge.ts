import type { QueryClient } from '@tanstack/react-query'
import { dashboardQueryKeys } from '../query-keys'
import type { DashboardRun, RunnerEvent } from '../types'
import { invalidateRunViews, upsertRunInDashboardCache } from './dashboard-cache'

const INVALIDATING_EVENT_TYPES = new Set([
  'agent_status',
  'artifact_written',
  'step_status',
  'workflow_awaiting_review',
  'workflow_cancelled',
  'workflow_completed',
  'workflow_failed',
  'exited',
])

function patchRunFromEvent(run: DashboardRun, event: RunnerEvent): DashboardRun {
  if (event.type === 'workflow_started') {
    return {
      ...run,
      runId: event.runId || run.runId,
      flowId: event.flowId || run.flowId,
      flowTitle: event.flowTitle || run.flowTitle,
      status: typeof event.status === 'string' ? event.status : 'running',
      command: Array.isArray(event.command) ? event.command : run.command,
      startedAt: typeof event.at === 'string' ? event.at : run.startedAt,
    }
  }
  if (event.type === 'exited') {
    return {
      ...run,
      status: typeof event.status === 'string' ? event.status : run.status,
      exitCode: typeof event.exitCode === 'number' ? event.exitCode : run.exitCode,
      signal: typeof event.signal === 'string' ? event.signal : run.signal,
      exitedAt: typeof event.at === 'string' ? event.at : run.exitedAt,
    }
  }
  if (typeof event.status === 'string' && (event.type === 'workflow_completed' || event.type === 'workflow_failed' || event.type === 'workflow_cancelled')) {
    return {
      ...run,
      status: event.status,
      updatedAt: typeof event.at === 'string' ? event.at : run.updatedAt,
    }
  }
  return run
}

export function applyRunnerEventToDashboardCache(queryClient: QueryClient, event: RunnerEvent, fallbackRunId: string): void {
  const eventRunId = event.runId || fallbackRunId
  if (!eventRunId) return
  const cachedRun = queryClient.getQueryData<DashboardRun>(dashboardQueryKeys.run(eventRunId))
  if (cachedRun) upsertRunInDashboardCache(queryClient, patchRunFromEvent(cachedRun, event))
  if (INVALIDATING_EVENT_TYPES.has(event.type)) void invalidateRunViews(queryClient, eventRunId)
}
