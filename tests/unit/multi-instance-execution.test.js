const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const {
  completedContinuationRuns,
  continuationRunForInstance,
  continuationSourceRuns,
  localRunIndex,
  waitForLocalRunSubset,
} = require('../../src/workflows/engine/local-executor')

const OPUS = 'claude:claude-opus-5:auto'
const SONNET = 'claude:claude-sonnet-4-5:auto'

function reporter() {
  return {
    setCount: () => {},
    updateRun: () => {},
    message: () => {},
    done: () => {},
    fail: () => {},
  }
}

test('follow-up inherits successful instances from only its first input', () => {
  const firstRuns = [
    { agent: 'claude', instanceId: OPUS, runnerId: 'runner-opus', status: 'completed' },
    { agent: 'claude', instanceId: SONNET, runnerId: 'runner-sonnet', status: 'failed' },
  ]
  const duplicateContextRun = { agent: 'claude', instanceId: OPUS, runnerId: 'runner-context', status: 'completed' }
  const states = new Map([
    ['source', { runs: firstRuns }],
    ['context', { runs: [duplicateContextRun] }],
  ])
  const step = {
    id: 'continue',
    submit: 'follow-up',
    input: [{ step: 'source' }, { step: 'context' }],
  }

  assert.strictEqual(continuationSourceRuns(step, states), firstRuns)
  const inherited = completedContinuationRuns(step, states)
  assert.deepEqual(inherited.map((run) => run.runnerId), ['runner-opus'])
  assert.equal(continuationRunForInstance(inherited, { agent: 'claude', id: OPUS }).runnerId, 'runner-opus')
})

test('follow-up matches legacy source runs by derived model and effort identity', () => {
  const inherited = [
    { agent: 'claude', model: 'claude-opus-5', runnerId: 'runner-opus', status: 'completed' },
    { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'high', runnerId: 'runner-sonnet', status: 'completed' },
  ]

  assert.equal(
    continuationRunForInstance(inherited, { agent: 'claude', id: OPUS }).runnerId,
    'runner-opus',
  )
  assert.equal(
    continuationRunForInstance(inherited, { agent: 'claude', id: 'claude:claude-sonnet-4-5:high' }).runnerId,
    'runner-sonnet',
  )
})

test('follow-up with no successful continuation source fails instead of starting fresh runners', () => {
  const step = { id: 'continue', submit: 'follow-up', input: [{ step: 'source' }] }
  const states = new Map([['source', { runs: [{ agent: 'claude', instanceId: OPUS, runnerId: 'runner-opus', status: 'failed' }] }]])
  assert.throws(
    () => completedContinuationRuns(step, states),
    (error) => {
      const typed = /** @type {{ code?: string, sourceStepId?: string }} */ (error)
      return typed.code === 'NAX_FOLLOWUP_SOURCE_UNAVAILABLE' && typed.sourceStepId === 'source'
    },
  )
})

test('run updates are merged by instance id when one provider has multiple runners', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-multi-execution-'))
  fs.mkdirSync(path.join(projectRoot, '.netlify'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, '.netlify', 'state.json'), JSON.stringify({ siteId: 'site-1' }))
  const step = { id: 'review', title: 'Review', waitFor: 'agent-results', agents: ['claude'] }
  const stepState = {
    ...step,
    status: 'running',
    runs: [
      { agent: 'claude', instanceId: OPUS, runnerId: 'runner-opus', status: 'submitted' },
      { agent: 'claude', instanceId: SONNET, runnerId: 'runner-sonnet', status: 'submitted' },
    ],
  }
  const runState = {
    schemaVersion: 1,
    runId: 'run-multi',
    flowId: 'review',
    flowTitle: 'Review',
    transport: 'netlify-api',
    projectRoot,
    status: 'running',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    dir: path.join(projectRoot, '.nax', 'workflows', 'run-multi'),
    steps: [stepState],
  }

  await waitForLocalRunSubset({
    runState,
    stepState,
    step,
    runs: [stepState.runs[1]],
    reporter: reporter(),
    options: { timeoutMinutes: 1 },
    projectRoot,
    netlify: { siteId: 'site-1', env: {} },
    waitForAgentRuns: async ({ runs, onProgress, onTerminalRun }) => {
      const failedAttempt = { ...runs[0], status: 'failed', resultText: 'temporary capacity failure' }
      onTerminalRun(failedAttempt)
      onProgress({
        retry: true,
        run: { ...runs[0], status: 'submitted', sessionId: 'session-retry' },
        state: 'retrying',
      })
      const terminal = { ...runs[0], status: 'completed', resultText: 'sonnet result' }
      onTerminalRun(terminal)
      return [terminal]
    },
  })

  assert.equal(localRunIndex(stepState.runs, { agent: 'claude', instanceId: OPUS, runnerId: 'replacement' }), 0)
  assert.deepEqual(stepState.runs.map((run) => [run.instanceId, run.status]), [
    [OPUS, 'submitted'],
    [SONNET, 'completed'],
  ])
})
