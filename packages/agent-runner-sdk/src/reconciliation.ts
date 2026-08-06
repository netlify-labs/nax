import type {
  EffectiveFollowUpInput,
  EffectiveStartInput,
  RequestWindow,
  Runner,
  Session,
} from './domain.js'
import {
  BasicAgentRunnerSdkError,
  InvalidApiShapeError,
  SessionAlreadyActiveError,
} from './errors.js'
import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
} from './handles.js'
import type {
  Handle,
  RunHandle,
  SessionHandle,
} from './handles.js'
import {
  hasRequestMarker,
  prepareFollowUpOperation,
  prepareStartOperation,
  requestMarkerFor,
  stripRequestMarkers,
} from './operations.js'
import type {
  ReconciliationCandidate,
  ReconciliationResult,
} from './result.js'
import type {
  Transport,
  TransportRequestOptions,
} from './transport/index.js'

export const DEFAULT_CLOCK_SKEW_ALLOWANCE_MS = 5_000

export interface ReconcileSessionOptions extends TransportRequestOptions {
  conflict?: SessionAlreadyActiveError
}

export interface ReconcilerOptions {
  transport: Transport
  defaultAgent: string
  defaultDeadlineMs: number
  defaultLanding: RunHandle['policy']['landing']
  clockSkewAllowanceMs?: number
}

export interface Reconciler {
  reconcileCreate(
    input: EffectiveStartInput,
    window: RequestWindow,
    options?: TransportRequestOptions,
  ): Promise<ReconciliationResult<RunHandle>>
  reconcileSession(
    handle: Handle,
    input: EffectiveFollowUpInput,
    window: RequestWindow,
    options?: ReconcileSessionOptions,
  ): Promise<ReconciliationResult<SessionHandle>>
}

interface BoundedWindow {
  lowerMs: number
  upperMs: number
  from: number
  to: number
}

interface RunnerMatch {
  runner: Runner
  session: Session
  candidate: ReconciliationCandidate
}

interface SessionMatch {
  session: Session
  candidate: ReconciliationCandidate
}

function nonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} must be a non-negative finite number.`,
    )
  }
  return value
}

function nonNegativeInteger(value: number, field: string): number {
  const parsed = nonNegativeFinite(value, field)
  if (!Number.isSafeInteger(parsed)) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} must be an integer.`,
    )
  }
  return parsed
}

function boundedWindow(
  window: RequestWindow,
  clockSkewAllowanceMs: number,
): BoundedWindow {
  const sentAt = nonNegativeFinite(window.sentAt, 'window.sentAt')
  const failedAt = nonNegativeFinite(window.failedAt, 'window.failedAt')
  if (failedAt < sentAt) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'window.failedAt must not precede window.sentAt.',
    )
  }
  const skew = nonNegativeFinite(
    clockSkewAllowanceMs,
    'clockSkewAllowanceMs',
  )
  const lowerMs = Math.max(0, sentAt - skew)
  const upperMs = failedAt + skew
  if (!Number.isFinite(upperMs)) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'The reconciliation window exceeds the supported time range.',
    )
  }
  return {
    lowerMs,
    upperMs,
    from: Math.floor(lowerMs / 1_000),
    to: Math.ceil(upperMs / 1_000),
  }
}

function requiredCreatedAt(
  value: number | undefined,
  endpoint: string,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new InvalidApiShapeError(endpoint, 'created_at')
  }
  return value
}

function within(
  createdAt: number,
  window: BoundedWindow,
): boolean {
  return createdAt >= window.lowerMs && createdAt <= window.upperMs
}

function sameStrings(
  expected: readonly string[] | undefined,
  actual: readonly string[] | undefined,
): boolean {
  if (expected === undefined) return true
  if (actual === undefined || expected.length !== actual.length) return false
  return expected.every((value, index) => value === actual[index])
}

function expectedStartPrompt(
  input: EffectiveStartInput,
): string | undefined {
  if (typeof input.prompt !== 'string') return undefined
  return stripRequestMarkers(
    prepareStartOperation(input).submittedInput.prompt,
  )
}

function expectedFollowUpPrompt(
  input: EffectiveFollowUpInput,
): string | undefined {
  if (typeof input.prompt !== 'string') return undefined
  return stripRequestMarkers(
    prepareFollowUpOperation(input).submittedInput.prompt,
  )
}

