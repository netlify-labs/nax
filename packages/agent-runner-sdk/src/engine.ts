import type {
  BlobRef,
  EffectiveFollowUpInput,
  EffectiveStartInput,
  FailureClassification,
  FollowUpInput,
  ProgressEvent,
  RequestWindow,
  Runner,
  Session,
  StartInput,
  Usage,
} from './domain.js'
import {
  BasicAgentRunnerSdkError,
  CreateAmbiguousError,
  HttpResponseError,
  InvalidApiShapeError,
  SessionAlreadyActiveError,
  SessionCreateAmbiguousError,
  isAgentRunnerSdkError,
} from './errors.js'
import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  parseHandle,
  serializeHandle,
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
  stripRequestMarkers,
  submitFollowUpOperation,
  submitStartOperation,
} from './operations.js'
import type {
  LandingOutcome,
  ReconciliationResult,
  RunOutcome,
  RunResult,
  RunSnapshot,
} from './result.js'
import {
  createReconciler,
} from './reconciliation.js'
import type {
  ReconcileSessionOptions,
} from './reconciliation.js'
import { createBackendLandingHandler } from './landing/backend.js'
import { createGithubLandingHandler } from './landing/github.js'
import type { GithubMergeMethod } from './github/mergePr.js'
import { detectRuntime } from './runtime.js'
import type { AgentRuntime } from './runtime.js'
import {
  createHttpTransport,
} from './transport/index.js'
import type {
  HttpTransportOptions,
  Transport,
  TransportRequestOptions,
} from './transport/index.js'

export const DEFAULT_AGENT = 'claude'
export const DEFAULT_DEADLINE_MS = 25 * 60 * 1_000
export const DEFAULT_POLL_INTERVAL_MS = 15_000
export const DEFAULT_LANDING = 'none'

const SUCCESS_STATES = new Set(['completed', 'done'])
const FAILURE_STATES = new Set(['failed', 'error'])
const CANCELLED_STATES = new Set(['cancelled', 'canceled', 'abandoned'])
const TIMEOUT_STATES = new Set(['timeout', 'timed_out', 'timedout'])

export interface LandingContext {
  transport: Transport
  requestOptions?: TransportRequestOptions
  now: () => number
  sleep: (ms: number) => Promise<unknown>
  checkpoint: (handle: Handle) => Promise<void>
  classifyFailure: typeof classifyFailure
}

export interface LandingResult<H extends Handle = Handle> {
  handle: H
  landing: LandingOutcome
}

export interface LandingHandler {
  <H extends Handle>(
    handle: H,
    context: LandingContext,
  ): Promise<LandingResult<H>>
}

export interface AgentRunnerSdkOptions
  extends Omit<HttpTransportOptions, 'sleep'> {
  transport?: 'http' | Transport
  sleep?: (ms: number) => Promise<unknown>
  generateRequestId?: () => string
  defaultDeadlineMs?: number
  pollIntervalMs?: number
  landingHandler?: LandingHandler
  clockSkewAllowanceMs?: number
  promptRefDelivery?: (ref: BlobRef) => string | Promise<string>
  githubToken?: string
  githubApiUrl?: string
  githubMergeMethod?: GithubMergeMethod
  onLandingCheckpoint?: (handle: Handle) => void | Promise<void>
}

export interface WaitForOptions extends TransportRequestOptions {
  pollIntervalMs?: number
  onProgress?: (event: ProgressEvent) => void
}

export interface RunOptions extends WaitForOptions {}

