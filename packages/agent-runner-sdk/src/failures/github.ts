import type {
  FailureClassification,
} from '../domain.js'
import {
  isAgentRunnerSdkError,
} from '../errors.js'
import type {
  FailureContext,
  FailureProfile,
} from './core.js'

function profile(
  value: FailureProfile,
): Readonly<FailureProfile> {
  return Object.freeze({
    ...value,
    remediation: Object.freeze([...value.remediation]),
  })
}

export const GITHUB_FAILURE_PROFILES = Object.freeze({
  tokenRequired: profile({
    category: 'github',
    code: 'github-token-required',
    title: 'GitHub token required for merge',
    message: 'The requested landing mode requires an explicit GitHub token.',
    remediation: [
      'Pass a GitHub token with pull-request read and merge permissions.',
      'Use pull-request-only landing when automatic merge is not intended.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'github',
  }),
  headChanged: profile({
    category: 'github',
    code: 'pr-head-changed',
    title: 'Pull request head changed before merge',
    message: 'The SDK refused to merge because the pull request head no longer matches its persisted compare-and-swap checkpoint.',
    remediation: [
      'Review the new pull request head and start a new landing decision.',
      'Do not automatically merge the newer revision.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'github',
  }),
  permission: profile({
    category: 'github',
    code: 'github-permission-denied',
    title: 'GitHub permission denied',
    message: 'GitHub denied the landing operation for the configured token.',
    remediation: [
      'Grant the required contents and pull-request permissions.',
      'Do not run mutation steps with a token from a restricted fork context.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'github',
  }),
  api: profile({
    category: 'github',
    code: 'github-api-failed',
    title: 'GitHub API operation failed',
    message: 'A GitHub landing operation failed without a safe automatic recovery.',
    remediation: [
      'Inspect the GitHub response and resume landing from the persisted checkpoint.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'github',
  }),
})

function classification(
  value: Readonly<FailureProfile>,
  context: FailureContext,
): FailureClassification {
  return {
    category: value.category,
    code: value.code,
    title: value.title,
    message: value.message,
    remediation: [...value.remediation],
    severity: value.severity,
    retryable: value.retryable,
    userActionRequired: value.userActionRequired,
    stage: context.stage ?? value.stage,
  }
}

function failureText(error: unknown): string {
  if (typeof error === 'string') return error.toLowerCase()
  if (error instanceof Error) return error.message.toLowerCase()
  return ''
}

export function classifyGithubFailure(
  error: unknown,
  context: FailureContext = {},
): FailureClassification | undefined {
  if (isAgentRunnerSdkError(error, 'github-token-required')) {
    return classification(GITHUB_FAILURE_PROFILES.tokenRequired, context)
  }
  if (isAgentRunnerSdkError(error, 'pr-head-changed')) {
    return classification(GITHUB_FAILURE_PROFILES.headChanged, context)
  }
  const text = failureText(error)
  if (
    /\b(resource not accessible by integration|github permission denied)\b/i.test(text)
  ) {
    return classification(GITHUB_FAILURE_PROFILES.permission, context)
  }
  if (/\b(github api|gh api|octokit)\b/i.test(text)) {
    return classification(GITHUB_FAILURE_PROFILES.api, context)
  }
  return undefined
}
