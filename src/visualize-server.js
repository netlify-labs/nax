const crypto = require('crypto')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { URL } = require('url')

const { listFlows, loadFlow } = require('./flows')
const { isUnfinishedRun, listRunStates } = require('./run-state')
const { flowToGraph } = require('./visualize-graph')
const { runWorkflow, workflowCommand } = require('./workflow-runner')
const { normalizeAgentList, normalizeStepModels, selectionValidationErrors } = require('./agent-selection')
const { buildRunDetails } = require('./visualize-run-details')
const { eventLogPathForRunState, readEventLog } = require('./runner-event-log')
const { formatAgentRunUrl } = require('./agent-run-results')
const { buildFollowupContextPackage } = require('./followup-context')
const { prepareFollowupContextDelivery } = require('./followup-delivery')
const { buildFollowupSubmissionPlan } = require('./followup-plan')
const { buildFollowupPrompt, submitFollowupPlan } = require('./handoff-runner')
const { persistFreshPseudoWorkflow } = require('./followup-persistence')
const { setBlob } = require('./netlify-blobs')

function jsonResponse(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function textResponse(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
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
        action: step.action || '',
        submit: step.submit || '',
        agents: Array.isArray(step.agents) ? step.agents : [],
        input: Array.isArray(step.input) ? step.input : [],
        waitFor: step.waitFor || '',
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large.'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (_err) {
        reject(new Error('Request body must be valid JSON.'))
      }
    })
    req.on('error', reject)
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

/** @param {{ projectRoot?: string, siteId?: string, env?: NodeJS.ProcessEnv, writeBlob?: ((input: { ref: Record<string, any>, payload: string }) => any) | null }} [input] */
function makeFollowupBlobWriter({ projectRoot, siteId, env = process.env, writeBlob } = {}) {
  if (typeof writeBlob === 'function') return writeBlob
  if (!siteId) return null
  return async ({ ref, payload }) => setBlob({
    store: ref.store,
    key: ref.key,
    value: payload,
    siteId,
    token: env.NETLIFY_AUTH_TOKEN,
    cwd: projectRoot,
    env,
  })
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
  const provided = req.headers['x-nax-token'] || requestUrl.searchParams.get('token')
  if (provided !== token) {
    throw requestError(401, 'unauthorized', 'A valid visualize session token is required.')
  }
}