export interface AgentRunnerSdk {
  readonly runtime: AgentRuntime
  readonly transport: Transport
  start(
    input: StartInput,
    options?: TransportRequestOptions,
  ): Promise<RunHandle>
  getSnapshot(
    handle: Handle,
    options?: TransportRequestOptions,
  ): Promise<RunSnapshot>
  getResult(
    handle: Handle,
    options?: TransportRequestOptions,
  ): Promise<RunResult>
  waitFor(handle: Handle, options?: WaitForOptions): Promise<RunResult>
  stop<H extends Handle>(
    handle: H,
    options?: TransportRequestOptions,
  ): Promise<H>
  land<H extends Handle>(
    handle: H,
    options?: TransportRequestOptions,
  ): Promise<LandingResult<H>>
  run(input: StartInput, options?: RunOptions): Promise<RunOutcome<RunHandle>>
  followUp(
    handle: Handle,
    input: FollowUpInput,
    options?: TransportRequestOptions,
  ): Promise<SessionHandle>
  retry(
    handle: RunHandle,
    options?: TransportRequestOptions,
  ): Promise<RunHandle>
  retry(
    handle: SessionHandle,
    options?: TransportRequestOptions,
  ): Promise<SessionHandle>
  shouldRetry(
    handle: Handle,
    failure: FailureClassification,
  ): boolean
  classifyFailure(error: unknown): FailureClassification
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
  parseHandle(value: string | unknown): Handle
  serializeHandle(handle: Handle): string
}

interface ObservedRun {
  runner: Runner
  session: Session
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nonNegativeInteger(
  value: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} must be a non-negative integer.`,
    )
  }
  return value
}

function positiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} must be greater than zero.`,
    )
  }
  return value
}

function state(value: string): string {
  return value.trim().toLowerCase()
}

function terminalState(runner: Runner, session: Session): string | undefined {
  const sessionState = state(session.state)
  if (
    SUCCESS_STATES.has(sessionState)
    || FAILURE_STATES.has(sessionState)
    || CANCELLED_STATES.has(sessionState)
    || TIMEOUT_STATES.has(sessionState)
  ) return sessionState
  const runnerState = state(runner.state)
  if (
    SUCCESS_STATES.has(runnerState)
    || FAILURE_STATES.has(runnerState)
    || CANCELLED_STATES.has(runnerState)
    || TIMEOUT_STATES.has(runnerState)
  ) return runnerState
  return undefined
}

function sessionUsage(session: Session): Usage | null {
  return session.usage === null ? null : { ...session.usage }
}

function changesFor(
  runner: Runner,
  session: Session,
): 'changed' | 'unchanged' | 'unknown' {
  const changed = session.hasResultDiff ?? runner.hasResultDiff
  return changed === true
    ? 'changed'
    : changed === false
      ? 'unchanged'
      : 'unknown'
}

function terminalFailure(
  terminal: string,
  session: Session,
): FailureClassification {
  if (session.creditLimitExceeded) {
    return {
      category: 'capacity',
      code: 'credit-limit-exceeded',
      message: 'The Agent Runner credit limit was exceeded.',
      retryable: false,
    }
  }
  return {
    category: 'platform',
    code: `terminal-${terminal}`,
    message: 'The Agent Runner ended with a failure.',
    retryable: false,
  }
}

function toRunResult(
  handle: Handle,
  observed: ObservedRun,
): RunResult | undefined {
  const terminal = terminalState(observed.runner, observed.session)
  if (terminal === undefined) return undefined
  const usage = sessionUsage(observed.session)
  if (SUCCESS_STATES.has(terminal)) {
    return {
      status: 'succeeded',
      runnerId: handle.runnerId,
      sessionId: handle.currentSessionId,
      resultText: stripRequestMarkers(observed.session.resultText ?? ''),
      usage,
      changes: changesFor(observed.runner, observed.session),
      ...(observed.session.deployUrl === undefined
        ? {}
        : { deployUrl: observed.session.deployUrl }),
      links: {
        ...(observed.runner.prUrl === undefined
          ? {}
          : { prUrl: observed.runner.prUrl }),
      },
    }
  }
  if (CANCELLED_STATES.has(terminal)) {
    return {
      status: 'cancelled',
      runnerId: handle.runnerId,
      sessionId: handle.currentSessionId,
      usage,
    }
  }
  if (TIMEOUT_STATES.has(terminal)) {
    return {
      status: 'timedOut',
      runnerId: handle.runnerId,
      sessionId: handle.currentSessionId,
      usage,
      cancelledRunner: false,
    }
  }
  return {
    status: 'failed',
    runnerId: handle.runnerId,
    sessionId: handle.currentSessionId,
    failure: terminalFailure(terminal, observed.session),
    usage,
  }
}

