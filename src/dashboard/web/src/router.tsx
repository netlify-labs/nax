import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import App from './App'

function EmptyRoute() {
  return null
}

const rootRoute = createRootRoute({
  component: App,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: EmptyRoute,
})

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows',
  component: EmptyRoute,
})

const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows/$workflowId',
  component: EmptyRoute,
})

const workflowStepRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows/$workflowId/steps/$stepId',
  component: EmptyRoute,
})

const workflowPromptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows/$workflowId/prompts',
  component: EmptyRoute,
})

const workflowPromptStepRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows/$workflowId/prompts/$stepId',
  component: EmptyRoute,
})

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runs',
  component: EmptyRoute,
})

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runs/$runId',
  component: EmptyRoute,
})

const runDetailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runs/$runId/details',
  component: EmptyRoute,
})

const runStepRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runs/$runId/steps/$stepId',
  component: EmptyRoute,
})

const runAgentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runs/$runId/steps/$stepId/agents/$agent',
  component: EmptyRoute,
})

const routeTree = rootRoute.addChildren([
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

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
