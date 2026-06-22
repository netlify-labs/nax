# NAX Dashboard Route Consolidation Plan

> Status: Draft implementation plan.
> Scope: dashboard client routing architecture.
> Primary goal: make TanStack Router the single source of truth for dashboard view state, route params, modal destinations, and navigation helpers.

## Summary

The dashboard now has useful URL-addressable routes, but route ownership is split:

- `src/dashboard/web/src/router.tsx` declares the TanStack Router tree.
- `src/dashboard/web/src/dashboard-routes.ts` manually parses `location.pathname`.
- `src/dashboard/web/src/App.tsx` reads `useRouterState`, calls `parseDashboardPath`, then derives selected workflow/run/step/modal state from that manual parser.
- Navigation helpers manually build route strings.

This works, but every route has to stay synchronized across at least two systems. The next routing pass should remove that duplication so adding or changing a route happens in one route table.

The right end state is not "delete TanStack Router" or "delete all helper functions". The right end state is:

- TanStack Router owns route matching and params.
- Route declarations contain the path structure and route ids.
- App rendering consumes typed route matches/params, not a second pathname parser.
- Navigation helpers are generated from or colocated with the route table.
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

`src/dashboard/web/src/router.tsx` declares routes such as:

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
- `parseDashboardPath(pathname)`
- helper selectors like `routeWorkflowId`, `routeRunId`, and `routeRunStepId`
- path builder helpers such as `workflowPath`, `runPath`, and details routes

`App.tsx` does this:

```ts
const pathname = useRouterState({ select: (state) => state.location.pathname })
const routeState = useMemo(() => parseDashboardPath(pathname), [pathname])
```

That means the TanStack route tree and `parseDashboardPath` must agree forever, but nothing mechanically enforces that.

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

## Proposed Architecture

### 1. Route Table As Source Of Truth

Create a route specification module, likely `src/dashboard/web/src/route-spec.ts`, that contains the route ids, path segments, and path builders.

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

The exact implementation can be more compact, but the important rule is that route declarations and path builders import from the same source.

### 2. TanStack Router Owns Matching

Update `router.tsx` so every route is created from the route spec. Routes may still render a shell-level null component if `App.tsx` remains the root renderer, but the route ids and params should be accessible from the router match state.

Use TanStack Router match APIs in `App.tsx`:

- `useMatches`
- `useMatchRoute`
- `getRouteApi` for individual routes where useful

The app should derive route state from matched route ids and params, not from `pathname`.

### 3. Replace `DashboardRouteState` With Matched State

Keep a small route-state adapter during migration:

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

After `App.tsx` fully consumes route APIs directly, this adapter can shrink or disappear.

### 4. Keep Navigation Helpers, But Stop Duplicating Parse Logic

Helpers such as `workflowPath`, `workflowStepPath`, `runPath`, and `runAgentPath` are valuable because they centralize URL encoding.

Keep them, but move them into the same source as route specs. Delete manual regex/pathname parsing once the router adapter has replaced it.

### 5. Route Tests

Add tests that assert:

- every path builder produces a URL matched by the router
- route params round-trip for ids containing spaces, slashes encoded as `%2F`, and model names with punctuation
- unknown paths fall back to home/not-found behavior intentionally
- prompt routes and details routes produce the correct modal state

The test should not reimplement parsing. It should instantiate the router or call the route-state adapter with real matches.

## Implementation Phases

### Phase 1: Introduce Route Spec

Tasks:

- Add `route-spec.ts`.
- Move existing path builder helpers into it or make `dashboard-routes.ts` re-export from it temporarily.
- Update `router.tsx` to import paths from the spec.
- Keep `parseDashboardPath` unchanged for now.

Validation:

- Existing route parser tests still pass.
- New route spec tests prove path builders match declared route patterns.

Rationale:

This creates the shared source without changing app behavior.

### Phase 2: Add Match-Based Route Adapter

Tasks:

- Add `routeStateFromRouterState` or `routeStateFromMatches`.
- Use TanStack Router match data to produce the same `DashboardRouteState` union currently produced by `parseDashboardPath`.
- Add tests comparing current parser output to match-based output for the known route matrix.

Validation:

- `npm run typecheck`
- focused route tests
- `npm run dashboard:build`

Rationale:

This gives a safe equivalence bridge before removing the old parser.

### Phase 3: Switch `App.tsx` To Match-Based Route State

Tasks:

- Replace `useRouterState(...pathname)` plus `parseDashboardPath(pathname)` with match-based route state.
- Keep downstream selectors like `routeWorkflowId` if they still simplify `App.tsx`.
- Verify workflow configure routes, run inspect routes, prompt modal routes, and details modal routes.

Validation:

- Unit tests for route adapter.
- Dashboard build.
- Existing e2e smoke if cheap enough in the implementation pass.

Rationale:

This removes the actual production duplication while minimizing rendering changes.

### Phase 4: Delete Manual Parser

Tasks:

- Delete `parseDashboardPath` or keep it only as a test helper if absolutely needed.
- Remove tests that assert manual pathname parsing.
- Replace them with route spec/router match tests.
- Update imports.

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

- Keep Phase 1 and Phase 2 behavior-preserving.
- Use adapter tests before switching `App.tsx`.
- Keep URL shapes unchanged.
- Prefer one route surface at a time if the implementation gets large.

## Acceptance Criteria

- `App.tsx` no longer calls `parseDashboardPath`.
- Route declarations and path builders share one route spec.
- Existing dashboard URLs still work.
- Prompt and run details modal routes still deep-link.
- Typecheck, tests, and dashboard build pass.

