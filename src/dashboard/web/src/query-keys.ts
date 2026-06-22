export const dashboardQueryKeys = {
  all: ['dashboard'] as const,
  health: () => [...dashboardQueryKeys.all, 'health'] as const,
  workflows: () => [...dashboardQueryKeys.all, 'workflows'] as const,
  workflowGraph: (workflowId: string) => [...dashboardQueryKeys.workflows(), workflowId, 'graph'] as const,
  runs: () => [...dashboardQueryKeys.all, 'runs'] as const,
  run: (runId: string) => [...dashboardQueryKeys.runs(), runId] as const,
  runGraph: (runId: string) => [...dashboardQueryKeys.run(runId), 'graph'] as const,
  runDetails: (runId: string) => [...dashboardQueryKeys.run(runId), 'details'] as const,
}

export type DashboardQueryKey =
  | typeof dashboardQueryKeys.all
  | ReturnType<typeof dashboardQueryKeys.health>
  | ReturnType<typeof dashboardQueryKeys.workflows>
  | ReturnType<typeof dashboardQueryKeys.workflowGraph>
  | ReturnType<typeof dashboardQueryKeys.runs>
  | ReturnType<typeof dashboardQueryKeys.run>
  | ReturnType<typeof dashboardQueryKeys.runGraph>
  | ReturnType<typeof dashboardQueryKeys.runDetails>