function progress(
  observer: ((event: ProgressEvent) => void) | undefined,
  event: ProgressEvent,
): void {
  if (!observer) return
  try {
    observer(event)
  } catch {
    // Progress observers cannot change engine behavior.
  }
}

function resultStatus(
  result: RunResult,
): 'succeeded' | 'failed' | 'cancelled' | 'timedOut' {
  return result.status
}

function landingStep(
  handle: Handle,
): 'commit' | 'pr' | 'merge' | 'publish' {
  if (handle.policy.landing === 'publish') return 'publish'
  if (handle.policy.landing === 'merge') return 'merge'
  return handle.kind === 'session' ? 'commit' : 'pr'
}

export function classifyFailure(error: unknown): FailureClassification {
  if (isAgentRunnerSdkError(error)) {
    const code = error.code
    let category: FailureClassification['category'] = 'unknown'
    if (
      code === 'auth-missing'
      || code === 'auth-invalid'
      || code === 'auth-expired'
    ) category = 'authentication'
    else if (code === 'auth-permission') category = 'permission'
    else if (
      code === 'validation-error'
      || code === 'invalid-api-shape'
      || code === 'invalid-handle'
      || code === 'unsupported-handle-version'
    ) category = 'validation'
    else if (code === 'missing-coding-installation') category = 'permission'
    else if (code === 'capacity-exhausted') category = 'capacity'
    else if (code === 'rate-limited') category = 'rate-limit'
    else if (code === 'network-error') category = 'network'
    else if (code === 'request-timeout') category = 'timeout'
    else if (code === 'pr-head-changed' || code === 'github-token-required') {
      category = 'github'
    } else if (code === 'http-error') category = 'platform'

    const retryable = code === 'capacity-exhausted'
      || code === 'rate-limited'
      || code === 'network-error'
      || code === 'request-timeout'
      || (
        error instanceof HttpResponseError
        && error.status >= 500
      )
    return {
      category,
      code,
      message: error.message,
      retryable,
      ...(error instanceof HttpResponseError
        ? { status: error.status }
        : {}),
    }
  }
  return {
    category: 'unknown',
    code: 'unknown-error',
    message: 'The Agent Runner operation failed.',
    retryable: false,
  }
}

