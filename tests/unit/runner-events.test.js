const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Writable } = require('stream')

const { readEventLog } = require('../../src/workflows/events/runner-event-log')
const {
  createRunnerEventEmitter,
  sanitizeEventPayload,
} = require('../../src/workflows/events/runner-events')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-runner-events-'))
}

function collectingStream() {
  const chunks = []
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString('utf8'))
        callback()
      },
    }),
  }
}

test('runner event emitter no-ops without event channel and cannot throw', () => {
  const emitter = createRunnerEventEmitter({ env: {}, now: () => new Date('2026-06-19T00:00:00.000Z') })
  const event = emitter.emit('workflow_started', { runId: 'run-1', flowId: 'review' })
  assert.equal(emitter.enabled, false)
  assert.equal(event.seq, 1)
  assert.equal(event.eventId, 'run-1:1')
  assert.equal(event.type, 'workflow_started')
})

test('runner event emitter writes one-line JSON to an enabled stream', () => {
  const { stream, chunks } = collectingStream()
  const emitter = createRunnerEventEmitter({
    runId: 'run-1',
    flowId: 'review',
    stream,
    now: () => new Date('2026-06-19T00:00:00.000Z'),
  })
  emitter.emit('step_started', { stepId: 'review', status: 'running' })

  const lines = chunks.join('').trim().split('\n')
  assert.equal(lines.length, 1)
  const event = JSON.parse(lines[0])
  assert.equal(event.schemaVersion, 1)
  assert.equal(event.seq, 1)
  assert.equal(event.eventId, 'run-1:1')
  assert.equal(event.flowId, 'review')
  assert.equal(event.stepId, 'review')
})

test('runner event emitter appends to durable event log with ordered seq values', () => {
  const logPath = path.join(tmpDir(), 'events.jsonl')
  const emitter = createRunnerEventEmitter({
    runId: 'run-1',
    flowId: 'review',
    logPath,
    now: () => new Date('2026-06-19T00:00:00.000Z'),
  })
  emitter.emit('workflow_started')
  emitter.emit('workflow_completed', { status: 'completed' })

  const replay = readEventLog(logPath)
  assert.deepEqual(replay.events.map((event) => event.seq), [1, 2])
  assert.deepEqual(replay.events.map((event) => event.eventId), ['run-1:1', 'run-1:2'])
  assert.equal(replay.events[1].status, 'completed')
})

test('runner event emitter context can be set after durable run creation', () => {
  const logPath = path.join(tmpDir(), 'events.jsonl')
  const emitter = createRunnerEventEmitter({
    flowId: 'review',
    logPath,
    now: () => new Date('2026-06-19T00:00:00.000Z'),
  })
  emitter.setContext({ runId: 'durable-run', flowId: 'review' })
  const event = emitter.emit('workflow_started')
  assert.equal(event.runId, 'durable-run')
  assert.equal(event.eventId, 'durable-run:1')
})

test('runner event emitter closes owned event fd streams', async () => {
  const filePath = path.join(tmpDir(), 'events-fd.jsonl')
  const fd = fs.openSync(filePath, 'w')
  const emitter = createRunnerEventEmitter({
    fd,
    env: {},
    now: () => new Date('2026-06-19T00:00:00.000Z'),
  })

  emitter.emit('workflow_started', { runId: 'run-1', flowId: 'review' })
  await emitter.close()

  assert.throws(() => fs.writeSync(fd, 'after-close\n'), /EBADF|bad file descriptor/i)
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
  assert.equal(JSON.parse(lines[0]).type, 'workflow_started')
})

test('runner event payload sanitization redacts secrets and omits large prompt text', () => {
  const payload = sanitizeEventPayload({
    token: 'super-secret',
    nested: { authorization: 'Bearer token' },
    promptText: 'x'.repeat(5000),
    message: 'ok',
  })

  assert.equal(payload.token, '[redacted]')
  assert.equal(payload.nested.authorization, '[redacted]')
  assert.match(payload.promptText, /^\[omitted 5000 chars\]$/)
  assert.equal(payload.message, 'ok')
})
