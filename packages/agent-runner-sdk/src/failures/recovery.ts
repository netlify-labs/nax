import type {
  EffectiveFollowUpInput,
  EffectiveStartInput,
  FailureClassification,
  RequestWindow,
  Runner,
  Session,
} from '../domain.js'
import {
  parseHandle,
} from '../handles.js'
import type {
  Handle,
} from '../handles.js'

export type RecoveryConfidence = 'high' | 'medium' | 'low'

export interface GithubRecoveryPullRequest {
  url: string
  state: 'open' | 'closed'
  headSha: string
  merged: boolean
  mergeSha?: string
}

export type RecoveryAction =
  | {
      kind: 'refreshResult'
      runnerId: string
      sessionId: string
    }
  | {
      kind: 'reconcileCreate'
      strategy: 'exact-request-marker'
      window: RequestWindow
    }
  | {
      kind: 'reconcileSession'
      strategy: 'exact-request-marker'
      runnerId: string
      window: RequestWindow
    }
  | {
      kind: 'resumeLanding'
      runnerId: string
      sessionId: string
      step: 'commit' | 'pr' | 'merge' | 'publish'
    }
  | {
      kind: 'stopAtDeadline'
      runnerId: string
      sessionId: string
      target: 'runner' | 'session'
    }
  | {
      kind: 'escalateChangedHead'
      prUrl: string
      expectedHeadSha: string
      observedHeadSha: string
    }
  | {
      kind: 'manualReview'
      reason:
        | 'ambiguous-candidates'
        | 'forbidden-retry'
        | 'incompatible-origin'
        | 'live-identity-mismatch'
        | 'terminal-failure'
    }
  | {
      kind: 'none'
      reason: 'landing-complete' | 'landing-skipped'
    }

export interface RecoveryRecommendation {
  confidence: RecoveryConfidence
  recoveryAction: RecoveryAction
}

export type RecoveryInput =
  | {
      kind: 'createAmbiguity'
      effectiveInput: EffectiveStartInput
      window: RequestWindow
      candidateCount?: number
    }
  | {
      kind: 'sessionAmbiguity'
      serializedHandle: string | unknown
      effectiveInput: EffectiveFollowUpInput
      window: RequestWindow
      candidateCount?: number
    }
  | {
      kind: 'live'
      serializedHandle: string | unknown
      now?: number
      runner?: Runner
      session?: Session
      pullRequest?: GithubRecoveryPullRequest
      failure?: FailureClassification
    }

const TERMINAL_STATES = new Set([
  'archived',
  'cancelled',
  'canceled',
  'completed',
  'done',
  'error',
  'failed',
  'timed_out',
  'timedout',
])

const SUCCESS_STATES = new Set(['completed', 'done'])

function normalizedState(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function validateWindow(window: RequestWindow): RequestWindow {
  if (
    !Number.isFinite(window.sentAt)
    || !Number.isFinite(window.failedAt)
    || window.sentAt > window.failedAt
  ) {
    throw new TypeError(
      'Recovery request windows require finite sentAt <= failedAt.',
    )
  }
  return { sentAt: window.sentAt, failedAt: window.failedAt }
}

function ambiguousCandidates(candidateCount: number | undefined): boolean {
  return (
    candidateCount !== undefined
    && Number.isInteger(candidateCount)
    && candidateCount > 1
  )
}

function recoveryOrigin(handle: Handle, runner: Runner | undefined): string {
  return (runner?.codeOrigin ?? handle.origin?.codeOrigin ?? '')
    .trim()
    .toLowerCase()
}

function identityMatches(
  handle: Handle,
  runner: Runner | undefined,
  session: Session | undefined,
): boolean {
  if (runner !== undefined && runner.runnerId !== handle.runnerId) return false
  if (session === undefined) return true
  return (
    session.runnerId === handle.runnerId
    && session.sessionId === handle.currentSessionId
  )
}

function currentSessionCommitted(handle: Handle, session: Session): boolean {
  return (
    session.commitSha !== undefined
    || handle.landing?.committedSessionIds?.includes(
      handle.currentSessionId,
    ) === true
  )
}

function landingRecommendation(
  handle: Handle,
  runner: Runner | undefined,
  session: Session,
  pullRequest: GithubRecoveryPullRequest | undefined,
): RecoveryRecommendation {
  const origin = recoveryOrigin(handle, runner)
  const mode = handle.policy.landing
  if (mode === 'none') {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'none',
        reason: 'landing-skipped',
      },
    }
  }

  if (origin === 'netlify-git') {
    if (mode !== 'publish' && mode !== 'auto') {
      return {
        confidence: 'high',
        recoveryAction: {
          kind: 'manualReview',
          reason: 'incompatible-origin',
        },
      }
    }
    if (
      handle.landing?.published === true
      || session.isPublished === true
    ) {
      return {
        confidence: 'high',
        recoveryAction: {
          kind: 'none',
          reason: 'landing-complete',
        },
      }
    }
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'resumeLanding',
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
        step: 'publish',
      },
    }
  }

  if (origin !== 'github') {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'manualReview',
        reason: 'incompatible-origin',
      },
    }
  }

  if (mode === 'publish') {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'manualReview',
        reason: 'incompatible-origin',
      },
    }
  }

  const prUrl = runner?.prUrl ?? handle.landing?.prUrl
  if (prUrl === undefined) {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'resumeLanding',
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
        step: 'pr',
      },
    }
  }

  if (
    handle.kind === 'session'
    && !currentSessionCommitted(handle, session)
    && session.hasResultDiff !== false
  ) {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'resumeLanding',
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
        step: 'commit',
      },
    }
  }

  if (mode === 'merge' || mode === 'auto') {
    if (
      handle.landing?.mergedSha !== undefined
      || pullRequest?.merged === true
    ) {
      return {
        confidence: 'high',
        recoveryAction: {
          kind: 'none',
          reason: 'landing-complete',
        },
      }
    }
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'resumeLanding',
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
        step: 'merge',
      },
    }
  }

  return {
    confidence: 'high',
    recoveryAction: {
      kind: 'none',
      reason: 'landing-complete',
    },
  }
}

