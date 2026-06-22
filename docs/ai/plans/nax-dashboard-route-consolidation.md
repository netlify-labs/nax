# NAX Dashboard Route Consolidation Plan

> Status: Implemented on 2026-06-22.
> Scope: dashboard client routing architecture.
> Primary goal: make TanStack Router the single source of truth for dashboard view state, route params, modal destinations, and navigation helpers.

## Summary

The dashboard previously had useful URL-addressable routes, but route ownership was split:

- `src/dashboard/web/src/router.tsx` declared the TanStack Router tree.
- `src/dashboard/web/src/dashboard-routes.ts` manually parsed `location.pathname`.
- `src/dashboard/web/src/App.tsx` read `useRouterState`, called `parseDashboardPath`, then derived selected workflow/run/step/modal state from that manual parser.
- Navigation helpers manually carried route strings.

That duplication has been removed. The current rule is: add or change dashboard URL shapes in `src/dashboard/web/src/route-spec.ts`, then consume those templates from the router, navigation callbacks, and tests.

The implemented end state is not "delete TanStack Router" or "delete all helper functions". The current shape is:

- TanStack Router owns route matching and params.
- `route-spec.ts` contains the route path structure and path builders.
- App rendering consumes router matches/params through `dashboardRouteStateFromMatches`, not a second pathname parser.
- Navigation callbacks use route templates from the same route spec.
- Tests assert route matching and navigation helpers against the same route definitions.

## Why This Matters

The dashboard route surface is central to several workflows:

- choosing a workflow to configure
- opening a workflow step inspector
- opening workflow prompt details
- selecting a durable or active run
- opening run summary details
- opening step and agent-specific run details

These routes are user-facing because users can refresh, deep-link, or share local dashboard URLs. A route mismatch can make a valid URL render the wrong mode, open the wrong modal, or silently fall back to home.

The current split was acceptable for the initial router migration because it limited churn in `App.tsx`. It should not be the long-term shape.

## Current State

### Route Declaration

`src/dashboard/web/src/route-spec.ts` defines the route templates, and `src/dashboard/web/src/router-factory.ts` creates TanStack routes from that spec:

```txt
/
/workflows
/workflows/$workflowId
/workflows/$workflowId/steps/$stepId
/workflows/$workflowId/prompts/$stepId
/runs
/runs/$runId
/runs/$runId/details
/runs/$runId/steps/$stepId
/runs/$runId/steps/$stepId/agents/$agent
```

The route leaves currently render a null component. They exist so the router can match URLs, but they do not own view rendering.

### Route Interpretation

`src/dashboard/web/src/dashboard-routes.ts` owns:

- route state union types
- `dashboardRouteStateFromMatches(matches)`
- helper selectors like `routeWorkflowId`, `routeRunId`, and `routeRunStepId`
- default dashboard capabilities

`App.tsx` does this:

```ts
const routeState = useRouterState({ select: (state) => dashboardRouteStateFromMatches(state.matches) })
```

Route path builders live in `route-spec.ts`, alongside the route templates that `router-factory.ts` consumes.

## Goals

1. Remove manual pathname parsing from `App.tsx`.
2. Keep existing URL shapes stable.
3. Keep current dashboard behavior stable:
   - workflow routes render configure mode
   - run routes render inspect mode
   - prompt routes open `WorkflowPromptModal`
   - run detail routes open `RunDetailsModal`
4. Preserve typed helpers for navigation, but tie them to the route table.
5. Keep the migration incremental and test-backed.

## Non-Goals

- Do not redesign the visual dashboard layout.
- Do not introduce file-based routing.
- Do not change URL paths unless a bug requires it.
- Do not replace TanStack Query server-state hooks.
- Do not solve hosted auth or API base URL concerns in this plan.

## Current Architecture

### 1. Route Table As Source Of Truth

`src/dashboard/web/src/route-spec.ts` contains path templates and path builders.

Example shape:

