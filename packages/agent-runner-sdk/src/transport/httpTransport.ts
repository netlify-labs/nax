import {
  DEFAULT_NETLIFY_API_URL,
  createAuthenticatedNetlifyClient,
} from '../auth/index.js'
import type {
  AuthTelemetryEvent,
  AuthenticatedNetlifyClientOptions,
  AuthenticatedResponse,
} from '../auth/index.js'
import type {
  EffectiveFollowUpInput,
  EffectiveStartInput,
  MemberAction,
  MemberInput,
  MemberResult,
  Runner,
  RunnerPage,
  Session,
} from '../domain.js'
import {
  BasicAgentRunnerSdkError,
  CreateAmbiguousError,
  HttpResponseError,
  InvalidApiShapeError,
  NetlifyNetworkError,
  SessionAlreadyActiveError,
  SessionCreateAmbiguousError,
} from '../errors.js'
import {
  normalizeRunner,
  normalizeSession,
} from './normalize.js'
import {
  boundedRetryDelayMs,
} from '../retry.js'
import type {
  AccountRunnerListQuery,
  AgentRunnerApiStyle,
  RunnerListQuery,
  Transport,
  TransportRequestOptions,
} from './types.js'

export const DEFAULT_BB_API_URL =
  'https://app.netlify.com/access-control/bb-api/api/v1'

export interface HttpTransportOptions
  extends Omit<
    AuthenticatedNetlifyClientOptions,
    'baseUrl' | 'onTelemetry' | 'retryAttempts' | 'sleep'
  > {
  apiStyle?: AgentRunnerApiStyle
  baseUrl?: string
  retryAttempts?: number
  sleep?: (ms: number) => Promise<unknown>
  random?: () => number
  now?: () => number
  baseRetryDelayMs?: number
  maxRetryDelayMs?: number
  onTelemetry?: (event: TransportTelemetryEvent) => void
}

export type TransportTelemetryEvent =
  | AuthTelemetryEvent
  | {
      kind: 'apiDrift'
      entity: 'runner' | 'session'
      field: string
    }

const SAFE_RETRY_STATUSES = new Set([408, 409, 425, 429])
const CREATE_AMBIGUOUS_STATUSES = new Set([408, 409, 425])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'Pagination values must be positive integers.',
    )
  }
  return value
}

function unixSeconds(value: number, field: string): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} must be a non-negative Unix timestamp in seconds.`,
    )
  }
  return String(value)
}

function requiredId(value: string, label: string): string {
  if (!value) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${label} is required.`,
    )
  }
  return encodeURIComponent(value)
}

function setOptional(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value !== undefined) params.set(key, String(value))
}

function requestOptions(
  options: TransportRequestOptions | undefined,
): {
  token?: string
  signal?: AbortSignal
  retry: false
} {
  return {
    ...(options?.token === undefined ? {} : { token: options.token }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    retry: false,
  }
}

function isRetryableStatus(status: number): boolean {
  return SAFE_RETRY_STATUSES.has(status) || status >= 500
}

function isCreateAmbiguousStatus(status: number): boolean {
  return CREATE_AMBIGUOUS_STATUSES.has(status) || status >= 500
}

function errorForResponse(response: AuthenticatedResponse): HttpResponseError {
  let code:
    | 'auth-invalid'
    | 'auth-permission'
    | 'not-found'
    | 'rate-limited'
    | 'http-error'
    | 'validation-error'
  if (response.status === 401) code = 'auth-invalid'
  else if (response.status === 403) code = 'auth-permission'
  else if (response.status === 404) code = 'not-found'
  else if (response.status === 400 || response.status === 422) {
    code = 'validation-error'
  } else if (response.status === 429) code = 'rate-limited'
  else code = 'http-error'
  return new HttpResponseError(code, response.status, response.pathname)
}

function networkError(error: NetlifyNetworkError): BasicAgentRunnerSdkError {
  return new BasicAgentRunnerSdkError(
    error.timedOut ? 'request-timeout' : 'network-error',
    error.timedOut
      ? 'Agent Runner API request timed out.'
      : 'Agent Runner API request failed.',
    { cause: error },
  )
}

function responseTotal(response: AuthenticatedResponse): number | undefined {
  if (response.headers.total === undefined) return undefined
  const total = Number.parseInt(response.headers.total, 10)
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined
}

function nextPageFromLink(link: string | undefined): number | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/)
    if (!match || match[2] !== 'next') continue
    try {
      const page = Number.parseInt(new URL(match[1] ?? '').searchParams.get(
        'page',
      ) ?? '', 10)
      if (Number.isSafeInteger(page) && page > 0) return page
    } catch {
      return undefined
    }
  }
  return undefined
}

