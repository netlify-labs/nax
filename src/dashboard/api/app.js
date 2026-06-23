const { Hono } = require('hono')

const { errorPayload, requestError } = require('./errors')
const { securityHeaders } = require('./security')
const { sessionBootstrapHeaders, timingSafeTokenEqual } = require('./auth')
const { localDashboardCapabilities } = require('./capabilities')

/**
 * @typedef {{
 *   mode?: 'local-node' | 'netlify-function',
 *   deploymentMode?: 'local' | 'desktop' | 'web',
 *   projectRoot?: string,
 *   capabilities?: Record<string, boolean | string>,
 *   healthCapabilities?: Record<string, boolean | string>,
 * }} DashboardApiRuntime
 *
 * @typedef {{
 *   runtime?: DashboardApiRuntime,
 *   token?: string,
 *   workflowStore?: import('../../storage/interfaces').WorkflowCatalog,
 *   runStore?: import('../../storage/interfaces').RunStore,
 *   eventStore?: import('../../storage/interfaces').EventStore,
 *   liveRuns?: import('../../storage/interfaces').LiveRuns,
 *   mutations?: import('../../storage/interfaces').DashboardMutations,
 * }} CreateDashboardApiOptions
 */

/** @param {Headers} headers */
function cookieHeader(headers) {
  return headers.get('cookie') || ''
}

/**
 * @param {Headers} headers
 * @param {string} name
 */
function cookieValue(headers, name) {
  for (const part of cookieHeader(headers).split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey !== name) continue
    try {
      return decodeURIComponent(rawValue.join('='))
    } catch (_err) {
      return rawValue.join('=')
    }
  }
  return ''
}

/** @param {import('hono').Context} c */
function tokenFromContext(c) {
  return c.req.header('x-nax-token') || cookieValue(c.req.raw.headers, 'nax_dashboard_token')
}

/** @param {import('hono').Context} c */
function explicitTokenFromContext(c) {
  return c.req.header('x-nax-token') || ''
}

/**
 * @param {import('hono').Context} c
 * @param {string} token
 * @param {{ secure?: boolean }} [options]
 */
function sessionBootstrapHeadersFromContext(c, token, options = {}) {
  return timingSafeTokenEqual(explicitTokenFromContext(c), token) ? sessionBootstrapHeaders(token, options) : {}
}

/**
 * @param {import('hono').Context} c
 * @param {string} token
 */
function assertHonoToken(c, token) {
  if (!timingSafeTokenEqual(tokenFromContext(c), token)) {
    throw requestError(401, 'unauthorized', 'A valid dashboard session token is required.')
  }
}

/**
 * @param {import('hono').Context} c
 * @param {unknown} payload
 * @param {import('hono/utils/http-status').ContentfulStatusCode} [status]
 * @param {Record<string, string>} [headers]
 */
function json(c, payload, status = 200, headers = {}) {
  return c.json(payload, status, headers)
}

/**
 * @param {number} status
 * @returns {import('hono/utils/http-status').ContentfulStatusCode}
 */
function contentfulStatusCode(status) {
  const code = Math.trunc(status)
  if (code < 100 || code > 599 || code === 204 || code === 205 || code === 304) return 500
  return /** @type {import('hono/utils/http-status').ContentfulStatusCode} */ (code)
}

/**
 * @param {import('hono').Context} c
 * @returns {Promise<Record<string, unknown>>}
 */
async function honoJsonBody(c) {
  const text = await c.req.text()
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw requestError(400, 'invalid_json', 'Request body must be a JSON object.')
    }
    return /** @type {Record<string, unknown>} */ (parsed)
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw requestError(400, 'invalid_json', 'Request body must be valid JSON.')
  }
}

/**
 * @param {unknown} result
 * @returns {{ statusCode: import('hono/utils/http-status').ContentfulStatusCode, body: import('../../storage/interfaces').JsonObject } | null}
 */
function mutationResult(result) {
  if (!result) return null
  if (isJsonObject(result) && isJsonObject(result.body)) {
    const statusCode = 'statusCode' in result && typeof result.statusCode === 'number' ? result.statusCode : 200
    return {
      statusCode: contentfulStatusCode(statusCode),
      body: result.body,
    }
  }
  if (isJsonObject(result)) {
    return { statusCode: 200, body: result }
  }
  throw requestError(500, 'invalid_service_response', 'Dashboard service returned an invalid response.')
}

/**
 * @param {unknown} value
 * @returns {value is import('../../storage/interfaces').JsonObject}
 */
function isJsonObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {Record<string, boolean | string>} capabilities
 * @param {string} key
 */
function requireCapability(capabilities, key) {
  if (capabilities[key] !== true) {
    throw requestError(501, 'unsupported_capability', `Dashboard capability "${key}" is not available in this runtime.`)
  }
}

