import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryHistory } from '@tanstack/react-router'
import { dashboardRouteStateFromMatches } from '../../src/dashboard/web/src/dashboard-routes'
import {
  dashboardRouteSpecs,
  runAgentPath,
  runDetailsPath,
  runPath,
  runStepPath,
  workflowPath,
  workflowPromptPath,
  workflowPromptsPath,
  workflowStepPath,
} from '../../src/dashboard/web/src/route-spec'
import { createDashboardRouter } from '../../src/dashboard/web/src/router-factory'
import type { DashboardRouteState } from '../../src/dashboard/web/src/dashboard-routes'

type RouteCase = {
  name: string
  href: string
  expected: DashboardRouteState
}

async function routeStateForHref(href: string): Promise<DashboardRouteState> {
  const router = createDashboardRouter()
  router.update({ history: createMemoryHistory({ initialEntries: [href] }) })
  await router.load()
  return dashboardRouteStateFromMatches(router.state.matches)
}

const routeCases: RouteCase[] = [
  { name: 'home', href: '/', expected: { kind: 'home' } },
  { name: 'legacy workflow query home', href: '/?workflow=review', expected: { kind: 'home' } },
  { name: 'workflows list', href: '/workflows', expected: { kind: 'workflows' } },
  { name: 'workflow', href: workflowPath('review'), expected: { kind: 'workflow', workflowId: 'review' } },
  {
    name: 'workflow with encoded punctuation',
    href: workflowPath('review flow!'),
    expected: { kind: 'workflow', workflowId: 'review flow!' },
  },
  {
    name: 'workflow with encoded slash',
    href: workflowPath('team/review'),
    expected: { kind: 'workflow', workflowId: 'team/review' },
  },
  {
    name: 'workflow step',
    href: workflowStepPath('review', 'cross-review'),
    expected: { kind: 'workflow-step', workflowId: 'review', stepId: 'cross-review' },
  },
  {
    name: 'workflow prompts',
    href: workflowPromptsPath('review'),
    expected: { kind: 'workflow-prompts', workflowId: 'review' },
  },
  {
    name: 'workflow prompt step',
    href: workflowPromptPath('review', 'cross review/notes'),
    expected: { kind: 'workflow-prompts', workflowId: 'review', stepId: 'cross review/notes' },
  },
  { name: 'runs list', href: '/runs', expected: { kind: 'runs' } },
  { name: 'run', href: runPath('run-1'), expected: { kind: 'run', runId: 'run-1' } },
  {
    name: 'run with encoded punctuation',
    href: runPath('run one!'),
    expected: { kind: 'run', runId: 'run one!' },
  },
  {
    name: 'run with encoded slash',
    href: runPath('folder/run-1'),
    expected: { kind: 'run', runId: 'folder/run-1' },
  },
  { name: 'run details', href: runDetailsPath('run-1'), expected: { kind: 'run-details', runId: 'run-1' } },
  {
    name: 'run step',
    href: runStepPath('run-1', 'review'),
    expected: { kind: 'run-step', runId: 'run-1', stepId: 'review' },
  },
  {
    name: 'run agent',
    href: runAgentPath('run-1', 'review', 'codex'),
    expected: { kind: 'run-agent', runId: 'run-1', stepId: 'review', agent: 'codex' },
  },
]

test('dashboard route spec matches router declarations', () => {
  const router = createDashboardRouter()
  const declaredPaths = Object.keys(router.routesByPath).sort()
  const specPaths = dashboardRouteSpecs.map((spec) => spec.fullPath).sort()
  assert.deepEqual(declaredPaths, specPaths)
})

test('dashboard route path builders encode params for declared routes', async () => {
  for (const routeCase of routeCases) {
    assert.deepEqual(await routeStateForHref(routeCase.href), routeCase.expected, routeCase.name)
  }
})
