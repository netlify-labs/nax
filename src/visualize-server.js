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

function runDryRunCommand({ flowId, projectRoot, options }) {
  return runWorkflow({
    flowId,
    projectRoot,
    options,
    dryRun: true,
  })
}

function runWorkflowChild({ flowId, projectRoot, options = {}, eventSink = () => {} }) {
  const command = workflowCommand({ flowId, projectRoot, options })
  const args = [path.resolve(__dirname, '..', 'bin', 'nax.js'), ...command.slice(1)]
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let cancelRequested = false
  let settled = false
  let forceKillTimer = null
  const childEnv = {
    ...process.env,
    FORCE_COLOR: process.env.FORCE_COLOR || '1',
  }
  delete childEnv.NO_COLOR

  eventSink({ type: 'started', command, flowId })
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (text) => {
    stdout += text
    eventSink({ type: 'stdout', text })
  })
  child.stderr.on('data', (text) => {
    stderr += text
    eventSink({ type: 'stderr', text })
  })

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

function publicRunState(runState = {}) {
  const summaryPath = runState.dir ? path.join(runState.dir, 'artifacts', 'summary.md') : ''
  return {
    runId: runState.runId || '',
    flowId: runState.flowId || '',
    flowTitle: runState.flowTitle || '',
    status: runState.status || '',
    transport: runState.transport || '',
    branch: runState.branch || '',
    createdAt: runState.createdAt || '',
    updatedAt: runState.updatedAt || '',
    dir: runState.dir || '',
    summaryPath,
    resumable: isUnfinishedRun(runState),
    steps: Array.isArray(runState.steps) ? runState.steps : [],
  }
}

function eventText(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
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
  const flowOptions = {
    projectRoot,
    flowsDir: options.flowsDir,
    flowsDirs: options.flowsDirs,
  }
  const token = options.token || crypto.randomBytes(24).toString('hex')
  const initialWorkflow = options.initialWorkflow || ''
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
    }
    runs.set(id, run)
    activeByWorkflow.set(flowId, id)
    const childRun = runWorkflowChild({
      flowId,
      projectRoot,
      options: runOptions,
      eventSink: (event) => {
        if (event.type === 'stdout') {
          run.stdout += event.text || ''
          if (!run.runId) run.runId = extractDurableRunId(run.stdout)
        }
        if (event.type === 'stderr') run.stderr += event.text || ''
        if (event.type === 'started') recordEvent(run, 'started', { command: event.command || run.command, flowId })
        else if (event.type === 'stdout') recordEvent(run, 'stdout', { text: event.text || '' })
        else if (event.type === 'stderr') recordEvent(run, 'stderr', { text: event.text || '' })
        else if (event.type === 'error') recordEvent(run, 'error', { message: event.message || '' })
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
      activeByWorkflow.delete(flowId)
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
      activeByWorkflow.delete(flowId)
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

        const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
        if (runEventsMatch) {
          if (req.method !== 'GET') {
            methodNotAllowed(res, req.method || 'UNKNOWN')
            return
          }
          const run = runs.get(safeDecode(runEventsMatch[1]))
          if (!run) {
            notFound(res, 'Unknown visualize run.')
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          for (const event of run.events) res.write(eventText(event))
          if (run.status === 'running') {
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
          const flow = durable.flow && Array.isArray(durable.flow.steps)
            ? durable.flow
            : await loadFlow(durable.flowId, flowOptions)
          jsonResponse(res, 200, {
            run: publicRunState(durable),
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
          const result = await runDryRunCommand({ flowId: id, projectRoot, options })
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
    extractDurableRunId,
  },
  createRequestHandler,
  publicFlow,
  startVisualizeServer,
}
