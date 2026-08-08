import assert from 'node:assert/strict'
import test from 'node:test'
import { projectWorkflowGraph } from '../../src/dashboard/web/src/run-projection'
import type { WorkflowGraph } from '../../src/dashboard/web/src/types'

function graphWithStep(step: Partial<WorkflowGraph['nodes'][number]['data']>): WorkflowGraph {
  const instances = ['claude', 'gemini', 'codex'].map((agent) => ({
    agent,
    id: `${agent}:auto:auto`,
    resolvedFrom: 'open' as const,
  }))
  return {
    nodes: [{
      id: step.stepId || 'review',
      type: 'workflowStep',
      position: { x: 0, y: 0 },
      data: {
        kind: 'workflow-step',
        flowId: 'review-flow',
        stepId: 'review',
        index: 0,
        graphIndex: 0,
        number: 1,
        title: 'Review',
        description: '',
        action: 'agent-run',
        submit: 'new-run',
        submitLabel: 'new agent run',
        waitFor: 'all',
        agents: ['claude', 'gemini', 'codex'],
        instances,
        input: [],
        status: 'definition',
        runs: [],
        sourceLabel: 'test',
        promptMarkdown: '',
        promptPath: '',
        promptTitle: 'Review',
        ...step,
      },
    }],
    edges: [],
    metadata: {
      flowId: 'review-flow',
      title: 'Review Flow',
      description: '',
      source: 'test',
      sourceLabel: 'test',
      stepCount: 1,
      renderedStepCount: 1,
      agents: ['claude', 'gemini', 'codex'],
      selectedAgents: [],
      hasRunState: true,
    },
  }
}

test('projectWorkflowGraph fills missing selected agent statuses from active step status', () => {
  const projected = projectWorkflowGraph({
    graph: graphWithStep({
      status: 'running',
      runs: [{ agent: 'codex', status: 'completed' }],
    }),
    stepAgents: {},
    stepStatuses: {},
    stepAgentStatuses: {},
  })
  const node = projected?.nodes[0].data
  assert.equal(node?.status, 'running')
  assert.deepEqual(node?.agentStatuses, {
    'codex:auto:auto': 'completed',
    'claude:auto:auto': 'running',
    'gemini:auto:auto': 'running',
  })
})

test('projectWorkflowGraph reports a terminal mixed lineup without hiding successful instances', () => {
  const projected = projectWorkflowGraph({
    graph: graphWithStep({
      status: 'running',
      selectedAgents: [
        { agent: 'claude', id: 'claude:auto:auto', resolvedFrom: 'open' },
        { agent: 'codex', id: 'codex:auto:auto', resolvedFrom: 'open' },
      ],
    }),
    stepAgents: {},
    stepStatuses: {},
    stepAgentStatuses: {
      review: {
        'claude:auto:auto': 'failed',
        'codex:auto:auto': 'completed',
      },
    },
  })
  assert.equal(projected?.nodes[0].data.status, 'completed_with_failures')
})

test('projectWorkflowGraph completes active step when all selected agents are completed', () => {
  const projected = projectWorkflowGraph({
    graph: graphWithStep({
      status: 'submitted',
      selectedAgents: [{ agent: 'codex', id: 'codex:auto:auto', resolvedFrom: 'open' }],
      runs: [{ agent: 'codex', status: 'submitted' }],
    }),
    stepAgents: {},
    stepStatuses: {},
    stepAgentStatuses: {
      review: { 'codex:auto:auto': 'completed' },
    },
  })
  const node = projected?.nodes[0].data
  assert.equal(node?.status, 'completed')
  assert.deepEqual(node?.agentStatuses, { 'codex:auto:auto': 'completed' })
})

test('projectWorkflowGraph keeps terminal step status ahead of stale active run snapshots', () => {
  const projected = projectWorkflowGraph({
    graph: graphWithStep({
      status: 'submitted',
      selectedAgents: [{ agent: 'codex', id: 'codex:auto:auto', resolvedFrom: 'open' }],
      runs: [{ agent: 'codex', status: 'submitted', runnerId: 'runner-1' }],
    }),
    stepAgents: {},
    stepStatuses: {
      review: 'completed',
    },
    stepAgentStatuses: {},
  })
  const node = projected?.nodes[0].data
  assert.equal(node?.status, 'completed')
  assert.deepEqual(node?.agentStatuses, { 'codex:auto:auto': 'completed' })
})

test('projectWorkflowGraph preserves an explicitly empty step lineup', () => {
  const projected = projectWorkflowGraph({
    graph: graphWithStep({}),
    stepAgents: { review: [] },
    stepStatuses: {},
    stepAgentStatuses: {},
  })

  assert.deepEqual(projected?.nodes[0].data.selectedAgents, [])
})

test('projectWorkflowGraph mirrors definition overrides into inherited follow-up steps', () => {
  const graph = graphWithStep({})
  graph.nodes.push({
    ...graph.nodes[0],
    id: 'cross-review',
    data: {
      ...graph.nodes[0].data,
      stepId: 'cross-review',
      number: 2,
      title: 'Cross Review',
      submit: 'follow-up',
      inheritedFromStepId: 'review',
    },
  })
  const claudeModels = [
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
  ].map((model) => ({
    agent: 'claude',
    model,
    id: `claude:${model}:auto`,
    resolvedFrom: 'pinned' as const,
  }))

  const projected = projectWorkflowGraph({
    graph,
    stepAgents: { review: claudeModels },
    stepStatuses: {},
    stepAgentStatuses: {},
  })

  assert.deepEqual(projected?.nodes[0].data.selectedAgents, claudeModels)
  assert.deepEqual(projected?.nodes[1].data.selectedAgents, claudeModels)
})
