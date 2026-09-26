// Verifies superseded runs are archived as attempts with lineage and artifact links.
// Uses real temp run directories so attempt artifact files exist on disk.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { supersedeRun } = require('../../src/workflows/engine/attempts')
const { persistRunArtifact } = require('../../src/workflows/artifacts/workflow-artifacts')

function fixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-attempts-'))
  const failed = {
    agent: 'codex',
    instanceId: 'codex:auto:auto',
    attemptId: 'attempt-1',
    supersedesAttemptId: null,
    status: 'failed',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    sentAt: '2026-09-25T12:00:00.000Z',
    error: 'model at capacity',
    raw: { failurePhase: 'wait', stepId: 'review' },
    usage: { totalCreditsCost: 3, totalTokens: 100 },
    resultText: 'partial output',
  }
  const step = { id: 'review', title: 'Review', status: 'failed', runs: [failed] }
  const runState = { runId: 'run-attempts', dir: path.join(projectRoot, '.nax', 'workflows', 'run-attempts'), steps: [step] }
  return { runState, step, failed }
}

test('supersedeRun archives the old attempt with lineage, usage and its attempt artifact path', () => {
  const { runState, step, failed } = fixture()
  persistRunArtifact(runState, step, failed)
  const replacement = { agent: 'codex', instanceId: 'codex:auto:auto', attemptId: 'attempt-2', status: 'pending' }
  supersedeRun(runState, step, 0, replacement)
  assert.equal(step.runs[0], replacement)
  assert.equal(replacement.supersedesAttemptId, 'attempt-1')
  assert.equal(step.attempts?.length, 1)
  const [archived] = step.attempts || []
  assert.deepEqual(
    { attemptId: archived.attemptId, status: archived.status, runnerId: archived.runnerId, failurePhase: archived.failurePhase, error: archived.error, sentAt: archived.sentAt },
    { attemptId: 'attempt-1', status: 'failed', runnerId: 'runner-1', failurePhase: 'wait', error: 'model at capacity', sentAt: '2026-09-25T12:00:00.000Z' },
  )
  assert.deepEqual(archived.usage, { totalCreditsCost: 3, totalTokens: 100 })
  assert.match(String(archived.resultTextPath), /agent-runners\/codex\.attempt-1\.md$/)
  assert.equal(Object.prototype.hasOwnProperty.call(archived, 'resultText'), false)
})

test('archiving the same attempt twice keeps one record', () => {
  const { runState, step } = fixture()
  supersedeRun(runState, step, 0, { agent: 'codex', attemptId: 'attempt-2', status: 'pending' })
  step.runs[0] = /** @type {typeof step.runs[0]} */ (/** @type {unknown} */ ({ agent: 'codex', attemptId: 'attempt-1', status: 'failed' }))
  supersedeRun(runState, step, 0, { agent: 'codex', attemptId: 'attempt-3', status: 'pending' })
  assert.deepEqual((step.attempts || []).map((attempt) => attempt.attemptId), ['attempt-1'])
})

test('resubmissionRun rebuilds delivery from the saved prompt and never reuses an expired blob ref', () => {
  const { resubmissionRun } = require('../../src/workflows/engine/attempts')
  const saved = /** @type {import('../../src/types').AgentRun} */ (/** @type {unknown} */ ({
    agent: 'codex',
    instanceId: 'codex:auto:auto',
    attemptId: 'a1',
    model: 'gpt-5.6-sol',
    status: 'failed',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    sdkHandle: { v: 1, runnerId: 'runner-1' },
    promptText: 'Full prompt',
    compactPromptText: 'Short prompt',
    promptDelivery: { mode: 'blob', blobRef: { store: 'nax-run', key: 'old-key', expiresAt: '2026-01-01T00:00:00.000Z', status: 'cleaned' } },
    blobRef: { store: 'nax-run', key: 'old-key' },
    resultText: 'error text',
    raw: { stepId: 'review', workflowRunId: 'run-1', submissionError: 'boom', failurePhase: 'wait' },
  }))
  const replacement = resubmissionRun(saved)
  assert.match(String(replacement.attemptId), /^[0-9a-f-]{36}$/)
  assert.notEqual(replacement.attemptId, 'a1')
  assert.equal(replacement.status, 'pending')
  assert.equal(replacement.promptText, 'Full prompt')
  assert.equal(replacement.runnerId, '')
  assert.equal(replacement.sessionId, '')
  assert.equal(replacement.sdkHandle, undefined)
  assert.equal(replacement.blobRef, undefined)
  assert.equal(JSON.stringify(replacement).includes('old-key'), false)
  assert.equal(replacement.model, 'gpt-5.6-sol')
  assert.equal(replacement.raw?.stepId, 'review')
  assert.equal(replacement.raw?.submissionError, undefined)
  const compact = resubmissionRun(saved, { useCompactPrompt: true, existingRunnerId: 'source-runner' })
  assert.equal(compact.promptText, 'Short prompt')
  assert.equal(compact.existingRunnerId, 'source-runner')
})
