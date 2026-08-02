import { BasicAgentRunnerSdkError } from '../errors.js'
import {
  resolveNetlifyToken,
} from './token.js'
import type {
  NetlifyCliConfigOptions,
  NetlifyTokenResult,
} from './token.js'

export const AGENT_RUNNER_SDK_VERSION = '0.1.0' as const
export const DEFAULT_USER_AGENT =
  `agent-runner-sdk/${AGENT_RUNNER_SDK_VERSION}` as const
export const DEFAULT_NETLIFY_API_URL = 'https://api.netlify.com/api/v1'

export type AuthTelemetryEvent =
  | {
      kind: 'httpFailure'
      operation?: string
      method: string
      pathname: string
      status: number
      attempt: number
      maxAttempts: number
      retrying: boolean
      durationMs: number
    }
  | {
      kind: 'networkError'
      operation?: string
      method: string
      pathname: string
      attempt: number
      maxAttempts: number
      retrying: false
      durationMs: number
      errorName: string
    }

export interface AuthenticatedRequestOptions {
  token?: string
  body?: unknown
  signal?: AbortSignal
  operation?: string
}

export interface AuthenticatedResponse {
  ok: boolean
  status: number
  statusText: string
  text: string
  payload: unknown
  method: string
  pathname: string
  attempts: number
}

export interface AuthenticatedNetlifyClientOptions
  extends NetlifyCliConfigOptions {
  fetch?: typeof globalThis.fetch
  token?: string
  baseUrl?: string
  timeoutMs?: number
  retryAttempts?: number
  sleep?: (ms: number) => Promise<unknown>
  userAgent?: string
  onTelemetry?: (event: AuthTelemetryEvent) => void
}

export interface AuthenticatedNetlifyClient {
  readonly auth: NetlifyTokenResult
  requestResponse(
    method: string,
    path: string,
    options?: AuthenticatedRequestOptions,
  ): Promise<AuthenticatedResponse>
  request(
    method: string,
    path: string,
    options?: AuthenticatedRequestOptions,
  ): Promise<unknown>
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '')
}

function joinedUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}/${trimLeadingSlash(path)}`
}

function safeJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { text }
  }
}

function retryableStatus(status: number): boolean {
  return status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500
}

function statusErrorCode(status: number) {
  if (status === 401) return 'auth-invalid' as const
  if (status === 403) return 'auth-permission' as const
  if (status === 400 || status === 422) return 'validation-error' as const
  if (status === 429) return 'capacity-exhausted' as const
  return 'http-error' as const
}

function safeNetworkError(error: unknown): Error {
  const safe = new Error(
    'Netlify API request failed before receiving a response.',
  )
  if (error instanceof Error && error.name) safe.name = error.name
  return safe
}

function emitTelemetry(
  callback: ((event: AuthTelemetryEvent) => void) | undefined,
  event: AuthTelemetryEvent,
): void {
  if (!callback) return
  try {
    callback(event)
  } catch {
    // Telemetry observers cannot change request control flow.
  }
}

export function createAuthenticatedNetlifyClient({
  fetch: fetchImpl = globalThis.fetch,
  token: constructorToken,
  env = process.env,
  home,
  platform,
  baseUrl = DEFAULT_NETLIFY_API_URL,
  timeoutMs = 30_000,
  retryAttempts = 1,
  sleep = async () => {},
  userAgent = DEFAULT_USER_AGENT,
  onTelemetry,
}: AuthenticatedNetlifyClientOptions = {}): AuthenticatedNetlifyClient {
  if (!fetchImpl) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'fetch is required to use the Agent Runner SDK.',
    )
  }
  const auth = resolveNetlifyToken({
    constructorToken,
    env,
    ...(home === undefined ? {} : { home }),
    ...(platform === undefined ? {} : { platform }),
  })
  const maxAttempts = Number.isFinite(retryAttempts)
    ? Math.max(1, Math.floor(retryAttempts))
    : 1

  async function requestResponse(
    method: string,
    path: string,
    options: AuthenticatedRequestOptions = {},
  ): Promise<AuthenticatedResponse> {
    const perCallAuth = resolveNetlifyToken({
      token: options.token,
      constructorToken: auth.token,
      env,
      ...(home === undefined ? {} : { home }),
      ...(platform === undefined ? {} : { platform }),
    })
    if (!perCallAuth.token) {
      throw new BasicAgentRunnerSdkError(
        'auth-missing',
        'A Netlify API token is required.',
      )
    }

    const resolvedMethod = method.toUpperCase()
    const url = joinedUrl(baseUrl, path)
    const pathname = new URL(url).pathname
    const headers: Record<string, string> = {
      authorization: `Bearer ${perCallAuth.token}`,
      accept: 'application/json',
      'user-agent': userAgent,
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    }

    let attempt = 0
    while (attempt < maxAttempts) {
      attempt += 1
      const startedAt = Date.now()
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: resolvedMethod,
          headers,
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
          signal: options.signal ?? AbortSignal.timeout(timeoutMs),
        })
      } catch (error: unknown) {
        emitTelemetry(onTelemetry, {
          kind: 'networkError',
          ...(options.operation === undefined
            ? {}
            : { operation: options.operation }),
          method: resolvedMethod,
          pathname,
          attempt,
          maxAttempts,
          retrying: false,
          durationMs: Math.max(0, Date.now() - startedAt),
          errorName: error instanceof Error ? error.name : 'Error',
        })
        throw safeNetworkError(error)
      }

      let text: string
      try {
        text = await response.text()
      } catch (error: unknown) {
        emitTelemetry(onTelemetry, {
          kind: 'networkError',
          ...(options.operation === undefined
            ? {}
            : { operation: options.operation }),
          method: resolvedMethod,
          pathname,
          attempt,
          maxAttempts,
          retrying: false,
          durationMs: Math.max(0, Date.now() - startedAt),
          errorName: error instanceof Error ? error.name : 'Error',
        })
        throw safeNetworkError(error)
      }
      const payload = safeJson(text)
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          statusText: response.statusText || '',
          text,
          payload,
          method: resolvedMethod,
          pathname,
          attempts: attempt,
        }
      }

      const retrying = attempt < maxAttempts
        && retryableStatus(response.status)
      emitTelemetry(onTelemetry, {
        kind: 'httpFailure',
        ...(options.operation === undefined
          ? {}
          : { operation: options.operation }),
        method: resolvedMethod,
        pathname,
        status: response.status,
        attempt,
        maxAttempts,
        retrying,
        durationMs: Math.max(0, Date.now() - startedAt),
      })
      if (retrying) {
        await sleep(Math.min(1_000 * attempt, 5_000))
        continue
      }
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText || '',
        text,
        payload,
        method: resolvedMethod,
        pathname,
        attempts: attempt,
      }
    }

    throw new BasicAgentRunnerSdkError(
      'http-error',
      'Netlify API request exhausted its retry policy.',
    )
  }

  async function request(
    method: string,
    path: string,
    options: AuthenticatedRequestOptions = {},
  ): Promise<unknown> {
    const response = await requestResponse(method, path, options)
    if (response.ok) return response.payload
    throw new BasicAgentRunnerSdkError(
      statusErrorCode(response.status),
      `Netlify API request failed with status ${response.status}.`,
    )
  }

  return { auth, requestResponse, request }
}
