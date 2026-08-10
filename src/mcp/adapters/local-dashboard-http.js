const { PACKAGE_VERSION } = require('../../core/artifact-metadata')
const {
  DashboardRegistryError,
  canonicalProjectRoot,
  isLoopbackOrigin,
  processIsAlive,
  readDashboardInstance,
  removeDashboardInstance,
} = require('../../runtime/local/mcp-instance-registry')

const DEFAULT_REQUEST_TIMEOUT_MS = 5000
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * @typedef {import('../../runtime/local/mcp-instance-registry').DashboardInstanceRecord} DashboardInstanceRecord
 *
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   tempDir?: string,
 *   userId?: string,
 * }} RegistryPathOptions
 *
 * @typedef {{
 *   projectRoot: string,
 *   expectedVersion?: string,
 *   fetchImpl?: typeof fetch,
 *   isProcessAlive?: (pid: number) => boolean,
 *   registry?: RegistryPathOptions,
 *   requestTimeoutMs?: number,
 *   maxRequestBytes?: number,
 *   maxResponseBytes?: number,
 * }} LocalDashboardHttpOptions
 *
 * @typedef {{
 *   record: DashboardInstanceRecord,
 *   health: Record<string, unknown>,
 * }} LocalDashboardSession
 *
 * @typedef {{
 *   method?: 'GET' | 'POST',
 *   body?: Record<string, unknown>,
 *   timeoutMs?: number,
 * }} DashboardJsonRequestOptions
 */

class LocalDashboardAdapterError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ statusCode?: number, recoverable?: boolean, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, { statusCode = 500, recoverable = true, details = {} } = {}) {
    super(message)
    this.name = 'LocalDashboardAdapterError'
    this.code = code
    this.statusCode = statusCode
    this.recoverable = recoverable
    this.details = details
  }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {unknown} value @param {number} fallback @param {number} minimum */
function boundedInteger(value, fallback, minimum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback
}

/**
 * @param {unknown} error
 * @returns {LocalDashboardAdapterError}
 */
function normalizeRegistryError(error) {
  if (error instanceof LocalDashboardAdapterError) return error
  if (error instanceof DashboardRegistryError) {
    return new LocalDashboardAdapterError(error.code, error.message, {
      statusCode: error.code === 'project_scope_mismatch' ? 403 : 503,
      details: objectValue(error.details),
    })
  }
  return new LocalDashboardAdapterError(
    'dashboard_registry_unavailable',
    'The nax dashboard registry could not be read.',
    { statusCode: 503 },
  )
}

/**
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBoundedResponseText(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new LocalDashboardAdapterError(
      'dashboard_response_too_large',
      `The nax dashboard response exceeded the ${maxBytes}-byte limit.`,
      { statusCode: 502, details: { maxBytes } },
    )
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const chunk = Buffer.from(result.value)
      size += chunk.length
      if (size > maxBytes) {
        await reader.cancel()
        throw new LocalDashboardAdapterError(
          'dashboard_response_too_large',
          `The nax dashboard response exceeded the ${maxBytes}-byte limit.`,
          { statusCode: 502, details: { maxBytes } },
        )
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function decodeJsonObject(text) {
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return /** @type {Record<string, unknown>} */ (parsed)
  } catch (_error) {
    throw new LocalDashboardAdapterError(
      'dashboard_malformed_response',
      'The nax dashboard returned malformed JSON.',
      { statusCode: 502 },
    )
  }
}

/** @param {unknown} value @param {string} token */
function redactToken(value, token) {
  const text = String(value || '')
  return token ? text.replaceAll(token, '[redacted]') : text
}

/** @param {unknown} value @param {string} token @returns {Record<string, unknown>} */
function redactedJsonObject(value, token) {
  const source = objectValue(value)
  try {
    return objectValue(JSON.parse(redactToken(JSON.stringify(source), token)))
  } catch (_error) {
    return {}
  }
}

/**
 * @param {DashboardInstanceRecord} record
 * @param {string} apiPath
 * @returns {URL}
 */
function dashboardUrl(record, apiPath) {
  if (!apiPath.startsWith('/api/')) throw new TypeError('Dashboard requests must use a fixed /api/ path.')
  const origin = record.origin.endsWith('/') ? record.origin : `${record.origin}/`
  const url = new URL(apiPath.slice(1), origin)
  if (!isLoopbackOrigin(url.origin) || url.origin !== new URL(record.origin).origin) {
    throw new LocalDashboardAdapterError('dashboard_origin_forbidden', 'The nax dashboard request origin is not loopback.', { statusCode: 403 })
  }
  return url
}

/**
 * @param {DashboardInstanceRecord} record
 * @param {string} apiPath
 * @param {LocalDashboardHttpOptions} config
 * @param {DashboardJsonRequestOptions} [request]
 * @returns {Promise<Record<string, unknown>>}
 */
