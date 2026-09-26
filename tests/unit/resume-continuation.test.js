// Verifies resume continues after a partially successful step instead of re-running (and re-billing) it.
// Uses real temp run state and flow files; only the Agent Runner network boundary is injected.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { resumeLocalFlow } = require('../../src/workflows/engine/local-executor')
const { firstRunnableStepIndex, completedStepMapFromRunState } = require('../../src/workflows/engine/execution-context')

function fixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-resume-continuation-'))
  fs.writeFileSync(path.join(projectRoot, 'review.md'), '---\ntitle: Review\n---\n\nReview it.\n')
  fs.writeFileSync(path.join(projectRoot, 'summarize.md'), '---\ntitle: Summarize\n---\n\nSummarize it.\n')
  const flow = {
    id: 'two-step',
    title: 'Two step',
    dir: projectRoot,
    defaults: {},
    steps: [
      { id: 'review', title: 'Review', action: 'issue', submit: 'new-run', waitFor: 'agent-results', prompt: 'review.md', agents: ['claude', 'codex'], lineup: ['claude', 'codex'] },
      { id: 'summarize', title: 'Summarize', action: 'issue', submit: 'new-run', waitFor: 'agent-results', prompt: 'summarize.md', agents: ['codex'], lineup: ['codex'], input: [{ step: 'review', results: 'all' }] },
    ],
  }
  const runState = {
    schemaVersion: 1,
    runId: 'run-resume-continuation',
    flowId: flow.id,
    flowTitle: flow.title,
    flow,
    transport: 'netlify-api',
    projectRoot,
    status: 'interrupted',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:00:00.000Z',
    dir: path.join(projectRoot, '.nax', 'workflows', 'run-resume-continuation'),
    target: { branch: 'main', ref: 'origin/main', sha: 'a'.repeat(40), sourceType: 'explicit-branch', verified: true, caveats: [] },
    branch: 'main',
    options: { branch: 'main', netlifySiteId: 'site_test', autoContext: false, timeoutMinutes: 1 },
    steps: [{
      id: 'review',
      title: 'Review',
      action: 'issue',
      agents: ['claude', 'codex'],
      status: 'completed_with_failures',
      runs: [
        { agent: 'claude', instanceId: 'claude:auto:auto', status: 'completed', runnerId: 'runner-claude', sessionId: 'session-claude', resultText: 'Claude review result.' },
        { agent: 'codex', instanceId: 'codex:auto:auto', status: 'failed', error: 'model at capacity' },
      ],
    }],
  }
  return { projectRoot, flow, runState }
}

test('resume after a completed_with_failures step starts at the next step and never resubmits step 1', async () => {
  const { projectRoot, flow, runState } = fixture()
  /** @type {string[]} */
  const submittedSteps = []
  /** @type {string[]} */
  const prompts = []
  await resumeLocalFlow({
    flow,
    runState,
    projectRoot,
    submitAgentRun: async ({ run }) => {
      submittedSteps.push(String(run.raw?.stepId || ''))
      prompts.push(String(run.promptText || ''))
      return { ...run, status: 'submitted', runnerId: `runner-${submittedSteps.length}`, sessionId: `session-${submittedSteps.length}` }
    },
    waitForAgentRuns: async ({ runs, onProgress, onTerminalRun }) => {
      const completed = { ...runs[0], status: 'completed', resultText: 'Summary result.' }
      onProgress({ run: completed, state: 'completed', terminal: true, terminalSuccess: true })
      onTerminalRun(completed)
      return [completed]
    },
    resolveRemoteSha: () => 'a'.repeat(40),
  })
  assert.deepEqual(submittedSteps, ['summarize'])
  assert.match(prompts[0], /Claude review result\./)
  assert.equal(runState.steps.filter((step) => step.id === 'review').length, 1)
  assert.equal(runState.status, 'completed')
})

test('a partial final step is still the resume start index; a partial earlier step is not', () => {
  const { flow, runState } = fixture()
  assert.equal(firstRunnableStepIndex(flow, runState), 1)
  assert.equal(completedStepMapFromRunState(runState).has('review'), true)
  const singleStep = { ...flow, steps: [flow.steps[0]] }
  assert.equal(firstRunnableStepIndex(singleStep, runState), 0)
})

test('an interrupted run whose earlier step finished with survivors is still unfinished', () => {
  const { isUnfinishedRun } = require('../../src/core/runs/resumable')
  const { runState } = fixture()
  assert.equal(isUnfinishedRun(runState), true)
  const finished = { ...runState, steps: [...runState.steps, { id: 'summarize', status: 'completed', runs: [{ status: 'completed', resultText: 'done' }] }] }
  assert.equal(isUnfinishedRun(finished), false)
})

test('re-executing a saved step reuses its record: one entry per id and a stable NN- artifact dir', async () => {
  const { executeLocalFlow } = require('../../src/workflows/engine/local-executor')
  const { projectRoot, flow, runState } = fixture()
  const review = /** @type {Record<string, unknown>} */ (runState.steps[0])
  review.status = 'failed'
  review.runs = [{ agent: 'claude', instanceId: 'claude:auto:auto', status: 'failed' }, { agent: 'codex', instanceId: 'codex:auto:auto', status: 'failed' }]
  runState.steps.push({ id: 'summarize', title: 'Summarize', action: 'issue', agents: ['codex'], status: 'running', runs: [] })
  await executeLocalFlow({
    flow,
    steps: [flow.steps[0]],
    options: runState.options,
    runState,
    projectRoot,
    submitAgentRun: async ({ run }) => ({ ...run, status: 'submitted', runnerId: `runner-${run.agent}`, sessionId: `session-${run.agent}` }),
    waitForAgentRuns: async ({ runs, onProgress, onTerminalRun }) => {
      const completed = { ...runs[0], status: 'completed', resultText: `${runs[0].agent} result` }
      onProgress({ run: completed, state: 'completed', terminal: true, terminalSuccess: true })
      onTerminalRun(completed)
      return [completed]
    },
  })
  assert.deepEqual(runState.steps.map((step) => step.id), ['review', 'summarize'])
  assert.equal(runState.steps[0].status, 'completed')
  const stepsDir = path.join(runState.dir, 'artifacts', 'steps')
  assert.ok(fs.readdirSync(stepsDir).includes('01-review'))
  assert.ok(!fs.readdirSync(stepsDir).some((name) => /^0[3-9]-review$/.test(name)))
})
