import { useInfiniteQuery, useQuery, type Query } from '@tanstack/react-query'
import { getHealth, getRunDetails, getRunGraph, getWorkflowGraph, listRuns, listWorkflows } from '../api'
import { dashboardQueryKeys } from '../query-keys'
import { graphHasActiveRemoteRuns, runsFromResponses, upsertRunDetailsInDashboardCache, upsertRunGraphInDashboardCache } from './dashboard-cache'
import type { HealthResponse, RunDetailsResponse, RunGraphResponse, RunsListData, WorkflowGraphResponse, WorkflowListResponse } from '../types'

type QueryOptions<TData> = {
  enabled?: boolean
  refetchInterval?: number | false | ((query: Query<TData, Error, TData, readonly unknown[]>) => number | false | undefined)
}

type RunsQueryOptions = {
  enabled?: boolean
  limit?: number
  refetchInterval?: number | false
}

const DEFAULT_RUNS_PAGE_LIMIT = 50

export function useDashboardHealthQuery(options: QueryOptions<HealthResponse> = {}) {
  return useQuery({
    queryKey: dashboardQueryKeys.health(),
    queryFn: getHealth,
    ...options,
  })
}

export function useWorkflowsQuery(options: QueryOptions<WorkflowListResponse> = {}) {
  return useQuery({
    queryKey: dashboardQueryKeys.workflows(),
    queryFn: listWorkflows,
    ...options,
  })
}

export function useWorkflowGraphQuery(workflowId: string, options: QueryOptions<WorkflowGraphResponse> = {}) {
  return useQuery({
    queryKey: dashboardQueryKeys.workflowGraph(workflowId),
    queryFn: () => getWorkflowGraph(workflowId),
    ...options,
    enabled: Boolean(workflowId) && (options.enabled ?? true),
  })
}

export function useRunsQuery(options: RunsQueryOptions = {}) {
  const limit = options.limit ?? DEFAULT_RUNS_PAGE_LIMIT
  return useInfiniteQuery({
    queryKey: dashboardQueryKeys.runsInfinite(limit),
    queryFn: async ({ pageParam }) => listRuns({
      limit,
      cursor: pageParam || undefined,
    }),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.pagination?.nextCursor || undefined,
    select: (data): RunsListData => runsFromResponses(data.pages),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval,
  })
}

export function useRunGraphQuery(
  runId: string,
  options: QueryOptions<RunGraphResponse> & { refetchActiveGraphs?: boolean } = {},
) {
  const { refetchActiveGraphs = false, refetchInterval, ...queryOptions } = options
  return useQuery({
    queryKey: dashboardQueryKeys.runGraph(runId),
    queryFn: async ({ client }) => {
      const response = await getRunGraph(runId)
      upsertRunGraphInDashboardCache(client, response)
      return response
    },
    ...queryOptions,
    enabled: Boolean(runId) && (queryOptions.enabled ?? true),
    refetchInterval: refetchActiveGraphs
      ? (query) => graphHasActiveRemoteRuns(query.state.data?.graph || null) ? 7000 : false
      : refetchInterval,
  })
}

export function useRunDetailsQuery(runId: string, options: QueryOptions<RunDetailsResponse> = {}) {
  return useQuery({
    queryKey: dashboardQueryKeys.runDetails(runId),
    queryFn: async ({ client }) => {
      const response = await getRunDetails(runId)
      upsertRunDetailsInDashboardCache(client, response)
      return response
    },
    ...options,
    enabled: Boolean(runId) && (options.enabled ?? true),
  })
}
