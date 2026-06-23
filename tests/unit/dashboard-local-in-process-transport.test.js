const assert = require('assert/strict')
const test = require('node:test')

const { dryRunWorkflow, resumeWorkflowRun } = require('../../src/dashboard/transports/local-in-process')

test('local in-process transport maps dashboard dry-run to runWorkflow dryRun call', async () => {
  const calls = []
  const result = {
    command: ['nax', 'review'],
    startedAt: '2026-06-22T00:00:00.000Z',
    exitedAt: '2026-06-22T00:00:00.001Z',
    durationMs: 1,
    exitCode: 0,
    signal: null,
    status: 'completed',
    stdout: 'ok',
    stderr: '',
  }
  const response = await dryRunWorkflow({
    flowId: 'review',
    projectRoot: '/tmp/project',
    options: { transport: 'netlify-api', branch: 'main' },
    tailOutput: true,
    deps: {
      runWorkflow: async (input) => {
        calls.push(input)
        return result
      },
    },
  })

  assert.equal(response, result)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    flowId: 'review',
    projectRoot: '/tmp/project',
    options: { transport: 'netlify-api', branch: 'main' },
    dryRun: true,
    passthrough: true,
  })
})

test('local in-process transport maps dashboard review resume options and events', async () => {
  const calls = []
  const result = {
    command: ['nax', 'resume', 'run-1'],
    startedAt: '2026-06-22T00:00:00.000Z',
    exitedAt: '2026-06-22T00:00:00.001Z',
    durationMs: 1,
    exitCode: 0,
    signal: null,
    status: 'completed',
    stdout: 'resumed',
    stderr: '',
  }
  const events = []
  const response = await resumeWorkflowRun({
    runId: 'run-1',
    projectRoot: '/tmp/project',
    stepId: 'review',
    tailOutput: true,
    eventSink: (event) => events.push(event),
    deps: {
      resumeWorkflow: async (input) => {
        calls.push(input)
        input.eventSink({ type: 'started' })
        return result
      },
    },
  })

  assert.equal(response, result)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].runId, 'run-1')
  assert.equal(calls[0].projectRoot, '/tmp/project')
  assert.deepEqual(calls[0].options, {
    projectRoot: '/tmp/project',
    stepId: 'review',
    reviewer: 'dashboard',
    yes: true,
    force: true,
  })
  assert.equal(calls[0].passthrough, true)
  assert.deepEqual(events, [{ type: 'started' }])
})
