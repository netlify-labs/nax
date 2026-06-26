// Live-run memory caps: the durable event log on disk is the source of truth for
// full history; the in-memory window is bounded so long/verbose runs cannot grow
// the dashboard process without limit.
const MAX_LIVE_OUTPUT_CHARS = 512 * 1024
const MAX_LIVE_EVENTS = 2000
const MAX_FINISHED_RUNS = 50
const TERMINAL_RUNNER_EVENT_TYPES = new Set(['workflow_completed', 'workflow_failed', 'workflow_cancelled', 'exited'])

/**
 * @typedef {{
 *   id: string,
 *   runId?: string,
 *   flowId: string,
 *   status: string,
 *   command?: Array<string>,
 *   startedAt?: string,
 *   exitedAt?: string,
 *   durationMs?: number,
 *   exitCode?: number | null,
 *   signal?: string | null,
 *   stdout: string,
 *   stderr: string,
 *   stdoutDropped?: number,
 *   stderrDropped?: number,
 *   events: Array<Record<string, unknown>>,
 *   eventSeq?: number,
 *   clients: Set<{ write: (text: string) => unknown, end: () => unknown, on?: (event: string, callback: () => void) => unknown }>,
 *   cancellable?: boolean,
 *   cancelRequested?: boolean,
 *   cancel?: (() => unknown) | null,
 *   stepStatuses?: Record<string, string>,
 *   stepStatusTimer?: NodeJS.Timeout | null,
 * }} LiveRun
 *
 * @typedef {{
 *   extractDurableRunId?: (output?: string) => string,
 *   maxFinished?: number,
 * }} LocalLiveRunRegistryOptions
 */

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

/** @param {LiveRun} run */
function defaultPublicRun(run) {
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

/** @param {LocalLiveRunRegistryOptions} [options] */
function createLocalLiveRunRegistry({ maxFinished = MAX_FINISHED_RUNS } = {}) {
  /** @type {Map<string, LiveRun>} */
  const runs = new Map()
  /** @type {Map<string, string>} */
  const activeByWorkflow = new Map()

  return {
    runs,
    activeByWorkflow,
    listRawRuns() {
      return [...runs.values()]
    },
    /** @param {string} id */
    getRawRun(id) {
      return runs.get(id) || null
    },
    /** @param {string} flowId */
    activeWorkflowRun(flowId) {
      const existingRunId = activeByWorkflow.get(flowId)
      return existingRunId ? runs.get(existingRunId) || null : null
    },
    /** @param {LiveRun} run */
    trackRun(run) {
      runs.set(run.id, run)
      activeByWorkflow.set(run.flowId, run.id)
      return run
    },
    /** @param {string} flowId */
    clearWorkflow(flowId) {
      activeByWorkflow.delete(flowId)
    },
    listActiveRuns() {
      return [...runs.values()].map(defaultPublicRun)
    },
    /** @param {string} id */
    getActiveRun(id) {
      const run = runs.get(id)
      return run ? defaultPublicRun(run) : null
    },
    /**
     * @param {string} id
     * @param {number} [since]
     */
    getActiveEvents(id, since = 0) {
      const run = runs.get(id)
      if (!run) return null
      return {
        run: defaultPublicRun(run),
        events: run.events.filter((candidate) => eventAfter(candidate, since)),
        errors: [],
      }
    },
    /**
     * @param {LiveRun} run
     * @param {string} type
     * @param {Record<string, unknown>} [data]
     */
    recordEvent(run, type, data = {}) {
      run.eventSeq = (run.eventSeq || 0) + 1
      const event = {
        type,
        at: new Date().toISOString(),
        runId: run.id,
        ...data,
        id: run.eventSeq,
        seq: run.eventSeq,
      }
      run.events.push(event)
      if (run.events.length > MAX_LIVE_EVENTS) run.events.shift()
      broadcastEvent(run.clients, eventText(event))
      return event
    },
    /** @param {LiveRun} run @param {Record<string, unknown>} [event] */
    recordRunnerEvent(run, event = {}) {
      if (event.type === 'workflow_started' && event.runId) run.runId = String(event.runId)
      if (event.runId && !run.runId) run.runId = String(event.runId)
      const recorded = this.recordEvent(run, String(event.type || 'runner_event'), event)
      if (TERMINAL_RUNNER_EVENT_TYPES.has(String(event.type || ''))) {
        run.status = typeof event.status === 'string' && event.status ? event.status : run.status
        run.exitedAt = typeof event.at === 'string' && event.at ? event.at : run.exitedAt
        run.durationMs = typeof event.durationMs === 'number' ? event.durationMs : run.durationMs
        run.exitCode = typeof event.exitCode === 'number' ? event.exitCode : run.exitCode
        run.signal = typeof event.signal === 'string' ? event.signal : run.signal
        run.cancellable = false
        run.cancel = null
        if (run.stepStatusTimer) {
          clearInterval(run.stepStatusTimer)
          run.stepStatusTimer = null
        }
        activeByWorkflow.delete(run.flowId)
      }
      return recorded
    },
    /** @param {LiveRun} run @param {string} text */
    appendStdout(run, text) {
      const bounded = appendBounded(run.stdout, text)
      run.stdout = bounded.text
      run.stdoutDropped = (run.stdoutDropped || 0) + bounded.dropped
      return bounded
    },
    /** @param {LiveRun} run @param {string} text */
    appendStderr(run, text) {
      const bounded = appendBounded(run.stderr, text)
      run.stderr = bounded.text
      run.stderrDropped = (run.stderrDropped || 0) + bounded.dropped
      return bounded
    },
    /** @param {LiveRun} run */
    endClients(run) {
      endClients(run.clients)
    },
    /** @param {LiveRun} run */
    registerSseClient(run, req, res) {
      registerSseClient(run, req, res)
    },
    evictFinishedRuns() {
      evictFinishedRuns(runs, maxFinished)
    },
    shutdown() {
      shutdownRuns(runs)
    },
  }
}

module.exports = {
  MAX_FINISHED_RUNS,
  MAX_LIVE_EVENTS,
  MAX_LIVE_OUTPUT_CHARS,
  TERMINAL_RUNNER_EVENT_TYPES,
  appendBounded,
  broadcastEvent,
  createLocalLiveRunRegistry,
  defaultPublicRun,
  endClients,
  eventAfter,
  eventText,
  evictFinishedRuns,
  extractDurableRunId,
  registerSseClient,
  shutdownRuns,
}
