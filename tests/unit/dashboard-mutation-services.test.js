const assert = require('assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { cancelFollowup, cancelRun, retryAgentRun } = require('../../src/dashboard/services/mutations')

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

test('mutation service retries a terminal agent in an active step', async () => {
  const durable = {
    runId: 'durable-1',
    flowId: 'review',
    flowTitle: 'Review',
    transport: 'netlify-api',
    status: 'running',
    branch: 'master',
    target: { branch: 'master', sourceType: 'explicit-branch', verified: true },
    options: { netlifySiteId: 'site-1', branch: 'master', transport: 'netlify-api' },
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'running',
      runs: [
        { agent: 'claude', status: 'running', runnerId: 'runner-claude' },
        {
          agent: 'codex',
          status: 'completed',
          runnerId: 'runner-old',
          sessionId: 'session-old',
          promptText: 'review this repo',
          resultText: 'junk',
          raw: { create: { id: 'runner-old' } },
        },
      ],
    }],
  }
  durable.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-retry-test-'))

  const result = await retryAgentRun({
    projectRoot: '/tmp/project',
    durable,
    body: { stepId: 'review', agent: 'codex', runnerId: 'runner-old' },
    env: { NETLIFY_SITE_ID: 'site-1' },
    submitRun: async ({ run }) => ({
      ...run,
      status: 'submitted',
      runnerId: 'runner-new',
      sessionId: '',
      raw: { ...run.raw, create: { id: 'runner-new' } },
    }),
  })

  assert.equal(result.retried, true)
  assert.equal(result.previousRunnerId, 'runner-old')
  assert.equal(result.runnerId, 'runner-new')
  assert.equal(result.run.status, 'running')
  assert.equal(durable.steps[0].runs[1].status, 'submitted')
  assert.equal(durable.steps[0].runs[1].runnerId, 'runner-new')
  assert.equal(durable.steps[0].runs[1].raw.dashboardRetry.previous.runnerId, 'runner-old')
})
