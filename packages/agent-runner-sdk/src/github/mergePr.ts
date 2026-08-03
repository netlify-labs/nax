import {
  BasicAgentRunnerSdkError,
  InvalidApiShapeError,
  PrHeadChangedError,
} from '../errors.js'

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com'
const DEFAULT_GITHUB_API_VERSION = '2022-11-28'
const DEFAULT_GITHUB_USER_AGENT = 'nax-agent-runner-sdk'

export type GithubMergeMethod = 'merge' | 'squash' | 'rebase'

export interface GithubPullRequest {
  prUrl: string
  owner: string
  repository: string
  number: number
  state: string
  merged: boolean
  headSha: string
  mergeSha?: string
}

export interface GithubMergeResult {
  merged: true
  mergeSha: string
}

export interface GithubMergeClientOptions {
  fetch?: typeof globalThis.fetch
  apiUrl?: string
  mergeMethod?: GithubMergeMethod
  userAgent?: string
}

export interface GithubMergeClient {
  getPullRequest(
    prUrl: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<GithubPullRequest>
  mergePullRequest(
    prUrl: string,
    expectedHeadSha: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<GithubMergeResult>
}

interface PullRequestIdentity {
  owner: string
  repository: string
  number: number
}

function requiredString(
  value: unknown,
  endpoint: string,
  field: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidApiShapeError(endpoint, field)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined
}

function record(
  value: unknown,
  endpoint: string,
  field = 'response',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidApiShapeError(endpoint, field)
  }
  return value as Record<string, unknown>
}

function parsePullRequestUrl(prUrl: string): PullRequestIdentity {
  let parsed: URL
  try {
    parsed = new URL(prUrl)
  } catch (cause: unknown) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'The Agent Runner pull request URL is invalid.',
      { cause },
    )
  }
  if (
    parsed.protocol !== 'https:'
    || (
      parsed.hostname !== 'github.com'
      && parsed.hostname !== 'www.github.com'
    )
  ) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'The Agent Runner pull request URL is not a supported GitHub URL.',
    )
  }
  const parts = parsed.pathname.split('/').filter(Boolean)
  const number = Number(parts[3])
  if (
    parts.length !== 4
    || parts[2] !== 'pull'
    || !Number.isSafeInteger(number)
    || number <= 0
  ) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'The Agent Runner pull request URL has an invalid repository or number.',
    )
  }
  return {
    owner: parts[0] as string,
    repository: parts[1] as string,
    number,
  }
}

function githubPath(identity: PullRequestIdentity): string {
  return `/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(
    identity.repository,
  )}/pulls/${identity.number}`
}

function statusError(status: number): BasicAgentRunnerSdkError {
  if (status === 401) {
    return new BasicAgentRunnerSdkError(
      'auth-invalid',
      'GitHub rejected the merge credential.',
    )
  }
  if (status === 403) {
    return new BasicAgentRunnerSdkError(
      'auth-permission',
      'GitHub denied access to the pull request.',
    )
  }
  if (status === 404) {
    return new BasicAgentRunnerSdkError(
      'not-found',
      'GitHub could not find the pull request.',
    )
  }
  if (status === 429) {
    return new BasicAgentRunnerSdkError(
      'rate-limited',
      'GitHub rate-limited the pull request operation.',
    )
  }
  if (status === 405 || status === 422) {
    return new BasicAgentRunnerSdkError(
      'validation-error',
      'GitHub refused to merge the pull request in its current state.',
    )
  }
  return new BasicAgentRunnerSdkError(
    'http-error',
    `GitHub pull request operation failed with status ${status}.`,
  )
}

function networkError(error: unknown): BasicAgentRunnerSdkError {
  const timedOut = (
    error instanceof Error
    && (
      error.name === 'AbortError'
      || error.name === 'TimeoutError'
    )
  )
  return new BasicAgentRunnerSdkError(
    timedOut ? 'request-timeout' : 'network-error',
    timedOut
      ? 'The GitHub pull request operation timed out.'
      : 'The GitHub pull request operation failed.',
  )
}

export function createGithubMergeClient({
  fetch: fetchImplementation = globalThis.fetch,
  apiUrl = DEFAULT_GITHUB_API_URL,
  mergeMethod = 'squash',
  userAgent = DEFAULT_GITHUB_USER_AGENT,
}: GithubMergeClientOptions = {}): GithubMergeClient {
  const baseUrl = apiUrl.replace(/\/+$/, '')

  async function request(
    method: 'GET' | 'PUT',
    path: string,
    token: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ response: Response; payload: unknown }> {
    let response: Response
    try {
      response = await fetchImplementation(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': userAgent,
          'x-github-api-version': DEFAULT_GITHUB_API_VERSION,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error: unknown) {
      throw networkError(error)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      if (!response.ok) throw statusError(response.status)
      throw new InvalidApiShapeError(path, 'response', { cause: error })
    }
    return { response, payload }
  }

  async function getPullRequest(
    prUrl: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<GithubPullRequest> {
    const identity = parsePullRequestUrl(prUrl)
    const path = githubPath(identity)
    const { response, payload } = await request(
      'GET',
      path,
      token,
      undefined,
      signal,
    )
    if (!response.ok) throw statusError(response.status)
    const source = record(payload, path)
    const head = record(source.head, path, 'head')
    if (typeof source.merged !== 'boolean') {
      throw new InvalidApiShapeError(path, 'merged')
    }
    const mergeSha = optionalString(source.merge_commit_sha)
    return {
      prUrl,
      ...identity,
      state: requiredString(source.state, path, 'state'),
      merged: source.merged,
      headSha: requiredString(head.sha, path, 'head.sha'),
      ...(mergeSha === undefined
        ? {}
        : { mergeSha }),
    }
  }

  async function mergePullRequest(
    prUrl: string,
    expectedHeadSha: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<GithubMergeResult> {
    const identity = parsePullRequestUrl(prUrl)
    const path = `${githubPath(identity)}/merge`
    const { response, payload } = await request(
      'PUT',
      path,
      token,
      {
        merge_method: mergeMethod,
        sha: expectedHeadSha,
      },
      signal,
    )
    if (response.status === 409) {
      throw new PrHeadChangedError(expectedHeadSha)
    }
    if (!response.ok) throw statusError(response.status)
    const source = record(payload, path)
    if (source.merged !== true) {
      throw new BasicAgentRunnerSdkError(
        'validation-error',
        'GitHub did not merge the pull request.',
      )
    }
    return {
      merged: true,
      mergeSha: requiredString(source.sha, path, 'sha'),
    }
  }

  return { getPullRequest, mergePullRequest }
}