/** @param {unknown} error */
function statusCodeForError(error) {
  const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : 500
  return contentfulStatusCode(status)
}

/** @param {unknown} error */
function codeForError(error) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'internal_error'
}

/** @param {unknown} error */
function messageForError(error) {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message
    : String(error)
}

/** @param {CreateDashboardApiOptions} [options] */
function createDashboardApi({
  runtime = {},
  token = '',
  workflowStore = {},
  runStore = {},
  eventStore = {},
  liveRuns = {},
  mutations = {},
} = {}) {
  const app = new Hono()
  const capabilities = {
    ...localDashboardCapabilities(),
    ...(runtime.capabilities || {}),
  }
  const healthCapabilities = runtime.healthCapabilities || capabilities
  const deploymentMode = String(runtime.deploymentMode || capabilities.deploymentMode || 'local')
  const sessionCookieOptions = {
    secure: deploymentMode === 'web' || runtime.mode === 'netlify-function',
  }
  /** @param {import('hono').Context} c */
  const sessionHeaders = (c) => sessionBootstrapHeadersFromContext(c, token, sessionCookieOptions)

  app.use('*', async (c, next) => {
    for (const [key, value] of Object.entries(securityHeaders())) c.header(key, value)
    await next()
  })

  app.onError((error, c) => {
    const statusCode = statusCodeForError(error)
    return json(c, errorPayload(statusCode, codeForError(error), messageForError(error)), statusCode)
  })

  app.notFound((c) => json(c, errorPayload(404, 'not_found', 'Not found'), 404))

  app.get('/api/health', (c) => {
    const provided = tokenFromContext(c)
    const headers = sessionHeaders(c)
    const health = {
      ok: true,
      tokenRequiredForMutations: true,
      tokenRequiredForSensitiveReads: true,
      capabilities: {
        ...healthCapabilities,
        deploymentMode,
      },
    }
    if (timingSafeTokenEqual(provided, token) && runtime.projectRoot) {
      health.projectRoot = runtime.projectRoot
    }
    return json(c, health, 200, headers)
  })

  app.get('/api/workflows', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canListWorkflows')
    if (typeof workflowStore.listWorkflows !== 'function') throw requestError(501, 'hosted_storage_unavailable', 'Workflow storage is not available in this runtime.')
    return json(c, await workflowStore.listWorkflows(), 200, sessionHeaders(c))
  })

  app.get('/api/workflows/:id', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canListWorkflows')
    if (typeof workflowStore.getWorkflow !== 'function') throw requestError(501, 'hosted_storage_unavailable', 'Workflow storage is not available in this runtime.')
    const workflow = await workflowStore.getWorkflow(c.req.param('id'))
    if (!workflow) throw requestError(404, 'not_found', `Unknown flow "${c.req.param('id')}".`)
    return json(c, workflow, 200, sessionHeaders(c))
  })

  app.get('/api/workflows/:id/graph', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canListWorkflows')
    if (typeof workflowStore.getWorkflowGraph !== 'function') throw requestError(501, 'hosted_storage_unavailable', 'Workflow storage is not available in this runtime.')
    const graph = await workflowStore.getWorkflowGraph(c.req.param('id'))
    if (!graph) throw requestError(404, 'not_found', `Unknown flow "${c.req.param('id')}".`)
    return json(c, graph, 200, sessionHeaders(c))
  })

  app.get('/api/runs', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canReadRuns')
    if (typeof runStore.listRunsPage !== 'function') throw requestError(501, 'hosted_storage_unavailable', 'Run storage is not available in this runtime.')
    const page = await runStore.listRunsPage({
      limit: c.req.query('limit') || '',
      cursor: c.req.query('cursor') || '',
    })
    return json(c, {
      active: typeof liveRuns.listActiveRuns === 'function' ? liveRuns.listActiveRuns() : [],
      durable: Array.isArray(page.durable) ? page.durable : [],
      pagination: page.pagination || null,
    }, 200, sessionHeaders(c))
  })

  app.get('/api/runs/:id', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canReadRuns')
    const runId = c.req.param('id')
    const active = typeof liveRuns.getActiveRun === 'function' ? liveRuns.getActiveRun(runId) : null
    if (active) return json(c, { run: active }, 200, sessionHeaders(c))
    if (typeof runStore.getRun !== 'function') throw requestError(501, 'hosted_storage_unavailable', 'Run storage is not available in this runtime.')
    const run = await runStore.getRun(runId)
    if (!run) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, { run }, 200, sessionHeaders(c))
  })

  app.get('/api/runs/:id/graph', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canReadRuns')
    if (typeof runStore.getRunGraph !== 'function') throw requestError(501, 'hosted_storage_unavailable', 'Run storage is not available in this runtime.')
    const graph = await runStore.getRunGraph(c.req.param('id'))
    if (!graph) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, graph, 200, sessionHeaders(c))
  })

  app.get('/api/runs/:id/details', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canReadRunDetails')
    if (typeof runStore.getRunDetails !== 'function') throw requestError(501, 'hosted_storage_unavailable', 'Run storage is not available in this runtime.')
    const details = await runStore.getRunDetails(c.req.param('id'))
    if (!details) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, details, 200, sessionHeaders(c))
  })

  app.get('/api/runs/:id/events.json', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canReadEventsJson')
    const runId = c.req.param('id')
    const since = Number(c.req.query('since') || 0)
    const active = typeof liveRuns.getActiveEvents === 'function' ? liveRuns.getActiveEvents(runId, since) : null
    if (active) return json(c, active, 200, sessionHeaders(c))
    if (typeof eventStore.listEvents !== 'function') throw requestError(501, 'hosted_storage_unavailable', 'Event storage is not available in this runtime.')
    const replay = await eventStore.listEvents({
      runId,
      since,
    })
    if (!replay) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, replay, 200, sessionHeaders(c))
  })

  app.get('/api/runs/:id/events', (c) => {
    assertHonoToken(c, token)
    if (capabilities.canStreamRunEvents !== true) {
      throw requestError(501, 'event_stream_unavailable', 'Run event streaming is not available in this runtime.')
    }
    throw requestError(501, 'event_stream_unavailable', 'Run event streaming requires a runtime-specific stream adapter.')
  })

  app.post('/api/files/open', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canOpenLocalFiles')
    if (typeof mutations.openFile !== 'function') throw requestError(501, 'unsupported_capability', 'Opening local files is not available in this runtime.')
    const result = mutationResult(await mutations.openFile(await honoJsonBody(c)))
    return json(c, result.body, result.statusCode)
  })

  app.post('/api/workflows/:id/dry-run', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canDryRun')
    if (typeof mutations.dryRunWorkflow !== 'function') throw requestError(501, 'unsupported_capability', 'Workflow dry-run is not available in this runtime.')
    const result = mutationResult(await mutations.dryRunWorkflow(c.req.param('id'), await honoJsonBody(c)))
    return json(c, result.body, result.statusCode)
  })

  app.post('/api/workflows/:id/runs', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canStartRuns')
    if (typeof mutations.startWorkflow !== 'function') throw requestError(501, 'unsupported_capability', 'Starting workflow runs is not available in this runtime.')
    const result = mutationResult(await mutations.startWorkflow(c.req.param('id'), await honoJsonBody(c)))
    return json(c, result.body, result.statusCode)
  })

  app.post('/api/runs/:id/cancel', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canCancelRuns')
    if (typeof mutations.cancelRun !== 'function') throw requestError(501, 'unsupported_capability', 'Run cancellation is not available in this runtime.')
    const result = mutationResult(await mutations.cancelRun(c.req.param('id'), await honoJsonBody(c)))
    if (!result) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, result.body, result.statusCode)
  })

  app.post('/api/runs/:id/review/approve', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canReviewGates')
    if (typeof mutations.approveReview !== 'function') throw requestError(501, 'unsupported_capability', 'Review gate approval is not available in this runtime.')
    const result = mutationResult(await mutations.approveReview(c.req.param('id'), await honoJsonBody(c)))
    if (!result) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, result.body, result.statusCode)
  })

  app.post('/api/runs/:id/review/cancel', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canReviewGates')
    if (typeof mutations.cancelReview !== 'function') throw requestError(501, 'unsupported_capability', 'Review gate cancellation is not available in this runtime.')
    const result = mutationResult(await mutations.cancelReview(c.req.param('id'), await honoJsonBody(c)))
    if (!result) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, result.body, result.statusCode)
  })

  app.post('/api/runs/:id/followups', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canSubmitFollowups')
    if (typeof mutations.submitFollowup !== 'function') throw requestError(501, 'unsupported_capability', 'Follow-up submission is not available in this runtime.')
    const result = mutationResult(await mutations.submitFollowup(c.req.param('id'), await honoJsonBody(c)))
    if (!result) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, result.body, result.statusCode)
  })

  app.post('/api/runs/:id/followups/cancel', async (c) => {
    assertHonoToken(c, token)
    requireCapability(capabilities, 'canSubmitFollowups')
    if (typeof mutations.cancelFollowup !== 'function') throw requestError(501, 'unsupported_capability', 'Follow-up cancellation is not available in this runtime.')
    const result = mutationResult(await mutations.cancelFollowup(c.req.param('id'), await honoJsonBody(c)))
    if (!result) throw requestError(404, 'not_found', 'Unknown dashboard run.')
    return json(c, result.body, result.statusCode)
  })

  return app
}

module.exports = {
  createDashboardApi,
}
