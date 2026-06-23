const assert = require('assert/strict')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const test = require('node:test')

const { runWorkflowChild } = require('../../src/dashboard/transports/local-process')

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.events = new PassThrough()
    this.stdio = [null, this.stdout, this.stderr, this.events]
    this.killed = false
    /** @type {Array<string>} */
    this.signals = []
  }

  /** @param {string} signal */
  kill(signal) {
    this.signals.push(signal)
    this.killed = true
    return true
  }
}

/**
 * @param {FakeChild} child
 * @returns {{ calls: Array<{ command: string, args: Array<string>, options: Record<string, unknown> }>, spawn: import('child_process').spawn }}
 */
function fakeSpawnFor(child) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({
      command: String(command),
      args: Array.isArray(args) ? args.map(String) : [],
      options: options && typeof options === 'object' ? /** @type {Record<string, unknown>} */ (options) : {},
    })
    return child
  }
  return {
    calls,
    spawn: /** @type {import('child_process').spawn} */ (/** @type {unknown} */ (spawn)),
  }
}

function fixedClock() {
  let nowCalls = 0
  let isoCalls = 0
  return {
    now: () => {
      nowCalls += 1
      return nowCalls === 1 ? 1000 : 1250
    },
    isoNow: () => {
      isoCalls += 1
      return isoCalls === 1 ? '2026-06-22T00:00:00.000Z' : '2026-06-22T00:00:00.250Z'
    },
  }
}

test('local process transport launches nax child with event fd and captures successful output', async () => {
  const child = new FakeChild()
  const fakeSpawn = fakeSpawnFor(child)
  const clock = fixedClock()
  const events = []
  const run = runWorkflowChild({
    flowId: 'review',
    projectRoot: '/tmp/project',
    options: { transport: 'netlify-api', branch: 'main' },
    eventSink: (event) => events.push(event),
    deps: {
      spawn: fakeSpawn.spawn,
      execPath: '/usr/bin/node',
      env: { NO_COLOR: '1' },
      now: clock.now,
      isoNow: clock.isoNow,
    },
  })

  child.stdout.write('hello\n')
  child.stderr.write('warn\n')
  child.events.write('{"type":"workflow_started","runId":"run-1"}\n')
  child.events.end()
  child.emit('close', 0, null)
  const result = await run.promise

  assert.equal(fakeSpawn.calls[0].command, '/usr/bin/node')
  assert.equal(fakeSpawn.calls[0].options.cwd, '/tmp/project')
  const childEnv = /** @type {NodeJS.ProcessEnv} */ (fakeSpawn.calls[0].options.env)
  assert.equal(childEnv.NO_COLOR, undefined)
  assert.equal(childEnv.NAX_EVENT_FD, '3')
  assert.deepEqual(fakeSpawn.calls[0].options.stdio, ['ignore', 'pipe', 'pipe', 'pipe'])
  assert.equal(run.command[0], 'nax')
  assert.equal(result.status, 'completed')
  assert.equal(result.stdout, 'hello\n')
  assert.equal(result.stderr, 'warn\n')
  assert.equal(result.durationMs, 250)
  assert.equal(events.some((event) => event.type === 'runner_event' && event.event.runId === 'run-1'), true)
  assert.equal(events.at(-1).type, 'exited')
})

test('local process transport maps awaiting review and runner parse errors', async () => {
  const child = new FakeChild()
  const fakeSpawn = fakeSpawnFor(child)
  const events = []
  const run = runWorkflowChild({
    flowId: 'review',
    projectRoot: '/tmp/project',
    eventSink: (event) => events.push(event),
    deps: {
      spawn: fakeSpawn.spawn,
      env: {},
    },
  })

  child.events.write('not-json\n')
  child.events.write('{"type":"workflow_awaiting_review"}\n')
  child.emit('close', 0, null)
  const result = await run.promise

  assert.equal(result.status, 'awaiting_review')
  assert.equal(events.some((event) => event.type === 'runner_event_error' && event.code === 'parse_runner_event'), true)
  assert.equal(events.some((event) => event.type === 'runner_event' && event.event.type === 'workflow_awaiting_review'), true)
})

test('local process transport reports failed exits and spawn errors', async () => {
  const failedChild = new FakeChild()
  const failedSpawn = fakeSpawnFor(failedChild)
  const failedEvents = []
  const failedRun = runWorkflowChild({
    flowId: 'review',
    projectRoot: '/tmp/project',
    eventSink: (event) => failedEvents.push(event),
    deps: { spawn: failedSpawn.spawn, env: {} },
  })
  failedChild.stderr.write('bad things\n')
  failedChild.emit('close', 1, null)
  const failedResult = await failedRun.promise

  assert.equal(failedResult.status, 'failed')
  assert.equal(failedResult.exitCode, 1)
  assert.equal(failedEvents.some((event) => event.type === 'error' && /bad things/.test(String(event.message))), true)

  const errorChild = new FakeChild()
  const errorSpawn = fakeSpawnFor(errorChild)
  const errorEvents = []
  const errorRun = runWorkflowChild({
    flowId: 'review',
    projectRoot: '/tmp/project',
    eventSink: (event) => errorEvents.push(event),
    deps: { spawn: errorSpawn.spawn, env: {} },
  })
  errorChild.emit('error', new Error('spawn failed'))
  const errorResult = await errorRun.promise

  assert.equal(errorResult.status, 'failed')
  assert.equal(errorResult.stderr, 'spawn failed\n')
  assert.equal(errorEvents.some((event) => event.type === 'stderr' && /spawn failed/.test(String(event.text))), true)
})

test('local process transport cancellation sends SIGTERM then SIGKILL fallback', async () => {
  const child = new FakeChild()
  const fakeSpawn = fakeSpawnFor(child)
  const run = runWorkflowChild({
    flowId: 'review',
    projectRoot: '/tmp/project',
    deps: {
      spawn: fakeSpawn.spawn,
      env: {},
      forceKillDelayMs: 1,
    },
  })

  assert.equal(run.cancel(), true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])

  child.emit('close', null, 'SIGTERM')
  const result = await run.promise
  assert.equal(result.status, 'cancelled')
  assert.equal(run.cancel(), false)
})
