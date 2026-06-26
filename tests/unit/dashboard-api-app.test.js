const test = require('node:test')
const assert = require('node:assert/strict')

const { createDashboardApi, overlayLiveOnlyRuns } = require('../../src/dashboard/api/app')
const { hostedPlaceholderCapabilities, localDashboardCapabilities } = require('../../src/dashboard/api/capabilities')

async function json(response) {
  return response.json()
}

function fakeApi(overrides = {}) {
  return createDashboardApi({
    token: 'token-1',
    runtime: {
      projectRoot: '/repo',
      capabilities: localDashboardCapabilities(),
      ...overrides.runtime,
    },
    workflowStore: {
      listWorkflows: async () => ({ count: 1, items: [{ id: 'review', title: 'Review' }] }),
      getWorkflow: async (id) => (id === 'review' ? { id, title: 'Review' } : null),
      getWorkflowGraph: async (id) => (id === 'review' ? { workflow: { id }, graph: { nodes: [], edges: [] } } : null),
      ...overrides.workflowStore,
    },
    runStore: {
      listRunsPage: () => ({
        runs: [{ runId: 'run-1', flowId: 'review' }],
        pagination: { limit: 50, offset: 0, total: 1, nextCursor: null, hasMore: false },
      }),
      getRun: (id) => (id === 'run-1' ? { runId: id, flowId: 'review' } : null),
      getRunGraph: async (id) => (id === 'run-1' ? { run: { runId: id }, workflow: { id: 'review' }, graph: { nodes: [], edges: [] } } : null),
      getRunDetails: async (id) => (id === 'run-1' ? { run: { runId: id }, details: { sections: [] } } : null),
      ...overrides.runStore,
    },
    eventStore: {
      listEvents: ({ runId }) => (runId === 'run-1' ? { run: { runId }, events: [{ seq: 1, type: 'stdout' }], errors: [] } : null),
      ...overrides.eventStore,
    },
    liveRuns: {
      listActiveRuns: () => [{ id: 'active-1', status: 'running' }],
      getActiveRun: (id) => (id === 'active-1' ? { id, status: 'running' } : null),
      ...overrides.liveRuns,
    },
  })
}

test('Hono dashboard API health bootstraps sessions and hides projectRoot when unauthenticated', async () => {
  const app = fakeApi()
  const unauthenticated = await app.request('/api/health')
  assert.equal(unauthenticated.status, 200)
  assert.equal((await json(unauthenticated)).projectRoot, undefined)

  const authenticated = await app.request('/api/health', {
    headers: { 'x-nax-token': 'token-1' },
  })
  const payload = await json(authenticated)
  assert.equal(payload.projectRoot, '/repo')
  assert.match(authenticated.headers.get('set-cookie') || '', /nax_dashboard_token=token-1/)
  assert.equal(payload.capabilities.canReadRuns, true)
})

test('Hono dashboard API requires auth for sensitive read routes', async () => {
  const app = fakeApi()
  const response = await app.request('/api/runs')
  assert.equal(response.status, 401)
  assert.equal((await json(response)).error.code, 'unauthorized')
})

test('Hono dashboard API serves read-only workflow, run, and event routes', async () => {
  const app = fakeApi()
  const headers = { 'x-nax-token': 'token-1' }

  assert.deepEqual(await json(await app.request('/api/workflows', { headers })), {
    count: 1,
    items: [{ id: 'review', title: 'Review' }],
  })
  assert.equal((await json(await app.request('/api/workflows/review', { headers }))).id, 'review')
  assert.deepEqual((await json(await app.request('/api/workflows/review/graph', { headers }))).graph, { nodes: [], edges: [] })

  const runs = await json(await app.request('/api/runs?limit=50', { headers }))
  assert.equal(runs.active, undefined)
  assert.equal(runs.durable, undefined)
  assert.deepEqual(runs.runs.map((run) => run.runId || run.id), ['run-1', 'active-1'])
  assert.equal(runs.pagination.hasMore, false)

  assert.equal((await json(await app.request('/api/runs/active-1', { headers }))).run.id, 'active-1')
  assert.equal((await json(await app.request('/api/runs/run-1', { headers }))).run.runId, 'run-1')
  assert.deepEqual((await json(await app.request('/api/runs/run-1/graph', { headers }))).graph, { nodes: [], edges: [] })
  assert.deepEqual((await json(await app.request('/api/runs/run-1/details', { headers }))).details, { sections: [] })
  assert.equal((await json(await app.request('/api/runs/run-1/events.json?since=1', { headers }))).events[0].type, 'stdout')
})

test('Hono dashboard run overlay only includes live-only rows on first page', async () => {
  const firstPage = await overlayLiveOnlyRuns({
    durableRuns: [{ runId: 'run-1' }],
    liveRuns: [{ id: 'active-1' }, { id: 'off-page-1' }],
    pagination: { offset: 0 },
    getDurableRun: async (id) => (id === 'off-page-1' ? { runId: id } : null),
  })
  assert.deepEqual(firstPage.map((run) => run.runId || run.id), ['run-1', 'active-1'])

  const secondPage = await overlayLiveOnlyRuns({
    durableRuns: [{ runId: 'run-2' }],
    liveRuns: [{ id: 'active-1' }],
    pagination: { offset: 1 },
    getDurableRun: async () => null,
  })
  assert.deepEqual(secondPage.map((run) => run.runId || run.id), ['run-2'])
})

