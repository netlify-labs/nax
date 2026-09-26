// Verifies mid-step resume: keep completed instances, poll in-flight ones, resubmit only failures.
// Real temp run state and prompt files; only the Agent Runner boundary and remote SHA lookup are injected.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { resumeLocalFlow } = require('../../src/workflows/engine/local-executor')
const { flowDigest } = require('../../src/workflows/catalog/flow-manifest')

const RUN_SHA = 'a'.repeat(40)

/** @param {Array<Record<string, unknown>>} runs @param {{ steps?: number, stepStatus?: string }} [options] */
function fixture(runs, { steps = 1, stepStatus = 'running' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-resume-mid-step-'))
  fs.writeFileSync(path.join(projectRoot, 'review.md'), '---\ntitle: Review\n---\n\nReview it.\n')
  fs.writeFileSync(path.join(projectRoot, 'summarize.md'), '---\ntitle: Summarize\n---\n\nSummarize it.\n')
  const lineup = ['claude', 'gemini', 'codex', 'opencode']
  const flowSteps = [
    { id: 'review', title: 'Review', action: 'issue', submit: 'new-run', waitFor: 'agent-results', prompt: 'review.md', agents: lineup, lineup },
    { id: 'summarize', title: 'Summarize', action: 'issue', submit: 'new-run', waitFor: 'agent-results', prompt: 'summarize.md', agents: ['codex'], lineup: ['codex'], input: [{ step: 'review', results: 'all' }] },
  ].slice(0, steps)
  const flow = { id: 'resume-flow', title: 'Resume flow', dir: projectRoot, defaults: {}, steps: flowSteps }
  const runState = {
    schemaVersion: 1,
    runId: 'run-mid-step',
    flowId: flow.id,
    flow,
    flowDigest: flowDigest(/** @type {import('../../src/types').WorkflowFlow} */ (flow)),
    transport: 'netlify-api',
    projectRoot,
    status: 'interrupted',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:00:00.000Z',
    dir: path.join(projectRoot, '.nax', 'workflows', 'run-mid-step'),
    target: { branch: 'main', ref: 'origin/main', sha: RUN_SHA, sourceType: 'explicit-branch', verified: true, caveats: [] },
    branch: 'main',
    options: { branch: 'main', netlifySiteId: 'site_test', autoContext: false, timeoutMinutes: 1 },
    steps: [{ id: 'review', title: 'Review', action: 'issue', agents: lineup, status: stepStatus, runs }],
  }
  return { projectRoot, flow, runState }
}

/** @param {string} agent @param {Record<string, unknown>} run */
function saved(agent, run) {
  return { transport: 'netlify-api', agent, instanceId: `${agent}:auto:auto`, attemptId: `${agent}-a1`, supersedesAttemptId: null, promptText: `Saved prompt for ${agent}`, compactPromptText: '', raw: { stepId: 'review', workflowRunId: 'run-mid-step' }, ...run }
}

/**
 * @typedef {typeof import('../../src/integrations/netlify/local-runner').submitLocalAgentRun} SubmitAgentRun
 * @typedef {typeof import('../../src/integrations/netlify/local-runner').waitForLocalAgentRuns} WaitForAgentRuns
 */

function boundary() {
  /** @type {import('../../src/types').AgentRun[]} */
  const submitted = []
  /** @type {string[]} */
  const polled = []
  /** @type {SubmitAgentRun} */
  const submitAgentRun = async ({ run }) => {
    submitted.push(run)
    return { ...run, status: 'submitted', runnerId: `new-${run.agent}`, sessionId: `session-${run.agent}` }
  }
  /** @type {WaitForAgentRuns} */
  const waitForAgentRuns = async ({ runs = [], onProgress = () => {}, onTerminalRun = () => {} } = {}) => {
    const run = runs[0]
    if (!String(run.runnerId).startsWith('new-')) polled.push(String(run.runnerId))
    const completed = { ...run, status: 'completed', resultText: `result from ${run.agent}` }
    onProgress({ run: completed, state: 'completed', terminal: true, terminalSuccess: true })
    onTerminalRun(completed)
    return [completed]
  }
  return { submitted, polled, submitAgentRun, waitForAgentRuns, resolveRemoteSha: () => RUN_SHA }
}

test('3 of 4 completed and 1 failed: resume resubmits exactly the failed instance with its saved prompt', async () => {
  const { projectRoot, flow, runState } = fixture([
    saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
    saved('gemini', { status: 'completed', runnerId: 'r-gemini', resultText: 'gemini done' }),
    saved('codex', { status: 'failed', runnerId: 'r-codex', error: 'The Codex model is currently at capacity.' }),
    saved('opencode', { status: 'completed', runnerId: 'r-opencode', resultText: 'opencode done' }),
  ])
  const io = boundary()
  await resumeLocalFlow({ flow, runState, projectRoot, ...io })
  assert.deepEqual(io.submitted.map((run) => run.agent), ['codex'])
  assert.equal(io.submitted[0].promptText, 'Saved prompt for codex')
  assert.equal(io.submitted[0].supersedesAttemptId, 'codex-a1')
  const step = runState.steps[0]
  assert.equal(step.status, 'completed')
  assert.equal(step.runs[0].resultText, 'claude done')
  assert.deepEqual((step.attempts || []).map((attempt) => attempt.attemptId), ['codex-a1'])
  assert.equal(runState.status, 'completed')
})

test('an in-flight instance is polled, not resubmitted', async () => {
  const { projectRoot, flow, runState } = fixture([
    saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
    saved('gemini', { status: 'running', runnerId: 'r-gemini' }),
    saved('codex', { status: 'completed', runnerId: 'r-codex', resultText: 'codex done' }),
    saved('opencode', { status: 'completed', runnerId: 'r-opencode', resultText: 'opencode done' }),
  ])
  const io = boundary()
  await resumeLocalFlow({ flow, runState, projectRoot, ...io })
  assert.equal(io.submitted.length, 0)
  assert.deepEqual(io.polled, ['r-gemini'])
  assert.equal(runState.steps[0].status, 'completed')
})

test('a partial final step resumes and resubmits only the failed instance', async () => {
  const { projectRoot, flow, runState } = fixture([
    saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
    saved('gemini', { status: 'failed', runnerId: 'r-gemini' }),
    saved('codex', { status: 'completed', runnerId: 'r-codex', resultText: 'codex done' }),
    saved('opencode', { status: 'completed', runnerId: 'r-opencode', resultText: 'opencode done' }),
  ], { stepStatus: 'completed_with_failures' })
  runState.status = 'failed'
  const io = boundary()
  await resumeLocalFlow({ flow, runState, projectRoot, ...io })
  assert.deepEqual(io.submitted.map((run) => run.agent), ['gemini'])
  assert.equal(runState.steps[0].status, 'completed')
})

test('a submission sent without a saved runner stops resume with zero submissions', async () => {
  const { projectRoot, flow, runState } = fixture([
    saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
    saved('gemini', { status: 'pending', runnerId: '', sentAt: '2026-09-25T12:01:00.000Z' }),
  ])
  const io = boundary()
  await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, ...io }), (error) => /** @type {{ code?: string }} */ (error).code === 'resume_ambiguous_submission')
  assert.equal(io.submitted.length, 0)
})

