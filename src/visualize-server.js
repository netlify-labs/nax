const crypto = require('crypto')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { URL } = require('url')

const { listFlows, loadFlow } = require('./flows')
const { isUnfinishedRun, listRunStates, saveRunState } = require('./run-state')
const { flowToGraph } = require('./visualize-graph')
const { resumeWorkflow, runWorkflow, workflowCommand } = require('./workflow-runner')
const { normalizeAgentList, normalizeStepModels, selectionValidationErrors } = require('./agent-selection')
const { buildRunDetails } = require('./visualize-run-details')
const { appendEventLog, eventLogPathForRunState, readEventLog } = require('./runner-event-log')
const { formatAgentRunUrl } = require('./agent-run-results')
const { buildFollowupContextPackage } = require('./followup-context')
const { prepareFollowupContextDelivery } = require('./followup-delivery')
const { buildFollowupSubmissionPlan } = require('./followup-plan')
const { buildFollowupPrompt, submitFollowupPlan } = require('./handoff-runner')
const { appendFollowupRunsToWorkflow, cancelFollowupRunInWorkflow, persistFreshPseudoWorkflow, syncSubmittedFollowupRunsToWorkflow } = require('./followup-persistence')
const { cancelHumanReviewGate, findReviewStep } = require('./human-review')
const { archiveAgentRun, stopAgentRun } = require('./local-runner')
const { setBlob } = require('./netlify-blobs')
const { readLinkedSiteId } = require('./init')
const { isCancelledRunStatus, isFailedRunStatus, isTerminalRunStatus } = require('./status')

const SESSION_COOKIE_NAME = 'nax_visualize_token'

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

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  }
}

function errorPayload(statusCode, code, message) {
  return {
    error: {
      statusCode,
      code,
      message,
    },
  }
}

/**
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 * @returns {Error & { statusCode: number, code: string }}
 */
function requestError(statusCode, code, message) {
  const error = /** @type {Error & { statusCode: number, code: string }} */ (new Error(message))
  error.statusCode = statusCode
  error.code = code
  return error
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch (_err) {
    return value
  }
}

// Live-run memory caps: the durable event log on disk is the source of truth for
// full history; the in-memory window is bounded so long/verbose runs cannot grow
// the visualize process without limit.
const MAX_LIVE_OUTPUT_CHARS = 512 * 1024
const MAX_LIVE_EVENTS = 2000
const MAX_FINISHED_RUNS = 50

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Appends to a live output string while keeping only the most recent maxChars,
// reporting how many leading characters were dropped so callers can flag truncation.
function appendBounded(existing, addition, maxChars = MAX_LIVE_OUTPUT_CHARS) {
  const combined = `${existing}${addition}`
  if (combined.length <= maxChars) return { text: combined, dropped: 0 }
  const dropped = combined.length - maxChars
  return { text: combined.slice(dropped), dropped }
}

// Writes an event to every SSE client, dropping any client whose write throws so
// a flaky/half-closed connection cannot surface an unhandled stream error.
function broadcastEvent(clients, text) {
  for (const client of clients) {
    try {
      client.write(text)
    } catch (_err) {
      clients.delete(client)
      try { client.end() } catch (_endErr) { /* already torn down */ }
    }
  }
}

// Ends every SSE client and clears the set, tolerating already-closed responses.
function endClients(clients) {
  for (const client of clients) {
    try { client.end() } catch (_err) { /* already torn down */ }
  }
  clients.clear()
}

// Registers an SSE response as a client of run, de-registering on both close and
// error so a client that errors out can never crash the broadcast loop.
function registerSseClient(run, req, res) {
  run.clients.add(res)
  const drop = () => run.clients.delete(res)
  req.on('close', drop)
  res.on('error', drop)
}

// Cancels every active workflow child, clears its status timer, and ends its SSE
// clients so server shutdown leaves no child processes or open connections behind.
function shutdownRuns(runs) {
  for (const run of runs.values()) {
    if (run.stepStatusTimer) {
      clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
    }
    if (typeof run.cancel === 'function') {
      try { run.cancel() } catch (_err) { /* child already gone */ }
    }
    endClients(run.clients)
  }
}

// Evicts the oldest finished runs from the in-memory map once the finished count
// exceeds maxFinished; durable run state on disk remains the record.
function evictFinishedRuns(runs, maxFinished = MAX_FINISHED_RUNS) {
  const finished = [...runs.values()].filter((run) => run.status !== 'running')
  if (finished.length <= maxFinished) return
  finished
    .sort((a, b) => String(a.exitedAt || '').localeCompare(String(b.exitedAt || '')))
    .slice(0, finished.length - maxFinished)
    .forEach((run) => runs.delete(run.id))
}

