import { agentLabel } from './run-format'
import type { RunDetails, RunFollowupArtifact, RunFollowupRequest, RunFollowupTarget } from './types'

export const SUPPORTED_FOLLOWUP_MODELS = ['codex', 'claude', 'gemini']

export function defaultFollowupTarget(details: RunDetails): RunFollowupTarget | null {
  return details.followupTargets.find((target) => target.isDefault) || details.followupTargets[0] || null
}

export function followupThreadTargets(details: RunDetails): RunFollowupTarget[] {
  return details.followupTargets.filter((target) => Boolean(target.runnerId))
}

export function defaultFollowupThreadTarget(details: RunDetails): RunFollowupTarget | null {
  const targets = followupThreadTargets(details)
  return targets.find((target) => target.isDefault) || targets[0] || null
}

export function defaultFollowupMode(details: RunDetails): 'follow-up-thread' | 'fresh-runner' {
  if (defaultFollowupThreadTarget(details)) return 'follow-up-thread'
  return defaultFollowupTarget(details)?.defaultMode || 'fresh-runner'
}

export function defaultFollowupArtifactIds(details: RunDetails): string[] {
  return details.followupArtifacts.filter((artifact) => artifact.defaultSelected).map((artifact) => artifact.id)
}

export function defaultFollowupModels(target: RunFollowupTarget | null): string[] {
  return target?.agent ? [target.agent] : ['codex']
}

export function formatArtifactBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function followupPlanLine(model: string, mode: string, target: RunFollowupTarget | null): string {
  const followsExisting = mode === 'follow-up-thread' && target?.runnerId && target.agent === model
  return `${agentLabel(model)}: ${followsExisting ? 'follow-up prompt on existing thread' : 'start fresh agent runner'}`
}

export function selectedFollowupArtifacts(artifacts: RunFollowupArtifact[], artifactIds: string[]): RunFollowupArtifact[] {
  const selected = new Set(artifactIds)
  return artifacts.filter((artifact) => selected.has(artifact.id))
}

export function buildRunFollowupRequest({
  mode,
  prompt,
  target,
  models,
  artifacts,
}: {
  mode: 'follow-up-thread' | 'fresh-runner'
  prompt: string
  target: RunFollowupTarget
  models: string[]
  artifacts: RunFollowupArtifact[]
}): RunFollowupRequest {
  return {
    mode,
    prompt,
    targetId: target.id,
    models,
    artifacts: artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind })),
  }
}
