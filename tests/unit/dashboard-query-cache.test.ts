import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { parseDashboardPath } from '../../src/dashboard/web/src/dashboard-routes'
import { dashboardQueryKeys } from '../../src/dashboard/web/src/query-keys'
import {
  graphHasActiveRemoteRuns,
  mergeRunLists,
  replaceRunInList,
  sameRun,
  upsertRunGraphInDashboardCache,
  upsertRunInDashboardCache,
} from '../../src/dashboard/web/src/queries/dashboard-cache'
import type { DashboardRun, RunGraphResponse, Workflow, WorkflowGraph } from '../../src/dashboard/web/src/types'

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
  assert.deepEqual(dashboardQueryKeys.run('run-1'), ['dashboard', 'run', 'run-1'])
  assert.deepEqual(dashboardQueryKeys.runGraph('run-1'), ['dashboard', 'run', 'run-1', 'graph'])
  assert.deepEqual(dashboardQueryKeys.runDetails('run-1'), ['dashboard', 'run', 'run-1', 'details'])
})

test('dashboard route parser separates workflow configuration and run inspection destinations', () => {
  assert.deepEqual(parseDashboardPath('/'), { kind: 'home' })
  assert.deepEqual(parseDashboardPath('/workflows'), { kind: 'workflows' })
  assert.deepEqual(parseDashboardPath('/workflows/review'), { kind: 'workflow', workflowId: 'review' })
  assert.deepEqual(parseDashboardPath('/workflows/review/steps/cross-review'), {
    kind: 'workflow-step',
    workflowId: 'review',
    stepId: 'cross-review',
  })
  assert.deepEqual(parseDashboardPath('/workflows/review/prompts/review'), {
    kind: 'workflow-prompts',
    workflowId: 'review',
    stepId: 'review',
  })
  assert.deepEqual(parseDashboardPath('/runs/run-1'), { kind: 'run', runId: 'run-1' })
  assert.deepEqual(parseDashboardPath('/runs/run-1/details'), { kind: 'run-details', runId: 'run-1' })
  assert.deepEqual(parseDashboardPath('/runs/run-1/steps/review'), {
    kind: 'run-step',
    runId: 'run-1',
    stepId: 'review',
  })
  assert.deepEqual(parseDashboardPath('/runs/run-1/steps/review/agents/codex'), {
    kind: 'run-agent',
    runId: 'run-1',
    stepId: 'review',
    agent: 'codex',
  })
})

test('run list helpers dedupe active and durable runs by canonical id', () => {
  assert.deepEqual(mergeRunLists([run('run-1')], [run('run-1'), run('run-2', 'completed')]).map((item) => item.runId), ['run-1', 'run-2'])
  assert.deepEqual(replaceRunInList([run('run-1'), run('run-2')], run('run-2', 'cancelled')).map((item) => item.status), ['cancelled', 'running'])
  assert.equal(sameRun({ id: 'local', runId: 'remote' }, { id: 'remote' }), true)
})

test('cache helpers update run list, individual run, and run graph entries', () => {
  const queryClient = new QueryClient()
  const nextRun = run('run-1', 'completed')
  upsertRunInDashboardCache(queryClient, nextRun)
  assert.deepEqual(queryClient.getQueryData<DashboardRun[]>(dashboardQueryKeys.runs())?.map((item) => item.status), ['completed'])
  assert.equal(queryClient.getQueryData<DashboardRun>(dashboardQueryKeys.run('run-1'))?.status, 'completed')

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
  queryClient.setQueryData(dashboardQueryKeys.runs(), [run('run-1')])
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

  assert.equal(queryClient.getQueryState(dashboardQueryKeys.runs())?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(dashboardQueryKeys.run('run-1'))?.isInvalidated, false)
  assert.equal(queryClient.getQueryState(dashboardQueryKeys.runGraph('run-1'))?.isInvalidated, false)
})

test('active remote graph detection only tracks active runs with remote identifiers', () => {
  assert.equal(graphHasActiveRemoteRuns(graphWithRunnerStatus('running')), true)
  assert.equal(graphHasActiveRemoteRuns(graphWithRunnerStatus('completed')), false)
})