function publicFlow(flow = {}) {
  return {
    id: flow.id || '',
    title: flow.title || '',
    description: flow.description || '',
    source: flow.source || '',
    sourceLabel: flow.sourceLabel || '',
    sourceDir: flow.sourceDir || '',
    sourcePriority: flow.sourcePriority ?? null,
    dir: flow.dir || '',
    file: flow.file || '',
    defaults: flow.defaults || {},
    options: flow.options || {},
    steps: Array.isArray(flow.steps)
      ? flow.steps.map((step) => ({
        id: step.id || '',
        title: step.title || '',
        description: step.description || '',
        prompt: step.prompt || '',
        type: step.type || '',
        action: step.action || '',
        submit: step.submit || '',
        agents: Array.isArray(step.agents) ? step.agents : [],
        input: Array.isArray(step.input) ? step.input : [],
        waitFor: step.waitFor || '',
        review: step.review || null,
        autoArchive: step.autoArchive,
        isArchivable: step.isArchivable,
      }))
      : [],
  }
}

function notFound(res, message = 'Not found') {
  jsonResponse(res, 404, errorPayload(404, 'not_found', message))
}

function methodNotAllowed(res, method) {
  jsonResponse(res, 405, errorPayload(405, 'method_not_allowed', `Method ${method} is not allowed for this endpoint.`))
}

function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let body = ''
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (settled) return
      body += chunk
      if (body.length > maxBytes) {
        // Stop reading and surface a typed error so the route catch can write a
        // structured 413 — destroying the socket here would reset the connection
        // before any HTTP response could be sent.
        req.pause()
        settle(reject, requestError(413, 'payload_too_large', 'Request body is too large.'))
      }
    })
    req.on('end', () => {
      if (!body.trim()) {
        settle(resolve, {})
        return
      }
      try {
        settle(resolve, JSON.parse(body))
      } catch (_err) {
        settle(reject, requestError(400, 'invalid_json', 'Request body must be valid JSON.'))
      }
    })
    req.on('error', (error) => settle(reject, error))
  })
}

function isInsideDir(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath)
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

