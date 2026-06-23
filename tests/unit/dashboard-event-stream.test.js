const assert = require('assert/strict')
const { EventEmitter } = require('events')
const test = require('node:test')

const { createDashboardApi } = require('../../src/dashboard/api/app')
const { hostedPlaceholderCapabilities, localDashboardCapabilities } = require('../../src/dashboard/api/capabilities')
const { createLocalEventStreamAdapter } = require('../../src/dashboard/events/local-stream')
const { createLocalLiveRunRegistry } = require('../../src/dashboard/runtime/live-run-registry')

/** @param {Partial<import('../../src/dashboard/runtime/live-run-registry').LiveRun>} [overrides] */
function liveRun(overrides = {}) {
  return {
    id: 'live-1',
    runId: '',
    flowId: 'review',
    status: 'running',
    command: ['nax', 'review'],
    startedAt: '2026-06-22T00:00:00.000Z',
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
    ...overrides,
  }
}

function fakeResponse() {
  return {
    headers: {},
    chunks: [],
    statusCode: 0,
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    write(text) {
      this.chunks.push(String(text))
      return true
    },
    end() {
      this.ended = true
    },
    on() {},
  }
}

function fakeRequest() {
  return /** @type {import('http').IncomingMessage} */ (/** @type {unknown} */ (new EventEmitter()))
}

function fakeServerResponse() {
  return /** @type {ReturnType<typeof fakeResponse> & import('http').ServerResponse} */ (/** @type {unknown} */ (fakeResponse()))
}

test('local event stream adapter replays active events and registers running clients', () => {
  const registry = createLocalLiveRunRegistry()
  const run = registry.trackRun(liveRun())
  registry.recordEvent(run, 'started')
  registry.recordEvent(run, 'step_status', { stepId: 'scan' })
  const adapter = createLocalEventStreamAdapter({
    liveRuns: {
      getRawRun: (id) => registry.getRawRun(id),
      registerSseClient: (active, req, res) => registry.registerSseClient(active, req, res),
    },
    eventStore: {
      getRunState: () => null,
      listEvents: () => null,
    },
  })
  const res = fakeServerResponse()

  const replay = adapter.streamEvents({
    req: fakeRequest(),
    res,
    runId: 'live-1',
    since: 1,
  })

  assert.equal(replay.ok, true)
  assert.equal(replay.active, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream')
  assert.equal(res.chunks.length, 1)
  assert.match(res.chunks[0], /event: step_status/)
  assert.equal(res.ended, false)
  assert.equal(run.clients.has(res), true)
})

test('local event stream adapter replays durable events and parse errors as SSE', () => {
  const durable = { runId: 'durable-1', flowId: 'review', status: 'completed', startedAt: '', completedAt: '', steps: [] }
  const adapter = createLocalEventStreamAdapter({
    liveRuns: {
      getRawRun: () => null,
      registerSseClient: () => {},
    },
    eventStore: {
      getRunState: () => durable,
      listEvents: () => ({
        run: { id: 'durable-1', runId: 'durable-1' },
        events: [{ id: 2, seq: 2, type: 'step_started', runId: 'durable-1' }],
        errors: [{ line: 'not-json', message: 'Invalid event JSON' }],
      }),
    },
  })
  const res = fakeServerResponse()

  const replay = adapter.streamEvents({
    req: fakeRequest(),
    res,
    runId: 'durable-1',
    since: 1,
  })

  assert.equal(replay.ok, true)
  assert.equal(replay.active, false)
  assert.equal(res.ended, true)
  assert.match(res.chunks.join(''), /event: step_started/)
  assert.match(res.chunks.join(''), /event: runner_event_error/)
  assert.match(res.chunks.join(''), /not-json/)
})

test('Hono dashboard API reports event stream unavailability explicitly', async () => {
  const localApp = createDashboardApi({
    token: 'token-1',
    runtime: { capabilities: localDashboardCapabilities() },
  })
  const localResponse = await localApp.request('/api/runs/run-1/events', {
    headers: { 'x-nax-token': 'token-1' },
  })
  const localPayload = /** @type {{ error: { code: string } }} */ (await localResponse.json())
  assert.equal(localResponse.status, 501)
  assert.equal(localPayload.error.code, 'event_stream_unavailable')

  const hostedApp = createDashboardApi({
    token: 'token-1',
    runtime: { capabilities: hostedPlaceholderCapabilities() },
  })
  const hostedResponse = await hostedApp.request('/api/runs/run-1/events', {
    headers: { 'x-nax-token': 'token-1' },
  })
  const hostedPayload = /** @type {{ error: { code: string } }} */ (await hostedResponse.json())
  assert.equal(hostedResponse.status, 501)
  assert.equal(hostedPayload.error.code, 'event_stream_unavailable')
})
