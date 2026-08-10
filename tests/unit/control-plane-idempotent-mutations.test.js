const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { mutationIntentHash, runIdempotentMutation } = require('../../src/control-plane/idempotent-mutations')
const { createLocalMutationStore, mutationPath } = require('../../src/dashboard/storage/local-mutations')

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-mutation-store-'))
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}

test('local mutation receipts persist claims and completed results across store instances', async () => {
  const projectRoot = tempRoot()
  const firstStore = createLocalMutationStore({ projectRoot, now: () => new Date('2026-08-08T12:00:00.000Z') })
  const intentHash = mutationIntentHash('agent-run-retry', { runId: 'run_01', agentRunId: 'agent_run_01' })
  const first = await firstStore.claim({ operation: 'agent-run-retry', requestId: 'request_01', intentHash })
  assert.equal(first.claimed, true)
  await firstStore.complete('agent-run-retry', 'request_01', { runId: 'run_02' })

  const restartedStore = createLocalMutationStore({ projectRoot, now: () => new Date('2026-08-08T12:01:00.000Z') })
  const replay = await restartedStore.claim({ operation: 'agent-run-retry', requestId: 'request_01', intentHash })
  assert.equal(replay.claimed, false)
  assert.equal(replay.record.status, 'completed')
  assert.deepEqual(replay.record.result, { runId: 'run_02' })
  assert.equal(fs.statSync(mutationPath(projectRoot, 'agent-run-retry', 'request_01')).mode & 0o777, 0o600)
})

test('idempotent mutation executes once, replays durably, and rejects changed intent', async () => {
  const projectRoot = tempRoot()
  const store = createLocalMutationStore({ projectRoot })
  let executions = 0
  const input = {
    store,
    operation: 'agent-run-followup',
    requestId: 'request_followup_01',
    intent: { runId: 'run_01', agentRunId: 'agent_run_01', prompt: 'Continue' },
    execute: async () => {
      executions += 1
      return { runId: 'run_followup', submissions: [{ runnerId: 'runner_01' }] }
    },
  }
  const first = await runIdempotentMutation(input)
  const replay = await runIdempotentMutation(input)
  assert.equal(executions, 1)
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.submissions, [{ runnerId: 'runner_01' }])

  await assert.rejects(
    () => runIdempotentMutation({ ...input, intent: { ...input.intent, prompt: 'Changed' } }),
    (error) => errorCode(error) === 'idempotency_conflict',
  )
})

test('an in-progress durable receipt never blindly submits a second mutation', async () => {
  const store = createLocalMutationStore({ projectRoot: tempRoot() })
  const intent = { runId: 'run_01', agentRunId: 'agent_run_01' }
  await store.claim({ operation: 'agent-run-retry', requestId: 'request_01', intentHash: mutationIntentHash('agent-run-retry', intent) })
  let executions = 0
  await assert.rejects(
    () => runIdempotentMutation({ store, operation: 'agent-run-retry', requestId: 'request_01', intent, execute: async () => { executions += 1; return {} } }),
    (error) => errorCode(error) === 'mutation_in_progress',
  )
  assert.equal(executions, 0)
})

test('failed mutations replay the same bounded failure instead of retransmitting', async () => {
  const store = createLocalMutationStore({ projectRoot: tempRoot() })
  let executions = 0
  const input = {
    store,
    operation: 'agent-run-retry',
    requestId: 'request_01',
    intent: { runId: 'run_01', agentRunId: 'agent_run_01' },
    execute: async () => {
      executions += 1
      throw Object.assign(new Error('Target is active.'), { code: 'retry_run_not_terminal', recoverable: true, details: { runId: 'run_01' } })
    },
  }
  await assert.rejects(() => runIdempotentMutation(input), (error) => errorCode(error) === 'retry_run_not_terminal')
  await assert.rejects(
    () => runIdempotentMutation(input),
    (error) => errorCode(error) === 'retry_run_not_terminal' && Boolean(error && typeof error === 'object' && 'details' in error && error.details && typeof error.details === 'object' && 'replayed' in error.details),
  )
  assert.equal(executions, 1)
})

test('mutation receipts reject credential-shaped response fields', async () => {
  const store = createLocalMutationStore({ projectRoot: tempRoot() })
  await store.claim({ operation: 'agent-run-retry', requestId: 'request_01', intentHash: 'hash_01' })
  await assert.rejects(
    () => store.complete('agent-run-retry', 'request_01', { authToken: 'must-not-persist' }),
    (error) => errorCode(error) === 'secret_field_rejected',
  )
})
