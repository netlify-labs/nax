const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { buildRunDetails } = require('../../src/dashboard/shared/run-details')
const { flowToGraph } = require('../../src/dashboard/shared/graph')
const { listRunStates, workflowStatePath } = require('../../src/run-state')
const {
  appendFollowupRunsToWorkflow,
  cancelFollowupRunInWorkflow,
  followupStepTitle,
  freshAgentFlow,
  persistFreshPseudoWorkflow,
  submittedStepStatus,
  syncSubmittedFollowupRunsToWorkflow,
  uniqueAgents,
} = require('../../src/followup-persistence')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-followup-persistence-'))
}

test('uniqueAgents preserves first-seen submitted agent order', () => {
  assert.deepEqual(uniqueAgents([
    { agent: 'codex' },
    { agent: 'claude' },
    { agent: 'codex' },
    { agent: '' },
  ]), ['codex', 'claude'])
})

test('submittedStepStatus summarizes submitted run statuses', () => {
  assert.equal(submittedStepStatus([]), 'submitted')
  assert.equal(submittedStepStatus([{ status: 'submitted' }, { status: 'running' }]), 'submitted')
  assert.equal(submittedStepStatus([{ status: 'completed' }]), 'completed')
  assert.equal(submittedStepStatus([{ status: 'cancelled' }]), 'cancelled')
  assert.equal(submittedStepStatus([{ status: 'submitted' }, { status: 'cancelled' }]), 'submitted')
  assert.equal(submittedStepStatus([{ status: 'completed' }, { status: 'failed' }]), 'failed')
})

test('followupStepTitle prefixes dashboard follow-up steps', () => {
  assert.equal(
    followupStepTitle({ stepTitle: 'Synthesize Security Findings' }, [{ agent: 'codex' }]),
    'Follow-up 1: Synthesize Security Findings (codex)',
  )
  assert.equal(
    followupStepTitle({ stepTitle: 'Audit Security' }, [{ agent: 'codex' }, { agent: 'gemini' }], 2),
    'Follow-up 2: Audit Security (2 agents)',
  )
  assert.equal(
    followupStepTitle({ stepTitle: 'Step 4: Follow up: Synthesize Security Findings (codex) follow-up (codex)' }, [{ agent: 'codex' }], 3),
    'Follow-up 3: Synthesize Security Findings (codex)',
  )
})

test('freshAgentFlow creates a one-step dashboard flow definition', () => {
  const flow = freshAgentFlow({ title: 'Follow-up', stepTitle: 'Run agents' })
  assert.equal(flow.id, 'agent-run')
  assert.equal(flow.title, 'Follow-up')
  assert.equal(flow.steps.length, 1)
  assert.equal(flow.steps[0].id, 'fresh-agent-runner')
  assert.equal(flow.steps[0].submit, 'new-run')
})

test('persistFreshPseudoWorkflow writes a renderable one-step workflow state', () => {
  const projectRoot = tmpRoot()
  const now = new Date('2026-06-20T20:00:00.000Z')
  const state = persistFreshPseudoWorkflow({
    projectRoot,
    now,
    title: 'Follow-up Agent Run',
    stepTitle: 'Review follow-up',
    promptText: 'Check the fix.',
    target: { sha: 'abc123', branch: 'main' },
    source: {
      sourceRunId: 'source-run',
      sourceTargetId: 'target:codex',
    },
    runs: [
      {
        transport: 'netlify-api',
        agent: 'codex',
        status: 'submitted',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        issueUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-1?session=session-1',
        links: { runner: 'https://app.netlify.com/projects/site/agent-runs/runner-1?session=session-1' },
      },
    ],
  })

  assert.equal(state.runId, '2026-06-20T20-00-00-000Z-agent-run')
  assert.equal(state.source.type, 'dashboard-followup')
  assert.equal(state.source.mode, 'fresh-runner')
  assert.equal(state.steps[0].status, 'submitted')
  assert.deepEqual(state.steps[0].agents, ['codex'])
  assert.equal(state.steps[0].runs[0].runnerId, 'runner-1')

  assert.equal(fs.existsSync(workflowStatePath(state.dir)), true)
  const listed = listRunStates(projectRoot)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].runId, state.runId)

  const graph = flowToGraph({ flow: state.flow, runState: state })
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0].data.status, 'submitted')
  assert.equal(graph.nodes[0].data.runs[0].sessionId, 'session-1')

  const details = buildRunDetails(state)
  assert.match(details.summaryMarkdown, /Follow-up Agent Run|Agent Run/)
  assert.ok(details.followupTargets.some((target) => target.kind === 'workflow-summary'))
})

