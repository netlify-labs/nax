import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import type { RouteComponent } from '@tanstack/react-router'
import { dashboardRouteSpec } from './route-spec'

function EmptyRoute() {
  return null
}

export function createDashboardRouteTree(rootComponent: RouteComponent = EmptyRoute) {
  const rootRoute = createRootRoute({
    component: rootComponent,
  })

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.home.path,
    component: EmptyRoute,
  })

  const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.workflows.path,
    component: EmptyRoute,
  })

  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.workflow.path,
    component: EmptyRoute,
  })

  const workflowStepRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.workflowStep.path,
    component: EmptyRoute,
  })

  const workflowPromptsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.workflowPrompts.path,
    component: EmptyRoute,
  })

  const workflowPromptStepRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.workflowPromptStep.path,
    component: EmptyRoute,
  })

  const runsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.runs.path,
    component: EmptyRoute,
  })

  const runRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.run.path,
    component: EmptyRoute,
  })

  const runDetailsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.runDetails.path,
    component: EmptyRoute,
  })

  const runStepRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.runStep.path,
    component: EmptyRoute,
  })

  const runAgentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: dashboardRouteSpec.runAgent.path,
    component: EmptyRoute,
  })

  return rootRoute.addChildren([
    indexRoute,
    workflowsRoute,
    workflowRoute,
    workflowStepRoute,
    workflowPromptsRoute,
    workflowPromptStepRoute,
    runsRoute,
    runRoute,
    runDetailsRoute,
    runStepRoute,
    runAgentRoute,
  ])
}

export function createDashboardRouter(rootComponent: RouteComponent = EmptyRoute) {
  // @ts-expect-error TanStack Router's createRouter type requires strictNullChecks, while the root project tsconfig intentionally leaves it off.
  return createRouter({ routeTree: createDashboardRouteTree(rootComponent) })
}