```ts
export const dashboardRoutes = {
  home: {
    id: 'home',
    path: '/',
    build: () => '/',
  },
  workflow: {
    id: 'workflow',
    path: '/workflows/$workflowId',
    build: (workflowId: string) => `/workflows/${encodeURIComponent(workflowId)}`,
  },
  runAgent: {
    id: 'run-agent',
    path: '/runs/$runId/steps/$stepId/agents/$agent',
    build: (runId: string, stepId: string, agent: string) => (
      `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/agents/${encodeURIComponent(agent)}`
    ),
  },
}
```

The implementation is more compact than this sketch, but the important rule is that route declarations and path builders import from the same source.

### 2. TanStack Router Owns Matching

`router-factory.ts` creates every route from the route spec. Routes still render a shell-level null component because `App.tsx` remains the root renderer, but params are consumed from router match state.

`App.tsx` uses TanStack Router match state through `useRouterState`:

- `dashboardRouteStateFromMatches(state.matches)` derives the dashboard route union.
- Route templates from `dashboardRouteSpec` are used for navigation callbacks.

The app should derive route state from matched route ids and params, not from `pathname`.

### 3. Derive `DashboardRouteState` From Matched State

The small route-state adapter keeps the existing downstream route union stable:

```ts
type DashboardRouteState =
  | { kind: 'home' }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'run-agent'; runId: string; stepId: string; agent: string }
```

But build it from TanStack matches:

```ts
function routeStateFromMatches(matches: RouterMatch[]): DashboardRouteState
```

If `App.tsx` later moves to route-specific component boundaries, this adapter can shrink or disappear.

### 4. Keep Navigation Helpers, But Stop Duplicating Parse Logic

Helpers such as `workflowPath`, `workflowStepPath`, `runPath`, and `runAgentPath` are valuable because they centralize URL encoding. They live in `route-spec.ts` with the route templates. Manual regex/pathname parsing has been removed.

### 5. Route Tests

Tests assert:

- every path builder produces a URL matched by the router
- route params round-trip for ids containing spaces, slashes encoded as `%2F`, and model names with punctuation
- unknown paths fall back to home/not-found behavior intentionally
- prompt routes and details routes produce the correct modal state

The test should not reimplement parsing. It should instantiate the router or call the route-state adapter with real matches.

## Completed Migration Steps

### Step 1: Introduce Route Spec

Completed:

- Added `route-spec.ts`.
- Moved path builder helpers into it.
- Updated router creation to import paths from the spec.

Validation:

- Route spec tests prove path builders match declared route patterns.

Rationale:

This creates the shared source without changing app behavior.

### Step 2: Add Match-Based Route Adapter

Completed:

- Added `dashboardRouteStateFromMatches`.
- Used TanStack Router match data to produce the `DashboardRouteState` union.
- Added tests comparing match-based output to the known route matrix.

Validation:

- `npm run typecheck`
- focused route tests
- `npm run dashboard:build`

Rationale:

This gives a safe equivalence bridge before removing the old parser.

### Step 3: Switch `App.tsx` To Match-Based Route State

Completed:

- Replaced `useRouterState(...pathname)` plus manual parsing with match-based route state.
- Kept downstream selectors like `routeWorkflowId` where they still simplify `App.tsx`.
- Verified workflow configure routes, run inspect routes, prompt modal routes, and details modal routes.

Validation:

- Unit tests for route adapter.
- Dashboard build.
- Existing e2e smoke if cheap enough in the implementation pass.

Rationale:

This removes the actual production duplication while minimizing rendering changes.

### Step 4: Delete Manual Parser

Completed:

- Deleted `parseDashboardPath`.
- Removed tests that asserted manual pathname parsing.
- Replaced them with route spec/router match tests.
- Updated imports.

Validation:

- `rg "parseDashboardPath"` should find no production usage.
- `npm run check`
- `npm test`
- `npm run dashboard:build`

Rationale:

Leaving the old parser around invites new code to depend on it again.

### Phase 5: Route-Aware Component Boundaries