function retryAfterMs(
  value: string | undefined,
  now: () => number,
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now()) : undefined
}

function optionalBody<T extends Record<string, unknown>>(
  value: T,
): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined
}

function startBody(input: EffectiveStartInput): Record<string, unknown> {
  if (!('prompt' in input) || typeof input.prompt !== 'string') {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'HTTP transport requires a delivered inline prompt.',
    )
  }
  return {
    prompt: input.prompt,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.deployId === undefined ? {} : { deploy_id: input.deployId }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.fileKeys === undefined ? {} : { file_keys: input.fileKeys }),
  }
}

function followUpBody(
  input: EffectiveFollowUpInput,
): Record<string, unknown> {
  if (!('prompt' in input) || typeof input.prompt !== 'string') {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'HTTP transport requires a delivered inline prompt.',
    )
  }
  return {
    prompt: input.prompt,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.fileKeys === undefined ? {} : { file_keys: input.fileKeys }),
  }
}

export function createHttpTransport(
  options: HttpTransportOptions = {},
): Transport {
  const {
    apiStyle = 'v1',
    baseUrl = apiStyle === 'bb-api'
      ? DEFAULT_BB_API_URL
      : DEFAULT_NETLIFY_API_URL,
    retryAttempts = 3,
    sleep = async () => {},
    random = Math.random,
    now = Date.now,
    baseRetryDelayMs = 250,
    maxRetryDelayMs = 5_000,
    onTelemetry,
    ...authOptions
  } = options
  const maxAttempts = Number.isFinite(retryAttempts)
    ? Math.max(1, Math.floor(retryAttempts))
    : 3
  const unknownFields = new Set<string>()
  const authenticated = createAuthenticatedNetlifyClient({
    ...authOptions,
    baseUrl,
    retryAttempts: 1,
    sleep,
    ...(onTelemetry === undefined ? {} : { onTelemetry }),
  })

  function reportUnknownField(
    entity: 'runner' | 'session',
    field: string,
  ): void {
    const key = `${entity}:${field}`
    if (unknownFields.has(key)) return
    unknownFields.add(key)
    if (!onTelemetry) return
    try {
      const event: TransportTelemetryEvent = {
        kind: 'apiDrift',
        entity,
        field,
      }
      onTelemetry(event)
    } catch {
      // Telemetry observers cannot change transport behavior.
    }
  }

  function normalizeRunnerResponse(
    payload: unknown,
    endpoint: string,
  ): Runner {
    return normalizeRunner(payload, {
      apiStyle,
      endpoint,
      reportUnknownField,
    })
  }

  function normalizeSessionResponse(
    payload: unknown,
    endpoint: string,
  ): Session {
    return normalizeSession(payload, {
      apiStyle,
      endpoint,
      reportUnknownField,
    })
  }

  async function waitBeforeRetry(
    attempt: number,
    retryAfter: string | undefined,
  ): Promise<void> {
    const serverDelay = retryAfterMs(retryAfter, now)
    const jittered = boundedRetryDelayMs(attempt, {
      baseDelayMs: baseRetryDelayMs,
      maxDelayMs: maxRetryDelayMs,
      random,
    })
    await sleep(Math.min(maxRetryDelayMs, serverDelay ?? jittered))
  }

  async function safeRequest(
    method: 'GET' | 'DELETE',
    path: string,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<AuthenticatedResponse> {
    let attempt = 0
    while (attempt < maxAttempts) {
      attempt += 1
      let response: AuthenticatedResponse
      try {
        response = await authenticated.requestResponse(method, path, {
          ...requestOptions(optionsForRequest),
          operation: `${method.toLowerCase()}-agent-runner`,
        })
      } catch (error: unknown) {
        if (!(error instanceof NetlifyNetworkError)) throw error
        if (optionsForRequest?.signal?.aborted || attempt >= maxAttempts) {
          throw networkError(error)
        }
        await waitBeforeRetry(attempt, undefined)
        continue
      }
      if (response.ok) return response
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) {
        throw errorForResponse(response)
      }
      await waitBeforeRetry(attempt, response.headers.retryAfter)
    }
    throw new BasicAgentRunnerSdkError(
      'http-error',
      'Agent Runner API request exhausted its retry policy.',
    )
  }

  async function unsafeRequest(
    method: 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<AuthenticatedResponse> {
    try {
      const response = await authenticated.requestResponse(method, path, {
        ...requestOptions(optionsForRequest),
        ...(body === undefined ? {} : { body }),
        operation: 'agent-runner-member',
      })
      if (!response.ok) {
        const payload = record(response.payload)
        const backendMessage = typeof payload?.error === 'string'
          ? payload.error
          : ''
        if (/coding installation/i.test(backendMessage)) {
          throw new BasicAgentRunnerSdkError(
            'missing-coding-installation',
            'The site repository is not covered by the GitHub Coding installation.',
          )
        }
        throw errorForResponse(response)
      }
      return response
    } catch (error: unknown) {
      if (error instanceof NetlifyNetworkError) throw networkError(error)
      throw error
    }
  }

  async function createRequest(
    kind: 'runner',
    path: string,
    input: EffectiveStartInput,
    body: Record<string, unknown>,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<AuthenticatedResponse>
  async function createRequest(
    kind: 'session',
    path: string,
    input: EffectiveFollowUpInput,
    body: Record<string, unknown>,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<AuthenticatedResponse>
  async function createRequest(
    kind: 'runner' | 'session',
    path: string,
    input: EffectiveStartInput | EffectiveFollowUpInput,
    body: Record<string, unknown>,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<AuthenticatedResponse> {
    let attempt = 0
    while (attempt < maxAttempts) {
      attempt += 1
      const sentAt = now()
      let response: AuthenticatedResponse
      try {
        response = await authenticated.requestResponse('POST', path, {
          ...requestOptions(optionsForRequest),
          body,
          operation: kind === 'runner'
            ? 'create-agent-runner'
            : 'create-agent-runner-session',
        })
      } catch (error: unknown) {
        if (!(error instanceof NetlifyNetworkError)) throw error
        if (
          error.preTransmission
          && !optionsForRequest?.signal?.aborted
          && attempt < maxAttempts
        ) {
          await waitBeforeRetry(attempt, undefined)
          continue
        }
        if (error.preTransmission) throw networkError(error)
        const window = { sentAt, failedAt: now() }
        if (kind === 'runner') {
          throw new CreateAmbiguousError(
            input as EffectiveStartInput,
            window,
            { cause: error },
          )
        }
        throw new SessionCreateAmbiguousError(
          input as EffectiveFollowUpInput,
          window,
          { cause: error },
        )
      }
      if (response.ok) return response
      const window = { sentAt, failedAt: now() }
      const payload = record(response.payload)
      if (
        kind === 'session'
        && response.status === 409
        && payload?.error_code === 'active_session_exists'
      ) {
        const activeSessionId = typeof payload.active_session_id === 'string'
          ? payload.active_session_id
          : undefined
        throw new SessionAlreadyActiveError(
          input as EffectiveFollowUpInput,
          window,
          activeSessionId,
        )
      }
      if (isCreateAmbiguousStatus(response.status)) {
        if (kind === 'runner') {
          throw new CreateAmbiguousError(
            input as EffectiveStartInput,
            window,
          )
        }
        throw new SessionCreateAmbiguousError(
          input as EffectiveFollowUpInput,
          window,
        )
      }
      throw errorForResponse(response)
    }
    throw new BasicAgentRunnerSdkError(
      'http-error',
      'Agent Runner create request exhausted its retry policy.',
    )
  }

  async function createRunner(
    input: EffectiveStartInput,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<Runner> {
    const siteId = requiredId(input.siteId, 'Netlify site ID')
    const path = `/agent_runners?site_id=${siteId}`
    const response = await createRequest(
      'runner',
      path,
      input,
      startBody(input),
      optionsForRequest,
    )
    return normalizeRunnerResponse(response.payload, response.pathname)
  }

  async function createSession(
    runnerId: string,
    input: EffectiveFollowUpInput,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<Session> {
    const path = `/agent_runners/${requiredId(
      runnerId,
      'Agent Runner ID',
    )}/sessions`
    const response = await createRequest(
      'session',
      path,
      input,
      followUpBody(input),
      optionsForRequest,
    )
    return normalizeSessionResponse(response.payload, response.pathname)
  }

  async function getRunner(
    runnerId: string,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<Runner> {
    const response = await safeRequest(
      'GET',
      `/agent_runners/${requiredId(runnerId, 'Agent Runner ID')}`,
      optionsForRequest,
    )
    return normalizeRunnerResponse(response.payload, response.pathname)
  }

  function runnerPage(
    response: AuthenticatedResponse,
    page: number,
    perPage: number,
  ): RunnerPage {
    if (!Array.isArray(response.payload)) {
      throw new InvalidApiShapeError(response.pathname, 'response')
    }
    const items = response.payload.map((item) => normalizeRunnerResponse(
      item,
      response.pathname,
    ))
    const total = responseTotal(response)
    const linkedNext = nextPageFromLink(response.headers.link)
    const inferredNext = total !== undefined && page * perPage < total
      ? page + 1
      : undefined
    return {
      items,
      ...(linkedNext === undefined && inferredNext === undefined
        ? {}
        : { nextPage: linkedNext ?? inferredNext }),
      ...(total === undefined ? {} : { total }),
    }
  }

  async function listRunners(
    query: RunnerListQuery,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<RunnerPage> {
    if (!query.siteId) {
      throw new BasicAgentRunnerSdkError(
        'validation-error',
        'Netlify site ID is required.',
      )
    }
    const page = positiveInteger(query.page, 1)
    const perPage = Math.min(100, positiveInteger(query.perPage, 100))
    const params = new URLSearchParams()
    params.set('site_id', query.siteId)
    setOptional(params, 'account_id', query.accountId)
    if (query.from !== undefined) {
      params.set('from', unixSeconds(query.from, 'from'))
    }
    if (query.to !== undefined) params.set('to', unixSeconds(query.to, 'to'))
    setOptional(params, 'state', query.state)
    setOptional(params, 'title', query.title)
    setOptional(params, 'branch', query.branch)
    setOptional(params, 'result_branch', query.resultBranch)
    setOptional(params, 'user_id', query.userId)
    params.set('page', String(page))
    params.set('per_page', String(perPage))
    const response = await safeRequest(
      'GET',
      `/agent_runners?${params.toString()}`,
      optionsForRequest,
    )
    return runnerPage(response, page, perPage)
  }

  async function listAccountRunners(
    query: AccountRunnerListQuery,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<RunnerPage> {
    const page = positiveInteger(query.page, 1)
    const perPage = Math.min(100, positiveInteger(query.perPage, 100))
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    })
    const response = await safeRequest(
      'GET',
      `/${requiredId(
        query.accountSlug,
        'Netlify account slug',
      )}/agent_runners?${params.toString()}`,
      optionsForRequest,
    )
    return runnerPage(response, page, perPage)
  }

  async function getSession(
    runnerId: string,
    sessionId: string,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<Session> {
    const response = await safeRequest(
      'GET',
      `/agent_runners/${requiredId(
        runnerId,
        'Agent Runner ID',
      )}/sessions/${requiredId(sessionId, 'Agent Runner session ID')}`,
      optionsForRequest,
    )
    return normalizeSessionResponse(response.payload, response.pathname)
  }

  async function listSessions(
    runnerId: string,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<Session[]> {
    const encodedRunnerId = requiredId(runnerId, 'Agent Runner ID')
    const sessions: Array<Session & { listIndex: number }> = []
    const seenPages = new Set<number>()
    let page: number | undefined = 1
    while (page !== undefined) {
      if (seenPages.has(page)) {
        throw new InvalidApiShapeError(
          `/agent_runners/${encodedRunnerId}/sessions`,
          'pagination.nextPage',
        )
      }
      seenPages.add(page)
      const params = new URLSearchParams({
        page: String(page),
        per_page: '100',
        order_by: 'asc',
      })
      const response = await safeRequest(
        'GET',
        `/agent_runners/${encodedRunnerId}/sessions?${params.toString()}`,
        optionsForRequest,
      )
      if (!Array.isArray(response.payload)) {
        throw new InvalidApiShapeError(response.pathname, 'response')
      }
      for (const item of response.payload) {
        sessions.push({
          ...normalizeSessionResponse(item, response.pathname),
          listIndex: sessions.length,
        })
      }
      const total = responseTotal(response)
      const linkedNext = nextPageFromLink(response.headers.link)
      page = linkedNext ?? (
        total !== undefined && sessions.length < total ? page + 1 : undefined
      )
    }
    sessions.sort((left, right) => {
      if (left.createdAt === undefined || right.createdAt === undefined) {
        return left.listIndex - right.listIndex
      }
      return left.createdAt - right.createdAt
        || left.listIndex - right.listIndex
    })
    return sessions.map(({ listIndex: _listIndex, ...session }) => session)
  }

  async function cancelRunner(
    runnerId: string,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<void> {
    await safeRequest(
      'DELETE',
      `/agent_runners/${requiredId(runnerId, 'Agent Runner ID')}`,
      optionsForRequest,
    )
  }

  async function cancelSession(
    runnerId: string,
    sessionId: string,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<void> {
    await safeRequest(
      'DELETE',
      `/agent_runners/${requiredId(
        runnerId,
        'Agent Runner ID',
      )}/sessions/${requiredId(sessionId, 'Agent Runner session ID')}`,
      optionsForRequest,
    )
  }

  async function member<A extends MemberAction>(
    runnerId: string,
    action: A,
    input: MemberInput<A>,
    optionsForRequest?: TransportRequestOptions,
  ): Promise<MemberResult<A>> {
    const base = `/agent_runners/${requiredId(
      runnerId,
      'Agent Runner ID',
    )}`
    if (action === 'diff') {
      const diffInput = input as MemberInput<'diff'>
      const params = new URLSearchParams()
      setOptional(params, 'page', diffInput.page)
      setOptional(params, 'per_page', diffInput.perPage)
      setOptional(params, 'strip_binary', diffInput.stripBinary)
      const query = params.size === 0 ? '' : `?${params.toString()}`
      const response = await safeRequest(
        'GET',
        `${base}/diff${query}`,
        optionsForRequest,
      )
      return {
        diff: response.text
          ? { kind: 'inline', text: response.text }
          : null,
      } as MemberResult<A>
    }

    let body: Record<string, unknown> | undefined
    if (action === 'commit') {
      const commitInput = input as MemberInput<'commit'>
      requiredId(commitInput.targetBranch, 'Target branch')
      body = { target_branch: commitInput.targetBranch }
    } else if (action === 'revert') {
      const revertInput = input as MemberInput<'revert'>
      requiredId(revertInput.sessionId, 'Agent Runner session ID')
      body = { session_id: revertInput.sessionId }
    } else {
      body = optionalBody(input as Record<string, unknown>)
    }
    const response = await unsafeRequest(
      'POST',
      `${base}/${action}`,
      body,
      optionsForRequest,
    )
    if (action === 'archive') return undefined as MemberResult<A>
    if (action === 'merge_target' || action === 'rebase') {
      return normalizeSessionResponse(
        response.payload,
        response.pathname,
      ) as MemberResult<A>
    }
    return normalizeRunnerResponse(
      response.payload,
      response.pathname,
    ) as MemberResult<A>
  }

  return {
    createRunner,
    createSession,
    getRunner,
    listRunners,
    listAccountRunners,
    getSession,
    listSessions,
    cancelRunner,
    cancelSession,
    member,
  }
}
