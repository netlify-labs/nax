import type { QueryClient } from '@tanstack/react-query'
import { dashboardQueryKeys } from '../query-keys'
import { recordValue, runId } from '../run-format'
import { isActiveStatus } from '../status-model'
import type { DashboardRun, RunDetailsResponse, RunGraphResponse, RunsListData, RunsResponse, WorkflowGraph } from '../types'

export function runIdentifier(run: Partial<DashboardRun>): string {
  return runId(run)
}

export function mergeRunLists(active: DashboardRun[], durable: DashboardRun[]): DashboardRun[] {
  const seen = new Set<string>()
  return [...active, ...durable].filter((run) => {
    const id = runIdentifier(run)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function runsFromResponse(response: RunsResponse): DashboardRun[] {
  return mergeRunLists(response.active, response.durable)
}

export function runsFromResponses(responses: RunsResponse[]): RunsListData {
  const first = responses[0] || { active: [], durable: [] }
  const durable = responses.flatMap((response) => response.durable || [])
  const durableIds = new Set<string>()
  for (const run of durable) {
    const id = runIdentifier(run)
    if (id) durableIds.add(id)
  }
  const last = responses[responses.length - 1]
  return {
    runs: mergeRunLists(first.active || [], durable),
    hasMore: Boolean(last?.pagination?.hasMore),
    durableShownCount: durableIds.size,
    durableTotal: first.pagination?.durableTotal ?? durableIds.size,
  }
}

export function graphHasActiveRemoteRuns(graph: WorkflowGraph | null): boolean {
  return Boolean(graph?.nodes.some((node) => (
    (node.data.runs || []).some((run) => (
      isActiveStatus(recordValue(run, 'status')) &&
      Boolean(recordValue(run, 'runnerId') || recordValue(run, 'sessionId'))
    ))
  )))
}

export function replaceRunInList(runs: DashboardRun[], nextRun: DashboardRun): DashboardRun[] {
  const nextId = nextRun.runId || nextRun.id
  if (!nextId) return runs
  const filtered = runs.filter((candidate) => candidate.runId !== nextId && candidate.id !== nextId)
  return [nextRun, ...filtered]
}

export function sameRun(left: Partial<DashboardRun>, right: Partial<DashboardRun>): boolean {
  const leftIds = [left.id, left.runId].filter(Boolean)
  const rightIds = [right.id, right.runId].filter(Boolean)
  return leftIds.some((id) => rightIds.includes(id))
}

export function upsertRunInDashboardCache(queryClient: QueryClient, run: DashboardRun): void {
  const id = run.runId || run.id
  if (id) queryClient.setQueryData<DashboardRun>(dashboardQueryKeys.run(id), run)
  void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.runs() })
}

export function upsertRunGraphInDashboardCache(queryClient: QueryClient, response: RunGraphResponse): void {
  const id = response.run.runId || response.run.id
  upsertRunInDashboardCache(queryClient, response.run)
  if (id) queryClient.setQueryData<RunGraphResponse>(dashboardQueryKeys.runGraph(id), response)
}

export function upsertRunDetailsInDashboardCache(queryClient: QueryClient, response: RunDetailsResponse): void {
  const id = response.run.runId || response.run.id
  upsertRunInDashboardCache(queryClient, response.run)
  if (id) queryClient.setQueryData<RunDetailsResponse>(dashboardQueryKeys.runDetails(id), response)
}

export async function invalidateRunViews(queryClient: QueryClient, runId: string): Promise<void> {
  if (!runId) return
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.runs() }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.run(runId) }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.runGraph(runId) }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.runDetails(runId) }),
  ])
}

export async function invalidateDashboardLists(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.health() }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.workflows() }),
    queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.runs() }),
  ])
}
