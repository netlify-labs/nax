import type { CSSProperties } from 'react'
import type { VisualizeRun } from './types'

export function runId(run: Partial<VisualizeRun>): string {
  return run.runId || run.id || ''
}

export function recordValue(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

export function recordList(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key]
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

export function isDoneStatus(status: string): boolean {
  return ['complete', 'completed', 'dry-run'].includes(status.toLowerCase())
}

export function agentLabel(agent: string): string {
  return agent.replace(/(^|-)([a-z])/g, (_match, prefix, char) => `${prefix}${char.toUpperCase()}`)
}

export function statusLabel(status: string): string {
  const normalized = status.toLowerCase()
  if (!normalized) return 'Unknown'
  if (isDoneStatus(normalized)) return 'Completed'
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

export function statusBadgeTone(status: string): 'green' | 'yellow' | 'red' | undefined {
  const normalized = status.toLowerCase()
  if (isDoneStatus(normalized)) return 'green'
  if (['pending', 'running', 'submitted', 'submitting', 'waiting', 'retrying', 'queued', 'interrupted'].includes(normalized)) return 'yellow'
  return ['failed', 'timeout', 'cancelled', 'canceled', 'dismissed', 'error', 'abandoned'].includes(normalized)
    ? 'red'
    : undefined
}

export function statusColor(status: string): string {
  return statusBadgeTone(status) || 'gray'
}

export function statusBadgeColor(status: string): string {
  return statusColor(status)
}

export function statusBadgeStyle(status: string): CSSProperties | undefined {
  const tone = statusBadgeTone(status)
  if (!tone) return undefined

  const color = tone === 'green' ? 'green' : tone === 'yellow' ? 'yellow' : 'red'
  const shade = tone === 'green' ? '4' : tone === 'yellow' ? '4' : '5'
  const mixShadow = tone === 'green' ? '72%' : tone === 'yellow' ? '76%' : '74%'
  const mixGlow = tone === 'green' ? '86%' : tone === 'yellow' ? '84%' : '86%'
  return {
    '--badge-bg': `color-mix(in srgb, var(--mantine-color-${color}-${shade}), transparent 88%)`,
    '--badge-color': `light-dark(var(--mantine-color-${color}-9), var(--mantine-color-${color}-1))`,
    '--badge-bd': `calc(0.0625rem * var(--mantine-scale)) solid var(--mantine-color-${color}-${shade})`,
    boxShadow: `0 0 0 1px color-mix(in srgb, var(--mantine-color-${color}-${shade}), transparent ${mixShadow}), 0 0 18px color-mix(in srgb, var(--mantine-color-${color}-${shade}), transparent ${mixGlow})`,
  } as CSSProperties
}

export function workflowName(run: VisualizeRun | undefined): string {
  return run ? run.flowTitle || run.flowId || runId(run) : ''
}