function startFingerprintMatches(
  runner: Runner,
  session: Session,
  input: EffectiveStartInput,
): boolean {
  const expectedPrompt = expectedStartPrompt(input)
  if (
    expectedPrompt !== undefined
    && (
      session.prompt === undefined
      || stripRequestMarkers(session.prompt) !== expectedPrompt
    )
  ) return false
  const expectedAgent = input.agent
  if (
    expectedAgent !== undefined
    && session.agent !== expectedAgent
  ) return false
  if (input.model !== undefined && session.model !== input.model) return false
  if (input.effort !== undefined && session.effort !== input.effort) {
    return false
  }
  if (input.branch !== undefined && runner.branch !== input.branch) return false
  if (input.mode !== undefined && session.mode !== input.mode) return false
  return sameStrings(input.fileKeys, session.fileKeys)
}

function sessionFingerprintMatches(
  session: Session,
  input: EffectiveFollowUpInput,
): boolean {
  const expectedPrompt = expectedFollowUpPrompt(input)
  if (
    expectedPrompt !== undefined
    && (
      session.prompt === undefined
      || stripRequestMarkers(session.prompt) !== expectedPrompt
    )
  ) return false
  if (input.agent !== undefined && session.agent !== input.agent) return false
  if (input.model !== undefined && session.model !== input.model) return false
  if (input.effort !== undefined && session.effort !== input.effort) {
    return false
  }
  if (input.mode !== undefined && session.mode !== input.mode) return false
  return sameStrings(input.fileKeys, session.fileKeys)
}

function runHandleFromMatch(
  match: RunnerMatch,
  input: EffectiveStartInput,
  window: RequestWindow,
  defaults: Pick<
    ReconcilerOptions,
    'defaultAgent' | 'defaultDeadlineMs' | 'defaultLanding'
  >,
): RunHandle {
  const deadlineMs = nonNegativeInteger(
    input.deadlineMs ?? defaults.defaultDeadlineMs,
    'deadlineMs',
  )
  const capacity = nonNegativeInteger(
    input.retryBudget?.capacity ?? 0,
    'retryBudget.capacity',
  )
  const deadlineAt = window.sentAt + deadlineMs
  if (!Number.isFinite(deadlineAt)) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'The reconciled deadline exceeds the supported time range.',
    )
  }
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: match.runner.runnerId,
    siteId: input.siteId,
    agent: input.agent ?? defaults.defaultAgent,
    ...(match.runner.codeOrigin === undefined
      ? {}
      : {
          origin: {
            codeOrigin: match.runner.codeOrigin,
            ...(match.runner.branch === undefined
              ? {}
              : { branch: match.runner.branch }),
          },
        }),
    input,
    policy: {
      landing: input.land ?? defaults.defaultLanding,
      deadlineAt,
      retryBudget: { capacity },
    },
    retries: { capacity: 0 },
    currentSessionId: match.session.sessionId,
  }
}

function sessionHandleFromMatch(
  handle: Handle,
  match: SessionMatch,
  input: EffectiveFollowUpInput,
): SessionHandle {
  return {
    ...handle,
    kind: 'session',
    currentSessionId: match.session.sessionId,
    sessionId: match.session.sessionId,
    sessionInput: input,
  }
}

