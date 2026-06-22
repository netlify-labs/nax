import type { CSSProperties } from 'react'
import { isCompletedStatus, statusLabel as displayStatusLabel, statusTone } from './status-model'
import type { DashboardRun } from './types'

export function runId(run: Partial<DashboardRun>): string {
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
  return isCompletedStatus(status)
}

export function agentLabel(agent: string): string {
  return agent.replace(/(^|-)([a-z])/g, (_match, prefix, char) => `${prefix}${char.toUpperCase()}`)
}

export function statusLabel(status: string): string {
  return displayStatusLabel(status)
}

export function statusBadgeTone(status: string): 'green' | 'yellow' | 'red' | undefined {
  return statusTone(status)
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

export function workflowName(run: DashboardRun | undefined): string {
  return run ? run.flowTitle || run.flowId || runId(run) : ''
}
