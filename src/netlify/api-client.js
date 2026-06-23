const DEFAULT_BASE_URL = 'https://api.netlify.com/api/v1'

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
 * }} NetlifyApiClientOptions
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

/** @param {string} value */
function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

/** @param {string} value */
function trimLeadingSlash(value) {
  return String(value || '').replace(/^\/+/, '')
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
  return token ? String(detail || '').split(token).join('[redacted]') : String(detail || '')
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

/** @param {number} status */
function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
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
} = {}) {
  const authToken = token || env.NETLIFY_AUTH_TOKEN || ''
  const defaultSiteId = siteId || env.NETLIFY_SITE_ID || ''
  if (!fetchImpl) throw new Error('fetch is required to use the Netlify API client.')

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: Record<string, unknown>, signal?: AbortSignal }} [options]
   */
  async function request(method, path, options = {}) {
    if (!authToken) {
      const error = /** @type {Error & { code?: string }} */ (new Error('Netlify API token is required.'))
      error.code = 'runner_auth_failed'
      throw error
    }
    const url = `${trimTrailingSlash(baseUrl)}/${trimLeadingSlash(path)}`
    const headers = {
      authorization: `Bearer ${authToken}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    }
    let attempt = 0
    while (true) {
      attempt += 1
      const response = await fetchImpl(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal || AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      const payload = text ? safeJson(text) : null
      if (response.ok) return payload
      const detail = redactToken(authToken, text || response.statusText)
      if (attempt < retryAttempts && retryableStatus(response.status)) {
        await sleep(Math.min(1000 * attempt, 5000))
        continue
      }
      const error = /** @type {Error & { statusCode?: number, code?: string, payload?: unknown }} */ (new Error(`Netlify API request failed (${response.status}): ${detail}`))
      error.statusCode = response.status
      error.code = errorCodeForStatus(response.status, detail)
      error.payload = payload
      throw error
    }
  }

  /** @param {string} path @param {Record<string, string>} params */
  function endpoint(path, params = {}) {
    return pathWithParams(path, params)
  }

  return {
    /** @param {{ siteId?: string, promptText?: string, agent?: string, branch?: string, source?: object }} input */
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
    request,
  }
}

/** @param {string} text */
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch (_err) {
    return { text }
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
  createNetlifyApiClient,
  errorCodeForStatus,
  normalizeAgentRunner,
  redactToken,
}
