import {
  createAgentRunnerSdk,
  isAgentRunnerSdkError,
} from 'nax-agent-runner-sdk'
import type {
  AgentRunnerSdkOptions,
  EffectiveFollowUpInput,
  EffectiveStartInput,
  FollowUpInput,
  Handle,
  LandingOutcome,
  ReconciliationCandidate,
  RequestWindow,
  RunResult,
  StartInput,
} from 'nax-agent-runner-sdk'

export interface DurableJobStore {
  loadHandle(jobId: string): Promise<string>
  saveHandle(jobId: string, serializedHandle: string): Promise<void>
  saveUsage(jobId: string, usage: RunResult['usage']): Promise<void>
  requireReview(
    jobId: string,
    reason: 'none' | 'ambiguous',
    candidates: ReconciliationCandidate[],
  ): Promise<void>
}

export interface TickScheduler {
  schedule(jobId: string, runAt: number): Promise<void>
}

export type TickResult =
  | { kind: 'rescheduled'; handle: Handle }
  | {
      kind: 'finished'
      handle: Handle
      result: RunResult
      landing?: LandingOutcome
    }

export function createEventBridgeRunner({
  sdkOptions,
  store,
  scheduler,
  now = Date.now,
}: {
  sdkOptions: AgentRunnerSdkOptions
  store: DurableJobStore
  scheduler: TickScheduler
  now?: () => number
}) {
  const sdk = createAgentRunnerSdk({ ...sdkOptions, now })

  async function persist(jobId: string, handle: Handle): Promise<void> {
    await store.saveHandle(jobId, sdk.serializeHandle(handle))
  }

  async function scheduleNext(jobId: string): Promise<void> {
    await scheduler.schedule(jobId, now() + 15_000)
  }

  async function adoptCreateResolution(
    jobId: string,
    effectiveInput: EffectiveStartInput,
    window: RequestWindow,
  ): Promise<Handle | undefined> {
    const resolution = await sdk.reconcileCreate(effectiveInput, window)
    switch (resolution.kind) {
      case 'matched':
        await persist(jobId, resolution.handle)
        return resolution.handle
      case 'none':
        await store.requireReview(jobId, 'none', [])
        return undefined
      case 'ambiguous':
        await store.requireReview(
          jobId,
          'ambiguous',
          resolution.candidates,
        )
        return undefined
    }
  }

  async function dispatch(
    jobId: string,
    input: StartInput,
  ): Promise<Handle | undefined> {
    try {
      const handle = await sdk.start(input)
      await persist(jobId, handle)
      await scheduleNext(jobId)
      return handle
    } catch (error: unknown) {
      if (!isAgentRunnerSdkError(error, 'create-ambiguous')) throw error
      const handle = await adoptCreateResolution(
        jobId,
        error.effectiveInput,
        error.window,
      )
      if (handle !== undefined) await scheduleNext(jobId)
      return handle
    }
  }

  async function tick(jobId: string): Promise<TickResult> {
    let handle = sdk.parseHandle(await store.loadHandle(jobId))
    const snapshot = await sdk.getSnapshot(handle)

    if (snapshot.kind === 'running') {
      if (now() >= handle.policy.deadlineAt) {
        handle = await sdk.stop(handle)
        await persist(jobId, handle)
      }
      await scheduleNext(jobId)
      return { kind: 'rescheduled', handle }
    }

    const result = snapshot.result
    await store.saveUsage(jobId, result.usage)

    if (
      result.status === 'failed'
      && sdk.shouldRetry(handle, result.failure)
    ) {
      handle = handle.kind === 'run'
        ? await sdk.retry(handle, { failure: result.failure })
        : await sdk.retry(handle, { failure: result.failure })
      await persist(jobId, handle)
      await scheduleNext(jobId)
      return { kind: 'rescheduled', handle }
    }

    if (result.status !== 'succeeded') {
      return { kind: 'finished', handle, result }
    }

    // resultText is available only after the succeeded check.
    console.log(result.resultText)

    const landed = await sdk.land(handle)
    handle = landed.handle
    await persist(jobId, handle)

    // Landing is independent from execution success.
    switch (landed.landing.kind) {
      case 'merged':
      case 'prOpen':
      case 'published':
      case 'unsupported':
      case 'failed':
      case 'skipped':
        return {
          kind: 'finished',
          handle,
          result,
          landing: landed.landing,
        }
    }
  }

  async function followUp(
    jobId: string,
    input: FollowUpInput,
  ): Promise<Handle | undefined> {
    const handle = sdk.parseHandle(await store.loadHandle(jobId))
    try {
      const sessionHandle = await sdk.followUp(handle, input)
      await persist(jobId, sessionHandle)
      await scheduleNext(jobId)
      return sessionHandle
    } catch (error: unknown) {
      if (
        !isAgentRunnerSdkError(error, 'session-create-ambiguous')
        && !isAgentRunnerSdkError(error, 'session-already-active')
      ) throw error

      const effectiveInput: EffectiveFollowUpInput = error.effectiveInput
      const resolution = isAgentRunnerSdkError(
        error,
        'session-already-active',
      )
        ? await sdk.reconcileSession(
            handle,
            effectiveInput,
            error.window,
            { conflict: error },
          )
        : await sdk.reconcileSession(
            handle,
            effectiveInput,
            error.window,
          )

      switch (resolution.kind) {
        case 'matched':
          await persist(jobId, resolution.handle)
          await scheduleNext(jobId)
          return resolution.handle
        case 'none':
          await store.requireReview(jobId, 'none', [])
          return undefined
        case 'ambiguous':
          await store.requireReview(
            jobId,
            'ambiguous',
            resolution.candidates,
          )
          return undefined
      }
    }
  }

  return { dispatch, tick, followUp }
}