test('appendFollowupRunsToWorkflow numbers repeated follow-ups without duplicating title text', () => {
  const projectRoot = tmpRoot()
  const runDir = path.join(projectRoot, '.nax', 'workflows', 'source-run')
  fs.mkdirSync(runDir, { recursive: true })
  const runState = {
    runId: 'source-run',
    flowId: 'security-audit',
    flowTitle: 'Security Audit',
    status: 'completed',
    dir: runDir,
    flow: {
      id: 'security-audit',
      title: 'Security Audit',
      steps: [
        { id: 'synthesize', title: 'Synthesize Security Findings', agents: ['codex'], submit: 'new-run' },
      ],
    },
    steps: [{
      id: 'synthesize',
      title: 'Synthesize Security Findings',
      status: 'completed',
      agents: ['codex'],
      runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1' }],
    }],
  }

  const first = appendFollowupRunsToWorkflow({
    runState,
    now: new Date('2026-06-20T20:00:00.000Z'),
    target: { id: 'agent-result:synthesize:codex', stepId: 'synthesize', stepTitle: 'Synthesize Security Findings' },
    source: { id: 'followup-1' },
    runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-2' }],
  })
  const second = appendFollowupRunsToWorkflow({
    runState: first,
    now: new Date('2026-06-20T20:01:00.000Z'),
    target: { id: 'agent-result:dashboard-followup-1:codex', stepId: 'dashboard-followup-1', stepTitle: first.steps[1].title },
    source: { id: 'followup-2' },
    runs: [{ agent: 'codex', status: 'submitted', runnerId: 'runner-1', sessionId: 'session-3' }],
  })

  assert.deepEqual(second.steps.slice(1).map((step) => step.title), [
    'Follow-up 1: Synthesize Security Findings (codex)',
    'Follow-up 2: Synthesize Security Findings (codex)',
  ])
})

