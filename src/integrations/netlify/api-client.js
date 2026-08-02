const {
  DEFAULT_NETLIFY_API_URL,
  DEFAULT_USER_AGENT,
  classifyFailure,
  createAgentRunnerSdk,
  createAuthenticatedNetlifyClient,
  isAgentRunnerSdkError,
  redactSensitiveText,
} = require('agent-runner-sdk')
const {
  parsePersistedHandle,
  resolveRunHandle,
  runnerArtifactPayload,
  sessionArtifactPayload,
} = require('./agent-runner-sdk')

const DEFAULT_BASE_URL = DEFAULT_NETLIFY_API_URL

/**
 * @typedef {{
 *   fetch?: typeof fetch,
 *   token?: string,
 *   env?: NodeJS.ProcessEnv,
 *   siteId?: string,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   retryAttempts?: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   home?: string,
 *   platform?: NodeJS.Platform,
 *   userAgent?: string,
 *   onTelemetry?: (event: import('agent-runner-sdk').AuthTelemetryEvent) => void,
 *   onRequestFailure?: (event: NetlifyRequestFailureEvent) => void,
 * }} NetlifyApiClientOptions
 *
 * @typedef {{
 *   kind: 'http_failure',
 *   method: string,
 *   apiPath: string,
 *   status: number,
 *   attempt: number,
 *   maxAttempts: number,
 *   retrying: boolean,
 * } | {
 *   kind: 'network_error',
 *   method: string,
 *   apiPath: string,
 *   attempt: number,
 *   maxAttempts: number,
 *   retrying: false,
 *   errorName: string,
 * }} NetlifyRequestFailureEvent
 *
 * @typedef {{
 *   ok: boolean,
 *   status: number,
 *   statusText: string,
 *   text: string,
 *   payload: unknown,
 *   method: string,
 *   apiPath: string,
 *   attempts: number,
 * }} NetlifyApiResponse
 *
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   state?: string,
 *   status?: string,
 *   latest_session?: Record<string, unknown>,
 *   latest_session_state?: string,
 *   session_id?: string,
 *   url?: string,
 *   links?: Record<string, unknown>,
 * }} NetlifyAgentRunnerPayload
 *
 * @typedef {{
 *   runnerId: string,
 *   sessionId: string,
 *   state: string,
 *   status: string,
 *   links: Record<string, unknown>,
 *   raw: NetlifyAgentRunnerPayload,
 *   sdkHandle?: import('agent-runner-sdk').Handle,
 * }} NormalizedAgentRunner
 */

/** @param {unknown} value */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
}

/** @param {unknown} value */
function stringValue(value) {
  return value === undefined || value === null ? '' : String(value)
}

/**
 * @param {string} token
 * @param {string} detail
 */
function redactToken(token, detail) {
  return redactSensitiveText(detail, [token])
}

/** @param {unknown} payload */
function normalizeAgentRunner(payload) {
  const raw = /** @type {NetlifyAgentRunnerPayload} */ (objectValue(payload))
  const latest = objectValue(raw.latest_session)
  const runnerId = stringValue(raw.agent_runner_id || raw.runner_id || raw.runnerId || raw.id)
  const sessionId = stringValue(raw.session_id || raw.sessionId || latest.id || (!raw.runner_id && !raw.runnerId ? raw.id : ''))
  const state = stringValue(raw.state || raw.status || raw.latest_session_state || latest.state || latest.status)
  const links = objectValue(raw.links)
  if (raw.url && !links.url) links.url = raw.url
  return {
    runnerId,
    sessionId,
    state,
    status: state,
    links,
    raw,
  }
}

/**
 * @param {number} status
 * @param {string} detail
 */
function errorCodeForStatus(status, detail = '') {
  if (status === 401) return 'runner_auth_failed'
  if (status === 403) return 'runner_permission_denied'
  if (status === 404) return 'runner_not_found'
  if (status === 422 || status === 400) return 'runner_validation_failed'
  if (status === 429) return 'runner_rate_limited'
  if (status >= 500) return 'runner_transport_error'
  if (/rate limit/i.test(detail)) return 'runner_rate_limited'
  return 'runner_transport_error'
}

