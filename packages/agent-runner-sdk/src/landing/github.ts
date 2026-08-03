import type { FailureClassification } from '../domain.js'
import {
  BasicAgentRunnerSdkError,
  PrHeadChangedError,
} from '../errors.js'
import {
  createGithubMergeClient,
} from '../github/mergePr.js'
import type {
  GithubMergeClientOptions,
} from '../github/mergePr.js'
import type { Handle } from '../handles.js'
import type { LandingOutcome } from '../result.js'
import type {
  BackendLandingContext,
  BackendLandingResult,
} from './backend.js'

interface GithubLandingContext extends BackendLandingContext {
  classifyFailure: (error: unknown) => FailureClassification
}

interface BackendLandingHandler {
  <H extends Handle>(
    handle: H,
    context: GithubLandingContext,
  ): Promise<BackendLandingResult<H>>
}

interface GithubLandingOptions extends GithubMergeClientOptions {
  backend: BackendLandingHandler
  githubToken?: string
}

function failed(
  failure: FailureClassification,
): LandingOutcome {
  return {
    kind: 'failed',
    step: 'merge',
    failure,
  }
}

function withExpectedHead<H extends Handle>(
  handle: H,
  expectedPrHeadSha: string,
): H {
  return {
    ...handle,
    landing: {
      ...handle.landing,
      expectedPrHeadSha,
    },
  }
}

function withMergedSha<H extends Handle>(
  handle: H,
  mergedSha: string,
): H {
  return {
    ...handle,
    landing: {
      ...handle.landing,
      mergedSha,
    },
  }
}

function deadlineFailure(
  handle: Handle,
  context: GithubLandingContext,
): LandingOutcome | undefined {
  if (handle.policy.deadlineAt > context.now()) return undefined
  return failed(context.classifyFailure(
    new BasicAgentRunnerSdkError(
      'request-timeout',
      'The Agent Runner landing deadline elapsed before GitHub merge.',
    ),
  ))
}

export function createGithubLandingHandler({
  backend,
  githubToken,
  ...githubOptions
}: GithubLandingOptions) {
  const github = createGithubMergeClient(githubOptions)

  return async function landWithGithub<H extends Handle>(
    originalHandle: H,
    context: GithubLandingContext,
  ): Promise<BackendLandingResult<H>> {
    const prepared = await backend(originalHandle, context)
    if (prepared.landing.kind !== 'prOpen') return prepared
    const mode = prepared.handle.policy.landing
    if (mode === 'pr') return prepared
    if (mode !== 'merge' && mode !== 'auto') return prepared
    const token = githubToken?.trim()
    if (!token) {
      if (mode === 'auto') return prepared
      return {
        handle: prepared.handle,
        landing: failed(context.classifyFailure(
          new BasicAgentRunnerSdkError(
            'github-token-required',
            'A GitHub token is required to merge the pull request.',
          ),
        )),
      }
    }

    let handle = prepared.handle
    const prUrl = prepared.landing.prUrl
    const beforeRead = deadlineFailure(handle, context)
    if (beforeRead !== undefined) {
      return { handle, landing: beforeRead }
    }
    let pullRequest
    try {
      pullRequest = await github.getPullRequest(
        prUrl,
        token,
        context.requestOptions?.signal,
      )
    } catch (error: unknown) {
      return {
        handle,
        landing: failed(context.classifyFailure(error)),
      }
    }

    if (pullRequest.merged) {
      const mergedSha = pullRequest.mergeSha ?? handle.landing?.mergedSha
      if (mergedSha === undefined) {
        return {
          handle,
          landing: failed(context.classifyFailure(
            new BasicAgentRunnerSdkError(
              'validation-error',
              'GitHub reported a merged pull request without a merge SHA.',
            ),
          )),
        }
      }
      handle = withMergedSha(handle, mergedSha)
      await context.checkpoint(handle)
      return {
        handle,
        landing: {
          kind: 'merged',
          prUrl,
          mergeSha: mergedSha,
        },
      }
    }
    if (pullRequest.state !== 'open') {
      return {
        handle,
        landing: failed(context.classifyFailure(
          new BasicAgentRunnerSdkError(
            'validation-error',
            'The GitHub pull request is closed and cannot be merged.',
          ),
        )),
      }
    }

    const persistedHead = handle.landing?.expectedPrHeadSha
    if (
      persistedHead !== undefined
      && persistedHead !== pullRequest.headSha
    ) {
      return {
        handle,
        landing: failed(context.classifyFailure(
          new PrHeadChangedError(persistedHead, pullRequest.headSha),
        )),
      }
    }
    if (persistedHead === undefined) {
      handle = withExpectedHead(handle, pullRequest.headSha)
      try {
        await context.checkpoint(handle)
      } catch (error: unknown) {
        return {
          handle,
          landing: failed(context.classifyFailure(error)),
        }
      }
    }
    const expectedHead = handle.landing?.expectedPrHeadSha
    if (expectedHead === undefined) {
      return {
        handle,
        landing: failed(context.classifyFailure(
          new BasicAgentRunnerSdkError(
            'invalid-handle',
            'The landing checkpoint did not retain the expected pull request head.',
          ),
        )),
      }
    }
    const beforeMerge = deadlineFailure(handle, context)
    if (beforeMerge !== undefined) {
      return { handle, landing: beforeMerge }
    }

    let mergeSha: string
    try {
      const merged = await github.mergePullRequest(
        prUrl,
        expectedHead,
        token,
        context.requestOptions?.signal,
      )
      mergeSha = merged.mergeSha
    } catch (error: unknown) {
      if (error instanceof PrHeadChangedError) {
        return {
          handle,
          landing: failed(context.classifyFailure(error)),
        }
      }
      try {
        const reconciled = await github.getPullRequest(
          prUrl,
          token,
          context.requestOptions?.signal,
        )
        if (!reconciled.merged || reconciled.mergeSha === undefined) {
          return {
            handle,
            landing: failed(context.classifyFailure(error)),
          }
        }
        mergeSha = reconciled.mergeSha
      } catch {
        return {
          handle,
          landing: failed(context.classifyFailure(error)),
        }
      }
    }

    handle = withMergedSha(handle, mergeSha)
    try {
      await context.checkpoint(handle)
    } catch (error: unknown) {
      return {
        handle,
        landing: failed(context.classifyFailure(error)),
      }
    }
    return {
      handle,
      landing: {
        kind: 'merged',
        prUrl,
        mergeSha,
      },
    }
  }
}
