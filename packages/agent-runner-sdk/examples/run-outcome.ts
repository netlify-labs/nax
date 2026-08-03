import type {
  LandingOutcome,
  RunOutcome,
  RunResult,
} from 'nax-agent-runner-sdk'

export function successfulResultText(
  result: RunResult,
): string | undefined {
  if (result.status !== 'succeeded') return undefined
  return result.resultText
}

export function landingStatus(
  landing: LandingOutcome | undefined,
): string {
  if (landing === undefined) return 'not requested'
  switch (landing.kind) {
    case 'merged':
      return `merged ${landing.mergeSha}`
    case 'prOpen':
      return `open ${landing.prUrl}`
    case 'published':
      return landing.deployUrl ?? 'published'
    case 'unsupported':
      return landing.reason
    case 'failed':
      return `${landing.step}: ${landing.failure.code}`
    case 'skipped':
      return 'skipped'
  }
}

export function summarizeOutcome(outcome: RunOutcome): {
  execution: string
  landing: string
} {
  return {
    execution: outcome.result.status === 'succeeded'
      ? outcome.result.resultText
      : outcome.result.status,
    landing: landingStatus(outcome.landing),
  }
}
