import type { QueryClient } from '@tanstack/react-query'
import type { RunnerEvent } from '../types'
import { invalidateRunViews } from './dashboard-cache'

const INVALIDATING_EVENT_TYPES = new Set([
  'agent_status',
  'artifact_written',
  'step_status',
  'workflow_awaiting_review',
  'workflow_cancelled',
  'workflow_completed',
  'workflow_failed',
  'workflow_started',
  'exited',
])

export function applyRunnerEventToDashboardCache(queryClient: QueryClient, event: RunnerEvent, fallbackRunId: string): void {
  const eventRunId = event.runId || fallbackRunId
  if (!INVALIDATING_EVENT_TYPES.has(event.type)) return
  const ids = [...new Set([eventRunId, fallbackRunId].filter(Boolean))]
  ids.forEach((id) => { void invalidateRunViews(queryClient, id) })
}