/** @param {unknown} error */
function legacyRunnerError(error) {
  if (!isAgentRunnerSdkError(error)) return error
  const failure = classifyFailure(error)
  let code = 'runner_transport_error'
  if (failure.category === 'authentication') code = 'runner_auth_failed'
  else if (failure.category === 'permission') code = 'runner_permission_denied'
  else if (failure.category === 'validation') code = 'runner_validation_failed'
  else if (failure.category === 'rate-limit') code = 'runner_rate_limited'
  else if (failure.code === 'not-found') code = 'runner_not_found'
  const legacy = /** @type {Error & {
   *   code?: string,
   *   statusCode?: number,
   *   cause?: unknown,
   * }} */ (new Error(failure.message))
  legacy.code = code
  if (failure.status !== undefined) legacy.statusCode = failure.status
  legacy.cause = error
  return legacy
}

/** @param {NetlifyApiClientOptions} [options] */
function createNetlifyApiClient({
  fetch: fetchImpl = globalThis.fetch,
  token,
  env = process.env,
  siteId,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 30000,
  retryAttempts = 1,
  sleep = async () => {},
  home,
  platform,
  userAgent = DEFAULT_USER_AGENT,
  onTelemetry,
  onRequestFailure,
} = {}) {
  const defaultSiteId = siteId || env.NETLIFY_SITE_ID || ''
  const emitTelemetry = (event) => {
    try {
      onTelemetry?.(event)
    } catch {
      // SDK telemetry observers never alter request behavior.
    }
    if (!onRequestFailure || event.kind === 'apiDrift') return
    try {
      if (event.kind === 'httpFailure') {
        onRequestFailure({
            kind: 'http_failure',
            method: event.method,
            apiPath: event.pathname,
            status: event.status,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            retrying: event.retrying,
        })
      } else {
        onRequestFailure({
            kind: 'network_error',
            method: event.method,
            apiPath: event.pathname,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            retrying: false,
            errorName: event.errorName,
        })
      }
    } catch {
      // Legacy observers have the same non-disruptive contract.
    }
  }
  const authenticated = createAuthenticatedNetlifyClient({
    fetch: fetchImpl,
    token,
    env,
    ...(home === undefined ? {} : { home }),
    ...(platform === undefined ? {} : { platform }),
    baseUrl,
    timeoutMs,
    retryAttempts,
    sleep,
    userAgent,
    onTelemetry: emitTelemetry,
  })
  const runnerSdk = createAgentRunnerSdk({
    fetch: fetchImpl,
    token,
    env,
    ...(home === undefined ? {} : { home }),
    ...(platform === undefined ? {} : { platform }),
    baseUrl,
    timeoutMs,
    retryAttempts,
    sleep,
    userAgent,
    onTelemetry: emitTelemetry,
  })

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: Record<string, unknown>, signal?: AbortSignal, token?: string, operation?: string }} [options]
   * @returns {Promise<NetlifyApiResponse>}
   */
  async function requestResponse(method, path, options = {}) {
    try {
      const response = await authenticated.requestResponse(method, path, options)
      return {
        ...response,
        apiPath: response.pathname,
      }
    } catch (error) {
      if (isAgentRunnerSdkError(error, 'auth-missing')) {
        throw requestError('runner_auth_failed', 'Netlify API token is required.')
      }
      throw error
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: Record<string, unknown>, signal?: AbortSignal, token?: string, operation?: string }} [options]
   */
  async function request(method, path, options = {}) {
    const response = await requestResponse(method, path, options)
    if (response.ok) return response.payload
    const authToken = options.token || authenticated.auth.token
    const detail = redactSensitiveText(
      response.text || response.statusText,
      [authToken, options.body],
    )
    const error = /** @type {Error & {
     *   statusCode?: number,
     *   code?: string,
     *   payload?: unknown,
     *   requestMeta?: { method: string, apiPath: string, attempts: number },
     * }} */ (new Error(`Netlify API request failed (${response.status}): ${detail}`))
    error.statusCode = response.status
    error.code = errorCodeForStatus(response.status, detail)
    error.payload = response.payload
    error.requestMeta = {
      method: response.method,
      apiPath: response.apiPath,
      attempts: response.attempts,
    }
    throw error
  }

  /** @param {import('agent-runner-sdk').Runner} runner @param {import('agent-runner-sdk').Session | null} session @param {import('agent-runner-sdk').Handle | null} handle */
  function normalizedSdkRunner(runner, session = null, handle = null) {
    const raw = {
      ...runnerArtifactPayload(runner),
      ...(session ? { latest_session: sessionArtifactPayload(session) } : {}),
    }
    return {
      ...normalizeAgentRunner(raw),
      ...(handle ? { sdkHandle: handle } : {}),
    }
  }

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  async function runnerOperation(operation) {
    try {
      return await operation()
    } catch (error) {
      throw legacyRunnerError(error)
    }
  }

  return {
    /** @param {{ siteId?: string, promptText?: string, agent?: string, branch?: string, source?: Record<string, unknown> }} input */
    async createAgentRunner(input = {}) {
      const resolvedSiteId = input.siteId || defaultSiteId
      if (!resolvedSiteId) throw requestError('runner_validation_failed', 'Netlify site ID is required to create an Agent Runner.')
      return runnerOperation(async () => {
        const handle = await runnerSdk.start({
          siteId: resolvedSiteId,
          prompt: input.promptText || '',
          agent: input.agent || 'claude',
          ...(input.branch ? { branch: input.branch } : {}),
          land: 'none',
        })
        const [runner, session] = await Promise.all([
          runnerSdk.transport.getRunner(handle.runnerId),
          runnerSdk.transport.getSession(handle.runnerId, handle.currentSessionId),
        ])
        return normalizedSdkRunner(runner, session, handle)
      })
    },
    /** @param {{ runnerId?: string, promptText?: string, agent?: string, siteId?: string, sdkHandle?: import('agent-runner-sdk').Handle }} input */
    async createAgentSession(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required to create a follow-up session.')
      return runnerOperation(async () => {
        const base = await resolveRunHandle({
          sdk: runnerSdk,
          run: {
            runnerId,
            sdkHandle: input.sdkHandle,
            netlifySiteId: input.siteId || defaultSiteId,
            agent: input.agent,
            promptText: input.promptText,
          },
          siteId: input.siteId || defaultSiteId,
        })
        const handle = await runnerSdk.followUp(base, {
          prompt: input.promptText || '',
          agent: input.agent || base.agent,
        })
        const [runner, session] = await Promise.all([
          runnerSdk.transport.getRunner(handle.runnerId),
          runnerSdk.transport.getSession(handle.runnerId, handle.currentSessionId),
        ])
        return normalizedSdkRunner(runner, session, handle)
      })
    },
    /** @param {{ runnerId?: string, sdkHandle?: import('agent-runner-sdk').Handle }} input */
    async getAgentRunner(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required.')
      return runnerOperation(async () => {
        const handle = parsePersistedHandle(input.sdkHandle)
        if (handle?.runnerId === runnerId) {
          const [runner, session] = await Promise.all([
            runnerSdk.transport.getRunner(runnerId),
            runnerSdk.transport.getSession(runnerId, handle.currentSessionId),
          ])
          return normalizedSdkRunner(runner, session, handle)
        }
        const [runner, sessions] = await Promise.all([
          runnerSdk.transport.getRunner(runnerId),
          runnerSdk.transport.listSessions(runnerId),
        ])
        return normalizedSdkRunner(runner, sessions[sessions.length - 1] || null)
      })
    },
    /** @param {{ runnerId?: string }} input */
    async listAgentSessions(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required.')
      return runnerOperation(async () => {
        const sessions = await runnerSdk.transport.listSessions(runnerId)
        return sessions.map((session) => normalizeAgentRunner(sessionArtifactPayload(session)))
      })
    },
    /** @param {{ runnerId?: string }} input */
    async cancelAgentRunner(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required to cancel a run.')
      return runnerOperation(async () => {
        await runnerSdk.transport.cancelRunner(runnerId)
        return normalizeAgentRunner({ id: runnerId, state: 'cancelled' })
      })
    },
    /** @param {{ runnerId?: string }} input */
    async archiveAgentRunner(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required to archive a run.')
      return runnerOperation(async () => {
        await runnerSdk.transport.member(runnerId, 'archive', {})
        return normalizeAgentRunner({ id: runnerId, state: 'archived' })
      })
    },
    requestResponse,
    request,
  }
}

/**
 * @param {string} code
 * @param {string} message
 */
function requestError(code, message) {
  const error = /** @type {Error & { code?: string }} */ (new Error(message))
  error.code = code
  return error
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_USER_AGENT,
  createNetlifyApiClient,
  errorCodeForStatus,
  normalizeAgentRunner,
  redactToken,
}
