import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { dashboardQueryKeys } from '../../src/dashboard/web/src/query-keys'
import {
  graphHasActiveRemoteRuns,
  mergeRunLists,
  replaceRunInList,
  runsFromResponses,
  sameRun,
  upsertRunGraphInDashboardCache,
  upsertRunInDashboardCache,
} from '../../src/dashboard/web/src/queries/dashboard-cache'
import type { DashboardRun, RunGraphResponse, RunsResponse, Workflow, WorkflowGraph } from '../../src/dashboard/web/src/types'

function run(id: string, status = 'running'): DashboardRun {
  return {
    id,
    runId: id,
    flowId: 'review',
    status,
  }
}

function graphWithRunnerStatus(status: string): WorkflowGraph {
  return {
    nodes: [{
      id: 'review',
      type: 'workflowStep',
      position: { x: 0, y: 0 },
      data: {
        kind: 'workflow-step',
        flowId: 'review',
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
        agents: ['codex'],
        input: [],
        status,
        runs: [{ agent: 'codex', status, runnerId: 'runner-1' }],
        sourceLabel: 'test',
        promptMarkdown: '',
        promptPath: '',
        promptTitle: 'Review',
      },
    }],
    edges: [],
    metadata: {
      flowId: 'review',
      title: 'Review',
      description: '',
      source: 'test',
      sourceLabel: 'test',
      stepCount: 1,
      renderedStepCount: 1,
      agents: ['codex'],
      selectedAgents: ['codex'],
      hasRunState: true,
    },
  }
}

test('dashboard query keys keep stable hierarchy', () => {
  assert.deepEqual(dashboardQueryKeys.health(), ['dashboard', 'health'])
  assert.deepEqual(dashboardQueryKeys.workflows(), ['dashboard', 'workflows'])
  assert.deepEqual(dashboardQueryKeys.workflowGraph('review'), ['dashboard', 'workflows', 'review', 'graph'])
  assert.deepEqual(dashboardQueryKeys.runs(), ['dashboard', 'runs', 'list'])
  assert.deepEqual(dashboardQueryKeys.runsInfinite(50), ['dashboard', 'runs', 'list', { limit: 50 }])
  assert.deepEqual(dashboardQueryKeys.run('run-1'), ['dashboard', 'run', 'run-1'])
  assert.deepEqual(dashboardQueryKeys.runGraph('run-1'), ['dashboard', 'run', 'run-1', 'graph'])
  assert.deepEqual(dashboardQueryKeys.runDetails('run-1'), ['dashboard', 'run', 'run-1', 'details'])
})

test('run list helpers dedupe active and durable runs by canonical id', () => {
  assert.deepEqual(mergeRunLists([run('run-1')], [run('run-1'), run('run-2', 'completed')]).map((item) => item.runId), ['run-1', 'run-2'])
  assert.deepEqual(replaceRunInList([run('run-1'), run('run-2')], run('run-2', 'cancelled')).map((item) => item.status), ['cancelled', 'running'])
  assert.equal(sameRun({ id: 'local', runId: 'remote' }, { id: 'remote' }), true)
})

test('paginated run list helpers flatten pages and dedupe durable history', () => {
  const pages: RunsResponse[] = [
    {
      active: [run('run-active')],
      durable: [run('run-active', 'completed'), run('run-2', 'completed')],
      pagination: {
        durableLimit: 2,
        durableOffset: 0,
        durableTotal: 4,
        nextCursor: 'cursor-2',
        hasMore: true,
      },
    },
    {
      active: [],
      durable: [run('run-2', 'completed'), run('run-3', 'completed')],
      pagination: {
        durableLimit: 2,
        durableOffset: 2,
        durableTotal: 4,
        nextCursor: null,
        hasMore: false,
      },
    },
  ]

  const flattened = runsFromResponses(pages)
  assert.deepEqual(flattened.runs.map((item) => item.runId), ['run-active', 'run-2', 'run-3'])
  assert.equal(flattened.hasMore, false)
  assert.equal(flattened.durableShownCount, 3)
  assert.equal(flattened.durableTotal, 4)
})

test('cache helpers update run list, individual run, and run graph entries', () => {
  const queryClient = new QueryClient()
  const nextRun = run('run-1', 'completed')
  queryClient.setQueryData(dashboardQueryKeys.runsInfinite(50), { pages: [], pageParams: [] })
  upsertRunInDashboardCache(queryClient, nextRun)
  assert.equal(queryClient.getQueryData<DashboardRun>(dashboardQueryKeys.run('run-1'))?.status, 'completed')
  assert.equal(queryClient.getQueryState(dashboardQueryKeys.runsInfinite(50))?.isInvalidated, true)

  const workflow: Workflow = {
    id: 'review',
    title: 'Review',
    description: '',
    source: 'test',
    sourceLabel: 'test',
    sourceDir: '',
    sourcePriority: null,
    dir: '',
    file: '',
    defaults: {},
    options: {},
    steps: [],
  }
  const response: RunGraphResponse = { run: nextRun, workflow, graph: graphWithRunnerStatus('completed') }
  upsertRunGraphInDashboardCache(queryClient, response)
  assert.equal(queryClient.getQueryData<RunGraphResponse>(dashboardQueryKeys.runGraph('run-1'))?.run.status, 'completed')
})

test('run list invalidation does not fuzzily match run entity entries', async () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(dashboardQueryKeys.runsInfinite(50), { pages: [], pageParams: [] })
  queryClient.setQueryData(dashboardQueryKeys.run('run-1'), run('run-1'))
  queryClient.setQueryData(dashboardQueryKeys.runGraph('run-1'), {
    run: run('run-1'),
    workflow: {
      id: 'review',
      title: 'Review',
      description: '',
      source: 'test',
      sourceLabel: 'test',
      sourceDir: '',
      sourcePriority: null,
      dir: '',
      file: '',
      defaults: {},
      options: {},
      steps: [],
    },
    graph: graphWithRunnerStatus('running'),
  } satisfies RunGraphResponse)

  await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.runs() })

  assert.equal(queryClient.getQueryState(dashboardQueryKeys.runsInfinite(50))?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(dashboardQueryKeys.run('run-1'))?.isInvalidated, false)
  assert.equal(queryClient.getQueryState(dashboardQueryKeys.runGraph('run-1'))?.isInvalidated, false)
})

test('active remote graph detection only tracks active runs with remote identifiers', () => {
  assert.equal(graphHasActiveRemoteRuns(graphWithRunnerStatus('running')), true)
  assert.equal(graphHasActiveRemoteRuns(graphWithRunnerStatus('completed')), false)
})