async function openLocalFile(filePath, { projectRoot }) {
  const absoluteFilePath = path.resolve(String(filePath || ''))
  const absoluteProjectRoot = path.resolve(projectRoot)
  if (!isInsideDir(absoluteProjectRoot, absoluteFilePath)) {
    throw requestError(403, 'forbidden_path', 'Only paths under the current project root can be opened.')
  }
  if (!fs.existsSync(absoluteFilePath)) {
    throw requestError(404, 'path_not_found', 'Path not found.')
  }
  const stat = fs.statSync(absoluteFilePath)
  if (!stat.isFile() && !stat.isDirectory()) {
    throw requestError(400, 'unsupported_path', 'Path is not a file or directory.')
  }
  const openFile = (await import('open')).default
  await openFile(absoluteFilePath)
  return absoluteFilePath
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

/** @param {{ projectRoot?: string, siteId?: string, env?: NodeJS.ProcessEnv, writeBlob?: ((input: { ref: Record<string, any>, payload: string }) => any) | null, setBlobCommand?: typeof setBlob }} [input] */
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

function timingSafeTokenEqual(provided, expected) {
  if (!provided || !expected) return false
  const providedDigest = crypto.createHash('sha256').update(String(provided)).digest()
  const expectedDigest = crypto.createHash('sha256').update(String(expected)).digest()
  return crypto.timingSafeEqual(providedDigest, expectedDigest)
}

function tokenFromRequest(req) {
  const raw = req.headers['x-nax-token']
  const headerToken = Array.isArray(raw) ? raw[0] : raw
  if (headerToken) return headerToken
  return cookieValue(req, SESSION_COOKIE_NAME)
}

function assertToken(req, _requestUrl, token) {
  const provided = tokenFromRequest(req)
  if (!timingSafeTokenEqual(provided, token)) {
    throw requestError(401, 'unauthorized', 'A valid visualize session token is required.')
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
    throw requestError(403, 'forbidden_host', 'The Host header is not allowed for this visualize server.')
  }
}

function cookieValue(req, name) {
  const header = String(req.headers.cookie || '')
  for (const part of header.split(';')) {
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

function sessionCookieHeader(token) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(String(token || ''))}; Path=/; HttpOnly; SameSite=Strict`
}

function sessionBootstrapHeaders(token) {
  return { 'set-cookie': sessionCookieHeader(token) }
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
    '  <title>Nax Visualize</title>',
    '  <style>',
    '    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #111827; }',
    '    main { max-width: 720px; margin: 12vh auto; padding: 0 24px; line-height: 1.5; }',
    '    code { background: #e5e7eb; border-radius: 4px; padding: 2px 5px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>Nax Visualize</h1>',
    '    <p>The visualize API is running. Build the web UI with <code>npm run visualize:build</code> to serve the full workbench.</p>',
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
    throw new Error(`Invalid visualize port: ${port}`)
  }
  return parsed
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

function runDryRunCommand({ flowId, projectRoot, options, tailOutput = false }) {
  return runWorkflow({
    flowId,
    projectRoot,
    options,
    dryRun: true,
    passthrough: tailOutput,
  })
}

/**
 * @typedef {(event: Record<string, unknown>) => void} VisualizeEventSink
 * @typedef {{ code?: string, message: string, line?: number, text?: string }} RunnerEventParseError
 */

/**
 * @param {{ flowId: string, projectRoot: string, options?: Record<string, unknown>, eventSink?: VisualizeEventSink, tailOutput?: boolean }} input
 */
function runWorkflowChild({ flowId, projectRoot, options = {}, eventSink = () => {}, tailOutput = false }) {
  const command = workflowCommand({ flowId, projectRoot, options })
  const args = [path.resolve(__dirname, '..', 'bin', 'nax.js'), ...command.slice(1)]
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let stdoutDropped = 0
  let stderrDropped = 0
  let cancelRequested = false
  let settled = false
  let runnerTerminalStatus = ''
  let forceKillTimer = null
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {
    ...process.env,
    FORCE_COLOR: process.env.FORCE_COLOR || '1',
    NAX_EVENT_FD: '3',
    NAX_EVENT_STREAM: 'jsonl',
  }
  delete childEnv.NO_COLOR

  eventSink({ type: 'started', command, flowId })
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })

  if (child.stdout) child.stdout.setEncoding('utf8')
  if (child.stderr) child.stderr.setEncoding('utf8')
  child.stdout.on('data', (text) => {
    const bounded = appendBounded(stdout, text)
    stdout = bounded.text
    stdoutDropped += bounded.dropped
    if (tailOutput) process.stdout.write(text)
    eventSink({ type: 'stdout', text })
  })
  child.stderr.on('data', (text) => {
    const bounded = appendBounded(stderr, text)
    stderr = bounded.text
    stderrDropped += bounded.dropped
    if (tailOutput) process.stderr.write(text)
    eventSink({ type: 'stderr', text })
  })
  const eventParser = createRunnerEventParser({
    onEvent: (event) => {
      if (event?.type === 'workflow_awaiting_review') runnerTerminalStatus = 'awaiting_review'
      eventSink({ type: 'runner_event', event })
    },
    onError: (error) => eventSink({
      type: 'runner_event_error',
      message: error.message,
      line: error.line || '',
      code: error.code || 'runner_event_error',
      text: error.text || '',
    }),
  })
  /** @type {import('node:stream').Readable | undefined} */
  const eventStream = child.stdio?.[3] && 'setEncoding' in child.stdio[3]
    ? /** @type {import('node:stream').Readable} */ (child.stdio[3])
    : undefined
  if (eventStream) {
    eventStream.setEncoding('utf8')
    eventStream.on('data', (chunk) => eventParser.push(chunk))
    eventStream.on('end', () => eventParser.end())
    eventStream.on('error', (error) => {
      eventSink({
        type: 'runner_event_error',
        message: error?.message || String(error),
        code: 'runner_event_stream_error',
      })
    })
  }

  const promise = new Promise((resolve) => {
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (forceKillTimer) clearTimeout(forceKillTimer)
      const message = error?.message || String(error)
      const bounded = appendBounded(stderr, `${message}\n`)
      stderr = bounded.text
      stderrDropped += bounded.dropped
      eventSink({ type: 'stderr', text: `${message}\n` })
      eventSink({ type: 'error', message })
      const result = {
        status: 'failed',
        command,
        startedAt,
        exitedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        exitCode: 1,
        signal: null,
        stdout,
        stderr,
        stdoutDropped,
        stderrDropped,
      }
      eventSink({ type: 'exited', status: result.status, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs })
      resolve(result)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (forceKillTimer) clearTimeout(forceKillTimer)
      const status = code === 0 ? runnerTerminalStatus || 'completed' : cancelRequested ? 'cancelled' : 'failed'
      const result = {
        status,
        command,
        startedAt,
        exitedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        stdout,
        stderr,
        stdoutDropped,
        stderrDropped,
      }
      if (status === 'failed') {
        const message = stderr.trim().split('\n').filter(Boolean).pop() || `Workflow "${flowId}" failed.`
        eventSink({ type: 'error', message })
      }
      eventParser.end()
      eventSink({ type: 'exited', status: result.status, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs })
      resolve(result)
    })
  })

  return {
    command,
    promise,
    cancel() {
      if (settled || child.killed) return false
      cancelRequested = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 3000)
      return true
    },
  }
}

/**
 * @param {{ onEvent?: (event: Record<string, unknown>) => void, onError?: (error: RunnerEventParseError) => void }} [handlers]
 */
function createRunnerEventParser({ onEvent = () => {}, onError = () => {} } = {}) {
  let buffer = ''
  let lineNumber = 0
  let ended = false

  function parseLine(line) {
    lineNumber += 1
    if (!line.trim()) return
    try {
      const event = JSON.parse(line)
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        onError({
          code: 'invalid_runner_event',
          message: 'Runner event line is not a JSON object.',
          line: lineNumber,
          text: line,
        })
        return
      }
      if (!event.type) {
        onError({
          code: 'missing_runner_event_type',
          message: 'Runner event is missing a type.',
          line: lineNumber,
          text: line,
        })
        return
      }
      onEvent(event)
    } catch (error) {
      onError({
        code: 'parse_runner_event',
        message: error?.message || String(error),
        line: lineNumber,
        text: line,
      })
    }
  }

  return {
    push(chunk) {
      if (ended) return
      buffer += String(chunk || '')
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        parseLine(line)
        index = buffer.indexOf('\n')
      }
    },
    end() {
      if (ended) return
      ended = true
      if (!buffer) return
      const line = buffer.replace(/\r$/, '')
      buffer = ''
      parseLine(line)
    },
  }
}

function publicRunState(runState = {}) {
  const summaryPath = runState.dir ? path.join(runState.dir, 'artifacts', 'summary.md') : ''
  return {
    runId: runState.runId || '',
    flowId: runState.flowId || '',
    flowTitle: runState.flowTitle || '',
    status: runState.status || inferRunStateStatus(runState),
    transport: runState.transport || '',
    branch: runState.branch || '',
    target: runState.target || null,
    createdAt: runState.createdAt || '',
    updatedAt: runState.updatedAt || '',
    dir: runState.dir || '',
    summaryPath,
    resumable: isUnfinishedRun(runState),
    steps: Array.isArray(runState.steps) ? runState.steps : [],
  }
}

function inferRunStateStatus(runState = {}) {
  const steps = Array.isArray(runState.steps) ? runState.steps : []
  if (steps.length === 0) return ''

  const statuses = steps.map((step) => String(step?.status || '').toLowerCase()).filter(Boolean)
  if (statuses.some((status) => isFailedRunStatus(status))) {
    return 'failed'
  }
  if (statuses.some((status) => isCancelledRunStatus(status))) return 'cancelled'
  if (runState?.status === 'awaiting_review' || statuses.some((status) => status === 'awaiting_review')) {
    return 'awaiting_review'
  }
  if (statuses.length === steps.length && statuses.every((status) => ['complete', 'completed', 'dry-run'].includes(status))) {
    return 'completed'
  }
  if (statuses.some((status) => ['running', 'submitted', 'submitting', 'pending', 'waiting', 'retrying', 'queued'].includes(status))) {
    return 'running'
  }
  return statuses[statuses.length - 1] || ''
}

function publicRunOptions(runState = {}) {
  const options = runState.options || {}
  return {
    branch: options.branch || runState.branch || '',
    target: runState.target || options.target || null,
    transport: options.transport || runState.transport || '',
    models: normalizeAgentList(options.models),
    stepModels: normalizeStepModels(options.stepModels),
    context: options.context || '',
    step: options.step || '',
    fromStep: options.fromStep || '',
  }
}

function stepStatusSnapshot(runState = {}) {
  return (Array.isArray(runState.steps) ? runState.steps : [])
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

/** @param {Record<string, any>} param0 */
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

function applyRemoteCancelToWorkflow(runState = {}, remoteCancel = {}, { reason = 'cancelled from visualizer' } = {}) {
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

function eventText(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function eventAfter(event, since = 0) {
  const minimum = Number.isFinite(Number(since)) ? Number(since) : 0
  const seq = Number(event?.seq ?? event?.id ?? 0)
  return seq > minimum
}

function extractDurableRunId(output = '') {
  const stateMatch = String(output).match(/(?:^|\n)State:\s+(.+?\.nax\/workflows\/([^/\n]+)\/workflow\.json)(?:\n|$)/)
  if (stateMatch?.[2]) return stateMatch[2]
  const runMatch = String(output).match(/(?:^|\n)Run\s+([^\s\n]+)(?:\n|$)/)
  return runMatch?.[1] || ''
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
  const indexPath = path.join(distDir, 'index.html')
  if (fs.existsSync(indexPath)) return indexPath
  return ''
}

function createRequestHandler(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const bindHost = options.host || '127.0.0.1'
  const distDir = options.distDir || path.resolve(__dirname, '..', 'web', 'dist')
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
  const runs = new Map()
  const activeByWorkflow = new Map()

  function recordEvent(run, type, data = {}) {
    run.eventSeq = (run.eventSeq || 0) + 1
    const event = {
      type,
      at: new Date().toISOString(),
      runId: run.id,
      ...data,
      // monotonic id/seq last so a bounded events window never reuses ids
      id: run.eventSeq,
      seq: run.eventSeq,
    }
    run.events.push(event)
    if (run.events.length > MAX_LIVE_EVENTS) run.events.shift()
    broadcastEvent(run.clients, eventText(event))
    return event
  }

  function recordRunnerEvent(run, event = {}) {
    if (event.type === 'workflow_started' && event.runId) run.runId = event.runId
    if (event.runId && !run.runId) run.runId = event.runId
    return recordEvent(run, event.type || 'runner_event', event)
  }

  function recordStepStatusEvents(run) {
    const durable = durableRunStateForId(run.runId || run.id)
    if (!durable) return
    run.stepStatuses ||= {}
    for (const step of stepStatusSnapshot(durable)) {
      const previous = run.stepStatuses[step.stepId]
      if (previous === step.status) continue
      run.stepStatuses[step.stepId] = step.status
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

  function startRun({ flowId, runOptions }) {
    const existingRunId = activeByWorkflow.get(flowId)
    if (existingRunId) {
      const existing = runs.get(existingRunId)
      if (existing && existing.status === 'running') {
        throw requestError(409, 'duplicate_run', `Workflow "${flowId}" already has an active visualize run.`)
      }
      activeByWorkflow.delete(flowId)
    }

    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${flowId}`
    const run = {
      id,
      runId: '',
      flowId,
      status: 'running',
      command: workflowCommand({ flowId, projectRoot, options: runOptions }),
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
    }
    runs.set(id, run)
    activeByWorkflow.set(flowId, id)
    run.stepStatusTimer = setInterval(() => {
      if (run.status === 'running') recordStepStatusEvents(run)
    }, 1000)
    run.stepStatusTimer.unref?.()
    const childRun = runWorkflowChild({
      flowId,
      projectRoot,
      options: runOptions,
      tailOutput,
      eventSink: (event) => {
        if (event.type === 'stdout') {
          const bounded = appendBounded(run.stdout, event.text || '')
          run.stdout = bounded.text
          run.stdoutDropped += bounded.dropped
          if (!run.runId) run.runId = extractDurableRunId(run.stdout)
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
          recordRunnerEvent(run, event.event || {})
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
      run.runId = run.runId || extractDurableRunId(`${result.stdout || ''}\n${result.stderr || ''}`)
      run.cancellable = false
      run.cancel = null
      if (run.stepStatusTimer) clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
      activeByWorkflow.delete(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal, durationMs: run.durationMs })
      endClients(run.clients)
      evictFinishedRuns(runs)
    }).catch((error) => {
      const message = error?.message || String(error)
      run.status = 'failed'
      run.exitedAt = new Date().toISOString()
      run.exitCode = 1
      const bounded = appendBounded(run.stderr, `${message}\n`)
      run.stderr = bounded.text
      run.stderrDropped += bounded.dropped
      run.runId = run.runId || extractDurableRunId(`${run.stdout || ''}\n${run.stderr || ''}`)
      run.cancellable = false
      run.cancel = null
      if (run.stepStatusTimer) clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
      activeByWorkflow.delete(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'error', { message })
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal })
      endClients(run.clients)
      evictFinishedRuns(runs)
    })
    return run
  }

  function startResumeRun({ durable, stepId = '' }) {
    const flowId = durable.flowId || ''
    const existingRunId = activeByWorkflow.get(flowId)
    if (existingRunId) {
      const existing = runs.get(existingRunId)
      if (existing && existing.status === 'running') {
        throw requestError(409, 'duplicate_run', `Workflow "${flowId}" already has an active visualize run.`)
      }
      activeByWorkflow.delete(flowId)
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
    runs.set(id, run)
    activeByWorkflow.set(flowId, id)
    run.stepStatusTimer = setInterval(() => {
      if (run.status === 'running') recordStepStatusEvents(run)
    }, 1000)
    run.stepStatusTimer.unref?.()
    const promise = resumeWorkflow({
      runId: durable.runId,
      projectRoot,
      options: { projectRoot, stepId, reviewer: 'visualizer', yes: true, force: true },
      passthrough: tailOutput,
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
      activeByWorkflow.delete(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal, durationMs: run.durationMs })
      endClients(run.clients)
      evictFinishedRuns(runs)
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
      activeByWorkflow.delete(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'error', { message })
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal })
      endClients(run.clients)
      evictFinishedRuns(runs)
    })
    return run
  }

  function publicRun(run) {
    const durableRunId = run.runId || extractDurableRunId(`${run.stdout || ''}\n${run.stderr || ''}`)
    if (durableRunId && !run.runId) run.runId = durableRunId
    return {
      id: run.id,
      runId: durableRunId || '',
      flowId: run.flowId,
      status: run.status,
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
      cancellable: run.cancellable === true,
    }
  }

  function durableRunStateForId(id) {
    const decoded = safeDecode(id)
    const states = listRunStates(projectRoot)
    const exact = states.find((state) => state.runId === decoded)
    if (exact) return exact
    const active = runs.get(decoded)
    if (!active) return null
    const durableRunId = active.runId || extractDurableRunId(`${active.stdout || ''}\n${active.stderr || ''}`)
    if (!durableRunId) return null
    active.runId = durableRunId
    return states.find((state) => state.runId === durableRunId) || null
  }

  function syncDurableFollowups(durable) {
    if (!durable) return durable
    const synced = syncSubmittedFollowupRunsToWorkflow({
      runState: durable,
      projectRoot,
      env,
      runCommand: followupSyncRunCommand,
    })
    return synced.runState || durable
  }

  return {
    token,
    // Cancels every active workflow child, ends SSE clients, and clears timers so
    // server shutdown does not leak child processes or open connections.
    shutdown() {
      shutdownRuns(runs)
    },
    async handle(req, res) {
      try {
        assertAllowedHost(req, bindHost)
        const base = `http://${req.headers.host || '127.0.0.1'}`
        const requestUrl = new URL(req.url || '/', base)
        const pathname = requestUrl.pathname

        if (pathname === '/api/health') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          jsonResponse(res, 200, {
            ok: true,
            projectRoot,
            tokenRequiredForMutations: true,
            tokenRequiredForSensitiveReads: true,
          }, sessionBootstrapHeaders(token))
          return
        }

        if (pathname === '/api/workflows') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          const flows = await listFlows(flowOptions)
          jsonResponse(res, 200, {
            count: flows.length,
            items: flows.map(publicFlow),
          })
          return
        }

        if (pathname === '/api/runs') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const durable = listRunStates(projectRoot).map(publicRunState)
          jsonResponse(res, 200, {
            active: [...runs.values()].map(publicRun),
            durable,
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
          const run = runs.get(runId)
          const durable = run ? null : durableRunStateForId(runId)
          if (!run && !durable) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          const since = Number(requestUrl.searchParams.get('since') || 0)
          if (run) {
            jsonResponse(res, 200, {
              run: publicRun(run),
              events: run.events.filter((candidate) => eventAfter(candidate, since)),
              errors: [],
            })
            return
          }
          const replay = readEventLog(eventLogPathForRunState(durable), { since })
          jsonResponse(res, 200, {
            run: publicRunState(durable),
            events: replay.events,
            errors: replay.errors,
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
          const run = runs.get(runId)
          const durable = run ? null : durableRunStateForId(runId)
          if (!run && !durable) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          const since = Number(requestUrl.searchParams.get('since') || 0)
          res.writeHead(200, {
            ...securityHeaders(),
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          if (run) {
            for (const event of run.events.filter((candidate) => eventAfter(candidate, since))) {
              res.write(eventText(event))
            }
          } else if (durable) {
            const replay = readEventLog(eventLogPathForRunState(durable), { since })
            for (const event of replay.events) res.write(eventText(event))
            for (const error of replay.errors) {
              res.write(eventText({
                id: 0,
                type: 'runner_event_error',
                at: new Date().toISOString(),
                runId: durable.runId,
                ...error,
              }))
            }
          }
          if (run && run.status === 'running') {
            registerSseClient(run, req, res)
          } else {
            res.end()
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
          const durable = syncDurableFollowups(durableRunStateForId(runGraphMatch[1]))
          if (!durable) {
            notFound(res, 'Unknown visualize run.')
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
          const durable = syncDurableFollowups(durableRunStateForId(runDetailsMatch[1]))
          if (!durable) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          let flow
          try {
            flow = await loadFlow(durable.flowId, flowOptions)
          } catch (_err) {
            flow = durable.flow && Array.isArray(durable.flow.steps) ? durable.flow : null
          }
          jsonResponse(res, 200, {
            run: publicRunState(durable),
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
            notFound(res, 'Unknown visualize run.')
            return
          }
          const body = await readJsonBody(req)
          const gate = findReviewStep(durable, body.stepId || '')
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
            notFound(res, 'Unknown visualize run.')
            return
          }
          const body = await readJsonBody(req)
          const next = cancelHumanReviewGate({
            runState: durable,
            stepId: body.stepId || '',
            reviewer: 'visualizer',
            reason: body.reason || 'cancelled by reviewer',
          })
          jsonResponse(res, 200, {
            run: publicRunState(next),
            cancelled: true,
          })
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
            notFound(res, 'Unknown visualize run.')
            return
          }
          const body = await readJsonBody(req)
          const details = buildRunDetails(durable)
          const normalized = normalizeFollowupRequest(body, details, durable)
          const contextPackage = buildFollowupContextPackage({
            projectRoot,
            details,
            artifacts: normalized.artifacts,
          })
          const delivery = await prepareFollowupContextDelivery({
            contextPackage,
            runId: durable.runId || sourceRunId,
            stepId: 'visualizer-followup',
            options: durable.options || {},
            writeBlob: makeFollowupBlobWriter({
              projectRoot,
              siteId: followupSiteId,
              env,
              writeBlob: followupWriteBlob,
              setBlobCommand: followupSetBlob,
            }),
          })
          const sourceArtifactIds = contextPackage.artifacts.map((artifact) => artifact.id)
          const plan = buildFollowupSubmissionPlan({
            requestedMode: normalized.mode,
            target: normalized.target,
            models: normalized.models,
            fallbackModels: normalizeAgentList(durable.options?.models || durable.steps?.flatMap((step) => step.agents || []) || ['codex']),
            sourceArtifactIds,
            targetSha: normalized.targetSha,
            targetBranch: normalized.targetBranch,
          })
          const promptText = buildFollowupPrompt({
            instructions: normalized.prompt,
            contextText: delivery.promptContext,
          })
          const id = followupId(durable.runId || sourceRunId)
          const results = await submitFollowupPlan({
            projectRoot,
            promptText,
            submissions: plan.submissions,
            shared: {
              branch: normalized.targetBranch,
              siteId: followupSiteId,
              netlifyFilter: followupNetlifyFilter,
              env,
              submitRun: followupSubmitRun,
              linkRun: linkSubmittedRunFactory({ siteName: followupSiteName }),
              source: {
                id,
                sourceWorkflowRunId: durable.runId || sourceRunId,
                sourceTargetId: normalized.target.id,
                sourceArtifactIds,
              },
              raw: {
                visualizerFollowup: {
                  id,
                  sourceWorkflowRunId: durable.runId || sourceRunId,
                  targetId: normalized.target.id,
                  delivery: delivery.delivery,
                },
              },
            },
          })
          const warnings = results.flatMap((result) => result.warnings || [])
          const freshResults = results
            .filter((result) => result.submission?.mode === 'fresh-runner')
            .map((result) => result.run)
          let persistedSourceWorkflow = null
          try {
            persistedSourceWorkflow = appendFollowupRunsToWorkflow({
              runState: durable,
              runs: results.map((result) => result.run),
              promptText,
              target: normalized.target,
              source: {
                id,
                sourceWorkflowRunId: durable.runId || sourceRunId,
                sourceTargetId: normalized.target.id,
                sourceArtifactIds,
                delivery: delivery.delivery,
              },
            })
          } catch (error) {
            warnings.push(error?.message || String(error))
          }
          let persistedWorkflow = null
          if (freshResults.length > 0) {
            try {
              persistedWorkflow = persistFreshPseudoWorkflow({
                projectRoot,
                runs: freshResults,
                promptText,
                target: {
                  sha: normalized.targetSha,
                  branch: normalized.targetBranch,
                  sourceType: 'visualizer-followup',
                },
                source: {
                  id,
                  sourceWorkflowRunId: durable.runId || sourceRunId,
                  sourceTargetId: normalized.target.id,
                  sourceArtifactIds,
                },
                title: freshFollowupTitle(durable, normalized.target, freshResults),
                stepTitle: freshResults.length === 1
                  ? `${titleCaseAgent(freshResults[0].agent)} follow-up`
                  : 'Multi-agent follow-up',
              })
            } catch (error) {
              warnings.push(error?.message || String(error))
            }
          }

          jsonResponse(res, 202, {
            followup: {
              id,
              status: 'submitted',
              sourceWorkflowRunId: durable.runId || sourceRunId,
              target: normalized.target,
              context: {
                artifactCount: contextPackage.artifactCount,
                artifacts: contextPackage.artifacts,
                delivery: delivery.delivery,
                bytes: delivery.bytes,
                blobRef: delivery.blobRef || null,
              },
              plan,
              submissions: results.map(submissionResponseItem),
              sourceWorkflow: persistedSourceWorkflow ? publicRunState(persistedSourceWorkflow) : null,
              persistedWorkflow: persistedWorkflow ? publicRunState(persistedWorkflow) : null,
              warnings,
            },
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
            notFound(res, 'Unknown visualize run.')
            return
          }
          const body = await readJsonBody(req)
          const runnerId = String(body.runnerId || '').trim()
          const sessionId = String(body.sessionId || '').trim()
          if (!runnerId && !sessionId) {
            throw requestError(400, 'missing_followup_run', 'Select a follow-up runner or session to cancel.')
          }
          const warnings = []
          const result = cancelFollowupRunInWorkflow({
            runState: durable,
            stepId: String(body.stepId || '').trim(),
            runnerId,
            sessionId,
            agent: String(body.agent || '').trim(),
          })
          let remoteStopped = false
          if (result.changed && runnerId && !result.run?.existingRunnerId) {
            const stopped = await followupStopRun({
              projectRoot,
              runnerId,
              env,
            })
            remoteStopped = stopped.stopped === true
            if (!remoteStopped && stopped.error) warnings.push(stopped.error)
          }
          jsonResponse(res, 200, {
            run: publicRunState(result.runState),
            cancelled: result.changed,
            remoteStopped,
            warnings,
          })
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
          const run = runs.get(requestedRunId)
          const durable = durableRunStateForId(run?.runId || run?.id || requestedRunId)
          if (!run && !durable) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          const remoteCancel = durable
            ? await stopWorkflowRunners({
                runState: durable,
                projectRoot,
                env,
                stopRun: cancelStopRun,
              })
            : { runnerIds: [], stopped: [], warnings: [] }
          if (durable) {
            applyRemoteCancelToWorkflow(durable, remoteCancel, { reason: 'cancelled from visualizer' })
          }
          if (!run) {
            jsonResponse(res, 200, {
              run: publicRunState(durable),
              cancelled: Boolean(durable?.status === 'cancelled' || remoteCancel.stopped.length > 0),
              remoteStopped: remoteCancel.stopped.length,
              remoteStopAttempted: remoteCancel.runnerIds.length,
              warnings: remoteCancel.warnings,
            })
            return
          }
          if (remoteCancel.runnerIds.length > 0) {
            recordEvent(run, 'remote_cancel_requested', {
              runnerIds: remoteCancel.runnerIds,
              stoppedRunnerIds: remoteCancel.stopped,
              warnings: remoteCancel.warnings,
            })
          }
          const canCancelLive = run.status === 'running' && run.cancellable
          const localCancelled = canCancelLive && typeof run.cancel === 'function' ? run.cancel() : false
          run.cancelRequested = localCancelled || remoteCancel.stopped.length > 0
          run.cancellable = canCancelLive ? !localCancelled : false
          recordEvent(run, 'cancel_requested', {
            remoteStopped: remoteCancel.stopped.length,
            remoteStopAttempted: remoteCancel.runnerIds.length,
          })
          if (localCancelled) recordCancelSemantics(run)
          jsonResponse(res, 200, {
            run: publicRun(run),
            cancelled: localCancelled || Boolean(durable?.status === 'cancelled') || remoteCancel.stopped.length > 0,
            remoteStopped: remoteCancel.stopped.length,
            remoteStopAttempted: remoteCancel.runnerIds.length,
            warnings: remoteCancel.warnings,
          })
          return
        }

        const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
        if (runMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          assertToken(req, requestUrl, token)
          const run = runs.get(safeDecode(runMatch[1]))
          if (run) {
            jsonResponse(res, 200, { run: publicRun(run) })
            return
          }
          const durable = durableRunStateForId(runMatch[1])
          if (!durable) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          jsonResponse(res, 200, { run: publicRunState(durable) })
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
          const result = await runDryRunCommand({ flowId: id, projectRoot, options, tailOutput })
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
          })
          return
        }

        const workflowMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/)
        if (workflowMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          const id = safeDecode(workflowMatch[1])
          const flow = await loadFlow(id, flowOptions)
          jsonResponse(res, 200, publicFlow(flow))
          return
        }

        if (!pathname.startsWith('/api/')) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          const staticFile = staticFileForPath(distDir, pathname)
          if (staticFile) {
            const body = fs.readFileSync(staticFile)
            res.writeHead(200, {
              ...securityHeaders(),
              ...sessionBootstrapHeaders(token),
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
          textResponse(res, 200, defaultIndexHtml({ token, initialWorkflow }), 'text/html; charset=utf-8', sessionBootstrapHeaders(token))
          return
        }

        notFound(res)
      } catch (error) {
        const message = error?.message || String(error)
        if (error?.statusCode) {
          const headers = error.statusCode === 401 ? sessionBootstrapHeaders(token) : {}
          jsonResponse(res, error.statusCode, errorPayload(error.statusCode, error.code || 'request_error', message), headers)
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

function startVisualizeServer(options = {}) {
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
      const workflow = options.initialWorkflow ? `&workflow=${encodeURIComponent(options.initialWorkflow)}` : ''
      const url = `http://${host}:${actualPort}/${workflow ? `?${workflow.slice(1)}` : ''}`
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
    endClients,
    evictFinishedRuns,
    extractDurableRunId,
    htmlEscape,
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
  startVisualizeServer,
}