/** @param {{ token?: string, initialWorkflow?: string }} [options] */
function defaultIndexHtml({ token, initialWorkflow = '' } = {}) {
  const workflowText = initialWorkflow
    ? `<p>Initial workflow: <code>${initialWorkflow}</code></p>`
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
    `    <p>API health: <a href="/api/health?token=${token}">/api/health</a></p>`,
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
  let cancelRequested = false
  let settled = false
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
    stdout += text
    if (tailOutput) process.stdout.write(text)
    eventSink({ type: 'stdout', text })
  })
  child.stderr.on('data', (text) => {
    stderr += text
    if (tailOutput) process.stderr.write(text)
    eventSink({ type: 'stderr', text })
  })
  const eventParser = createRunnerEventParser({
    onEvent: (event) => eventSink({ type: 'runner_event', event }),
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
      stderr += `${message}\n`
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
      }
      eventSink({ type: 'exited', status: result.status, exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs })
      resolve(result)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (forceKillTimer) clearTimeout(forceKillTimer)
      const status = code === 0 ? 'completed' : cancelRequested ? 'cancelled' : 'failed'
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
  if (statuses.some((status) => ['failed', 'timeout', 'cancelled', 'canceled'].includes(status))) {
    return 'failed'
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
  const followupSiteId = options.siteId || env.NETLIFY_SITE_ID || ''
  const followupSiteName = options.siteName || env.NETLIFY_SITE_NAME || ''
  const followupNetlifyFilter = options.netlifyFilter || ''
  const followupSubmitRun = options.followupSubmitRun
  const followupWriteBlob = options.followupWriteBlob
  const runs = new Map()
  const activeByWorkflow = new Map()

  function recordEvent(run, type, data = {}) {
    const event = {
      id: run.events.length + 1,
      type,
      at: new Date().toISOString(),
      runId: run.id,
      ...data,
    }
    run.events.push(event)
    for (const client of run.clients) client.write(eventText(event))
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
      events: [],
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
          run.stdout += event.text || ''
          if (!run.runId) run.runId = extractDurableRunId(run.stdout)
          if (run.runId) recordStepStatusEvents(run)
        }
        if (event.type === 'stderr') run.stderr += event.text || ''
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
      run.runId = run.runId || extractDurableRunId(`${result.stdout || ''}\n${result.stderr || ''}`)
      run.cancellable = false
      run.cancel = null
      if (run.stepStatusTimer) clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
      activeByWorkflow.delete(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal, durationMs: run.durationMs })
      for (const client of run.clients) client.end()
      run.clients.clear()
    }).catch((error) => {
      const message = error?.message || String(error)
      run.status = 'failed'
      run.exitedAt = new Date().toISOString()
      run.exitCode = 1
      run.stderr += `${message}\n`
      run.runId = run.runId || extractDurableRunId(`${run.stdout || ''}\n${run.stderr || ''}`)
      run.cancellable = false
      run.cancel = null
      if (run.stepStatusTimer) clearInterval(run.stepStatusTimer)
      run.stepStatusTimer = null
      activeByWorkflow.delete(flowId)
      recordStepStatusEvents(run)
      recordEvent(run, 'error', { message })
      recordEvent(run, 'exited', { status: run.status, exitCode: run.exitCode, signal: run.signal })
      for (const client of run.clients) client.end()
      run.clients.clear()
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

  return {
    token,
    async handle(req, res) {
      const base = `http://${req.headers.host || '127.0.0.1'}`
      const requestUrl = new URL(req.url || '/', base)
      const pathname = requestUrl.pathname

      try {
        if (pathname === '/api/health') {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          jsonResponse(res, 200, {
            ok: true,
            projectRoot,
            tokenRequiredForMutations: true,
          })
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
          const runId = safeDecode(runEventsMatch[1])
          const run = runs.get(runId)
          const durable = run ? null : durableRunStateForId(runId)
          if (!run && !durable) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          const since = Number(requestUrl.searchParams.get('since') || 0)
          res.writeHead(200, {
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
            run.clients.add(res)
            req.on('close', () => run.clients.delete(res))
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
          const durable = durableRunStateForId(runGraphMatch[1])
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
          const durable = durableRunStateForId(runDetailsMatch[1])
          if (!durable) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          jsonResponse(res, 200, {
            run: publicRunState(durable),
            details: buildRunDetails(durable),
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
              persistedWorkflow: persistedWorkflow ? publicRunState(persistedWorkflow) : null,
              warnings,
            },
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
          const run = runs.get(safeDecode(runCancelMatch[1]))
          if (!run) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          if (run.status !== 'running' || !run.cancellable) {
            jsonResponse(res, 200, { run: publicRun(run), cancelled: false })
            return
          }
          const cancelled = typeof run.cancel === 'function' ? run.cancel() : false
          run.cancelRequested = cancelled
          run.cancellable = !cancelled
          recordEvent(run, 'cancel_requested')
          if (cancelled) recordCancelSemantics(run)
          jsonResponse(res, 200, { run: publicRun(run), cancelled })
          return
        }

        const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
        if (runMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
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
          textResponse(res, 200, defaultIndexHtml({ token, initialWorkflow }), 'text/html; charset=utf-8')
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
      const url = `http://${host}:${actualPort}/?token=${handler.token}${workflow}`
      resolve({
        server,
        host,
        port: actualPort,
        token: handler.token,
        url,
        projectRoot: path.resolve(options.projectRoot || process.cwd()),
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => (error ? closeReject(error) : closeResolve()))
        }),
      })
    })
  })
}

module.exports = {
  _private: {
    createRunnerEventParser,
    extractDurableRunId,
    stepStatusSnapshot,
  },
  createRequestHandler,
  publicFlow,
  startVisualizeServer,
}
