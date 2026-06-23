const assert = require('assert/strict')
const test = require('node:test')

const { cancelFollowup, cancelRun } = require('../../src/dashboard/services/mutations')

test('mutation service cancels active local runs and records remote stop metadata', async () => {
  const events = []
  let localCancelled = 0
  const run = {
    id: 'dash-1',
    runId: 'durable-1',
    flowId: 'review',
    status: 'running',
    cancellable: true,
    cancelRequested: false,
    cancel() {
      localCancelled += 1
      return true
    },
  }
  const durable = { runId: 'durable-1', status: 'running' }
  let remoteApplied = false
  let cancelSemanticsRecorded = false

  const result = await cancelRun({
    run,
    durable,
    projectRoot: '/tmp/project',
    env: {},
    stopRun: async () => ({ stopped: true }),
    stopWorkflowRunners: async () => ({
      runnerIds: ['runner-1'],
      stopped: ['runner-1'],
      warnings: [],
    }),
    applyRemoteCancelToWorkflow: () => {
      remoteApplied = true
      durable.status = 'cancelled'
    },
    recordEvent: (activeRun, type, data) => {
      events.push({ activeRun, type, data })
    },
    recordCancelSemantics: () => {
      cancelSemanticsRecorded = true
    },
    publicRun: (activeRun) => ({ id: activeRun.id, status: activeRun.status }),
  })

  assert.equal(localCancelled, 1)
  assert.equal(remoteApplied, true)
  assert.equal(cancelSemanticsRecorded, true)
  assert.equal(run.cancelRequested, true)
  assert.equal(run.cancellable, false)
  assert.equal(result.cancelled, true)
  assert.equal(result.remoteStopped, 1)
  assert.equal(result.remoteStopAttempted, 1)
  assert.deepEqual(events.map((event) => event.type), ['remote_cancel_requested', 'cancel_requested'])
})

test('mutation service cancels durable-only runs without requiring a live run', async () => {
  const durable = { runId: 'durable-1', status: 'running' }
  const result = await cancelRun({
    run: null,
    durable,
    projectRoot: '/tmp/project',
    env: {},
    stopRun: async () => ({ stopped: true }),
    stopWorkflowRunners: async () => ({
      runnerIds: ['runner-1'],
      stopped: ['runner-1'],
      warnings: ['kept going'],
    }),
    applyRemoteCancelToWorkflow: () => {
      durable.status = 'cancelled'
    },
    recordEvent: () => {},
    recordCancelSemantics: () => {},
    publicRun: () => ({}),
  })

  assert.equal(result.cancelled, true)
  assert.equal(result.remoteStopped, 1)
  assert.deepEqual(result.warnings, ['kept going'])
})

test('mutation service validates follow-up cancel target', async () => {
  await assert.rejects(
    () => cancelFollowup({
      projectRoot: '/tmp/project',
      durable: { runId: 'durable-1' },
      body: {},
      env: {},
      stopRun: async () => ({ stopped: false }),
    }),
    (error) => {
      const requestError = /** @type {{ statusCode?: number, code?: string }} */ (error)
      assert.equal(requestError.statusCode, 400)
      assert.equal(requestError.code, 'missing_followup_run')
      return true
    }
  )
})