export function recommendRecovery(
  input: RecoveryInput,
): RecoveryRecommendation {
  if (input.kind === 'createAmbiguity') {
    const window = validateWindow(input.window)
    if (ambiguousCandidates(input.candidateCount)) {
      return {
        confidence: 'high',
        recoveryAction: {
          kind: 'manualReview',
          reason: 'ambiguous-candidates',
        },
      }
    }
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'reconcileCreate',
        strategy: 'exact-request-marker',
        window,
      },
    }
  }

  const handle = parseHandle(input.serializedHandle)
  if (input.kind === 'sessionAmbiguity') {
    const window = validateWindow(input.window)
    if (ambiguousCandidates(input.candidateCount)) {
      return {
        confidence: 'high',
        recoveryAction: {
          kind: 'manualReview',
          reason: 'ambiguous-candidates',
        },
      }
    }
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'reconcileSession',
        strategy: 'exact-request-marker',
        runnerId: handle.runnerId,
        window,
      },
    }
  }

  if (!identityMatches(handle, input.runner, input.session)) {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'manualReview',
        reason: 'live-identity-mismatch',
      },
    }
  }

  const now = input.now ?? Date.now()
  const runnerTerminal = TERMINAL_STATES.has(
    normalizedState(input.runner?.state),
  )
  const sessionTerminal = TERMINAL_STATES.has(
    normalizedState(input.session?.state),
  )
  const targetTerminal = handle.kind === 'run'
    ? runnerTerminal || sessionTerminal
    : sessionTerminal
  if (
    now >= handle.policy.deadlineAt
    && !targetTerminal
  ) {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'stopAtDeadline',
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
        target: handle.kind === 'run' ? 'runner' : 'session',
      },
    }
  }

  const expectedHead = handle.landing?.expectedPrHeadSha
  if (
    expectedHead !== undefined
    && input.pullRequest !== undefined
    && input.pullRequest.state === 'open'
    && !input.pullRequest.merged
    && input.pullRequest.headSha !== expectedHead
  ) {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'escalateChangedHead',
        prUrl: input.pullRequest.url,
        expectedHeadSha: expectedHead,
        observedHeadSha: input.pullRequest.headSha,
      },
    }
  }

  if (
    input.failure !== undefined
    && !input.failure.retryable
    && input.failure.stage !== 'landing'
  ) {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'manualReview',
        reason: 'forbidden-retry',
      },
    }
  }

  if (input.session === undefined) {
    return {
      confidence: 'medium',
      recoveryAction: {
        kind: 'refreshResult',
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
      },
    }
  }

  const sessionState = normalizedState(input.session.state)
  if (!sessionTerminal) {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'refreshResult',
        runnerId: handle.runnerId,
        sessionId: handle.currentSessionId,
      },
    }
  }
  if (!SUCCESS_STATES.has(sessionState)) {
    return {
      confidence: 'high',
      recoveryAction: {
        kind: 'manualReview',
        reason: 'terminal-failure',
      },
    }
  }

  return landingRecommendation(
    handle,
    input.runner,
    input.session,
    input.pullRequest,
  )
}