export function createReconciler(
  options: ReconcilerOptions,
): Reconciler {
  const {
    transport,
    defaultAgent,
    defaultDeadlineMs,
    defaultLanding,
    clockSkewAllowanceMs = DEFAULT_CLOCK_SKEW_ALLOWANCE_MS,
  } = options
  nonNegativeFinite(clockSkewAllowanceMs, 'clockSkewAllowanceMs')

  async function allBoundedRunners(
    input: EffectiveStartInput,
    window: BoundedWindow,
    requestOptions?: TransportRequestOptions,
  ): Promise<Runner[]> {
    const runners = new Map<string, Runner>()
    const visitedPages = new Set<number>()
    let page = 1
    while (true) {
      if (visitedPages.has(page)) {
        throw new InvalidApiShapeError('/agent_runners', 'next_page')
      }
      visitedPages.add(page)
      const result = await transport.listRunners({
        siteId: input.siteId,
        from: window.from,
        to: window.to,
        page,
        perPage: 100,
      }, requestOptions)
      for (const runner of result.items) {
        runners.set(runner.runnerId, runner)
      }
      if (result.nextPage === undefined) break
      page = result.nextPage
    }
    return [...runners.values()]
  }

  async function runnerMatches(
    input: EffectiveStartInput,
    window: BoundedWindow,
    requestOptions?: TransportRequestOptions,
  ): Promise<RunnerMatch[]> {
    const runners = await allBoundedRunners(input, window, requestOptions)
    const matches: RunnerMatch[] = []
    for (const runner of runners) {
      const createdAt = requiredCreatedAt(
        runner.createdAt,
        `/agent_runners/${runner.runnerId}`,
      )
      if (!within(createdAt, window)) continue
      const sessions = await transport.listSessions(
        runner.runnerId,
        requestOptions,
      )
      const initialSession = sessions[0]
      if (
        initialSession === undefined
        || initialSession.runnerId !== runner.runnerId
        || initialSession.prompt === undefined
        || !hasRequestMarker(initialSession.prompt, input.requestId)
        || !startFingerprintMatches(runner, initialSession, input)
      ) continue
      matches.push({
        runner,
        session: initialSession,
        candidate: {
          runnerId: runner.runnerId,
          sessionId: initialSession.sessionId,
          createdAt,
        },
      })
    }
    return matches
  }

  async function reconcileCreate(
    input: EffectiveStartInput,
    requestWindow: RequestWindow,
    requestOptions?: TransportRequestOptions,
  ): Promise<ReconciliationResult<RunHandle>> {
    requestMarkerFor(input.requestId)
    const window = boundedWindow(
      requestWindow,
      clockSkewAllowanceMs,
    )
    const matches = await runnerMatches(input, window, requestOptions)
    if (matches.length === 0) return { kind: 'none' }
    if (matches.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: matches.map((match) => match.candidate),
      }
    }
    return {
      kind: 'matched',
      handle: runHandleFromMatch(
        matches[0] as RunnerMatch,
        input,
        requestWindow,
        { defaultAgent, defaultDeadlineMs, defaultLanding },
      ),
    }
  }

  async function reconcileSession(
    handle: Handle,
    input: EffectiveFollowUpInput,
    requestWindow: RequestWindow,
    reconcileOptions: ReconcileSessionOptions = {},
  ): Promise<ReconciliationResult<SessionHandle>> {
    const { conflict, ...requestOptions } = reconcileOptions
    requestMarkerFor(input.requestId)
    if (
      conflict
      && (
        conflict.effectiveInput.requestId !== input.requestId
        || conflict.window.sentAt !== requestWindow.sentAt
        || conflict.window.failedAt !== requestWindow.failedAt
      )
    ) {
      throw new BasicAgentRunnerSdkError(
        'validation-error',
        'The active-session conflict does not match this reconciliation attempt.',
      )
    }
    const window = boundedWindow(
      requestWindow,
      clockSkewAllowanceMs,
    )
    const sessions = await transport.listSessions(
      handle.runnerId,
      requestOptions,
    )
    const matches: SessionMatch[] = []
    for (const session of sessions) {
      if (
        session.runnerId !== handle.runnerId
        || session.prompt === undefined
        || !hasRequestMarker(session.prompt, input.requestId)
        || !sessionFingerprintMatches(session, input)
        || (
          conflict?.activeSessionId !== undefined
          && session.sessionId !== conflict.activeSessionId
        )
      ) continue
      const createdAt = requiredCreatedAt(
        session.createdAt,
        `/agent_runners/${handle.runnerId}/sessions/${session.sessionId}`,
      )
      if (!within(createdAt, window)) continue
      matches.push({
        session,
        candidate: {
          runnerId: handle.runnerId,
          sessionId: session.sessionId,
          createdAt,
        },
      })
    }
    if (matches.length === 0) {
      if (conflict) throw conflict
      return { kind: 'none' }
    }
    if (matches.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: matches.map((match) => match.candidate),
      }
    }
    return {
      kind: 'matched',
      handle: sessionHandleFromMatch(
        handle,
        matches[0] as SessionMatch,
        input,
      ),
    }
  }

  return { reconcileCreate, reconcileSession }
}
