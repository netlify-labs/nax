const test = require('node:test')
const assert = require('node:assert/strict')

const { loadFlow } = require('../../src/workflows/catalog/flows')
const { flowToGraph } = require('../../src/dashboard/shared/graph')

test('flowToGraph renders review as three nodes and two input edges', async () => {
  const flow = await loadFlow('review')
  const graph = flowToGraph({ flow })

  assert.equal(graph.metadata.flowId, 'review')
  assert.equal(graph.metadata.stepCount, 3)
  assert.equal(graph.metadata.renderedStepCount, 3)
  assert.deepEqual(graph.nodes.map((node) => node.id), ['review', 'cross-review', 'synthesize'])
  assert.deepEqual(graph.edges.map((edge) => edge.id), [
    'edge:review:cross-review',
    'edge:cross-review:synthesize',
  ])
  assert.equal(graph.edges[0].data.kind, 'follow-up')
  assert.equal(graph.edges[0].animated, true)
  assert.equal(graph.nodes[2].data.agents.length, 1)
  assert.deepEqual(graph.nodes[2].data.agents, ['codex'])
})

test('flowToGraph adds sequential fallback edges for steps without explicit input', () => {
  const flow = {
    id: 'linear',
    title: 'Linear',
    steps: [
      { id: 'one', title: 'One', agents: ['codex'], submit: 'new-run' },
      { id: 'two', title: 'Two', agents: ['codex'], submit: 'new-run' },
      { id: 'three', title: 'Three', agents: ['codex'], submit: 'new-run' },
    ],
  }

  const graph = flowToGraph({ flow })

  assert.deepEqual(graph.edges.map((edge) => edge.id), [
    'edge:one:two',
    'edge:two:three',
  ])
  assert.equal(graph.edges[0].data.implicit, true)
})

test('flowToGraph spaces the next node after long descriptions', () => {
  const flow = {
    id: 'long-description',
    title: 'Long Description',
    steps: [
      {
        id: 'one',
        title: 'One',
        description: 'React to adversarial scores, concede valid criticism, defend strong ideas, and identify blind spots. '.repeat(8),
        agents: ['claude', 'gemini', 'codex'],
        submit: 'follow-up',
      },
      { id: 'two', title: 'Two', agents: ['codex'], submit: 'new-run' },
    ],
  }

  const graph = flowToGraph({ flow })

  assert.equal(graph.nodes[0].position.y, 0)
  assert.ok(graph.nodes[1].position.y > 220)
})

test('flowToGraph filters agents without mutating original flow', async () => {
  const flow = await loadFlow('review')
  const originalAgents = flow.steps[0].agents.slice()
  const graph = flowToGraph({ flow, selectedAgents: ['codex'] })

  assert.deepEqual(flow.steps[0].agents, originalAgents)
  assert.deepEqual(graph.nodes.map((node) => node.id), ['review', 'cross-review', 'synthesize'])
  assert.deepEqual(graph.nodes.map((node) => node.data.agents), [['codex'], ['codex'], ['codex']])
  assert.deepEqual(graph.metadata.agents, ['codex'])
})

test('flowToGraph drops steps with no selected agents and reconnects runnable steps', () => {
  const flow = {
    id: 'mixed',
    title: 'Mixed',
    steps: [
      { id: 'one', title: 'One', agents: ['claude'], submit: 'new-run' },
      { id: 'two', title: 'Two', agents: ['gemini'], submit: 'new-run' },
      { id: 'three', title: 'Three', agents: ['codex'], submit: 'new-run' },
    ],
  }

  const graph = flowToGraph({ flow, selectedAgents: ['claude', 'codex'] })

  assert.deepEqual(graph.nodes.map((node) => node.id), ['one', 'three'])
  assert.deepEqual(graph.edges.map((edge) => edge.id), ['edge:one:three'])
})

test('flowToGraph overlays run state status and runs', () => {
  const flow = {
    id: 'stateful',
    title: 'Stateful',
    steps: [
      { id: 'one', title: 'One', agents: ['codex'], submit: 'new-run' },
    ],
  }
  const runState = {
    steps: [{
      id: 'one',
      status: 'completed',
      runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1' }],
    }],
  }

  const graph = flowToGraph({ flow, runState })

  assert.equal(graph.metadata.hasRunState, true)
  assert.equal(graph.nodes[0].data.status, 'completed')
  assert.deepEqual(graph.nodes[0].data.runs, [{ agent: 'codex', status: 'completed', runnerId: 'runner-1' }])
  assert.deepEqual(graph.nodes[0].data.selectedAgents, ['codex'])
})

test('flowToGraph keeps available agents visible when overlaying filtered run state', () => {
  const flow = {
    id: 'stateful',
    title: 'Stateful',
    steps: [
      { id: 'one', title: 'One', agents: ['claude', 'gemini', 'codex'], submit: 'new-run' },
    ],
  }
  const runState = {
    steps: [{
      id: 'one',
      status: 'completed',
      agents: ['claude'],
      runs: [{ agent: 'claude', status: 'completed', runnerId: 'runner-1' }],
    }],
  }

  const graph = flowToGraph({ flow, runState })

  assert.deepEqual(graph.nodes[0].data.agents, ['claude', 'gemini', 'codex'])
  assert.deepEqual(graph.nodes[0].data.selectedAgents, ['claude'])
})

test('flowToGraph renders saved dashboard follow-up steps not present in the flow definition', () => {
  const flow = {
    id: 'stateful',
    title: 'Stateful',
    steps: [
      { id: 'review', title: 'Review', agents: ['codex'], submit: 'new-run' },
    ],
  }
  const runState = {
    steps: [
      {
        id: 'review',
        status: 'completed',
        runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1' }],
      },
      {
        id: 'dashboard-followup-1',
        title: 'Review follow-up',
        action: 'agent-run',
        submit: 'follow-up',
        status: 'submitted',
        input: [{ step: 'review', results: 'selected' }],
        runs: [{ agent: 'codex', status: 'submitted', runnerId: 'runner-1', sessionId: 'session-2' }],
      },
    ],
  }

  const graph = flowToGraph({ flow, runState })

  assert.deepEqual(graph.nodes.map((node) => node.id), ['review', 'dashboard-followup-1'])
  assert.equal(graph.nodes[1].data.status, 'submitted')
  assert.deepEqual(graph.nodes[1].data.agents, ['codex'])
  assert.equal(graph.nodes[1].data.runs[0].sessionId, 'session-2')
  assert.deepEqual(graph.edges.map((edge) => edge.id), ['edge:review:dashboard-followup-1'])
  assert.equal(graph.edges[0].data.kind, 'follow-up')
})