test('Hono dashboard API returns workflow graph for active runs before durable state exists', async () => {
  const app = fakeApi({
    runStore: {
      getRunGraph: async () => null,
    },
    liveRuns: {
      getActiveRun: (id) => (id === 'active-1' ? { id, flowId: 'review', status: 'running' } : null),
    },
    workflowStore: {
      getWorkflowGraph: async (id) => (id === 'review'
        ? {
            workflow: { id: 'review', title: 'Review' },
            graph: { nodes: [{ id: 'node:review' }], edges: [] },
          }
        : null),
    },
  })

  const response = await app.request('/api/runs/active-1/graph', { headers: { 'x-nax-token': 'token-1' } })
  assert.equal(response.status, 200)
  const payload = await json(response)
  assert.equal(payload.run.id, 'active-1')
  assert.equal(payload.workflow.id, 'review')
  assert.deepEqual(payload.graph.nodes, [{ id: 'node:review' }])
})

test('Hono dashboard API resolves active live run graph through durable run id when available', async () => {
  const app = fakeApi({
    runStore: {
      getRunGraph: async (id) => (id === 'durable-1'
        ? {
            run: { runId: 'durable-1', flowId: 'review', status: 'running' },
            workflow: { id: 'review', title: 'Review' },
            graph: { nodes: [{ id: 'node:review', data: { status: 'running' } }], edges: [] },
          }
        : null),
    },
    liveRuns: {
      getActiveRun: (id) => (id === 'active-1' ? { id, runId: 'durable-1', flowId: 'review', status: 'running' } : null),
    },
  })

  const response = await app.request('/api/runs/active-1/graph', { headers: { 'x-nax-token': 'token-1' } })
  assert.equal(response.status, 200)
  const payload = await json(response)
  assert.equal(payload.run.runId, 'durable-1')
  assert.equal(payload.graph.nodes[0].data.status, 'running')
})

test('Hono dashboard API prefers durable run status for reconciled active runs', async () => {
  const app = fakeApi({
    runStore: {
      getRun: (id) => (id === 'durable-1'
        ? { runId: 'durable-1', flowId: 'review', status: 'completed' }
        : null),
    },
    liveRuns: {
      getActiveRun: (id) => (id === 'active-1' ? { id, runId: 'durable-1', flowId: 'review', status: 'running' } : null),
    },
  })

  const response = await app.request('/api/runs/active-1', { headers: { 'x-nax-token': 'token-1' } })
  assert.equal(response.status, 200)
  const payload = await json(response)
  assert.equal(payload.run.runId, 'durable-1')
  assert.equal(payload.run.status, 'completed')
})

test('Hono dashboard API prefers durable state when active id already equals durable id', async () => {
  const app = fakeApi({
    runStore: {
      getRun: (id) => (id === 'durable-1'
        ? { runId: 'durable-1', flowId: 'review', status: 'completed' }
        : null),
      getRunGraph: async (id) => (id === 'durable-1'
        ? { run: { runId: 'durable-1', status: 'completed' }, workflow: { id: 'review' }, graph: { nodes: [{ id: 'review', data: { status: 'completed' } }], edges: [] } }
        : null),
      getRunDetails: async (id) => (id === 'durable-1'
        ? { run: { runId: 'durable-1', status: 'completed' }, details: { sections: [{ id: 'done' }] } }
        : null),
    },
    liveRuns: {
      getActiveRun: (id) => (id === 'durable-1' ? { id, runId: id, flowId: 'review', status: 'running' } : null),
    },
  })
  const headers = { 'x-nax-token': 'token-1' }

  const detail = await json(await app.request('/api/runs/durable-1', { headers }))
  assert.equal(detail.run.status, 'completed')
  const graph = await json(await app.request('/api/runs/durable-1/graph', { headers }))
  assert.equal(graph.run.status, 'completed')
  const details = await json(await app.request('/api/runs/durable-1/details', { headers }))
  assert.equal(details.run.status, 'completed')
})

test('Hono dashboard API returns structured not found errors', async () => {
  const app = fakeApi()
  const response = await app.request('/api/runs/missing', { headers: { 'x-nax-token': 'token-1' } })
  assert.equal(response.status, 404)
  assert.equal((await json(response)).error.code, 'not_found')
})

test('Hono dashboard API reports unsupported hosted capabilities explicitly', async () => {
  const app = fakeApi({
    runtime: {
      projectRoot: '',
      capabilities: hostedPlaceholderCapabilities(),
      deploymentMode: 'web',
    },
  })
  const response = await app.request('/api/runs', { headers: { 'x-nax-token': 'token-1' } })
  assert.equal(response.status, 501)
  assert.equal((await json(response)).error.code, 'unsupported_capability')
})
