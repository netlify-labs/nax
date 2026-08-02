const {
  DEFAULT_NETLIFY_API_URL,
  DEFAULT_USER_AGENT,
  createAuthenticatedNetlifyClient,
  isAgentRunnerSdkError,
  redactSensitiveText,
} = require('agent-runner-sdk')

const DEFAULT_BASE_URL = DEFAULT_NETLIFY_API_URL

/**
 * Provisional Agent Runner endpoints used by the hosted dashboard transport.
 *
 * Required API surface:
 * - POST /sites/:siteId/agent-runners creates a fresh runner.
 * - POST /agent-runners/:runnerId/sessions creates a follow-up session.
 * - GET /agent-runners/:runnerId reads runner status and latest session.
 * - GET /agent-runners/:runnerId/sessions lists sessions/artifacts.
 * - POST /agent-runners/:runnerId/cancel cancels active work.
 * - POST /agent-runners/:runnerId/archive archives completed work.
 *
 * These paths are intentionally centralized here so the hosted dashboard
 * transport can change endpoint names without route-layer churn.
 */

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
 * @param {string} path
 * @param {Record<string, string>} params
 */
function pathWithParams(path, params) {
  let out = path
  for (const [key, value] of Object.entries(params)) {
    out = out.replace(`:${key}`, encodeURIComponent(value))
  }
  return out
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
  const runnerId = stringValue(raw.id || raw.runner_id || raw.runnerId)
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
    onTelemetry: (event) => {
      try {
        onTelemetry?.(event)
      } catch {
        // SDK telemetry observers never alter request behavior.
      }
      if (!onRequestFailure) return
      try {
        onRequestFailure(event.kind === 'httpFailure'
          ? {
              kind: 'http_failure',
              method: event.method,
              apiPath: event.pathname,
              status: event.status,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              retrying: event.retrying,
            }
          : {
              kind: 'network_error',
              method: event.method,
              apiPath: event.pathname,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              retrying: false,
              errorName: event.errorName,
            })
      } catch {
        // Legacy observers have the same non-disruptive contract.
      }
    },
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

  /** @param {string} path @param {Record<string, string>} params */
  function endpoint(path, params = {}) {
    return pathWithParams(path, params)
  }

  return {
    /** @param {{ siteId?: string, promptText?: string, agent?: string, branch?: string, source?: Record<string, unknown> }} input */
    async createAgentRunner(input = {}) {
      const resolvedSiteId = input.siteId || defaultSiteId
      if (!resolvedSiteId) throw requestError('runner_validation_failed', 'Netlify site ID is required to create an Agent Runner.')
      const payload = await request('POST', endpoint('/sites/:siteId/agent-runners', { siteId: resolvedSiteId }), {
        body: {
          prompt: input.promptText || '',
          agent: input.agent || '',
          branch: input.branch || '',
          source: input.source || {},
        },
      })
      return normalizeAgentRunner(payload)
    },
    /** @param {{ runnerId?: string, promptText?: string, agent?: string }} input */
    async createAgentSession(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required to create a follow-up session.')
      const payload = await request('POST', endpoint('/agent-runners/:runnerId/sessions', { runnerId }), {
        body: {
          prompt: input.promptText || '',
          agent: input.agent || '',
        },
      })
      return normalizeAgentRunner(payload)
    },
    /** @param {{ runnerId?: string }} input */
    async getAgentRunner(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required.')
      return normalizeAgentRunner(await request('GET', endpoint('/agent-runners/:runnerId', { runnerId })))
    },
    /** @param {{ runnerId?: string }} input */
    async listAgentSessions(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required.')
      const payload = await request('GET', endpoint('/agent-runners/:runnerId/sessions', { runnerId }))
      const data = objectValue(payload)
      return Array.isArray(payload)
        ? payload.map(normalizeAgentRunner)
        : Array.isArray(data.sessions)
          ? data.sessions.map(normalizeAgentRunner)
          : []
    },
    /** @param {{ runnerId?: string }} input */
    async cancelAgentRunner(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required to cancel a run.')
      return normalizeAgentRunner(await request('POST', endpoint('/agent-runners/:runnerId/cancel', { runnerId })))
    },
    /** @param {{ runnerId?: string }} input */
    async archiveAgentRunner(input = {}) {
      const runnerId = input.runnerId || ''
      if (!runnerId) throw requestError('runner_validation_failed', 'Agent Runner ID is required to archive a run.')
      return normalizeAgentRunner(await request('POST', endpoint('/agent-runners/:runnerId/archive', { runnerId })))
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
