const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { buildRunDetails } = require('../../src/visualize-run-details')
const { flowToGraph } = require('../../src/visualize-graph')
const { listRunStates, workflowStatePath } = require('../../src/run-state')
const {
  cancelFollowupRunInWorkflow,
  followupStepTitle,
  freshAgentFlow,
  persistFreshPseudoWorkflow,
  submittedStepStatus,
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

test('followupStepTitle prefixes visualizer follow-up steps', () => {
  assert.equal(
    followupStepTitle({ stepTitle: 'Synthesize Security Findings' }, [{ agent: 'codex' }]),
    'Follow up: Synthesize Security Findings (codex)',
  )
  assert.equal(
    followupStepTitle({ stepTitle: 'Audit Security' }, [{ agent: 'codex' }, { agent: 'gemini' }]),
    'Follow up: Audit Security (2 agents)',
  )
})

test('freshAgentFlow creates a one-step visualizer flow definition', () => {
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
  assert.equal(state.source.type, 'visualizer-followup')
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
  assert.equal(result.runState.steps[0].runs[0].raw.cancelSource, 'visualizer')

  const listed = listRunStates(projectRoot)
  assert.equal(listed[0].steps[0].runs[0].status, 'cancelled')
})