export function createAgentRunnerSdk(
  options: AgentRunnerSdkOptions = {},
): AgentRunnerSdk {
  const {
    transport: configuredTransport = 'http',
    sleep = defaultSleep,
    generateRequestId,
    defaultDeadlineMs = DEFAULT_DEADLINE_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    landingHandler: configuredLandingHandler,
    clockSkewAllowanceMs,
    promptRefDelivery,
    githubToken,
    githubApiUrl,
    githubMergeMethod,
    onLandingCheckpoint,
    now = Date.now,
    ...httpOptions
  } = options
  const resolvedDefaultDeadlineMs = nonNegativeInteger(
    defaultDeadlineMs,
    'defaultDeadlineMs',
  )
  const resolvedPollIntervalMs = positiveFinite(
    pollIntervalMs,
    'pollIntervalMs',
  )
  const landingHandler = configuredLandingHandler
    ?? createGithubLandingHandler({
      backend: createBackendLandingHandler({
        pollIntervalMs: resolvedPollIntervalMs,
      }),
      ...(githubToken === undefined ? {} : { githubToken }),
      ...(githubApiUrl === undefined ? {} : { githubApiUrl }),
      ...(githubMergeMethod === undefined ? {} : { githubMergeMethod }),
      ...(httpOptions.fetch === undefined
        ? {}
        : { fetch: httpOptions.fetch }),
    })
  const transport = configuredTransport === 'http'
    ? createHttpTransport({
        ...httpOptions,
        now,
        sleep,
      })
    : configuredTransport
  const reconciler = createReconciler({
    transport,
    defaultAgent: DEFAULT_AGENT,
    defaultDeadlineMs: resolvedDefaultDeadlineMs,
    defaultLanding: DEFAULT_LANDING,
    ...(clockSkewAllowanceMs === undefined
      ? {}
      : { clockSkewAllowanceMs }),
  })

  async function deliveryOptions(
    input: StartInput | FollowUpInput,
  ): Promise<{ deliveredPrompt?: string }> {
    if (input.promptRef === undefined) return {}
    if (input.promptRef.expiresAt <= now()) {
      throw new BasicAgentRunnerSdkError(
        'prompt-ref-expired',
        'The Agent Runner prompt reference has expired.',
      )
    }
    if (!promptRefDelivery) {
      throw new BasicAgentRunnerSdkError(
        'validation-error',
        'Prompt-reference delivery is not configured.',
      )
    }
    return {
      deliveredPrompt: await promptRefDelivery(input.promptRef),
    }
  }

  async function initialSessionFor(
    runner: Runner,
    requestId: string,
    requestOptions?: TransportRequestOptions,
  ): Promise<Session> {
    const sessions = await transport.listSessions(
      runner.runnerId,
      requestOptions,
    )
    const matching = sessions.filter((session) => (
      session.prompt !== undefined
      && hasRequestMarker(session.prompt, requestId)
    ))
    if (matching.length !== 1) {
      throw new InvalidApiShapeError(
        `/agent_runners/${runner.runnerId}/sessions`,
        'initial_session_request_marker',
      )
    }
    const initialSession = matching[0] as Session
    if (initialSession.runnerId !== runner.runnerId) {
      throw new InvalidApiShapeError(
        `/agent_runners/${runner.runnerId}/sessions`,
        'agent_runner_id',
      )
    }
    return initialSession
  }

  async function observe(
    handle: Handle,
    requestOptions?: TransportRequestOptions,
  ): Promise<ObservedRun> {
    const [runner, session] = await Promise.all([
      transport.getRunner(handle.runnerId, requestOptions),
      transport.getSession(
        handle.runnerId,
        handle.currentSessionId,
        requestOptions,
      ),
    ])
    if (session.runnerId !== handle.runnerId) {
      throw new InvalidApiShapeError(
        `/agent_runners/${handle.runnerId}/sessions/${handle.currentSessionId}`,
        'agent_runner_id',
      )
    }
    if (session.sessionId !== handle.currentSessionId) {
      throw new InvalidApiShapeError(
        `/agent_runners/${handle.runnerId}/sessions/${handle.currentSessionId}`,
        'id',
      )
    }
    return { runner, session }
  }

  async function start(
    input: StartInput,
    requestOptions?: TransportRequestOptions,
  ): Promise<RunHandle> {
    const startedAt = now()
    const deadlineMs = nonNegativeInteger(
      input.deadlineMs ?? resolvedDefaultDeadlineMs,
      'deadlineMs',
    )
    const retryCapacity = nonNegativeInteger(
      input.retryBudget?.capacity ?? 0,
      'retryBudget.capacity',
    )
    const resolvedInput: StartInput = {
      ...input,
      agent: input.agent ?? DEFAULT_AGENT,
      land: input.land ?? DEFAULT_LANDING,
      deadlineMs,
      retryBudget: { capacity: retryCapacity },
    }
    const delivery = await deliveryOptions(resolvedInput)
    const prepared = prepareStartOperation(resolvedInput, {
      ...(generateRequestId === undefined
        ? {}
        : { randomUUID: generateRequestId }),
      ...delivery,
    })
    let submitted
    try {
      submitted = await submitStartOperation(
        prepared,
        (wireInput) => transport.createRunner(wireInput, requestOptions),
      )
    } catch (error: unknown) {
      if (!(error instanceof CreateAmbiguousError)) throw error
      const reconciled = await reconciler.reconcileCreate(
        error.effectiveInput,
        error.window,
        requestOptions,
      )
      if (reconciled.kind === 'matched') return reconciled.handle
      throw error
    }
    const runner = submitted.value
    const initialSession = await initialSessionFor(
      runner,
      submitted.effectiveInput.requestId,
      requestOptions,
    )
    const codeOrigin = runner.codeOrigin
    return {
      v: AGENT_RUNNER_SDK_HANDLE_VERSION,
      kind: 'run',
      runnerId: runner.runnerId,
      siteId: submitted.effectiveInput.siteId,
      agent: submitted.effectiveInput.agent ?? DEFAULT_AGENT,
      ...(codeOrigin === undefined
        ? {}
        : {
            origin: {
              codeOrigin,
              ...(runner.branch === undefined
                ? {}
                : { branch: runner.branch }),
            },
          }),
      input: submitted.effectiveInput,
      policy: {
        landing: submitted.effectiveInput.land ?? DEFAULT_LANDING,
        deadlineAt: startedAt + deadlineMs,
        retryBudget: { capacity: retryCapacity },
      },
      retries: { capacity: 0 },
      currentSessionId: initialSession.sessionId,
    }
  }

  async function getSnapshot(
    handleValue: Handle,
    requestOptions?: TransportRequestOptions,
  ): Promise<RunSnapshot> {
    const handle = parseHandle(handleValue)
    const observed = await observe(handle, requestOptions)
    const result = toRunResult(handle, observed)
    if (result !== undefined) return { kind: 'terminal', result }
    return {
      kind: 'running',
      runnerId: handle.runnerId,
      sessionId: handle.currentSessionId,
      state: observed.session.state || observed.runner.state,
      ...(observed.session.currentTask === undefined
        && observed.runner.currentTask === undefined
        ? {}
        : {
            latestStep:
              observed.session.currentTask ?? observed.runner.currentTask,
          }),
      usage: sessionUsage(observed.session),
    }
  }

  async function getResult(
    handle: Handle,
    requestOptions?: TransportRequestOptions,
  ): Promise<RunResult> {
    const snapshot = await getSnapshot(handle, requestOptions)
    if (snapshot.kind === 'running') {
      throw new BasicAgentRunnerSdkError(
        'validation-error',
        'The Agent Runner has not reached a terminal state.',
      )
    }
    return snapshot.result
  }

  async function stop<H extends Handle>(
    handleValue: H,
    requestOptions?: TransportRequestOptions,
  ): Promise<H> {
    const handle = parseHandle(handleValue) as H
    try {
      if (handle.kind === 'session') {
        await transport.cancelSession(
          handle.runnerId,
          handle.sessionId,
          requestOptions,
        )
      } else {
        await transport.cancelRunner(handle.runnerId, requestOptions)
      }
    } catch (error: unknown) {
      if (!isAgentRunnerSdkError(error, 'not-found')) throw error
    }
    return handle
  }

  async function waitFor(
    handleValue: Handle,
    waitOptions: WaitForOptions = {},
  ): Promise<RunResult> {
    const handle = parseHandle(handleValue)
    const {
      pollIntervalMs: operationPollIntervalMs = resolvedPollIntervalMs,
      onProgress,
      ...requestOptions
    } = waitOptions
    const interval = positiveFinite(
      operationPollIntervalMs,
      'pollIntervalMs',
    )
    let lastState: string | undefined
    let latestUsage: Usage | null = null
    while (true) {
      const snapshot = await getSnapshot(handle, requestOptions)
      if (snapshot.kind === 'terminal') {
        progress(onProgress, {
          kind: 'finished',
          runnerId: handle.runnerId,
          status: resultStatus(snapshot.result),
          at: now(),
        })
        return snapshot.result
      }
      latestUsage = snapshot.usage
      if (snapshot.state !== lastState) {
        lastState = snapshot.state
        progress(onProgress, {
          kind: 'stateChanged',
          runnerId: handle.runnerId,
          sessionId: handle.currentSessionId,
          state: snapshot.state,
          ...(snapshot.latestStep === undefined
            ? {}
            : { latestStep: snapshot.latestStep }),
          at: now(),
        })
      }
      const remaining = handle.policy.deadlineAt - now()
      if (remaining <= 0) {
        let cancelledRunner = false
        try {
          await stop(handle, requestOptions)
          cancelledRunner = handle.kind === 'run'
        } catch {
          // The timeout result records whether runner cancellation succeeded.
        }
        const result: RunResult = {
          status: 'timedOut',
          runnerId: handle.runnerId,
          sessionId: handle.currentSessionId,
          usage: latestUsage,
          cancelledRunner,
        }
        progress(onProgress, {
          kind: 'finished',
          runnerId: handle.runnerId,
          status: 'timedOut',
          at: now(),
        })
        return result
      }
      await sleep(Math.min(interval, remaining))
    }
  }

  async function land<H extends Handle>(
    handleValue: H,
    requestOptions?: TransportRequestOptions,
  ): Promise<LandingResult<H>> {
    const handle = parseHandle(handleValue) as H
    if (handle.policy.landing === 'none') {
      return { handle, landing: { kind: 'skipped' } }
    }
    try {
      const landed = await landingHandler(handle, {
        transport,
        ...(requestOptions === undefined ? {} : { requestOptions }),
        now,
        sleep,
        checkpoint: async (checkpointHandle) => {
          const parsed = parseHandle(checkpointHandle)
          if (onLandingCheckpoint !== undefined) {
            await onLandingCheckpoint(parsed)
          }
        },
        classifyFailure,
      })
      const updated = parseHandle(landed.handle)
      if (
        updated.kind !== handle.kind
        || updated.runnerId !== handle.runnerId
        || updated.siteId !== handle.siteId
        || updated.currentSessionId !== handle.currentSessionId
      ) {
        throw new BasicAgentRunnerSdkError(
          'invalid-handle',
          'Landing cannot replace the run or current session identity.',
        )
      }
      return {
        handle: updated as H,
        landing: landed.landing,
      }
    } catch (error: unknown) {
      return {
        handle,
        landing: {
          kind: 'failed',
          step: landingStep(handle),
          failure: classifyFailure(error),
        },
      }
    }
  }

  async function run(
    input: StartInput,
    runOptions: RunOptions = {},
  ): Promise<RunOutcome<RunHandle>> {
    const {
      onProgress,
      pollIntervalMs: operationPollIntervalMs,
      ...requestOptions
    } = runOptions
    const handle = await start(input, requestOptions)
    progress(onProgress, {
      kind: 'started',
      runnerId: handle.runnerId,
      sessionId: handle.currentSessionId,
      at: now(),
    })
    const result = await waitFor(handle, {
      ...requestOptions,
      ...(operationPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: operationPollIntervalMs }),
      ...(onProgress === undefined ? {} : { onProgress }),
    })
    if (result.status !== 'succeeded') return { result, handle }
    const landed = await land(handle, requestOptions)
    return {
      result,
      landing: landed.landing,
      handle: landed.handle,
    }
  }

  async function createFollowUp(
    handle: Handle,
    input: FollowUpInput,
    requestOptions?: TransportRequestOptions,
    rotateRequestId = false,
  ): Promise<SessionHandle> {
    const delivery = await deliveryOptions(input)
    const prepared = prepareFollowUpOperation(input, {
      ...(generateRequestId === undefined
        ? {}
        : { randomUUID: generateRequestId }),
      ...delivery,
      ...(rotateRequestId ? { rotateRequestId: true } : {}),
    })
    try {
      const submitted = await submitFollowUpOperation(
        prepared,
        (wireInput) => transport.createSession(
          handle.runnerId,
          wireInput,
          requestOptions,
        ),
      )
      if (submitted.value.runnerId !== handle.runnerId) {
        throw new InvalidApiShapeError(
          `/agent_runners/${handle.runnerId}/sessions`,
          'agent_runner_id',
        )
      }
      return {
        ...handle,
        kind: 'session',
        currentSessionId: submitted.value.sessionId,
        sessionId: submitted.value.sessionId,
        sessionInput: submitted.effectiveInput,
      }
    } catch (error: unknown) {
      if (
        !(error instanceof SessionAlreadyActiveError)
        && !(error instanceof SessionCreateAmbiguousError)
      ) throw error
      const reconciled = await reconciler.reconcileSession(
        handle,
        error.effectiveInput,
        error.window,
        {
          ...requestOptions,
          ...(error instanceof SessionAlreadyActiveError
            ? { conflict: error }
            : {}),
        },
      )
      if (reconciled.kind === 'matched') return reconciled.handle
      throw error
    }
  }

  async function followUp(
    handleValue: Handle,
    input: FollowUpInput,
    requestOptions?: TransportRequestOptions,
  ): Promise<SessionHandle> {
    const handle = parseHandle(handleValue)
    return createFollowUp(handle, input, requestOptions)
  }

  async function retry(
    handleValue: RunHandle,
    requestOptions?: TransportRequestOptions,
  ): Promise<RunHandle>
  async function retry(
    handleValue: SessionHandle,
    requestOptions?: TransportRequestOptions,
  ): Promise<SessionHandle>
  async function retry(
    handleValue: Handle,
    requestOptions?: TransportRequestOptions,
  ): Promise<Handle> {
    const handle = parseHandle(handleValue)
    if (
      handle.retries.capacity
      >= handle.policy.retryBudget.capacity
    ) {
      throw new BasicAgentRunnerSdkError(
        'capacity-exhausted',
        'The Agent Runner retry budget is exhausted.',
      )
    }
    if (handle.kind === 'session') {
      const retried = await createFollowUp(
        handle,
        handle.sessionInput,
        requestOptions,
        true,
      )
      return {
        ...retried,
        retries: {
          capacity: handle.retries.capacity + 1,
        },
      }
    }

    const delivery = await deliveryOptions(handle.input)
    const prepared = prepareStartOperation(handle.input, {
      ...(generateRequestId === undefined
        ? {}
        : { randomUUID: generateRequestId }),
      ...delivery,
      rotateRequestId: true,
    })
    const submitted = await submitStartOperation(
      prepared,
      (wireInput) => transport.createRunner(wireInput, requestOptions),
    )
    const runner = submitted.value
    const initialSession = await initialSessionFor(
      runner,
      submitted.effectiveInput.requestId,
      requestOptions,
    )
    return {
      ...handle,
      kind: 'run',
      runnerId: runner.runnerId,
      agent: submitted.effectiveInput.agent ?? handle.agent,
      ...(runner.codeOrigin === undefined
        ? {}
        : {
            origin: {
              codeOrigin: runner.codeOrigin,
              ...(runner.branch === undefined
                ? {}
                : { branch: runner.branch }),
            },
          }),
      input: submitted.effectiveInput,
      retries: {
        capacity: handle.retries.capacity + 1,
      },
      currentSessionId: initialSession.sessionId,
    }
  }

  return {
    runtime: detectRuntime(),
    transport,
    start,
    getSnapshot,
    getResult,
    waitFor,
    stop,
    land,
    run,
    followUp,
    retry,
    shouldRetry: (handle, failure) => (
      failure.retryable
      && handle.retries.capacity < handle.policy.retryBudget.capacity
    ),
    classifyFailure,
    reconcileCreate: reconciler.reconcileCreate,
    reconcileSession: (
      handle,
      input,
      window,
      reconcileOptions,
    ) => reconciler.reconcileSession(
      parseHandle(handle),
      input,
      window,
      reconcileOptions,
    ),
    parseHandle,
    serializeHandle,
  }
}
