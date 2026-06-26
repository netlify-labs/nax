const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { URL } = require('url')

const { listFlows, loadFlow } = require('../workflows/catalog/flows')
const { listRunStates, listWorkflowStatePage, saveRunState } = require('../storage/local/run-state')
const { flowToGraph } = require('./shared/graph')
const { normalizeAgentList, normalizeStepModels, selectionValidationErrors } = require('../core/agents/selection')
const { buildRunDetails } = require('./shared/run-details')
const { appendEventLog, eventLogPathForRunState, readEventLog } = require('../workflows/events/runner-event-log')
const { formatAgentRunUrl } = require('../workflows/results/agent-run-results')
const { findReviewStep } = require('../workflows/human-review')
const { archiveAgentRun, stopAgentRun } = require('../integrations/netlify/local-runner')
const { setBlob } = require('../integrations/netlify/blobs')
const { readLinkedSiteId } = require('../integrations/netlify/init')
const { isTerminalRunStatus } = require('../core/status')
const { errorPayload, requestError } = require('./api/errors')
const { readJsonBody } = require('./api/request')
const { securityHeaders } = require('./api/security')
const { isActiveProjectedStatus, projectRunSnapshot, publicFlow, publicRunOptions, publicRunState } = require('./api/serializers')
const {
  sessionBootstrapHeadersForRequest,
  sessionCookieHeader,
  timingSafeTokenEqual,
  tokenFromRequest,
} = require('./api/auth')
const { createDashboardApi } = require('./api/app')
const { localDashboardCapabilities } = require('./api/capabilities')
const { createLocalWorkflowStore } = require('./storage/local-workflows')
const { createLocalRunStore } = require('./storage/local-runs')
const { createLocalEventStore } = require('./storage/local-events')
const { createLocalEventStreamAdapter } = require('./events/local-stream')
const {
  cancelFollowup: cancelFollowupService,
  cancelReviewGate: cancelReviewGateService,
  cancelRun: cancelRunService,
  submitFollowup: submitFollowupService,
} = require('./services/mutations')
const { dryRunWorkflow, resumeWorkflowRun } = require('./transports/local-in-process')
const { createRunnerEventParser, runWorkflowChild } = require('./transports/local-process')
const { openLocalFile } = require('./runtime/local-files')
const {
  MAX_FINISHED_RUNS,
  MAX_LIVE_EVENTS,
  MAX_LIVE_OUTPUT_CHARS,
  appendBounded,
  broadcastEvent,
  createLocalLiveRunRegistry,
  endClients,
  eventAfter,
  eventText,
  evictFinishedRuns,
  extractDurableRunId,
  registerSseClient,
  shutdownRuns,
} = require('./runtime/live-run-registry')

