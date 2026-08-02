import type {
  FailureClassification,
  Runner,
  Session,
} from '../domain.js'
import {
  BasicAgentRunnerSdkError,
  InvalidApiShapeError,
} from '../errors.js'
import type {
  Handle,
  LandingProgress,
} from '../handles.js'
import type { LandingOutcome } from '../result.js'
import type {
  Transport,
  TransportRequestOptions,
} from '../transport/index.js'

export interface BackendLandingContext {
  transport: Transport
  requestOptions?: TransportRequestOptions
  now: () => number
  sleep: (ms: number) => Promise<unknown>
}

export interface BackendLandingResult<H extends Handle = Handle> {
  handle: H
  landing: LandingOutcome
}

export interface BackendLandingOptions {
  pollIntervalMs: number
}

type LandingStep = 'commit' | 'pr' | 'merge' | 'publish'

interface GithubObservation {
  runner: Runner
  session: Session
}

function backendFailure(
  step: LandingStep,
  code: string,
  message: string,
  category: FailureClassification['category'] = 'platform',
): LandingOutcome {
  return {
    kind: 'failed',
    step,
    failure: {
      category,
      code,
      message,
      retryable: false,
    },
  }
}

function errorFromBackend(
  step: LandingStep,
  message: string,
): LandingOutcome {
  if (/coding installation/i.test(message)) {
    return backendFailure(
      step,
      'missing-coding-installation',
      message,
      'permission',
    )
  }
  return backendFailure(
    step,
    step === 'pr' ? 'pr-creation-failed' : 'commit-to-pr-failed',
    message,
  )
}

function withLanding<H extends Handle>(
  handle: H,
  patch: Partial<LandingProgress>,
): H {
  return {
    ...handle,
    landing: {
      ...handle.landing,
      ...patch,
    },
  }
}

function withOrigin<H extends Handle>(
  handle: H,
  runner: Runner,
): H {
  if (runner.codeOrigin === undefined) return handle
  return {
    ...handle,
    origin: {
      ...handle.origin,
      codeOrigin: runner.codeOrigin,
      ...(runner.branch === undefined
        ? {}
        : { branch: runner.branch }),
    },
  }
}

function markSessionCommitted<H extends Handle>(
  handle: H,
  sessionId: string,
): H {
  const committed = new Set(handle.landing?.committedSessionIds ?? [])
  committed.add(sessionId)
  return withLanding(handle, {
    committedSessionIds: [...committed],
  })
}

function isCommitted(handle: Handle, sessionId: string): boolean {
  return handle.landing?.committedSessionIds?.includes(sessionId) ?? false
}

function codeOrigin(handle: Handle, runner: Runner): string {
  return (runner.codeOrigin ?? handle.origin?.codeOrigin ?? '')
    .trim()
    .toLowerCase()
}

function validPrBranch(branch: string | undefined): string | undefined {
  const normalized = branch?.trim()
  if (!normalized) return undefined
  if (normalized === 'main' || normalized === 'master') return undefined
  return normalized
}

function ensureTimeRemaining(
  handle: Handle,
  context: BackendLandingContext,
): number {
  const remaining = handle.policy.deadlineAt - context.now()
  if (remaining <= 0) {
    throw new BasicAgentRunnerSdkError(
      'request-timeout',
      'The Agent Runner landing deadline elapsed.',
    )
  }
  return remaining
}

async function pause(
  handle: Handle,
  context: BackendLandingContext,
  pollIntervalMs: number,
): Promise<void> {
  await context.sleep(Math.min(
    pollIntervalMs,
    ensureTimeRemaining(handle, context),
  ))
}

async function observe(
  handle: Handle,
  context: BackendLandingContext,
): Promise<GithubObservation> {
  const [runner, session] = await Promise.all([
    context.transport.getRunner(
      handle.runnerId,
      context.requestOptions,
    ),
    context.transport.getSession(
      handle.runnerId,
      handle.currentSessionId,
      context.requestOptions,
    ),
  ])
  if (
    runner.runnerId !== handle.runnerId
    || session.runnerId !== handle.runnerId
    || session.sessionId !== handle.currentSessionId
  ) {
    throw new InvalidApiShapeError(
      `/agent_runners/${handle.runnerId}/landing`,
      'runner_or_session_identity',
    )
  }
  return { runner, session }
}

