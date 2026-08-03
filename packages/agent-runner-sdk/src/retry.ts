export interface RetryBackoffOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  random?: () => number
}

function nonNegativeFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function boundedRetryDelayMs(
  attempt: number,
  options: RetryBackoffOptions = {},
): number {
  const baseDelayMs = nonNegativeFinite(options.baseDelayMs ?? 250, 250)
  const maxDelayMs = nonNegativeFinite(options.maxDelayMs ?? 5_000, 5_000)
  const sampled = (options.random ?? Math.random)()
  const jitter = Number.isFinite(sampled)
    ? Math.max(0, Math.min(1, sampled))
    : 0.5
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * (2 ** Math.max(0, attempt - 1)),
  )
  return Math.floor(Math.min(maxDelayMs, exponential * (0.5 + jitter)))
}
