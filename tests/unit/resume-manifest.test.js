// Verifies the execution manifest (attemptId, supersedesAttemptId, sentAt, prompt) is saved before any remote call.
// Uses real temp run state; the Agent Runner boundary records the call and then throws.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { executeLocalFlow } = require('../../src/workflows/engine/local-executor')
const { readRunState, workflowStatePath } = require('../../src/storage/local/run-state')

function fixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-resume-manifest-'))
  fs.writeFileSync(path.join(projectRoot, 'review.md'), '---\ntitle: Review\n---\n\nReview it.\n')
  const step = { id: 'review', title: 'Review', action: 'issue', submit: 'new-run', waitFor: 'agent-results', prompt: 'review.md', agents: ['claude', 'codex'], lineup: ['claude', 'codex'] }
  const flow = { id: 'manifest-flow', title: 'Manifest', dir: projectRoot, defaults: {}, steps: [step] }
  const runState = {
    schemaVersion: 1,
    runId: 'run-manifest',
    flowId: flow.id,
    flow,
    transport: 'netlify-api',
    projectRoot,
    status: 'running',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:00:00.000Z',
    dir: path.join(projectRoot, '.nax', 'workflows', 'run-manifest'),
    target: { branch: 'main', ref: 'origin/main', sha: 'a'.repeat(40), sourceType: 'explicit-branch', verified: true, caveats: [] },
    branch: 'main',
    options: { branch: 'main', netlifySiteId: 'site_test', autoContext: false, timeoutMinutes: 1 },
    steps: [],
  }
  return { projectRoot, flow, step, runState }
}

test('every run is saved with prompt, attemptId and sentAt before the Agent Runner is called', async () => {
  const { projectRoot, flow, step, runState } = fixture()
  /** @type {Array<Record<string, unknown>>} */
  const seenOnDisk = []
  await assert.rejects(executeLocalFlow({
    flow,
    steps: [step],
    options: runState.options,
    runState,
    projectRoot,
    submitAgentRun: async ({ run }) => {
      const saved = readRunState(workflowStatePath(runState.dir))
      seenOnDisk.push(/** @type {Record<string, unknown>} */ (saved.steps[0].runs.find((candidate) => candidate.instanceId === run.instanceId)))
      throw new Error('network down after send')
    },
    waitForAgentRuns: async () => [],
  }))
  assert.equal(seenOnDisk.length, 2)
  for (const saved of seenOnDisk) {
    assert.match(String(saved.attemptId), /^[0-9a-f-]{36}$/)
    assert.equal(saved.supersedesAttemptId, null)
    assert.match(String(saved.sentAt), /^\d{4}-\d{2}-\d{2}T/)
    assert.match(String(saved.promptText), /Review it\./)
  }
  assert.notEqual(seenOnDisk[0].attemptId, seenOnDisk[1].attemptId)
})