async function waitForPullRequest(
  handle: Handle,
  initialRunner: Runner,
  context: BackendLandingContext,
  pollIntervalMs: number,
): Promise<Runner | LandingOutcome> {
  let runner = initialRunner
  while (true) {
    if (runner.prError) return errorFromBackend('pr', runner.prError)
    if (runner.prUrl && runner.prIsBeingCreated !== true) return runner
    if (
      runner.prIsBeingCreated !== true
      && runner.prUrl === undefined
    ) {
      return backendFailure(
        'pr',
        'pr-url-missing',
        'Pull request creation settled without a pull request URL.',
      )
    }
    await pause(handle, context, pollIntervalMs)
    runner = await context.transport.getRunner(
      handle.runnerId,
      context.requestOptions,
    )
  }
}

async function ensureCurrentSessionCommitted<H extends Handle>(
  handle: H,
  initial: GithubObservation,
  context: BackendLandingContext,
  pollIntervalMs: number,
): Promise<BackendLandingResult<H> | GithubObservation> {
  const sessionId = handle.currentSessionId
  if (isCommitted(handle, sessionId) || initial.session.commitSha) {
    return {
      ...initial,
      session: {
        ...initial.session,
        ...(initial.session.commitSha === undefined
          ? {}
          : { commitSha: initial.session.commitSha }),
      },
    }
  }
  let observation = initial
  let actionObserved = observation.runner.mergeCommitIsBeingCreated === true
  if (observation.runner.mergeCommitError) {
    return {
      handle,
      landing: errorFromBackend(
        'commit',
        observation.runner.mergeCommitError,
      ),
    }
  }
  if (!actionObserved) {
    ensureTimeRemaining(handle, context)
    const targetBranch = validPrBranch(observation.runner.prBranch)
    if (targetBranch === undefined) {
      return {
        handle,
        landing: backendFailure(
          'commit',
          'invalid-pr-branch',
          'The Agent Runner did not provide a safe pull request branch.',
          'validation',
        ),
      }
    }
    const actionRunner = await context.transport.member(
      handle.runnerId,
      'commit',
      { targetBranch },
      context.requestOptions,
    )
    if (actionRunner.runnerId !== handle.runnerId) {
      throw new InvalidApiShapeError(
        `/agent_runners/${handle.runnerId}/commit`,
        'id',
      )
    }
    observation = {
      runner: actionRunner,
      session: observation.session,
    }
    actionObserved = true
  }

  while (true) {
    if (observation.session.commitSha) return observation
    if (observation.runner.mergeCommitError) {
      return {
        handle,
        landing: errorFromBackend(
          'commit',
          observation.runner.mergeCommitError,
        ),
      }
    }
    if (
      actionObserved
      && observation.runner.mergeCommitIsBeingCreated !== true
    ) {
      return {
        handle,
        landing: backendFailure(
          'commit',
          'session-commit-missing',
          'Branch commit settled without a commit for the current session.',
        ),
      }
    }
    await pause(handle, context, pollIntervalMs)
    observation = await observe(handle, context)
  }
}

async function waitForBackendSettlement(
  handle: Handle,
  initial: GithubObservation,
  context: BackendLandingContext,
  pollIntervalMs: number,
  requireSessionCommit: boolean,
): Promise<GithubObservation | LandingOutcome> {
  let observation = initial
  while (
    observation.runner.prIsBeingCreated === true
    || observation.runner.mergeCommitIsBeingCreated === true
    || (
      requireSessionCommit
      && observation.session.hasResultDiff !== false
      && observation.session.commitSha === undefined
    )
  ) {
    await pause(handle, context, pollIntervalMs)
    observation = await observe(handle, context)
    if (observation.runner.prError) {
      return errorFromBackend('pr', observation.runner.prError)
    }
    if (observation.runner.mergeCommitError) {
      return errorFromBackend(
        'commit',
        observation.runner.mergeCommitError,
      )
    }
  }
  return observation
}