test('a moved branch head refuses unless forced', async () => {
  const runs = [saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'done' }), saved('codex', { status: 'failed', runnerId: 'r-codex' })]
  const first = fixture(runs)
  const io = { ...boundary(), resolveRemoteSha: () => 'b'.repeat(40) }
  await assert.rejects(resumeLocalFlow({ ...first, ...io }), (error) => /** @type {{ code?: string }} */ (error).code === 'branch_moved_since_run')
  assert.equal(io.submitted.length, 0)
  const second = fixture(runs)
  await resumeLocalFlow({ ...second, ...io, force: true })
  assert.deepEqual(io.submitted.map((run) => run.agent), ['codex'])
})

test('a flow edited since the run started refuses', async () => {
  const { projectRoot, flow, runState } = fixture([saved('claude', { status: 'failed', runnerId: 'r-claude' })])
  const io = boundary()
  await assert.rejects(
    resumeLocalFlow({ flow, runState, projectRoot, ...io, currentFlowDigest: 'f'.repeat(64) }),
    (error) => /** @type {{ code?: string }} */ (error).code === 'flow_changed_since_run',
  )
  assert.equal(io.submitted.length, 0)
})

test('a run another live process owns refuses with run_locked and submits nothing', async () => {
  const { runLockDir } = require('../../src/storage/local/run-lock')
  const { projectRoot, flow, runState } = fixture([saved('claude', { status: 'failed', runnerId: 'r-claude' })])
  fs.mkdirSync(runLockDir(runState.dir), { recursive: true })
  fs.writeFileSync(path.join(runLockDir(runState.dir), 'owner.json'), JSON.stringify({ pid: process.ppid, hostname: os.hostname(), nonce: 'dashboard', command: 'nax dashboard' }))
  const io = boundary()
  await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, ...io }), (error) => /** @type {{ code?: string }} */ (error).code === 'run_locked')
  assert.equal(io.submitted.length, 0)
  await resumeLocalFlow({ flow, runState, projectRoot, ...io, forceUnlock: true })
  assert.deepEqual(io.submitted.map((run) => run.agent), ['claude'])
  assert.equal(fs.existsSync(runLockDir(runState.dir)), false)
})

