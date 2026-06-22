export type StatusTone = 'green' | 'yellow' | 'red'

const STATUS_ALIASES: Record<string, string> = {
  pending: 'running',
  queued: 'running',
  submitting: 'running',
  submitted: 'running',
  processing: 'running',
  executing: 'running',
  waiting: 'running',
  retrying: 'running',
  complete: 'completed',
  canceled: 'cancelled',
  timeout: 'failed',
  error: 'failed',
}

const COMPLETED_STATUSES = new Set(['completed', 'dry-run'])
const ACTIVE_STATUSES = new Set(['running'])
const FAILED_STATUSES = new Set(['failed'])
const CANCELLED_STATUSES = new Set(['cancelled', 'abandoned', 'dismissed'])
const WARNING_STATUSES = new Set(['awaiting_review', 'interrupted'])

function titleCaseStatus(status: string): string {
  const label = status.replace(/_/g, ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function statusKey(status = ''): string {
  const normalized = status.toLowerCase()
  if (!normalized) return 'unknown'
  return STATUS_ALIASES[normalized] || normalized
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(statusKey(status))
}

export function isCompletedStatus(status: string): boolean {
  return COMPLETED_STATUSES.has(statusKey(status))
}

export function isFailedStatus(status: string): boolean {
  return FAILED_STATUSES.has(statusKey(status))
}

export function isCancelledStatus(status: string): boolean {
  return CANCELLED_STATUSES.has(statusKey(status))
}

export function isTerminalStatus(status: string): boolean {
  const key = statusKey(status)
  return COMPLETED_STATUSES.has(key) || FAILED_STATUSES.has(key) || CANCELLED_STATUSES.has(key) || key === 'skipped'
}

export function statusLabel(status: string): string {
  const key = statusKey(status)
  if (key === 'unknown') return 'Unknown'
  if (key === 'running') return 'In progress'
  if (key === 'dry-run') return 'Dry run'
  return titleCaseStatus(key)
}

export function statusTone(status: string): StatusTone | undefined {
  const key = statusKey(status)
  if (COMPLETED_STATUSES.has(key)) return 'green'
  if (ACTIVE_STATUSES.has(key) || WARNING_STATUSES.has(key)) return 'yellow'
  if (FAILED_STATUSES.has(key) || CANCELLED_STATUSES.has(key)) return 'red'
  return undefined
}

export const completedStatuses = COMPLETED_STATUSES
export const activeStatuses = ACTIVE_STATUSES
export const activeOrCompletedStatuses = new Set([...ACTIVE_STATUSES, ...COMPLETED_STATUSES])
export const failedStatuses = new Set([...FAILED_STATUSES, ...CANCELLED_STATUSES])