Tasks:

- Consider splitting major route render branches out of `App.tsx`:
  - `WorkflowRouteView`
  - `RunRouteView`
  - `PromptRouteModalBridge`
  - `RunDetailsRouteModalBridge`
- Keep shared shell state in `App.tsx`.
- Avoid deep refactors unless `App.tsx` becomes harder to follow during the route switch.

Validation:

- Same as Phase 4.

Rationale:

This is optional cleanup. It should happen only if it makes the migration clearer.

## User Workflows To Preserve

### Workflow Configure

1. User opens `/workflows/review`.
2. Dashboard renders workflow graph in configure mode.
3. Clicking a step navigates to `/workflows/review/steps/<stepId>`.
4. The inspector shows the selected step.
5. Agent pill clicks toggle model selection.

### Prompt Browsing

1. User opens `/workflows/review/prompts/review`.
2. Prompt modal opens directly to the review step prompt.
3. Switching prompt steps updates the URL.
4. Closing modal returns to the workflow route.

### Run Inspection

1. User opens `/runs/<runId>`.
2. Dashboard renders run graph in inspect mode.
3. Clicking a step navigates to `/runs/<runId>/steps/<stepId>`.
4. Clicking an agent pill navigates to `/runs/<runId>/steps/<stepId>/agents/<agent>`.
5. `RunDetailsModal` opens with the correct target.
6. Closing modal returns to `/runs/<runId>`.

## Edge Cases

- Encoded ids must round-trip.
- Unknown workflow or run ids should show existing loading/error behavior, not crash.
- Browser back/forward should restore the correct route state.
- Legacy `?workflow=` support should remain until explicitly removed.
- Hosted or desktop API base behavior should be unaffected.

## Test Plan

Required:

```bash
npm run typecheck
node --import tsx --test tests/unit/dashboard-query-cache.test.ts
npm run dashboard:build
```

Recommended for the implementation PR:

```bash
npm test
npm run dashboard:smoke
```

Add or update tests for:

- route path builders
- router match to route-state adapter
- prompt modal route state
- run details modal route state
- unknown routes

## Risks

- TanStack Router APIs can make tests heavier than a pure parser.
- `App.tsx` is large, so route changes can accidentally alter unrelated state flow.
- Modal close behavior depends on prior route context; simple "go to parent" logic may not match every current behavior.

Mitigations:

- Keep route-spec and adapter changes behavior-preserving.
- Use adapter tests before changing route consumers.
- Keep URL shapes unchanged.
- Prefer one route surface at a time if the implementation gets large.

## Acceptance Criteria

- `App.tsx` no longer calls `parseDashboardPath`.
- Route declarations and path builders share one route spec.
- Existing dashboard URLs still work.
- Prompt and run details modal routes still deep-link.
- Typecheck, tests, and dashboard build pass.

## Implementation Notes

Implemented files:

- `src/dashboard/web/src/route-spec.ts` is the route source of truth for path templates and encoded path builders.
- `src/dashboard/web/src/router-factory.ts` creates the TanStack route tree from `route-spec.ts` without importing `App.tsx`, so unit tests can instantiate the router without loading CSS-bearing UI components.
- `src/dashboard/web/src/router.tsx` now only binds `App` to the shared router factory.
- `src/dashboard/web/src/dashboard-routes.ts` keeps the route-state union and selector helpers, but derives route state from router matches via `dashboardRouteStateFromMatches`.
- `tests/unit/dashboard-routes.test.ts` verifies route declarations, builders, router matches, encoded params, prompt routes, run details routes, and legacy `?workflow=` behavior.
- `tests/e2e/dashboard.spec.js` covers workflow deep-links, prompt modal deep-links with back/forward, and run details/step/agent deep-links.

Optional route-aware `App.tsx` component extraction was not done in this pass. After replacing the parser, the route-facing code remained localized enough that extracting `WorkflowRouteView`, `RunRouteView`, or modal bridge components would be cleanup rather than required migration work.