async function requestDashboardJson(record, apiPath, config, request = {}) {
  const fetchImpl = config.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new LocalDashboardAdapterError('dashboard_unreachable', 'No HTTP client is available to reach the nax dashboard.', { statusCode: 503 })
  }
  const method = request.method || 'GET'
  const maxRequestBytes = boundedInteger(config.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1)
  const maxResponseBytes = boundedInteger(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1)
  const timeoutMs = boundedInteger(request.timeoutMs, boundedInteger(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1), 1)
  const body = method === 'POST' ? JSON.stringify(request.body || {}) : undefined
  if (body && Buffer.byteLength(body) > maxRequestBytes) {
    throw new LocalDashboardAdapterError(
      'dashboard_request_too_large',
      `The nax dashboard request exceeded the ${maxRequestBytes}-byte limit.`,
      { statusCode: 413, details: { maxBytes: maxRequestBytes } },
    )
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(dashboardUrl(record, apiPath), {
      method,
      headers: {
        accept: 'application/json',
        'x-nax-token': record.token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
      signal: controller.signal,
    })
    const payload = decodeJsonObject(await readBoundedResponseText(response, maxResponseBytes))
    if (!response.ok) {
      const dashboardError = objectValue(payload.error)
      const statusCode = Number(dashboardError.statusCode || response.status)
      const code = typeof dashboardError.code === 'string' && dashboardError.code
        ? dashboardError.code
        : 'dashboard_http_error'
      const message = typeof dashboardError.message === 'string' && dashboardError.message
        ? redactToken(dashboardError.message, record.token)
        : `The nax dashboard request failed with HTTP ${response.status}.`
      const domainDetails = redactedJsonObject(dashboardError.details, record.token)
      throw new LocalDashboardAdapterError(code, message, {
        statusCode: Number.isSafeInteger(statusCode) ? statusCode : response.status,
        recoverable: typeof dashboardError.recoverable === 'boolean' ? dashboardError.recoverable : true,
        details: {
          ...domainDetails,
          httpStatus: response.status,
        },
      })
    }
    return payload
  } catch (error) {
    if (error instanceof LocalDashboardAdapterError) throw error
    if (controller.signal.aborted) {
      throw new LocalDashboardAdapterError(
        'dashboard_timeout',
        `The nax dashboard did not respond within ${timeoutMs}ms.`,
        { statusCode: 504, details: { timeoutMs } },
      )
    }
    throw new LocalDashboardAdapterError(
      'dashboard_unreachable',
      'The running nax dashboard could not be reached.',
      { statusCode: 503 },
    )
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Resolves the private registry afresh and authenticates the dashboard health
 * response. Callers invoke this once at the start of each control-plane operation.
 * @param {LocalDashboardHttpOptions} config
 * @returns {Promise<LocalDashboardSession>}
 */
async function discoverDashboardSession(config) {
  const projectRoot = canonicalProjectRoot(config.projectRoot)
  const registry = config.registry || {}
  let record
  try {
    record = readDashboardInstance(projectRoot, registry)
  } catch (error) {
    throw normalizeRegistryError(error)
  }
  if (!record) {
    throw new LocalDashboardAdapterError(
      'dashboard_not_running',
      'No running nax dashboard is advertised for this project. Start the nax control plane for this project: nax dashboard --no-open.',
      { statusCode: 503, details: { projectRoot } },
    )
  }

  const isAlive = config.isProcessAlive || processIsAlive
  if (!isAlive(record.pid)) {
    removeDashboardInstance(projectRoot, record.instanceId, registry)
    throw new LocalDashboardAdapterError(
      'dashboard_not_running',
      'The advertised nax dashboard is no longer running. Start the nax control plane for this project: nax dashboard --no-open.',
      { statusCode: 503, details: { projectRoot } },
    )
  }

  const expectedVersion = config.expectedVersion || PACKAGE_VERSION
  if (record.version !== expectedVersion) {
    throw new LocalDashboardAdapterError(
      'dashboard_version_mismatch',
      'The running nax dashboard version does not match the MCP adapter.',
      {
        statusCode: 409,
        details: { expectedVersion, actualVersion: record.version },
      },
    )
  }

  const health = await requestDashboardJson(record, '/api/health', config)
  if (health.ok === true && health.tokenRequiredForSensitiveReads === true && !health.projectRoot) {
    throw new LocalDashboardAdapterError(
      'dashboard_auth_failed',
      'The MCP adapter could not authenticate to the running nax dashboard.',
      { statusCode: 401 },
    )
  }
  let healthRoot = ''
  try {
    healthRoot = canonicalProjectRoot(String(health.projectRoot || ''))
  } catch (_error) {
    healthRoot = ''
  }
  if (health.ok !== true || healthRoot !== record.projectRoot || String(health.projectId || '') !== record.projectId) {
    throw new LocalDashboardAdapterError(
      'project_scope_mismatch',
      'The running nax dashboard belongs to a different project.',
      { statusCode: 403, details: { expectedProjectRoot: record.projectRoot } },
    )
  }
  if (String(health.version || '') !== record.version) {
    throw new LocalDashboardAdapterError(
      'dashboard_version_mismatch',
      'The running nax dashboard and its registry record have different versions.',
      {
        statusCode: 409,
        details: { expectedVersion: record.version, actualVersion: String(health.version || '') },
      },
    )
  }
  return { record, health }
}

module.exports = {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LocalDashboardAdapterError,
  decodeJsonObject,
  discoverDashboardSession,
  readBoundedResponseText,
  redactToken,
  redactedJsonObject,
  requestDashboardJson,
}