test('syncSubmittedFollowupRunsToWorkflow merges completed remote sessions into workflow state', () => {
  const projectRoot = tmpRoot()
  const runDir = path.join(projectRoot, '.nax', 'workflows', 'source-run')
  fs.mkdirSync(runDir, { recursive: true })
  const submitted = appendFollowupRunsToWorkflow({
    runState: {
      runId: 'source-run',
      flowId: 'security-audit',
      flowTitle: 'Security Audit',
      status: 'completed',
      projectRoot,
      dir: runDir,
      flow: {
        id: 'security-audit',
        title: 'Security Audit',
        steps: [
          { id: 'synthesize', title: 'Synthesize Security Findings', agents: ['codex'], submit: 'new-run' },
        ],
      },
      steps: [{
        id: 'synthesize',
        title: 'Synthesize Security Findings',
        status: 'completed',
        agents: ['codex'],
        runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1' }],
      }],
    },
    now: new Date('2026-06-20T20:00:00.000Z'),
    target: { id: 'agent-result:synthesize:codex', stepId: 'synthesize', stepTitle: 'Synthesize Security Findings' },
    source: { id: 'followup-1' },
    runs: [{ agent: 'codex', status: 'submitted', runnerId: 'runner-1', sessionId: 'session-2' }],
  })

  const synced = syncSubmittedFollowupRunsToWorkflow({
    runState: submitted,
    projectRoot,
    syncRunner: () => ({
      sessions: [{
        sessionId: 'session-2',
        runnerId: 'runner-1',
        agent: 'codex',
        status: 'completed',
        resultText: 'Remote result text.',
        updatedAt: '2026-06-20T20:02:00.000Z',
        links: { sessionUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-1?session=session-2' },
      }],
    }),
  })

  assert.equal(synced.changed, true)
  assert.equal(synced.runState.status, 'completed')
  assert.equal(synced.runState.steps[1].status, 'completed')
  assert.equal(synced.runState.steps[1].runs[0].status, 'completed')
  assert.equal(synced.runState.steps[1].runs[0].resultText, 'Remote result text.')
  assert.equal(listRunStates(projectRoot)[0].steps[1].runs[0].status, 'completed')
})

test('syncSubmittedFollowupRunsToWorkflow does not use runner-wide latest session without a run session id', () => {
  const projectRoot = tmpRoot()
  const runDir = path.join(projectRoot, '.nax', 'workflows', 'source-run')
  fs.mkdirSync(runDir, { recursive: true })
  const submitted = appendFollowupRunsToWorkflow({
    runState: {
      runId: 'source-run',
      flowId: 'security-audit',
      flowTitle: 'Security Audit',
      status: 'completed',
      projectRoot,
      dir: runDir,
      flow: {
        id: 'security-audit',
        title: 'Security Audit',
        steps: [
          { id: 'synthesize', title: 'Synthesize Security Findings', agents: ['codex'], submit: 'new-run' },
        ],
      },
      steps: [{
        id: 'synthesize',
        title: 'Synthesize Security Findings',
        status: 'completed',
        agents: ['codex'],
        runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1' }],
      }],
    },
    now: new Date('2026-06-20T20:00:00.000Z'),
    target: { id: 'agent-result:synthesize:codex', stepId: 'synthesize', stepTitle: 'Synthesize Security Findings' },
    source: { id: 'followup-1' },
    runs: [{ agent: 'codex', status: 'submitted', runnerId: 'runner-1', sessionId: '' }],
  })

  const synced = syncSubmittedFollowupRunsToWorkflow({
    runState: submitted,
    projectRoot,
    syncRunner: () => ({
      sessions: [{
        sessionId: 'session-1',
        runnerId: 'runner-1',
        agent: 'codex',
        status: 'completed',
        resultText: 'Older source session result.',
        updatedAt: '2026-06-20T20:02:00.000Z',
      }],
    }),
  })

  assert.equal(synced.changed, false)
  assert.equal(synced.runState.steps[1].runs[0].status, 'submitted')
  assert.equal(synced.runState.steps[1].runs[0].resultText, '')
})

test('syncSubmittedFollowupRunsToWorkflow renumbers existing completed follow-up titles', () => {
  const projectRoot = tmpRoot()
  const runDir = path.join(projectRoot, '.nax', 'workflows', 'source-run')
  fs.mkdirSync(runDir, { recursive: true })
  const state = {
    runId: 'source-run',
    flowId: 'security-audit',
    flowTitle: 'Security Audit',
    status: 'completed',
    projectRoot,
    dir: runDir,
    flow: {
      id: 'security-audit',
      title: 'Security Audit',
      steps: [
        { id: 'synthesize', title: 'Synthesize Security Findings', agents: ['codex'], submit: 'new-run' },
        { id: 'dashboard-followup-1', title: 'Follow up: Synthesize Security Findings (codex)', agents: ['codex'], submit: 'follow-up' },
        { id: 'dashboard-followup-2', title: 'Follow up: Synthesize Security Findings (codex) follow-up (codex)', agents: ['codex'], submit: 'follow-up' },
      ],
    },
    steps: [
      { id: 'synthesize', title: 'Synthesize Security Findings', status: 'completed', agents: ['codex'], runs: [] },
      {
        id: 'dashboard-followup-1',
        title: 'Follow up: Synthesize Security Findings (codex)',
        status: 'completed',
        source: { type: 'dashboard-followup' },
        agents: ['codex'],
        runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-2' }],
      },
      {
        id: 'dashboard-followup-2',
        title: 'Follow up: Synthesize Security Findings (codex) follow-up (codex)',
        status: 'completed',
        source: { type: 'dashboard-followup' },
        agents: ['codex'],
        runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-3' }],
      },
    ],
  }

  const synced = syncSubmittedFollowupRunsToWorkflow({ runState: state, projectRoot })

  assert.equal(synced.changed, true)
  assert.deepEqual(synced.runState.steps.slice(1).map((step) => step.title), [
    'Follow-up 1: Synthesize Security Findings (codex)',
    'Follow-up 2: Synthesize Security Findings (codex)',
  ])
  assert.deepEqual(synced.runState.flow.steps.slice(1).map((step) => step.title), [
    'Follow-up 1: Synthesize Security Findings (codex)',
    'Follow-up 2: Synthesize Security Findings (codex)',
  ])
})

test('cancelFollowupRunInWorkflow marks a submitted follow-up run cancelled', () => {
  const projectRoot = tmpRoot()
  const state = persistFreshPseudoWorkflow({
    projectRoot,
    now: new Date('2026-06-20T20:00:00.000Z'),
    title: 'Follow-up Agent Run',
    stepTitle: 'Review follow-up',
    promptText: 'Check the fix.',
    runs: [{
      transport: 'netlify-api',
      agent: 'codex',
      status: 'submitted',
      runnerId: 'runner-1',
      sessionId: 'session-1',
    }],
  })

  const result = cancelFollowupRunInWorkflow({
    runState: state,
    stepId: 'fresh-agent-runner',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    agent: 'codex',
    now: new Date('2026-06-20T20:01:00.000Z'),
  })

  assert.equal(result.changed, true)
  assert.equal(result.run.status, 'cancelled')
  assert.equal(result.runState.status, 'cancelled')
  assert.equal(result.runState.steps[0].status, 'cancelled')
  assert.equal(result.runState.steps[0].runs[0].raw.cancelSource, 'dashboard')

  const listed = listRunStates(projectRoot)
  assert.equal(listed[0].steps[0].runs[0].status, 'cancelled')
})

test('cancelFollowupRunInWorkflow rejects ambiguous runner-only active matches', () => {
  const projectRoot = tmpRoot()
  const state = persistFreshPseudoWorkflow({
    projectRoot,
    now: new Date('2026-06-20T20:00:00.000Z'),
    title: 'Follow-up Agent Run',
    stepTitle: 'Review follow-up',
    promptText: 'Check the fix.',
    runs: [
      { transport: 'netlify-api', agent: 'codex', status: 'submitted', runnerId: 'runner-1', sessionId: 'session-1' },
      { transport: 'netlify-api', agent: 'gemini', status: 'running', runnerId: 'runner-1', sessionId: 'session-2' },
    ],
  })

  assert.throws(() => cancelFollowupRunInWorkflow({
    runState: state,
    stepId: 'fresh-agent-runner',
    runnerId: 'runner-1',
    now: new Date('2026-06-20T20:01:00.000Z'),
  }), /Multiple active follow-up runs matched runner runner-1/)

  assert.deepEqual(state.steps[0].runs.map((run) => run.status), ['submitted', 'running'])
})

test('cancelFollowupRunInWorkflow prefers exact session matches and only cancels that run', () => {
  const projectRoot = tmpRoot()
  const state = persistFreshPseudoWorkflow({
    projectRoot,
    now: new Date('2026-06-20T20:00:00.000Z'),
    title: 'Follow-up Agent Run',
    stepTitle: 'Review follow-up',
    promptText: 'Check the fix.',
    runs: [
      { transport: 'netlify-api', agent: 'codex', status: 'submitted', runnerId: 'runner-1', sessionId: 'session-1' },
      { transport: 'netlify-api', agent: 'gemini', status: 'running', runnerId: 'runner-1', sessionId: 'session-2' },
    ],
  })

  const result = cancelFollowupRunInWorkflow({
    runState: state,
    stepId: 'fresh-agent-runner',
    runnerId: 'runner-1',
    sessionId: 'session-2',
    now: new Date('2026-06-20T20:01:00.000Z'),
  })

  assert.equal(result.changed, true)
  assert.equal(result.run.sessionId, 'session-2')
  assert.deepEqual(result.runState.steps[0].runs.map((run) => run.status), ['submitted', 'cancelled'])
})