export function createBackendLandingHandler({
  pollIntervalMs,
}: BackendLandingOptions) {
  return async function landWithBackend<H extends Handle>(
    originalHandle: H,
    context: BackendLandingContext,
  ): Promise<BackendLandingResult<H>> {
    ensureTimeRemaining(originalHandle, context)
    let handle = originalHandle
    let observation = await observe(handle, context)
    handle = withOrigin(handle, observation.runner)
    const origin = codeOrigin(handle, observation.runner)
    if (origin !== 'github') {
      return {
        handle,
        landing: {
          kind: 'unsupported',
          reason: origin === ''
            ? 'The Agent Runner code origin is unknown.'
            : `Landing is not implemented for ${origin} runners.`,
        },
      }
    }

    const persistedPrUrl = handle.landing?.prUrl
    const hadPullRequest = Boolean(
      observation.runner.prUrl ?? persistedPrUrl,
    )
    if (!hadPullRequest) {
      if (observation.runner.prError) {
        return {
          handle,
          landing: errorFromBackend('pr', observation.runner.prError),
        }
      }
      if (observation.runner.prIsBeingCreated !== true) {
        ensureTimeRemaining(handle, context)
        const actionRunner = await context.transport.member(
          handle.runnerId,
          'pull_request',
          {},
          context.requestOptions,
        )
        if (actionRunner.runnerId !== handle.runnerId) {
          throw new InvalidApiShapeError(
            `/agent_runners/${handle.runnerId}/pull_request`,
            'id',
          )
        }
        observation = {
          runner: actionRunner,
          session: observation.session,
        }
      }
      const settled = await waitForPullRequest(
        handle,
        observation.runner,
        context,
        pollIntervalMs,
      )
      if (!('runnerId' in settled)) {
        return { handle, landing: settled }
      }
      observation = {
        runner: settled,
        session: observation.session,
      }
      handle = withLanding(handle, { prUrl: settled.prUrl })
      handle = markSessionCommitted(handle, handle.currentSessionId)
    } else {
      const prUrl = observation.runner.prUrl ?? persistedPrUrl
      handle = withLanding(handle, {
        ...(prUrl === undefined ? {} : { prUrl }),
      })
      if (observation.runner.prError) {
        return {
          handle,
          landing: errorFromBackend('pr', observation.runner.prError),
        }
      }
      if (observation.runner.prIsBeingCreated === true) {
        const settled = await waitForPullRequest(
          handle,
          observation.runner,
          context,
          pollIntervalMs,
        )
        if (!('runnerId' in settled)) {
          return { handle, landing: settled }
        }
        observation = {
          runner: settled,
          session: observation.session,
        }
        handle = withLanding(handle, { prUrl: settled.prUrl })
      }
    }

    if (
      hadPullRequest
      && handle.kind === 'session'
      && !isCommitted(handle, handle.currentSessionId)
    ) {
      if (observation.session.hasResultDiff !== false) {
        const committed = await ensureCurrentSessionCommitted(
          handle,
          observation,
          context,
          pollIntervalMs,
        )
        if ('handle' in committed) return committed
        observation = committed
      }
      handle = markSessionCommitted(handle, handle.currentSessionId)
    }

    if (
      handle.policy.landing === 'merge'
      || handle.policy.landing === 'auto'
    ) {
      const settled = await waitForBackendSettlement(
        handle,
        observation,
        context,
        pollIntervalMs,
        isCommitted(handle, handle.currentSessionId),
      )
      if (!('runner' in settled)) {
        return { handle, landing: settled }
      }
      observation = settled
    }

    const prUrl = observation.runner.prUrl ?? handle.landing?.prUrl
    if (prUrl === undefined) {
      return {
        handle,
        landing: backendFailure(
          'pr',
          'pr-url-missing',
          'The Agent Runner did not provide a pull request URL.',
        ),
      }
    }
    handle = withLanding(handle, { prUrl })
    return {
      handle,
      landing: {
        kind: 'prOpen',
        prUrl,
        merged: false,
      },
    }
  }
}
