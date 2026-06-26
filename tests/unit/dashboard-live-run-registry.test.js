const assert = require('assert/strict')
const { EventEmitter } = require('events')
const test = require('node:test')

const {
  MAX_LIVE_EVENTS,
  appendBounded,
  broadcastEvent,
  createLocalLiveRunRegistry,
  defaultPublicRun,
  eventAfter,
  eventText,
  registerSseClient,
} = require('../../src/dashboard/runtime/live-run-registry')

/** @param {Partial<import('../../src/dashboard/runtime/live-run-registry').LiveRun>} [overrides] */
function liveRun(overrides = {}) {
  return {
    id: 'dash-run-1',
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

test('live run registry records ordered bounded events and public run DTOs', () => {
  const registry = createLocalLiveRunRegistry()
  const run = registry.trackRun(liveRun({
    id: 'dash-run-1',
    stdout: 'State: /tmp/project/.nax/workflows/workflow-123/workflow.json\n',
  }))

  registry.recordEvent(run, 'started', { flowId: 'review' })
  registry.recordEvent(run, 'stdout', { text: 'hello' })

  assert.deepEqual(run.events.map((event) => event.seq), [1, 2])
  assert.equal(eventAfter(run.events[1], 1), true)
  assert.equal(eventText(run.events[0]).startsWith('event: started\ndata: {'), true)

  const publicRun = registry.getActiveRun('dash-run-1')
  assert.equal(publicRun.runId, 'workflow-123')
  assert.equal(publicRun.eventCount, 2)
  assert.equal(publicRun.truncated, false)
  assert.equal(registry.listActiveRuns().length, 1)
})

test('live run registry truncates output windows and serializes truncation', () => {
  const registry = createLocalLiveRunRegistry()
  const run = registry.trackRun(liveRun())

  const bounded = appendBounded('12345', '67890', 6)
  assert.deepEqual(bounded, { text: '567890', dropped: 4 })

  registry.appendStdout(run, 'a'.repeat(512 * 1024 + 10))
  registry.appendStderr(run, 'b'.repeat(512 * 1024 + 20))

  const publicRun = defaultPublicRun(run)
  assert.equal(publicRun.stdout.length, 512 * 1024)
  assert.equal(publicRun.stderr.length, 512 * 1024)
  assert.equal(publicRun.stdoutDropped, 10)
  assert.equal(publicRun.stderrDropped, 20)
  assert.equal(publicRun.truncated, true)
})

test('live run registry evicts only oldest finished runs', () => {
  const registry = createLocalLiveRunRegistry({ maxFinished: 2 })
  registry.trackRun(liveRun({ id: 'old', flowId: 'old', status: 'completed', exitedAt: '2026-06-22T00:00:00.000Z' }))
  registry.trackRun(liveRun({ id: 'middle', flowId: 'middle', status: 'failed', exitedAt: '2026-06-22T00:01:00.000Z' }))
  registry.trackRun(liveRun({ id: 'new', flowId: 'new', status: 'completed', exitedAt: '2026-06-22T00:02:00.000Z' }))
  registry.trackRun(liveRun({ id: 'running', flowId: 'running', status: 'running', exitedAt: '' }))

  registry.evictFinishedRuns()

  assert.equal(registry.getRawRun('old'), null)
  assert.ok(registry.getRawRun('middle'))
  assert.ok(registry.getRawRun('new'))
  assert.ok(registry.getRawRun('running'))
})

test('live run registry tracks duplicate workflow reservations and shutdown cleanup', () => {
  const registry = createLocalLiveRunRegistry()
  let cancelled = 0
  const run = registry.trackRun(liveRun({
    id: 'active',
    flowId: 'review',
    cancel: () => {
      cancelled += 1
      return true
    },
    stepStatusTimer: setInterval(() => {}, 1000),
  }))
  run.stepStatusTimer.unref?.()
  const client = {
    ended: false,
    write() {},
    end() {
      this.ended = true
    },
  }
  run.clients.add(client)

  assert.equal(registry.activeWorkflowRun('review'), run)
  registry.clearWorkflow('review')
  assert.equal(registry.activeWorkflowRun('review'), null)

  registry.shutdown()
  assert.equal(cancelled, 1)
  assert.equal(run.stepStatusTimer, null)
  assert.equal(run.clients.size, 0)
  assert.equal(client.ended, true)
})

test('live run registry finalizes live sidecar from terminal runner events', () => {
  const registry = createLocalLiveRunRegistry()
  const run = registry.trackRun(liveRun({
    id: 'active',
    flowId: 'review',
    cancel: () => true,
    stepStatusTimer: setInterval(() => {}, 1000),
  }))
  run.stepStatusTimer.unref?.()

  registry.recordRunnerEvent(run, {
    type: 'workflow_completed',
    runId: 'durable-1',
    status: 'completed',
    durationMs: 1200,
    exitCode: 0,
    at: '2026-06-22T00:01:00.000Z',
  })

  assert.equal(run.status, 'completed')
  assert.equal(run.runId, 'durable-1')
  assert.equal(run.cancellable, false)
  assert.equal(run.cancel, null)
  assert.equal(run.stepStatusTimer, null)
  assert.equal(registry.activeWorkflowRun('review'), null)
  assert.equal(run.events.at(-1).type, 'workflow_completed')
})

test('live run registry drops broken SSE clients and unregisters on close', () => {
  const run = liveRun()
  const goodClient = { text: '', write(text) { this.text += text }, end() {} }
  const brokenClient = { write() { throw new Error('closed') }, end() { this.ended = true }, ended: false }
  run.clients.add(goodClient)
  run.clients.add(brokenClient)

  broadcastEvent(run.clients, 'event: started\n\n')
  assert.equal(goodClient.text, 'event: started\n\n')
  assert.equal(run.clients.has(brokenClient), false)
  assert.equal(brokenClient.ended, true)

  const req = new EventEmitter()
  const res = Object.assign(new EventEmitter(), {
    write: () => true,
    end: () => true,
  })
  registerSseClient(run, req, res)
  assert.equal(run.clients.has(res), true)
  req.emit('close')
  assert.equal(run.clients.has(res), false)
})

test('live run registry keeps bounded live event windows', () => {
  const registry = createLocalLiveRunRegistry()
  const run = registry.trackRun(liveRun())

  for (let index = 0; index < MAX_LIVE_EVENTS + 3; index += 1) {
    registry.recordEvent(run, 'tick', { index })
  }

  assert.equal(run.events.length, MAX_LIVE_EVENTS)
  assert.equal(run.events[0].seq, 4)
  assert.equal(run.events.at(-1).seq, MAX_LIVE_EVENTS + 3)
})
