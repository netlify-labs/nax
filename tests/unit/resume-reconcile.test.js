// Verifies the pure resume decision table: keep, poll, resubmit, submit, skip, or stop the whole resume.
// Covers every row of the mid-step resume plan plus follow-up source loss and flow-change detection.
const test = require('node:test')
const assert = require('node:assert/strict')

const { reconcileStepInstances } = require('../../src/workflows/engine/resume')

const flowStep = { id: 'review', submit: 'new-run', agents: ['claude', 'codex'] }

/** @param {Array<Record<string, unknown>>} runs @param {Record<string, unknown>} [extra] */
function reconcile(runs, extra = {}) {
  return reconcileStepInstances({
    stepState: { id: 'review', status: 'running', runs },
    flowStep,
    completedStepStates: new Map(),
    runState: { runId: 'run-1', flowDigest: 'd1' },
    currentFlowDigest: 'd1',
    ...extra,
  })
}

/** @param {Record<string, unknown>} run */
function base(run) {
  return { agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'a1', promptText: 'Review it.', ...run }
}

/** @param {ReturnType<typeof reconcile>} result */
function actionsOf(result) {
  return result.actions.map((action) => action.action)
}

test('completed with result keeps; submitted/running with a runner polls', () => {
  const result = reconcile([
    base({ instanceId: 'claude:auto:auto', agent: 'claude', status: 'completed', resultText: 'done' }),
    base({ status: 'running', runnerId: 'r1' }),
  ])
  assert.equal(result.stop, null)
  assert.deepEqual(actionsOf(result), ['keep', 'poll'])
})

test('transient or unknown failures resubmit with the saved prompt', () => {
  const result = reconcile([base({ status: 'failed', error: 'The Codex model is currently at capacity.' }), base({ instanceId: 'claude:auto:auto', status: 'timeout' })])
  assert.deepEqual(actionsOf(result), ['resubmit', 'resubmit'])
  assert.equal(result.actions[0].useCompactPrompt, false)
})

test('auth failures stop the whole resume before any submission', () => {
  const result = reconcile([base({ status: 'failed', error: 'Agent Runner API request failed with status 401: token expired' }), base({ instanceId: 'claude:auto:auto', status: 'failed' })])
  assert.equal(result.stop?.code, 'resume_auth_failure')
})

test('prompt_too_large resubmits with the compact prompt, or skips when there is none', () => {
  const withCompact = reconcile([base({ status: 'failed', error: 'fork/exec /opt/build-bin/agent-runner: argument list too long', compactPromptText: 'short' })])
  assert.deepEqual(actionsOf(withCompact), ['resubmit'])
  assert.equal(withCompact.actions[0].useCompactPrompt, true)
  const without = reconcile([base({ status: 'failed', error: 'fork/exec /opt/build-bin/agent-runner: argument list too long' })])
  assert.deepEqual(actionsOf(without), ['skip'])
  assert.match(without.actions[0].reason, /no shorter prompt/)
})

test('cancelled runs skip unless includeCancelled', () => {
  assert.deepEqual(actionsOf(reconcile([base({ status: 'cancelled' })])), ['skip'])
  assert.deepEqual(actionsOf(reconcile([base({ status: 'cancelled' })], { includeCancelled: true })), ['resubmit'])
})

test('a pending run never sent is submitted', () => {
  assert.deepEqual(actionsOf(reconcile([base({ status: 'pending' })])), ['submit'])
})

test('a pending run that was sent but has no runner stops resume unless forced', () => {
  const run = base({ status: 'pending', sentAt: '2026-09-25T12:00:00.000Z' })
  const stopped = reconcile([run])
  assert.equal(stopped.stop?.code, 'resume_ambiguous_submission')
  assert.match(stopped.stop?.message || '', /codex:auto:auto.*2026-09-25T12:00:00.000Z/)
  const forced = reconcile([run], { force: true })
  assert.equal(forced.stop, null)
  assert.deepEqual(actionsOf(forced), ['resubmit'])
})

test('a saved step without a manifest cannot be resumed exactly', () => {
  const result = reconcile([])
  assert.equal(result.stop?.code, 'resume_plan_unavailable')
  assert.match(result.stop?.message || '', /--from-step review/)
})

test('a flow that changed since the run started refuses; legacy runs without a digest proceed with a note', () => {
  const changed = reconcile([base({ status: 'failed' })], { currentFlowDigest: 'd2' })
  assert.equal(changed.stop?.code, 'flow_changed_since_run')
  const legacy = reconcile([base({ status: 'failed' })], { runState: { runId: 'run-1' }, currentFlowDigest: 'd2' })
  assert.equal(legacy.stop, null)
  assert.match(legacy.notes.join('\n'), /flow change detection unavailable/)
})

test('follow-up instances continue their source runner, or skip when the source did not survive', () => {
  const followStep = { id: 'cross', submit: 'follow-up', input: [{ step: 'review' }] }
  const source = { id: 'review', status: 'completed_with_failures', runs: [
    { agent: 'claude', instanceId: 'claude:auto:auto', status: 'completed', runnerId: 'src-claude', resultText: 'ok' },
    { agent: 'codex', instanceId: 'codex:auto:auto', status: 'failed' },
  ] }
  const result = reconcileStepInstances({
    stepState: { id: 'cross', status: 'running', runs: [
      base({ agent: 'claude', instanceId: 'claude:auto:auto', status: 'failed' }),
      base({ status: 'failed' }),
    ] },
    flowStep: followStep,
    completedStepStates: new Map([['review', source]]),
    runState: { runId: 'run-1', flowDigest: 'd1' },
    currentFlowDigest: 'd1',
  })
  assert.deepEqual(actionsOf(result), ['resubmit', 'skip'])
  assert.equal(result.actions[0].existingRunnerId, 'src-claude')
  assert.match(result.actions[1].reason, /source_unavailable/)
})