function jsonResponse(res, statusCode, payload, headers = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.writeHead(statusCode, {
    ...securityHeaders(),
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function textResponse(res, statusCode, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(statusCode, {
    ...securityHeaders(),
    ...headers,
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** @param {NodeJS.ProcessEnv} env */
function dashboardDeploymentMode(env) {
  return ['local', 'desktop', 'web'].includes(String(env.NAX_DASHBOARD_DEPLOYMENT_MODE || ''))
    ? /** @type {'local' | 'desktop' | 'web'} */ (String(env.NAX_DASHBOARD_DEPLOYMENT_MODE))
    : 'local'
}

/** @param {NodeJS.ProcessEnv} env */
function legacyHealthCapabilities(env) {
  const deploymentMode = dashboardDeploymentMode(env)
  return {
    deploymentMode,
    canStartRuns: deploymentMode !== 'web' || String(env.NAX_DASHBOARD_WEB_CAN_START_RUNS || '') === '1',
    canDryRun: deploymentMode !== 'web' || String(env.NAX_DASHBOARD_WEB_CAN_DRY_RUN || '') === '1',
    canOpenLocalFiles: deploymentMode !== 'web',
    canStreamRunEvents: true,
    requiresAuth: true,
  }
}

/** @param {NodeJS.ProcessEnv} env */
function localServerCapabilities(env) {
  return localDashboardCapabilities({
    ...legacyHealthCapabilities(env),
  })
}

const DEFAULT_RUNS_DURABLE_LIMIT = 50
const MAX_RUNS_DURABLE_LIMIT = 200
const ACTIVE_DURABLE_MATCH_WINDOW_MS = 5 * 60 * 1000
const ACTIVE_DURABLE_MATCH_SKEW_MS = 10 * 1000
const RUN_STARTUP_DURABLE_ID_TIMEOUT_MS = 30000

/**
 * @param {string | null | undefined} value
 * @param {number} fallback
 * @param {number} max
 */
function parsePositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

/** @param {{ offset: number }} cursor */
function encodeRunsCursor(cursor) {
  return Buffer.from(JSON.stringify({ offset: cursor.offset })).toString('base64url')
}

/** @param {string} value */
function decodeRunsCursor(value) {
  if (!value) return { offset: 0 }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const offset = Number(parsed?.offset)
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('invalid offset')
    }
    return { offset }
  } catch {
    throw requestError(400, 'invalid_cursor', 'Invalid runs cursor.')
  }
}

/**
 * @param {string} projectRoot
 * @param {{ limit?: string | null, cursor?: string | null }} [options]
 */
function paginatedDurableRuns(projectRoot, { limit: limitValue, cursor: cursorValue } = {}) {
  const limit = parsePositiveInteger(limitValue, DEFAULT_RUNS_DURABLE_LIMIT, MAX_RUNS_DURABLE_LIMIT)
  const { offset } = decodeRunsCursor(String(cursorValue || ''))
  const page = listWorkflowStatePage(projectRoot, { limit, offset })
  const nextOffset = page.offset + page.limit
  const hasMore = nextOffset < page.total
  return {
    items: page.items,
    pagination: {
      limit: page.limit,
      offset: page.offset,
      total: page.total,
      nextCursor: hasMore ? encodeRunsCursor({ offset: nextOffset }) : null,
      hasMore,
    },
  }
}

/** @param {Record<string, unknown>} run */
function runIdentity(run) {
  return String(run.runId || run.id || '').trim()
}

/**
 * @param {{
 *   durableRuns?: Array<Record<string, unknown>>,
 *   liveRuns?: Array<Record<string, unknown>>,
 *   pagination?: Record<string, unknown> | null,
 *   hasDurableRun?: (id: string) => boolean,
 * }} input
 */
function overlayLiveOnlyRuns({ durableRuns = [], liveRuns = [], pagination = null, hasDurableRun }) {
  const seen = new Set()
  const runs = []
  for (const run of durableRuns) {
    const id = runIdentity(run)
    if (!id || seen.has(id)) continue
    seen.add(id)
    runs.push(run)
  }
  if ((Number(pagination?.offset ?? pagination?.durableOffset ?? 0) || 0) !== 0) return runs
  for (const run of liveRuns) {
    const id = runIdentity(run)
    if (!id || seen.has(id)) continue
    if (typeof hasDurableRun === 'function' && hasDurableRun(id)) continue
    seen.add(id)
    runs.push(run)
  }
  return runs
}

/**
 * @param {{
 *   flowId: string,
 *   liveRun?: Record<string, unknown> | null,
 *   durableStates?: Array<Record<string, unknown>>,
 * }} input
 */
function projectedWorkflowActivity({ flowId, liveRun = null, durableStates = [] }) {
  const normalizedFlowId = String(flowId || '').trim()
  if (!normalizedFlowId) return { active: false, staleLive: false, source: '' }
  const matchingStates = durableStates.filter((state) => String(state?.flowId || '') === normalizedFlowId)
  const liveDurableId = String(liveRun?.runId || liveRun?.id || '').trim()
  const liveDurable = liveDurableId
    ? matchingStates.find((state) => String(state?.runId || '') === liveDurableId) || null
    : null
  if (liveRun) {
    if (liveDurable && !isActiveProjectedStatus(projectRunSnapshot(liveDurable).status)) {
      return { active: false, staleLive: true, source: 'live' }
    }
    if (isActiveProjectedStatus(liveRun.status || 'running')) {
      return { active: true, staleLive: false, source: 'live' }
    }
  }
  const activeDurable = matchingStates.find((state) => isActiveProjectedStatus(projectRunSnapshot(state).status))
  return activeDurable
    ? { active: true, staleLive: false, source: 'durable', runId: String(activeDurable.runId || '') }
    : { active: false, staleLive: false, source: '' }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch (_err) {
    return value
  }
}

/** @param {string | null | undefined} value */
function timestampMs(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : null
}

/** @param {string | null | undefined} id */
function runIdTimestampMs(id) {
  const match = String(id || '').match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-|$)/)
  if (!match) return null
  return timestampMs(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`)
}

/**
 * @param {Array<Record<string, unknown>>} states
 * @param {{ id?: string, runId?: string, flowId?: string, startedAt?: string }} active
 */
function durableRunIdFromActiveRunStates(states, active = {}) {
  const flowId = String(active.flowId || '').trim()
  if (!flowId) return ''
  const startedAtMs = timestampMs(active.startedAt) ?? runIdTimestampMs(active.id)
  if (startedAtMs == null) return ''
  const lowerBound = startedAtMs - ACTIVE_DURABLE_MATCH_SKEW_MS
  const upperBound = startedAtMs + ACTIVE_DURABLE_MATCH_WINDOW_MS
  return states
    .map((state) => {
      const runId = String(state?.runId || '').trim()
      const createdAtMs = timestampMs(/** @type {string | undefined} */ (state?.createdAt)) ?? runIdTimestampMs(runId)
      return {
        runId,
        flowId: String(state?.flowId || '').trim(),
        createdAtMs,
      }
    })
    .filter((state) => {
      if (!state.runId || state.runId === active.id || state.runId === active.runId) return false
      if (state.flowId !== flowId || state.createdAtMs == null) return false
      return state.createdAtMs >= lowerBound && state.createdAtMs <= upperBound
    })
    .sort((left, right) => {
      const leftAfterStart = left.createdAtMs >= startedAtMs ? 0 : 1
      const rightAfterStart = right.createdAtMs >= startedAtMs ? 0 : 1
      return leftAfterStart - rightAfterStart ||
        Math.abs(left.createdAtMs - startedAtMs) - Math.abs(right.createdAtMs - startedAtMs) ||
        left.runId.localeCompare(right.runId)
    })[0]?.runId || ''
}

/** @param {string} pathname */
function isReadOnlyDashboardApiPath(pathname) {
  if (pathname === '/api/health' || pathname === '/api/workflows' || pathname === '/api/runs') return true
  if (/^\/api\/workflows\/[^/]+(?:\/graph)?$/.test(pathname)) return true
  return /^\/api\/runs\/[^/]+(?:\/graph|\/details|\/events\.json)?$/.test(pathname)
}

/** @param {string} pathname */
function isMutationDashboardApiPath(pathname) {
  if (pathname === '/api/files/open') return true
  if (/^\/api\/workflows\/[^/]+\/(?:dry-run|runs)$/.test(pathname)) return true
  return /^\/api\/runs\/[^/]+\/(?:cancel|review\/approve|review\/cancel|followups|followups\/cancel)$/.test(pathname)
}

/**
 * @param {string | undefined} method
 * @param {string} pathname
 */
function isHonoDashboardApiPath(method, pathname) {
  return (method === 'GET' && isReadOnlyDashboardApiPath(pathname)) ||
    (method === 'POST' && isMutationDashboardApiPath(pathname))
}

/** @param {http.IncomingMessage} req */
function fetchHeadersFromIncomingMessage(req) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  return headers
}

/** @param {http.IncomingMessage} req */
function requestMayHaveBody(req) {
  return !['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())
}

/** @param {http.IncomingMessage} req */
function readIncomingMessageBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      length += buffer.length
      if (length > 1024 * 1024) {
        reject(requestError(413, 'payload_too_large', 'Request body is too large.'))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {Response} response
 * @param {http.ServerResponse} res
 */
async function writeFetchResponse(response, res) {
  /** @type {Record<string, string>} */
  const headers = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const body = Buffer.from(await response.arrayBuffer())
  headers['content-length'] = String(body.length)
  res.writeHead(response.status, headers)
  res.end(body)
}

/**
 * @param {import('hono').Hono} app
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} base
 */
async function handleHonoRequest(app, req, res, base) {
  const requestUrl = new URL(req.url || '/', base)
  const body = requestMayHaveBody(req) ? await readIncomingMessageBody(req) : undefined
  const response = await app.request(requestUrl.toString(), {
    method: req.method || 'GET',
    headers: fetchHeadersFromIncomingMessage(req),
    body,
  })
  await writeFetchResponse(response, res)
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function notFound(res, message = 'Not found') {
  jsonResponse(res, 404, errorPayload(404, 'not_found', message))
}

function methodNotAllowed(res, method) {
  jsonResponse(res, 405, errorPayload(405, 'method_not_allowed', `Method ${method} is not allowed for this endpoint.`))
}

function defaultFollowupArtifacts(details = {}, requestedArtifacts) {
  if (Array.isArray(requestedArtifacts) && requestedArtifacts.length > 0) return requestedArtifacts
  return (Array.isArray(details.followupArtifacts) ? details.followupArtifacts : [])
    .filter((artifact) => artifact.defaultSelected)
    .map((artifact) => ({ id: artifact.id, kind: artifact.kind }))
}

function followupTargetById(details = {}, targetId = '') {
  const targets = Array.isArray(details.followupTargets) ? details.followupTargets : []
  if (targetId) return targets.find((target) => target.id === targetId) || null
  return targets.find((target) => target.isDefault) || targets[0] || null
}

function normalizeFollowupRequest(body = {}, details = {}, runState = {}) {
  const prompt = String(body.prompt || body.instructions || '').trim()
  if (!prompt) {
    throw requestError(400, 'missing_prompt', 'Enter follow-up instructions before submitting.')
  }
  const target = followupTargetById(details, String(body.targetId || body.target?.id || ''))
  if (!target) {
    throw requestError(400, 'missing_followup_target', 'No follow-up target is available for this run.')
  }
  const artifacts = defaultFollowupArtifacts(details, body.artifacts)
  const mode = String(body.mode || target.defaultMode || 'follow-up-thread')
  const models = normalizeAgentList(body.models)
  const targetSha = String(body.targetSha || body.target?.sha || runState.target?.sha || '')
  const targetBranch = String(body.targetBranch || body.target?.branch || runState.branch || runState.target?.branch || '')
  return {
    prompt,
    target,
    artifacts,
    mode,
    models,
    targetSha,
    targetBranch,
  }
}

function submissionResponseItem(result = {}) {
  const run = result.run || {}
  return {
    id: result.submission?.id || '',
    mode: result.submission?.mode || '',
    agent: run.agent || result.submission?.agent || '',
    runnerId: run.runnerId || result.submission?.runnerId || '',
    sessionId: run.sessionId || result.submission?.sessionId || '',
    status: run.status || 'submitted',
    links: run.links || {},
    issueUrl: run.issueUrl || '',
    sessionArtifactPath: result.sessionArtifact?.filePath || '',
    runnerArtifactPath: result.runnerArtifact?.filePath || '',
    warnings: result.warnings || [],
  }
}

function followupId(sourceRunId = '') {
  return `followup-${String(sourceRunId || 'run')}-${Date.now().toString(36)}`
}

/**
 * Follow-up blob write callback.
 * @callback FollowupBlobWriter
 * @param {{ ref: import('../types').BlobRef, payload: string }} input
 * @returns {unknown}
 *
 * Options for creating a follow-up blob writer.
 * @typedef {{
 *   projectRoot?: string,
 *   siteId?: string,
 *   env?: NodeJS.ProcessEnv,
 *   writeBlob?: FollowupBlobWriter | null,
 *   setBlobCommand?: typeof setBlob,
 * }} MakeFollowupBlobWriterInput
 */

/** @param {MakeFollowupBlobWriterInput} [input] */
function makeFollowupBlobWriter({ projectRoot, siteId, env = process.env, writeBlob, setBlobCommand = setBlob } = {}) {
  if (typeof writeBlob === 'function') return writeBlob
  if (!siteId) return null
  return async ({ ref, payload }) => setBlobCommand({
    store: ref.store,
    key: ref.key,
    value: payload,
    siteId,
    token: env.NETLIFY_AUTH_TOKEN,
    cwd: projectRoot,
    env,
  })
}

/** @param {{ projectRoot?: string, siteId?: string, env?: NodeJS.ProcessEnv }} [input] */
function resolveFollowupSiteId({ projectRoot, siteId = '', env = process.env } = {}) {
  return siteId || env.NETLIFY_SITE_ID || readLinkedSiteId(projectRoot, env) || ''
}

function linkSubmittedRunFactory({ siteName = '' } = {}) {
  return (run = {}) => {
    const agentRunUrl = formatAgentRunUrl(siteName, run.runnerId, run.sessionId)
    if (!agentRunUrl) return run
    return {
      ...run,
      issueUrl: run.issueUrl || agentRunUrl,
      links: {
        ...(run.links || {}),
        agentRunUrl,
        ...(run.sessionId ? { sessionUrl: agentRunUrl } : {}),
      },
    }
  }
}

function titleCaseAgent(agent = '') {
  const value = String(agent || '').trim()
  if (!value) return 'Agent'
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function freshFollowupTitle(sourceRun = {}, target = {}, freshResults = []) {
  const workflowTitle = sourceRun.flowTitle || sourceRun.flowId || 'workflow'
  const agents = freshResults.map((run) => titleCaseAgent(run.agent)).filter(Boolean)
  const agentText = agents.length === 1 ? agents[0] : agents.length > 1 ? `${agents.length} agents` : titleCaseAgent(target.agent)
  return `Follow-up on ${workflowTitle}${agentText ? ` (${agentText})` : ''}`
}

function assertToken(req, requestUrl, token) {
  const provided = tokenFromRequest(req, requestUrl)
  if (!timingSafeTokenEqual(provided, token)) {
    throw requestError(401, 'unauthorized', 'A valid dashboard session token is required.')
  }
}

function hostWithoutPort(hostHeader = '') {
  const value = String(hostHeader || '').trim().toLowerCase()
  if (!value) return ''
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'))
  return value.split(':')[0]
}

function allowedHostnames(bindHost = '127.0.0.1') {
  const bind = String(bindHost || '').trim().toLowerCase()
  const allowed = new Set(['localhost', '127.0.0.1', '::1'])
  if (bind && bind !== '0.0.0.0' && bind !== '::') allowed.add(bind)
  return allowed
}

function assertAllowedHost(req, bindHost) {
  const host = hostWithoutPort(req.headers.host)
  if (!host || !allowedHostnames(bindHost).has(host)) {
    throw requestError(403, 'forbidden_host', 'The Host header is not allowed for this dashboard server.')
  }
}

/** @param {{ token?: string, initialWorkflow?: string }} [options] */
function defaultIndexHtml({ token, initialWorkflow = '' } = {}) {
  const workflowText = initialWorkflow
    ? `<p>Initial workflow: <code>${htmlEscape(initialWorkflow)}</code></p>`
    : ''
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Nax Dashboard</title>',
    '  <style>',
    '    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #111827; }',
    '    main { max-width: 720px; margin: 12vh auto; padding: 0 24px; line-height: 1.5; }',
    '    code { background: #e5e7eb; border-radius: 4px; padding: 2px 5px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>Nax Dashboard</h1>',
    '    <p>The dashboard API is running. Build the web UI with <code>npm run dashboard:build</code> to serve the full workbench.</p>',
    `    ${workflowText}`,
    '    <p>API health: <a href="/api/health">/api/health</a></p>',
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n')
}

function normalizePort(port) {
  if (port === undefined || port === null || port === '') return 0
  const parsed = Number.parseInt(String(port), 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid dashboard port: ${port}`)
  }
  return parsed
}

/** @param {unknown} input @returns {string} */
function dashboardInitialPath(input) {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!value || value.includes('://') || value.startsWith('//') || value.includes('\\')) return '/'
  const pathname = value.split(/[?#]/)[0] || '/'
  if (!pathname.startsWith('/') || pathname.startsWith('/api/')) return '/'
  return pathname.replace(/\/{2,}/g, '/')
}

function normalizeDryRunOptions(raw = {}, flow = {}) {
  const allowedTransports = new Set(['auto', 'github', 'github-actions', 'netlify-api', 'local', 'local-machine'])
  const out = {}
  const transport = String(raw.transport || 'auto').trim()
  if (!allowedTransports.has(transport)) {
    throw requestError(400, 'invalid_transport', `Invalid transport "${transport}".`)
  }
  out.transport = transport

  for (const key of ['branch', 'context', 'step', 'fromStep']) {
    if (raw[key] === undefined || raw[key] === null) continue
    out[key] = String(raw[key])
  }
  const siteId = raw.siteId || raw.netlifySiteId
  if (siteId !== undefined && siteId !== null && String(siteId).trim()) {
    out.siteId = String(siteId).trim()
    out.netlifySiteId = String(siteId).trim()
  }

  const stepIds = new Set((flow.steps || []).map((step) => step.id))
  if (out.step && !stepIds.has(out.step)) {
    throw requestError(400, 'invalid_step', `Unknown step "${out.step}" in flow "${flow.id}".`)
  }
  if (out.fromStep && !stepIds.has(out.fromStep)) {
    throw requestError(400, 'invalid_from_step', `Unknown fromStep "${out.fromStep}" in flow "${flow.id}".`)
  }

  const models = normalizeAgentList(raw.models)
  out.models = models
  out.stepModels = normalizeStepModels(raw.stepModels)
  const errors = selectionValidationErrors(flow, out)
  if (errors.length > 0) {
    throw requestError(400, errors[0].code, errors[0].message)
  }
  return out
}

function stepStatusSnapshot(runState = {}) {
  return projectRunSnapshot(runState).steps
    .map((step) => ({
      stepId: step.id || '',
      title: step.title || step.id || '',
      status: step.status || '',
      agents: Array.isArray(step.agents) ? step.agents : [],
      runCount: Array.isArray(step.runs) ? step.runs.length : 0,
    }))
    .filter((step) => step.stepId)
}

function workflowAgentEventSnapshots(runState = {}) {
  if (!runState?.dir) return []
  let replay
  try {
    replay = readEventLog(eventLogPathForRunState(runState))
  } catch {
    return []
  }

  const snapshots = new Map()
  for (const event of Array.isArray(replay.events) ? replay.events : []) {
    if (event?.type !== 'agent_status') continue
    const stepId = String(event.stepId || '').trim()
    const agent = String(event.agent || '').trim()
    const runnerId = String(event.runnerId || '').trim()
    if (!stepId || !agent || !runnerId || event.existingRunnerId) continue
    snapshots.set(`${stepId}\0${agent}`, {
      stepId,
      agent,
      runnerId,
      sessionId: String(event.sessionId || ''),
      links: event.links && typeof event.links === 'object' && !Array.isArray(event.links) ? event.links : {},
      status: String(event.status || ''),
      submittedAfterSeconds: typeof event.submittedAfterSeconds === 'number' ? event.submittedAfterSeconds : null,
    })
  }
  return [...snapshots.values()]
}

function hydrateWorkflowRunsFromEvents(runState = {}) {
  const snapshots = workflowAgentEventSnapshots(runState)
  if (snapshots.length === 0) return runState

  const byStepAgent = new Map(snapshots.map((snapshot) => [`${snapshot.stepId}\0${snapshot.agent}`, snapshot]))
  for (const step of Array.isArray(runState.steps) ? runState.steps : []) {
    const stepId = String(step?.id || '').trim()
    if (!stepId) continue
    for (const run of Array.isArray(step.runs) ? step.runs : []) {
      const agent = String(run?.agent || '').trim()
      const snapshot = byStepAgent.get(`${stepId}\0${agent}`)
      if (!snapshot) continue
      if (!String(run.runnerId || '').trim()) run.runnerId = snapshot.runnerId
      if (!String(run.sessionId || '').trim() && snapshot.sessionId) run.sessionId = snapshot.sessionId
      if ((!run.links || Object.keys(run.links).length === 0) && Object.keys(snapshot.links).length > 0) {
        run.links = snapshot.links
      }
      if (run.submittedAfterSeconds == null && snapshot.submittedAfterSeconds != null) {
        run.submittedAfterSeconds = snapshot.submittedAfterSeconds
      }
    }
  }
  return runState
}

function cancellableWorkflowRunnerIds(runState = {}) {
  hydrateWorkflowRunsFromEvents(runState)
  const runnerIds = []
  const terminalStepAgents = new Set()
  const add = (runnerId) => {
    const normalized = String(runnerId || '').trim()
    if (normalized) runnerIds.push(normalized)
  }
  for (const step of Array.isArray(runState.steps) ? runState.steps : []) {
    const stepId = String(step?.id || '').trim()
    for (const run of Array.isArray(step.runs) ? step.runs : []) {
      const status = String(run.status || '').toLowerCase()
      if (stepId && run.agent && isTerminalRunStatus(status)) terminalStepAgents.add(`${stepId}\0${run.agent}`)
      const runnerId = String(run.runnerId || '').trim()
      if (!runnerId || run.existingRunnerId) continue
      if (isTerminalRunStatus(status)) continue
      add(runnerId)
    }
  }

  for (const snapshot of workflowAgentEventSnapshots(runState)) {
    const status = String(snapshot.status || '').toLowerCase()
    if (isTerminalRunStatus(status)) continue
    if (terminalStepAgents.has(`${snapshot.stepId}\0${snapshot.agent}`)) continue
    add(snapshot.runnerId)
  }
  return [...new Set(runnerIds)]
}

/**
 * Stop-runner callback result.
 * @typedef {{
 *   stopped?: boolean,
 *   error?: string,
 * }} StopWorkflowRunnerResult
 *
 * Stop-runner callback input.
 * @typedef {{
 *   projectRoot?: string,
 *   runnerId?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} StopWorkflowRunnerInput
 *
 * Stop-runner callback used by dashboard cancellation.
 * @callback StopWorkflowRunner
 * @param {StopWorkflowRunnerInput} input
 * @returns {StopWorkflowRunnerResult | Promise<StopWorkflowRunnerResult>}
 *
 * Options for cancelling active workflow Agent Runners.
 * @typedef {{
 *   runState?: import('../types').WorkflowRunState,
 *   projectRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stopRun?: StopWorkflowRunner,
 * }} StopWorkflowRunnersInput
 */

/** @param {StopWorkflowRunnersInput} param0 */
async function stopWorkflowRunners({ runState, projectRoot, env, stopRun = stopAgentRun } = {}) {
  const runnerIds = cancellableWorkflowRunnerIds(runState)
  const stopped = []
  const warnings = []
  for (const runnerId of runnerIds) {
    try {
      const result = await stopRun({ projectRoot, runnerId, env })
      if (result?.stopped === true) {
        stopped.push(runnerId)
      } else if (result?.error) {
        warnings.push(`${runnerId}: ${result.error}`)
      } else {
        warnings.push(`${runnerId}: stop request did not report success`)
      }
    } catch (error) {
      warnings.push(`${runnerId}: ${error?.message || String(error)}`)
    }
  }
  return { runnerIds, stopped, warnings }
}

function appendDurableWorkflowEvent(runState = {}, type, data = {}) {
  if (!runState?.dir) return null
  const filePath = eventLogPathForRunState(runState)
  const replay = readEventLog(filePath)
  const seq = replay.events.reduce((max, event) => Math.max(max, Number(event.seq || 0)), 0) + 1
  const event = {
    schemaVersion: 1,
    seq,
    eventId: `${runState.runId || 'workflow'}:${seq}`,
    type,
    at: new Date().toISOString(),
    runId: runState.runId || '',
    flowId: runState.flowId || '',
    flowTitle: runState.flowTitle || '',
    projectRoot: runState.projectRoot || '',
    transport: runState.transport || '',
    branch: runState.branch || runState.options?.branch || '',
    target: runState.target || runState.options?.target || null,
    ...data,
  }
  appendEventLog(filePath, event)
  return event
}

function applyRemoteCancelToWorkflow(runState = {}, remoteCancel = {}, { reason = 'cancelled from dashboard' } = {}) {
  hydrateWorkflowRunsFromEvents(runState)
  const stopped = new Set(Array.isArray(remoteCancel.stopped) ? remoteCancel.stopped : Array.isArray(remoteCancel.archived) ? remoteCancel.archived : [])
  const runnerIds = Array.isArray(remoteCancel.runnerIds) ? remoteCancel.runnerIds : []
  const attempted = new Set(runnerIds)
  const cancelledAt = new Date().toISOString()
  let changed = false
  for (const step of Array.isArray(runState.steps) ? runState.steps : []) {
    let stepChanged = false
    for (const run of Array.isArray(step.runs) ? step.runs : []) {
      const runnerId = String(run.runnerId || '').trim()
      const status = String(run.status || '').toLowerCase()
      if (isTerminalRunStatus(status)) continue
      if (runnerId && attempted.has(runnerId) && !stopped.has(runnerId)) continue
      run.status = 'cancelled'
      run.cancelledAt = cancelledAt
      run.cancelReason = reason
      changed = true
      stepChanged = true
    }
    const runs = Array.isArray(step.runs) ? step.runs : []
    const hasActiveRun = runs.some((run) => !isTerminalRunStatus(run.status))
    if (stepChanged && !hasActiveRun) {
      step.status = 'cancelled'
    }
  }
  if (!changed && runnerIds.length === 0) return runState
  if (changed) {
    runState.status = 'cancelled'
    runState.cancelledAt = cancelledAt
    runState.cancelReason = reason
  }
  runState.remoteCancel = {
    reason,
    requestedAt: cancelledAt,
    runnerIds,
    stopped: [...stopped],
    warnings: Array.isArray(remoteCancel.warnings) ? remoteCancel.warnings : [],
  }
  if (runState.remoteCancel.warnings.length > 0) {
    runState.remoteCancelWarning = `${runState.remoteCancel.warnings.length} remote ${runState.remoteCancel.warnings.length === 1 ? 'runner' : 'runners'} could not be stopped.`
  }
  saveRunState(runState)
  appendDurableWorkflowEvent(runState, 'remote_cancel_requested', {
    runnerIds,
    stoppedRunnerIds: [...stopped],
    warnings: runState.remoteCancel.warnings,
  })
  if (changed || stopped.size > 0) {
    appendDurableWorkflowEvent(runState, 'workflow_cancelled', {
      status: 'cancelled',
      reason,
    })
  }
  return runState
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.html') return 'text/html; charset=utf-8'
  if (extension === '.js') return 'text/javascript; charset=utf-8'
  if (extension === '.css') return 'text/css; charset=utf-8'
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (extension === '.png') return 'image/png'
  if (extension === '.ico') return 'image/x-icon'
  return 'application/octet-stream'
}

function staticFileForPath(distDir, pathname) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname
  const relative = cleanPath.replace(/^\/+/, '')
  const resolved = path.resolve(distDir, relative)
  if (!resolved.startsWith(path.resolve(distDir) + path.sep) && resolved !== path.resolve(distDir)) {
    return ''
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
  const assetLikePath = pathname === '/assets' || pathname.startsWith('/assets/') || path.extname(pathname) !== ''
  if (assetLikePath) return ''
  const indexPath = path.join(distDir, 'index.html')
  if (fs.existsSync(indexPath)) return indexPath
  return ''
}

function createRequestHandler(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const bindHost = options.host || '127.0.0.1'
  const distDir = options.distDir || path.resolve(__dirname, 'web', 'dist')
  const tailOutput = options.tail === true || options.tailOutput === true
  const flowOptions = {
    projectRoot,
    flowsDir: options.flowsDir,
    flowsDirs: options.flowsDirs,
  }
  const token = options.token || crypto.randomBytes(24).toString('hex')
  const initialWorkflow = options.initialWorkflow || ''
  const env = options.env || process.env
  const followupSiteId = resolveFollowupSiteId({ projectRoot, siteId: options.siteId, env })
  const followupSiteName = options.siteName || env.NETLIFY_SITE_NAME || ''
  const followupNetlifyFilter = options.netlifyFilter || ''
  const followupSubmitRun = options.followupSubmitRun
  const followupWriteBlob = options.followupWriteBlob
  const followupSetBlob = options.followupSetBlob || setBlob
  const followupStopRun = options.followupStopRun || stopAgentRun
  const cancelStopRun = options.cancelStopRun || stopAgentRun
  const followupSyncRunCommand = options.followupSyncRunCommand
  const workflowChildRunner = options.runWorkflowChild || runWorkflowChild
  const liveRunRegistry = createLocalLiveRunRegistry()
  const workflowStore = createLocalWorkflowStore(flowOptions)
  /** @param {string} id */
  function resolveActiveDurableRunId(id) {
    const active = liveRunRegistry.getRawRun(safeDecode(id))
    if (!active) return ''
    let durableRunId = active.runId || extractDurableRunId(`${active.stdout || ''}\n${active.stderr || ''}`)
    if (!durableRunId) {
      try {
        durableRunId = durableRunIdFromActiveRunStates(listRunStates(projectRoot), active)
      } catch (_err) {
        durableRunId = ''
      }
    }
    if (!durableRunId) return ''
    return bindLiveRunToDurableId(active, durableRunId)
  }

  const runStore = createLocalRunStore({
    projectRoot,
    env,
    flowStore: workflowStore,
    followupSyncRunCommand,
    resolveRunStateId: resolveActiveDurableRunId,
  })
  const eventStore = createLocalEventStore({ getRunState: runStore.getRunState })
  const eventStream = createLocalEventStreamAdapter({
    liveRuns: {
      getRawRun: (id) => liveRunRegistry.getRawRun(id),
      registerSseClient: (run, request, response) => liveRunRegistry.registerSseClient(run, request, response),
    },
    eventStore: {
      getRunState: runStore.getRunState,
      listEvents: (input) => eventStore.listEvents(input),
    },
  })
  const capabilities = localServerCapabilities(env)
  const healthCapabilities = legacyHealthCapabilities(env)
  const readOnlyApi = createDashboardApi({
    runtime: {
      mode: 'local-node',
      deploymentMode: dashboardDeploymentMode(env),
      projectRoot,
      capabilities,
      healthCapabilities,
    },
    token,
    workflowStore,
    runStore,
    eventStore,
      liveRuns: {
      listActiveRuns: () => listPublicActiveRuns(),
      getActiveRun: (id) => {
        const run = liveRunRegistry.getRawRun(safeDecode(id))
        return run ? publicRun(run) : null
      },
      getActiveEvents: (id, since = 0) => {
        const run = liveRunRegistry.getRawRun(safeDecode(id))
        if (!run) return null
        return {
          run: publicRun(run),
          events: run.events.filter((candidate) => eventAfter(candidate, since)),
          errors: [],
        }
      },
    },
    mutations: {
      openFile: async (body) => ({
        body: {
          opened: true,
          path: await openLocalFile(body.path, { projectRoot }),
        },
      }),
      dryRunWorkflow: async (id, body) => {
        const flowId = safeDecode(id)
        const flow = await loadFlow(flowId, flowOptions)
        const options = normalizeDryRunOptions(body, flow)
        const result = await dryRunWorkflow({ flowId, projectRoot, options, tailOutput })
        return {
          statusCode: result.exitCode === 0 ? 200 : 500,
          body: {
            workflow: publicFlow(flow),
            dryRun: result,
          },
        }
      },
      startWorkflow: async (id, body) => {
        const flowId = safeDecode(id)
        const flow = await loadFlow(flowId, flowOptions)
        const runOptions = normalizeDryRunOptions(body, flow)
        const run = startRun({ flowId, runOptions })
        await run.startedPromise
        return {
          statusCode: 202,
          body: {
            workflow: publicFlow(flow),
            run: publicRun(run),
          },
        }
      },
      cancelRun: async (id) => {
        const requestedRunId = safeDecode(id)
        const run = liveRunRegistry.getRawRun(requestedRunId)
        const durable = durableRunStateForId(run?.runId || run?.id || requestedRunId)
        if (!run && !durable) return null
        return {
          body: await cancelRunService({
            run,
            durable,
            projectRoot,
            env,
            stopWorkflowRunners,
            stopRun: cancelStopRun,
            applyRemoteCancelToWorkflow,
            recordEvent,
            recordCancelSemantics,
            publicRun,
          }),
        }
      },
      approveReview: async (id, body) => {
        const durable = durableRunStateForId(id)
        if (!durable) return null
        const gate = findReviewStep(durable, String(body.stepId || ''))
        if (!gate) throw requestError(409, 'no_review_gate', 'No human review gate is awaiting approval for this workflow.')
        const run = startResumeRun({ durable, stepId: gate.id || '' })
        return {
          statusCode: 202,
          body: {
            run: publicRun(run),
            approved: true,
            stepId: gate.id || '',
          },
        }
      },
      cancelReview: async (id, body) => {
        const durable = durableRunStateForId(id)
        return durable ? { body: cancelReviewGateService({ runState: durable, body }) } : null
      },
      submitFollowup: async (id, body) => {
        const sourceRunId = safeDecode(id)
        const durable = durableRunStateForId(sourceRunId)
        if (!durable) return null
        return {
          statusCode: 202,
          body: {
            followup: await submitFollowupService({
              projectRoot,
              sourceRunId,
              durable,
              body,
              env,
              followupSiteId,
              followupSiteName,
              followupNetlifyFilter,
              followupSubmitRun,
              writeBlob: followupWriteBlob,
              normalizeFollowupRequest,
              makeBlobWriter: makeFollowupBlobWriter,
              setBlobCommand: followupSetBlob,
              linkSubmittedRun: linkSubmittedRunFactory,
              followupId,
              freshFollowupTitle,
              submissionResponseItem,
            }),
          },
        }
      },
      cancelFollowup: async (id, body) => {
        const sourceRunId = safeDecode(id)
        const durable = durableRunStateForId(sourceRunId)
        return durable
          ? {
              body: await cancelFollowupService({
                projectRoot,
                durable,
                body,
                env,
                stopRun: followupStopRun,
              }),
            }
          : null
      },
    },
  })

  function recordEvent(run, type, data = {}) {
    return liveRunRegistry.recordEvent(run, type, data)
  }

  function recordRunnerEvent(run, event = {}) {
    return liveRunRegistry.recordRunnerEvent(run, event)
  }

  function recordStepStatusEvents(run) {
    const durable = durableRunStateForId(run.runId || run.id)
    if (!durable) return
    run.stepStatuses ||= {}
    for (const step of stepStatusSnapshot(durable)) {
      const stepId = String(step.stepId || '')
      const previous = run.stepStatuses[stepId]
      if (previous === step.status) continue
      run.stepStatuses[stepId] = step.status
      recordEvent(run, 'step_status', step)
    }
  }

  function recordCancelSemantics(run) {
    const durable = durableRunStateForId(run.runId || run.id)
    recordEvent(run, 'workflow_cancelled', {
      status: 'cancelled',
      flowId: run.flowId,
      runId: run.runId || run.id,
    })
    if (!durable) return
    for (const step of Array.isArray(durable.steps) ? durable.steps : []) {
      if (!['running', 'submitted'].includes(step.status)) continue
      recordEvent(run, 'step_status', {
        stepId: step.id || '',
        title: step.title || step.id || '',
        status: 'cancelled',
        agents: Array.isArray(step.agents) ? step.agents : [],
        runCount: Array.isArray(step.runs) ? step.runs.length : 0,
      })
      for (const agentRun of Array.isArray(step.runs) ? step.runs : []) {
        const remoteSubmitted = Boolean(agentRun.runnerId || agentRun.issueNumber)
        recordEvent(run, 'agent_status', {
          stepId: step.id || '',
          stepTitle: step.title || step.id || '',
          agent: agentRun.agent || '',
          status: remoteSubmitted ? 'abandoned' : 'cancelled',
          runnerId: agentRun.runnerId || '',
          sessionId: agentRun.sessionId || '',
          issueNumber: agentRun.issueNumber || null,
          issueUrl: agentRun.issueUrl || '',
          links: agentRun.links || {},
        })
      }
    }
  }

  function bindLiveRunToDurableId(run, durableRunId) {
    const nextId = String(durableRunId || '').trim()
    if (!nextId) return ''
    const previousId = run.id
    run.runId = nextId
    if (previousId !== nextId) {
      liveRunRegistry.runs.delete(previousId)
      run.id = nextId
      liveRunRegistry.runs.set(nextId, run)
      liveRunRegistry.activeByWorkflow.set(run.flowId, nextId)
      for (const event of run.events) {
        if (event.runId === previousId) event.runId = nextId
      }
    }
    return nextId
  }

  function startRun({ flowId, runOptions }) {
    const existing = liveRunRegistry.activeWorkflowRun(flowId)
    const activity = projectedWorkflowActivity({
      flowId,
      liveRun: existing,
      durableStates: listRunStates(projectRoot),
    })
    if (activity.staleLive) {
      liveRunRegistry.clearWorkflow(flowId)
    }
    if (activity.active) {
      throw requestError(409, 'duplicate_run', `Workflow "${flowId}" already has an active dashboard run.`)
    }

    const id = `pending-${new Date().toISOString().replace(/[:.]/g, '-')}-${flowId}`
    /** @type {(run: Record<string, unknown>) => void} */
    let resolveStarted = () => {}
    /** @type {(error: Error) => void} */
    let rejectStarted = () => {}
    let startupSettled = false
    /** @type {NodeJS.Timeout | null} */
    let startupTimer = null
    const startedPromise = new Promise((resolve, reject) => {
      resolveStarted = resolve
      rejectStarted = reject
    })
    const run = {
      id,
      runId: '',
      flowId,
      status: 'running',
      command: [],
      startedAt: new Date().toISOString(),
      exitedAt: '',
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutDropped: 0,
      stderrDropped: 0,
      events: [],
      eventSeq: 0,
      clients: new Set(),
      cancellable: true,
      cancelRequested: false,
      cancel: null,
      stepStatuses: {},
      stepStatusTimer: null,
      startedPromise,
    }
    const settleStarted = (durableRunId) => {
      if (startupSettled) return
      const nextId = bindLiveRunToDurableId(run, durableRunId)
      if (!nextId) return
      startupSettled = true
      if (startupTimer) clearTimeout(startupTimer)
      startupTimer = null
      resolveStarted(run)
    }
    const failStarted = (error) => {
      if (startupSettled) return
      startupSettled = true
      if (startupTimer) clearTimeout(startupTimer)
      startupTimer = null
      rejectStarted(error)
    }
    startupTimer = setTimeout(() => {
      failStarted(new Error(`Workflow "${flowId}" did not report a durable run id within ${RUN_STARTUP_DURABLE_ID_TIMEOUT_MS / 1000}s.`))
    }, RUN_STARTUP_DURABLE_ID_TIMEOUT_MS)
    startupTimer.unref?.()
    liveRunRegistry.trackRun(run)
    run.stepStatusTimer = setInterval(() => {
      if (run.status === 'running') recordStepStatusEvents(run)
    }, 1000)
    run.stepStatusTimer.unref?.()
    const childRun = workflowChildRunner({
      flowId,
      projectRoot,
      options: runOptions,
      tailOutput,
      eventSink: (event) => {
        if (event.type === 'stdout') {
          const bounded = appendBounded(run.stdout, event.text || '')
          run.stdout = bounded.text
          run.stdoutDropped += bounded.dropped
          if (!run.runId) settleStarted(extractDurableRunId(run.stdout))
          if (run.runId) recordStepStatusEvents(run)
        }
        if (event.type === 'stderr') {
          const bounded = appendBounded(run.stderr, event.text || '')
          run.stderr = bounded.text
          run.stderrDropped += bounded.dropped
        }
        if (event.type === 'started') recordEvent(run, 'started', { command: event.command || run.command, flowId })
        else if (event.type === 'stdout') recordEvent(run, 'stdout', { text: event.text || '' })
        else if (event.type === 'stderr') recordEvent(run, 'stderr', { text: event.text || '' })
        else if (event.type === 'error') recordEvent(run, 'error', { message: event.message || '' })
        else if (event.type === 'runner_event') {
          const runnerEvent = event.event && typeof event.event === 'object' && !Array.isArray(event.event)
            ? /** @type {Record<string, unknown>} */ (event.event)
            : {}
          if (runnerEvent.runId) settleStarted(String(runnerEvent.runId))
          recordRunnerEvent(run, runnerEvent)
          if (run.runId) recordStepStatusEvents(run)
        } else if (event.type === 'runner_event_error') {
          recordEvent(run, 'runner_event_error', {
            message: event.message || '',
            line: event.line || '',
            code: event.code || 'runner_event_error',
            text: event.text || '',
          })
        }
      },
    })
    run.command = childRun.command
    run.cancel = childRun.cancel
    childRun.promise.then((result) => {
      run.exitCode = result.exitCode
      run.signal = result.signal
      run.status = result.status
      run.exitedAt = result.exitedAt
      run.durationMs = result.durationMs
      run.stdout = result.stdout
      run.stderr = result.stderr
      run.stdoutDropped = result.stdoutDropped || 0
      run.stderrDropped = result.stderrDropped || 0
      settleStarted(run.runId || extractDurableRunId(`${result.stdout || ''}\n${result.stderr || ''}`))
      if (!run.runId) failStarted(new Error(`Workflow "${flowId}" exited before reporting a durable run id.`))
      run.cancellable = false
      run.cancel = null
      if (run.stepStatusTimer) clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
      liveRunRegistry.clearWorkflow(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal, durationMs: run.durationMs })
      endClients(run.clients)
      liveRunRegistry.evictFinishedRuns()
    }).catch((error) => {
      const message = error?.message || String(error)
      run.status = 'failed'
      run.exitedAt = new Date().toISOString()
      run.exitCode = 1
      const bounded = appendBounded(run.stderr, `${message}\n`)
      run.stderr = bounded.text
      run.stderrDropped += bounded.dropped
      settleStarted(run.runId || extractDurableRunId(`${run.stdout || ''}\n${run.stderr || ''}`))
      if (!run.runId) failStarted(error instanceof Error ? error : new Error(message))
      run.cancellable = false
      run.cancel = null
      if (run.stepStatusTimer) clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
      liveRunRegistry.clearWorkflow(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'error', { message })
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal })
      endClients(run.clients)
      liveRunRegistry.evictFinishedRuns()
    })
    return run
  }

  function startResumeRun({ durable, stepId = '' }) {
    const flowId = durable.flowId || ''
    const existing = liveRunRegistry.activeWorkflowRun(flowId)
    const activity = projectedWorkflowActivity({
      flowId,
      liveRun: existing,
      durableStates: listRunStates(projectRoot),
    })
    if (activity.staleLive) {
      liveRunRegistry.clearWorkflow(flowId)
    }
    if (activity.active) {
      throw requestError(409, 'duplicate_run', `Workflow "${flowId}" already has an active dashboard run.`)
    }
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${durable.runId}-resume`
    const run = {
      id,
      runId: durable.runId || '',
      flowId,
      status: 'running',
      command: ['nax', 'resume', durable.runId || '', '--project-root', projectRoot],
      startedAt: new Date().toISOString(),
      exitedAt: '',
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutDropped: 0,
      stderrDropped: 0,
      events: [],
      eventSeq: 0,
      clients: new Set(),
      cancellable: false,
      cancelRequested: false,
      cancel: null,
      stepStatuses: {},
      stepStatusTimer: null,
    }
    liveRunRegistry.trackRun(run)
    run.stepStatusTimer = setInterval(() => {
      if (run.status === 'running') recordStepStatusEvents(run)
    }, 1000)
    run.stepStatusTimer.unref?.()
    const promise = resumeWorkflowRun({
      runId: durable.runId,
      projectRoot,
      stepId,
      tailOutput,
      eventSink: (event) => {
        if (event.type === 'stdout') {
          const bounded = appendBounded(run.stdout, event.text || '')
          run.stdout = bounded.text
          run.stdoutDropped += bounded.dropped
          recordStepStatusEvents(run)
        }
        if (event.type === 'stderr') {
          const bounded = appendBounded(run.stderr, event.text || '')
          run.stderr = bounded.text
          run.stderrDropped += bounded.dropped
        }
        if (event.type === 'started') recordEvent(run, 'started', { command: event.command || run.command, flowId })
        else if (event.type === 'stdout') recordEvent(run, 'stdout', { text: event.text || '' })
        else if (event.type === 'stderr') recordEvent(run, 'stderr', { text: event.text || '' })
        else if (event.type === 'error') recordEvent(run, 'error', { message: event.message || '' })
      },
    })
    promise.then((result) => {
      run.exitCode = result.exitCode
      run.signal = result.signal
      run.status = result.status
      run.exitedAt = result.exitedAt
      run.durationMs = result.durationMs
      run.stdout = result.stdout
      run.stderr = result.stderr
      run.cancellable = false
      if (run.stepStatusTimer) clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
      liveRunRegistry.clearWorkflow(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal, durationMs: run.durationMs })
      endClients(run.clients)
      liveRunRegistry.evictFinishedRuns()
    }).catch((error) => {
      const message = error?.message || String(error)
      run.status = 'failed'
      run.exitedAt = new Date().toISOString()
      run.exitCode = 1
      const bounded = appendBounded(run.stderr, `${message}\n`)
      run.stderr = bounded.text
      run.stderrDropped += bounded.dropped
      if (run.stepStatusTimer) clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
      liveRunRegistry.clearWorkflow(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'error', { message })
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal })
      endClients(run.clients)
      liveRunRegistry.evictFinishedRuns()
    })
    return run
  }

  function publicRun(run) {
    const durableRunId = resolveActiveDurableRunId(run.id) || run.runId || extractDurableRunId(`${run.stdout || ''}\n${run.stderr || ''}`)
    if (durableRunId) bindLiveRunToDurableId(run, durableRunId)
    const durable = durableRunId ? durableRunStateForId(durableRunId) : null
    const status = String(durable?.status || run.status || '')
    const durableFlow = durable?.flow && typeof durable.flow === 'object' && !Array.isArray(durable.flow)
      ? /** @type {Record<string, unknown>} */ (durable.flow)
      : null
    const flowTitle = typeof durable?.flowTitle === 'string'
      ? durable.flowTitle
      : typeof durableFlow?.title === 'string'
        ? durableFlow.title
        : ''
    return {
      id: run.id,
      runId: durableRunId || '',
      flowId: run.flowId,
      flowTitle,
      status,
      command: run.command,
      startedAt: run.startedAt,
      exitedAt: run.exitedAt,
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
      stdoutDropped: run.stdoutDropped || 0,
      stderrDropped: run.stderrDropped || 0,
      truncated: (run.stdoutDropped || 0) > 0 || (run.stderrDropped || 0) > 0,
      eventCount: run.events.length,
      cancellable: run.cancellable === true && !isTerminalRunStatus(status),
    }
  }

  function listPublicActiveRuns() {
    return liveRunRegistry
      .listRawRuns()
      .map(publicRun)
      .filter((run) => !String(run.id || '').startsWith('pending-'))
  }

  function durableRunStateForId(id) {
    return runStore.getRunState(id)
  }

  /** @param {string} id @param {string} view */
  function durableRunStateForRequest(id, view) {
    const requestedId = safeDecode(id)
    const active = liveRunRegistry.getRawRun(requestedId)
    const candidates = [requestedId, String(active?.runId || '')].filter(Boolean)
    const seen = new Set()
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const durable = refreshDurableRunState(durableRunStateForId(candidate), view)
      if (durable) return durable
    }
    return null
  }

  /** @param {Record<string, unknown> | null} durable @param {string} view */
  function refreshDurableRunState(durable, view) {
    if (!durable) return durable
    if (typeof runStore.refreshRunStateIfNeeded === 'function') {
      return runStore.refreshRunStateIfNeeded(durable, { view })
    }
    return durable
  }

  return {
    token,
    // Cancels every active workflow child, ends SSE clients, and clears timers so
    // server shutdown does not leak child processes or open connections.
    shutdown() {
      liveRunRegistry.shutdown()
    },
    async handle(req, res) {
      try {
        assertAllowedHost(req, bindHost)
        const base = `http://${req.headers.host || '127.0.0.1'}`
        const requestUrl = new URL(req.url || '/', base)
        const pathname = requestUrl.pathname

        if (isHonoDashboardApiPath(req.method, pathname)) {
          await handleHonoRequest(readOnlyApi, req, res, base)
          return
        }

        if (pathname === '/api/health') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          /** @type {'local' | 'desktop' | 'web'} */
          const deploymentMode = ['local', 'desktop', 'web'].includes(String(env.NAX_DASHBOARD_DEPLOYMENT_MODE || ''))
            ? /** @type {'local' | 'desktop' | 'web'} */ (String(env.NAX_DASHBOARD_DEPLOYMENT_MODE))
            : 'local'
          /** @type {{ deploymentMode: 'local' | 'desktop' | 'web', canStartRuns: boolean, canDryRun: boolean, canOpenLocalFiles: boolean, canStreamRunEvents: boolean, requiresAuth: boolean }} */
          const capabilities = {
            deploymentMode,
            canStartRuns: deploymentMode !== 'web' || String(env.NAX_DASHBOARD_WEB_CAN_START_RUNS || '') === '1',
            canDryRun: deploymentMode !== 'web' || String(env.NAX_DASHBOARD_WEB_CAN_DRY_RUN || '') === '1',
            canOpenLocalFiles: deploymentMode !== 'web',
            canStreamRunEvents: true,
            requiresAuth: true,
          }
          /** @type {{ ok: boolean, tokenRequiredForMutations: boolean, tokenRequiredForSensitiveReads: boolean, capabilities: typeof capabilities, projectRoot?: string }} */
          const health = {
            ok: true,
            tokenRequiredForMutations: true,
            tokenRequiredForSensitiveReads: true,
            capabilities,
          }
          if (timingSafeTokenEqual(tokenFromRequest(req, requestUrl), token)) health.projectRoot = projectRoot
          jsonResponse(res, 200, health, sessionBootstrapHeadersForRequest(req, requestUrl, token))
          return
        }

        if (pathname === '/api/workflows') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const flows = await listFlows(flowOptions)
          jsonResponse(res, 200, {
            count: flows.length,
            items: flows.map(publicFlow),
          }, sessionBootstrapHeadersForRequest(req, requestUrl, token))
          return
        }

        if (pathname === '/api/runs') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const durablePage = paginatedDurableRuns(projectRoot, {
            limit: requestUrl.searchParams.get('limit') || '',
            cursor: requestUrl.searchParams.get('cursor') || '',
          })
          const durableRuns = durablePage.items.map(publicRunState)
          jsonResponse(res, 200, {
            runs: overlayLiveOnlyRuns({
              durableRuns,
              liveRuns: listPublicActiveRuns(),
              pagination: durablePage.pagination,
              hasDurableRun: (id) => Boolean(durableRunStateForId(id)),
            }),
            pagination: durablePage.pagination,
          })
          return
        }

        if (pathname === '/api/files/open') {
          if (req.method !== 'POST') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const body = await readJsonBody(req)
          const openedPath = await openLocalFile(body.path, { projectRoot })
          jsonResponse(res, 200, { opened: true, path: openedPath })
          return
        }

        const runEventsJsonMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events\.json$/)
        if (runEventsJsonMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const runId = safeDecode(runEventsJsonMatch[1])
          const replay = eventStream.replayEvents({
            runId,
            since: Number(requestUrl.searchParams.get('since') || 0),
          })
          if (!replay.ok) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          jsonResponse(res, 200, {
            run: replay.run,
            events: replay.events || [],
            errors: replay.errors || [],
          })
          return
        }

        const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
        if (runEventsMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const runId = safeDecode(runEventsMatch[1])
          const replay = eventStream.streamEvents({
            req,
            res,
            runId,
            since: Number(requestUrl.searchParams.get('since') || 0),
          })
          if (!replay.ok) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          return
        }

        const runGraphMatch = pathname.match(/^\/api\/runs\/([^/]+)\/graph$/)
        if (runGraphMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const durable = durableRunStateForRequest(runGraphMatch[1], 'graph')
          if (!durable) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          let flow
          try {
            flow = await loadFlow(durable.flowId, flowOptions)
          } catch (_err) {
            flow = durable.flow && Array.isArray(durable.flow.steps) ? durable.flow : null
          }
          if (!flow) {
            notFound(res, `Unknown flow "${durable.flowId}".`)
            return
          }
          jsonResponse(res, 200, {
            run: {
              ...publicRunState(durable),
              options: publicRunOptions(durable),
            },
            workflow: publicFlow(flow),
            graph: flowToGraph({ flow, runState: durable }),
          })
          return
        }

        const runDetailsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/details$/)
        if (runDetailsMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const durable = durableRunStateForRequest(runDetailsMatch[1], 'details')
          if (!durable) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          let flow
          try {
            flow = await loadFlow(durable.flowId, flowOptions)
          } catch (_err) {
            flow = durable.flow && Array.isArray(durable.flow.steps) ? durable.flow : null
          }
          jsonResponse(res, 200, {
            run: {
              ...publicRunState(durable),
              options: publicRunOptions(durable),
            },
            details: buildRunDetails(durable, { flow }),
          })
          return
        }

        const reviewApproveMatch = pathname.match(/^\/api\/runs\/([^/]+)\/review\/approve$/)
        if (reviewApproveMatch) {
          if (req.method !== 'POST') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const durable = durableRunStateForId(reviewApproveMatch[1])
          if (!durable) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          const body = await readJsonBody(req)
          const gate = findReviewStep(durable, String(body.stepId || ''))
          if (!gate) throw requestError(409, 'no_review_gate', 'No human review gate is awaiting approval for this workflow.')
          const run = startResumeRun({ durable, stepId: gate.id || '' })
          jsonResponse(res, 202, {
            run: publicRun(run),
            approved: true,
            stepId: gate.id || '',
          })
          return
        }

        const reviewCancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/review\/cancel$/)
        if (reviewCancelMatch) {
          if (req.method !== 'POST') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const durable = durableRunStateForId(reviewCancelMatch[1])
          if (!durable) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          const body = await readJsonBody(req)
          jsonResponse(res, 200, cancelReviewGateService({ runState: durable, body }))
          return
        }

        const runFollowupsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/followups$/)
        if (runFollowupsMatch) {
          if (req.method !== 'POST') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const sourceRunId = safeDecode(runFollowupsMatch[1])
          const durable = durableRunStateForId(sourceRunId)
          if (!durable) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          const body = await readJsonBody(req)
          const followup = await submitFollowupService({
            projectRoot,
            sourceRunId,
            durable,
            body,
            env,
            followupSiteId,
            followupSiteName,
            followupNetlifyFilter,
            followupSubmitRun,
            writeBlob: followupWriteBlob,
            normalizeFollowupRequest,
            makeBlobWriter: makeFollowupBlobWriter,
            setBlobCommand: followupSetBlob,
            linkSubmittedRun: linkSubmittedRunFactory,
            followupId,
            freshFollowupTitle,
            submissionResponseItem,
          })
          jsonResponse(res, 202, {
            followup,
          })
          return
        }

        const runFollowupCancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/followups\/cancel$/)
        if (runFollowupCancelMatch) {
          if (req.method !== 'POST') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const sourceRunId = safeDecode(runFollowupCancelMatch[1])
          const durable = durableRunStateForId(sourceRunId)
          if (!durable) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          const body = await readJsonBody(req)
          jsonResponse(res, 200, await cancelFollowupService({
            projectRoot,
            durable,
            body,
            env,
            stopRun: followupStopRun,
          }))
          return
        }

        const runCancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
        if (runCancelMatch) {
          if (req.method !== 'POST') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const requestedRunId = safeDecode(runCancelMatch[1])
          const run = liveRunRegistry.getRawRun(requestedRunId)
          const durable = durableRunStateForId(run?.runId || run?.id || requestedRunId)
          if (!run && !durable) {
            notFound(res, 'Unknown dashboard run.')
            return
          }
          jsonResponse(res, 200, await cancelRunService({
            run,
            durable,
            projectRoot,
            env,
            stopWorkflowRunners,
            stopRun: cancelStopRun,
            applyRemoteCancelToWorkflow,
            recordEvent,
            recordCancelSemantics,
            publicRun,
          }))
          return
        }

        const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
        if (runMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const requestedRunId = safeDecode(runMatch[1])
          const durable = durableRunStateForRequest(requestedRunId, 'detail')
          if (durable) {
            jsonResponse(res, 200, { run: publicRunState(durable) })
            return
          }
          const run = liveRunRegistry.getRawRun(requestedRunId)
          if (run) {
            jsonResponse(res, 200, { run: publicRun(run) })
            return
          }
          notFound(res, 'Unknown dashboard run.')
          return
        }

        const dryRunMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/dry-run$/)
        if (dryRunMatch) {
          if (req.method !== 'POST') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const id = safeDecode(dryRunMatch[1])
          const flow = await loadFlow(id, flowOptions)
          const body = await readJsonBody(req)
          const options = normalizeDryRunOptions(body, flow)
          const result = await dryRunWorkflow({ flowId: id, projectRoot, options, tailOutput })
          jsonResponse(res, result.exitCode === 0 ? 200 : 500, {
            workflow: publicFlow(flow),
            dryRun: result,
          })
          return
        }

        const startRunMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/runs$/)
        if (startRunMatch) {
          if (req.method !== 'POST') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const id = safeDecode(startRunMatch[1])
          const flow = await loadFlow(id, flowOptions)
          const body = await readJsonBody(req)
          const runOptions = normalizeDryRunOptions(body, flow)
          const run = startRun({ flowId: id, runOptions })
          jsonResponse(res, 202, {
            workflow: publicFlow(flow),
            run: publicRun(run),
          })
          return
        }

        const graphMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/graph$/)
        if (graphMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const id = safeDecode(graphMatch[1])
          const flow = await loadFlow(id, flowOptions)
          jsonResponse(res, 200, {
            workflow: publicFlow(flow),
            graph: flowToGraph({ flow }),
          }, sessionBootstrapHeadersForRequest(req, requestUrl, token))
          return
        }

        const workflowMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/)
        if (workflowMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const id = safeDecode(workflowMatch[1])
          const flow = await loadFlow(id, flowOptions)
          jsonResponse(res, 200, publicFlow(flow), sessionBootstrapHeadersForRequest(req, requestUrl, token))
          return
        }

        if (!pathname.startsWith('/api/')) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          const staticFile = staticFileForPath(distDir, pathname)
          if (staticFile) {
            let body
            try {
              body = fs.readFileSync(staticFile)
            } catch (error) {
              const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
              if (code === 'ENOENT') {
                notFound(res, 'Static asset not found.')
                return
              }
              if (code === 'EACCES' || code === 'EPERM') {
                jsonResponse(res, 403, errorPayload(403, 'forbidden', 'Static asset is not readable.'))
                return
              }
              throw error
            }
            res.writeHead(200, {
              ...securityHeaders(),
              ...sessionBootstrapHeadersForRequest(req, requestUrl, token),
              'content-type': contentTypeFor(staticFile),
              'content-length': body.length,
            })
            res.end(body)
            return
          }
        }

        if (pathname === '/' || pathname === '/index.html') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          textResponse(res, 200, defaultIndexHtml({ token, initialWorkflow }), 'text/html; charset=utf-8', sessionBootstrapHeadersForRequest(req, requestUrl, token))
          return
        }

        notFound(res)
      } catch (error) {
        const message = error?.message || String(error)
        if (error?.statusCode) {
          jsonResponse(res, error.statusCode, errorPayload(error.statusCode, error.code || 'request_error', message))
          return
        }
        if (/^Unknown flow /.test(message)) {
          notFound(res, message)
          return
        }
        jsonResponse(res, 500, errorPayload(500, 'internal_error', message))
      }
    },
  }
}

