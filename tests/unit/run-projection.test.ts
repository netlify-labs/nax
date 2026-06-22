import assert from 'node:assert/strict'
import test from 'node:test'
import { projectWorkflowGraph } from '../../src/dashboard/web/src/run-projection'
import type { WorkflowGraph } from '../../src/dashboard/web/src/types'

function graphWithStep(step: Partial<WorkflowGraph['nodes'][number]['data']>): WorkflowGraph {
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
    stepModels: {},
    stepStatuses: {},
    stepAgentStatuses: {},
  })
  const node = projected?.nodes[0].data
  assert.equal(node?.status, 'running')
  assert.deepEqual(node?.agentStatuses, {
    codex: 'completed',
    claude: 'running',
    gemini: 'running',
  })
})

test('projectWorkflowGraph completes active step when all selected agents are completed', () => {
  const projected = projectWorkflowGraph({
    graph: graphWithStep({
      status: 'submitted',
      selectedAgents: ['codex'],
      runs: [{ agent: 'codex', status: 'submitted' }],
    }),
    stepModels: {},
    stepStatuses: {},
    stepAgentStatuses: {
      review: { codex: 'completed' },
    },
  })
  const node = projected?.nodes[0].data
  assert.equal(node?.status, 'completed')
  assert.deepEqual(node?.agentStatuses, { codex: 'completed' })
})

test('projectWorkflowGraph keeps terminal step status ahead of stale active run snapshots', () => {
  const projected = projectWorkflowGraph({
    graph: graphWithStep({
      status: 'submitted',
      selectedAgents: ['codex'],
      runs: [{ agent: 'codex', status: 'submitted', runnerId: 'runner-1' }],
    }),
    stepModels: {},
    stepStatuses: {
      review: 'completed',
    },
    stepAgentStatuses: {},
  })
  const node = projected?.nodes[0].data
  assert.equal(node?.status, 'completed')
  assert.deepEqual(node?.agentStatuses, { codex: 'completed' })
})
