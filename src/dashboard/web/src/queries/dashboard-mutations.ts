import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  approveHumanReviewGate,
  cancelFollowupRun,
  cancelHumanReviewGate,
  cancelWorkflowRun,
  runWorkflowDryRun,
  startRunFollowup,
  startWorkflowRun,
} from '../api'
import type { DryRunOptions, RunFollowupRequest } from '../types'
import { invalidateRunViews, upsertRunInDashboardCache } from './dashboard-cache'

export function useDryRunWorkflowMutation() {
  return useMutation({
    mutationFn: ({ workflowId, options }: { workflowId: string; options: DryRunOptions }) => runWorkflowDryRun(workflowId, options),
  })
}

export function useStartWorkflowRunMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ workflowId, options }: { workflowId: string; options: DryRunOptions }) => startWorkflowRun(workflowId, options),
    onSuccess(response) {
      upsertRunInDashboardCache(queryClient, response.run)
      void invalidateRunViews(queryClient, response.run.runId || response.run.id)
    },
  })
}

export function useCancelWorkflowRunMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => cancelWorkflowRun(runId),
    onSuccess(response) {
      upsertRunInDashboardCache(queryClient, response.run)
      void invalidateRunViews(queryClient, response.run.runId || response.run.id)
    },
  })
}

export function useCancelFollowupRunMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, target }: { runId: string; target: { stepId?: string; agent?: string; runnerId?: string; sessionId?: string } }) => cancelFollowupRun(runId, target),
    onSuccess(response) {
      upsertRunInDashboardCache(queryClient, response.run)
      void invalidateRunViews(queryClient, response.run.runId || response.run.id)
    },
  })
}

export function useApproveHumanReviewGateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, stepId }: { runId: string; stepId?: string }) => approveHumanReviewGate(runId, { stepId }),
    onSuccess(response) {
      upsertRunInDashboardCache(queryClient, response.run)
      void invalidateRunViews(queryClient, response.run.runId || response.run.id)
    },
  })
}

export function useCancelHumanReviewGateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, stepId, reason }: { runId: string; stepId?: string; reason?: string }) => cancelHumanReviewGate(runId, { stepId, reason }),
    onSuccess(response) {
      upsertRunInDashboardCache(queryClient, response.run)
      void invalidateRunViews(queryClient, response.run.runId || response.run.id)
    },
  })
}

export function useStartRunFollowupMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, request }: { runId: string; request: RunFollowupRequest }) => startRunFollowup(runId, request),
    onSuccess(response) {
      const source = response.followup.sourceWorkflow || response.followup.persistedWorkflow
      if (source) {
        upsertRunInDashboardCache(queryClient, source)
        void invalidateRunViews(queryClient, source.runId || source.id)
      }
    },
  })
}