function startDashboardServer(options = {}) {
  const host = options.host || '127.0.0.1'
  const port = normalizePort(options.port)
  const handler = createRequestHandler(options)
  const server = http.createServer((req, res) => {
    handler.handle(req, res)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      const params = new URLSearchParams({ token: handler.token })
      if (options.initialWorkflow) params.set('workflow', options.initialWorkflow)
      const initialPath = dashboardInitialPath(options.initialPath)
      const url = `http://${host}:${actualPort}${initialPath}?${params.toString()}`
      resolve({
        server,
        host,
        port: actualPort,
        token: handler.token,
        url,
        projectRoot: path.resolve(options.projectRoot || process.cwd()),
        close: () => new Promise((closeResolve, closeReject) => {
          try { handler.shutdown() } catch (_err) { /* best-effort cleanup */ }
          server.close((error) => (error ? closeReject(error) : closeResolve()))
        }),
      })
    })
  })
}

module.exports = {
  _private: {
    appendBounded,
    appendDurableWorkflowEvent,
    applyRemoteCancelToWorkflow,
    broadcastEvent,
    cancellableWorkflowRunnerIds,
    stopWorkflowRunners,
    createRunnerEventParser,
    defaultIndexHtml,
    dashboardInitialPath,
    endClients,
    evictFinishedRuns,
    extractDurableRunId,
    durableRunIdFromActiveRunStates,
    htmlEscape,
    projectedWorkflowActivity,
    readJsonBody,
    securityHeaders,
    sessionCookieHeader,
    timingSafeTokenEqual,
    registerSseClient,
    shutdownRuns,
    stepStatusSnapshot,
    MAX_LIVE_EVENTS,
    MAX_LIVE_OUTPUT_CHARS,
    MAX_FINISHED_RUNS,
  },
  createRequestHandler,
  publicFlow,
  startDashboardServer,
}