test('a resume that ends on failed instances records the failure code and releases its lock', async () => {
  const { runLockDir } = require('../../src/storage/local/run-lock')
  const { isExplicitlyResumableRun } = require('../../src/core/runs/resumable')
  const { projectRoot, flow, runState } = fixture([
    saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
    saved('codex', { status: 'failed', runnerId: 'r-codex' }),
  ])
  const io = boundary()
  /** @type {WaitForAgentRuns} */
  const failingWait = async ({ runs = [], onTerminalRun = () => {} } = {}) => {
    const failed = { ...runs[0], status: 'failed', resultText: 'still at capacity' }
    onTerminalRun(failed)
    return [failed]
  }
  await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, ...io, waitForAgentRuns: failingWait }), (error) => /** @type {{ code?: string }} */ (error).code === 'NAX_PARTIAL_FINAL_STEP')
  assert.equal(runState.status, 'failed')
  assert.equal(runState.failureCode, 'NAX_PARTIAL_FINAL_STEP')
  assert.equal(isExplicitlyResumableRun(runState), true)
  assert.equal(fs.existsSync(runLockDir(runState.dir)), false)
})

test('an ambiguous create during resume is recorded so the next resume stops instead of duplicating', async () => {
  const { projectRoot, flow, runState } = fixture([
    saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
    saved('codex', { status: 'failed', runnerId: 'r-codex' }),
  ])
  const io = boundary()
  /** @type {SubmitAgentRun} */
  const ambiguousSubmit = async () => {
    throw Object.assign(new Error('Agent Runner create may have succeeded.'), { code: 'create-ambiguous' })
  }
  await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, ...io, submitAgentRun: ambiguousSubmit }))
  const codex = runState.steps[0].runs[1]
  assert.equal(/** @type {Record<string, unknown>} */ (codex.raw)?.submissionErrorCode, 'create-ambiguous')
  await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, ...io }), (error) => /** @type {{ code?: string }} */ (error).code === 'resume_ambiguous_submission')
  assert.equal(io.submitted.length, 0)
})

test('a moved branch does not block continuing into later steps when nothing in the resumed step is resubmitted', async () => {
  const { projectRoot, flow, runState } = fixture([
    saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
    saved('gemini', { status: 'failed', runnerId: 'r-gemini' }),
  ], { steps: 2, stepStatus: 'completed_with_failures' })
  runState.flowDigest = flowDigest(/** @type {import('../../src/types').WorkflowFlow} */ (flow))
  const io = { ...boundary(), resolveRemoteSha: () => 'b'.repeat(40) }
  await resumeLocalFlow({ flow, runState, projectRoot, ...io })
  assert.deepEqual(io.submitted.map((run) => run.raw?.stepId), ['summarize'])
})

test('a resume refusal leaves the run status untouched and releases the lock', async () => {
  const { runLockDir } = require('../../src/storage/local/run-lock')
  const { projectRoot, flow, runState } = fixture([
    saved('claude', { status: 'completed', runnerId: 'r-claude', resultText: 'claude done' }),
    saved('gemini', { status: 'pending', runnerId: '', sentAt: '2026-09-25T12:01:00.000Z' }),
  ])
  const io = boundary()
  await assert.rejects(resumeLocalFlow({ flow, runState, projectRoot, ...io }), (error) => /** @type {{ code?: string }} */ (error).code === 'resume_ambiguous_submission')
  assert.equal(runState.status, 'interrupted')
  assert.equal(fs.existsSync(runLockDir(runState.dir)), false)
})
