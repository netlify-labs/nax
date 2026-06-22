import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { dashboardQueryKeys } from '../../src/dashboard/web/src/query-keys'
import { applyRunnerEventToDashboardCache } from '../../src/dashboard/web/src/queries/query-event-bridge'
import type { DashboardRun, RunDetailsResponse, RunGraphResponse, Workflow, WorkflowGraph } from '../../src/dashboard/web/src/types'

function dashboardRun(id: string, status = 'pending'): DashboardRun {
  return {
    id,
    runId: id,
    flowId: 'review',
    status,
  }
}

function workflow(): Workflow {
  return {
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
}

function graph(): WorkflowGraph {
  return {
    nodes: [],
    edges: [],
    metadata: {
      flowId: 'review',
      title: 'Review',
      description: '',
      source: 'test',
      sourceLabel: 'test',
      stepCount: 0,
      renderedStepCount: 0,
      agents: [],
      selectedAgents: [],
      hasRunState: true,
    },
  }
}

function runDetails(run: DashboardRun): RunDetailsResponse {
  return {
    run,
    details: {
      summaryPath: '',
      summaryAbsolutePath: '',
      summaryMarkdown: '',
      finalMarkdown: '',
      finalTitle: '',
      workflowSteps: [],
      sections: [],
      followupTargets: [],
      followupArtifacts: [],
    },
  }
}

test('query event bridge patches cached runs from workflow lifecycle events', () => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(dashboardQueryKeys.run('run-1'), dashboardRun('run-1'))

  applyRunnerEventToDashboardCache(queryClient, {
    type: 'workflow_started',
    runId: 'run-1',
    flowId: 'review',
    flowTitle: 'Review',
    status: 'running',
    command: ['nax', 'workflow', 'run'],
    at: '2026-06-22T00:00:00.000Z',
  }, 'fallback-run')

  const started = queryClient.getQueryData<DashboardRun>(dashboardQueryKeys.run('run-1'))
  assert.equal(started?.status, 'running')
  assert.equal(started?.flowTitle, 'Review')
  assert.deepEqual(started?.command, ['nax', 'workflow', 'run'])
  assert.equal(started?.startedAt, '2026-06-22T00:00:00.000Z')
  assert.equal(queryClient.getQueryData<DashboardRun[]>(dashboardQueryKeys.runs())?.[0]?.status, 'running')

  applyRunnerEventToDashboardCache(queryClient, {
    type: 'workflow_failed',
    runId: 'run-1',
    status: 'failed',
    at: '2026-06-22T00:01:00.000Z',
  }, 'fallback-run')

  const failed = queryClient.getQueryData<DashboardRun>(dashboardQueryKeys.run('run-1'))
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.updatedAt, '2026-06-22T00:01:00.000Z')

  applyRunnerEventToDashboardCache(queryClient, {
    type: 'exited',
    runId: 'run-1',
    status: 'completed',
    exitCode: 0,
    signal: null,
    at: '2026-06-22T00:02:00.000Z',
  }, 'fallback-run')

  const exited = queryClient.getQueryData<DashboardRun>(dashboardQueryKeys.run('run-1'))
  assert.equal(exited?.status, 'completed')
  assert.equal(exited?.exitCode, 0)
  assert.equal(exited?.exitedAt, '2026-06-22T00:02:00.000Z')
})

test('query event bridge skips missing cached runs but invalidates known run views', () => {
  const queryClient = new QueryClient()
  const run = dashboardRun('run-1', 'running')
  queryClient.setQueryData(dashboardQueryKeys.runs(), [run])
  queryClient.setQueryData(dashboardQueryKeys.run('run-1'), run)
  queryClient.setQueryData(dashboardQueryKeys.runGraph('run-1'), {
    run,
    workflow: workflow(),
    graph: graph(),
  } satisfies RunGraphResponse)
  queryClient.setQueryData(dashboardQueryKeys.runDetails('run-1'), runDetails(run))

  applyRunnerEventToDashboardCache(queryClient, { type: 'artifact_written', runId: 'missing-run' }, 'fallback-run')

  assert.equal(queryClient.getQueryData<DashboardRun>(dashboardQueryKeys.run('missing-run')), undefined)

  applyRunnerEventToDashboardCache(queryClient, { type: 'artifact_written', runId: 'run-1' }, 'fallback-run')

  assert.equal(queryClient.getQueryState(dashboardQueryKeys.runs())?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(dashboardQueryKeys.run('run-1'))?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(dashboardQueryKeys.runGraph('run-1'))?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(dashboardQueryKeys.runDetails('run-1'))?.isInvalidated, true)
})
