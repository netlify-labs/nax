# NAX Dashboard React Query Server-State Plan

> Status: Draft for review.
> Scope: dashboard client request/state architecture.
> Primary goal: standardize requests to and from the local dashboard server with shared TanStack Query hooks, deduped reads, coherent mutation invalidation, and a clear boundary between server state, live event state, and UI state.

## Executive Summary

The dashboard currently works, but its request/state model is too ad hoc for the amount of server interaction it now performs.

`src/dashboard/web/src/App.tsx` manually owns:

- workflow list data
- workflow graph data
- recent run list data
- selected run graph data
- active run state
- run polling
- health/project-root data
- refresh keys
- duplicated loading and error flags

`src/dashboard/web/src/components/RunDetailsModal.tsx` independently owns:

- run-details fetch state
- run-details polling while entries are cancellable
- live-revision-driven refreshes
- local stale response guards

That manual state is now overlapping with the event-driven live path. The recent queued/running/completed UI bugs happened in exactly this overlap: persisted server state, graph state, details state, and live reducer state were all being merged in different places.

Adopt `@tanstack/react-query` for dashboard server state:

- reads are expressed as common query hooks
- duplicate consumers share the same cache entry and in-flight request
- mutations update or invalidate the same keys
- polling lives in query options instead of hand-written intervals when it is ordinary REST polling
- live SSE events keep using the reducer, but patch/invalidate query caches at well-defined points

Do not use Query as a replacement for every piece of state. Keep local React state for UI-only state and keep `liveRunReducer` for the SSE event stream.

## Decision

Use TanStack Query for server state in the Vite dashboard app.

Use it narrowly and deliberately:

- Server state: Query.
- Server mutations: Query mutations.
- Server-state cache updates after mutations/SSE: QueryClient.
- Local UI state: React state.
- Live event stream state: existing reducer plus Query cache reconciliation.
- URL state: future TanStack Router plan, separate from this plan.

This complements `docs/ai/plans/nax-dashboard-routing.md`, which explicitly deferred Query during the first router migration. Routing and Query can be introduced independently, but the long-term design should let Router own addressable navigation and Query own server data.

## Current State Map

### API Functions

`src/dashboard/web/src/api.ts` already provides a clean typed API boundary:

- `getHealth()`
- `listWorkflows()`
- `getWorkflowGraph(id)`
- `runWorkflowDryRun(id, options)`
- `startWorkflowRun(id, options)`
- `cancelWorkflowRun(id)`
- `cancelFollowupRun(id, target)`
- `approveHumanReviewGate(id, target)`
- `cancelHumanReviewGate(id, target)`
- `listRuns()`
- `getRunGraph(id)`
- `getRunDetails(id)`
- `startRunFollowup(id, options)`
- `openLocalFile(path)`
- `runEventsStream(id, since, handlers)`

These should remain the low-level request functions. Query hooks should wrap them rather than replacing them.

`runEventsStream` is not a normal query. It is a long-lived event transport and should remain separate.

### App-Level Manual Reads

`App.tsx` has manual reads and manual loading/error state:

- `getHealth()` effect keyed by `refreshKey`
- `listWorkflows()` effect keyed by `refreshKey`
- `getWorkflowGraph(selectedWorkflowId)` effect keyed by selected workflow and refresh key
- `refreshRuns()` wrapping `listRuns()`, called from effects, mutation handlers, and reconciliation paths
- `getRunGraph(id)` in `selectRun`
- `getRunGraph(selectedRunId)` polling when the graph has active remote runs

The main repeated pattern is:

```ts
setLoadingX(true)
apiCall()
  .then(setData)
  .catch(setError)
  .finally(() => setLoadingX(false))
```

This is the exact pattern Query should replace.

### Run Details Manual Reads

`RunDetailsModal.tsx` has its own `getRunDetails(detailsRunId)` path:

- initial fetch on open
- `refreshDetails()` callback used after cancellation/review actions
- 7-second polling while any entry is cancellable
- live-revision debounce refetch
- separate `detailsLoading`, `detailsError`, `detailsResponse`

This is a strong candidate for `useRunDetailsQuery(runId, { enabled })` plus targeted invalidation/refetch.

### Mutations

Current mutation-like flows:

- dry-run workflow
- start workflow run
- cancel active run
- select run graph
- cancel follow-up entry
- approve/cancel human review gate
- submit follow-up
- open local file

Only some should become Query mutations:

- yes: dry-run, start run, cancel run, cancel follow-up, approve/cancel review, start follow-up
- probably no: open local file, because it is a side-effecting OS action with transient UI status and no meaningful cache invalidation
- not a mutation: select run graph; it is navigation plus a query read

### Live Event State

`liveRunReducer` owns:

- live run status
- stdout/stderr output
- step statuses
- agent statuses
- artifacts
- raw events
- event dedupe by sequence/id

This state is not server cache. It is an event-sourced live view. Keep it.

However, the live reducer and Query cache need a bridge:

- terminal events should invalidate `runs`, `runGraph`, and possibly `runDetails`
- graph-changing events may patch `runGraph` if the server payload is available, or wait for the periodic server graph query
- mutation responses should update Query cache and then let SSE fill in fine-grained progress

## Problems To Solve

### P1. Duplicate Requests

The same run details can be fetched by:

- opening details from Recent Runs
- opening details from a graph step/agent
- live revision refresh
- cancellable-entry polling
- mutation refresh

Without a shared cache, those can overlap or race. Query will dedupe in-flight requests for the same key.

### P2. Stale Response Races

Manual effects guard with local `cancelled` flags, but this pattern is repeated and easy to get wrong. Query centralizes stale result handling by query key and active observers.

### P3. Local Refresh Key

`refreshKey` is a coarse invalidation mechanism. It reloads unrelated data and forces effects to re-run. Replace it with query invalidation by key:

- invalidate health only when health is needed
- invalidate workflows only when workflow definitions may have changed
- invalidate runs after run mutations
- invalidate a specific run graph/details after run mutations or terminal events

### P4. Mixed Sources Of Truth

The graph, details modal, recent runs list, and live reducer can currently disagree. Query cannot solve projection mistakes by itself, but it gives one canonical cache for each server response.

The dashboard should have explicit precedence rules:

1. Server persisted run graph/details are the recovery/history source.
2. SSE live reducer is the immediate active-run overlay.
3. UI projections merge server state plus live overlay in one place.
4. Local UI state never invents server facts.

### P5. Polling Ownership

Polling exists in several hand-written intervals. Ordinary REST polling should move into Query where possible:

- active run graph polling
- run details polling while cancellable entries exist
- recent runs polling while any run is active, if needed

The SSE reconnect loop remains manual because it is transport state, not REST polling.

## Non-Goals

- Do not replace the SSE stream with Query.
- Do not move dry-run visual simulation into Query.
- Do not route dashboard URLs in this plan.
- Do not add TanStack Router as part of this plan.
- Do not rewrite server endpoints unless a specific missing endpoint blocks deduped client state.
- Do not introduce optimistic updates for remote runner completion states; remote work is expensive and best-effort, so optimistic status can mislead.
- Do not convert tiny UI interactions like copy/open-file button states into Query.

## Desired Architecture

### File Layout

Add:

```txt
src/dashboard/web/src/query-client.ts
src/dashboard/web/src/query-keys.ts
src/dashboard/web/src/queries/
  dashboard-queries.ts
  dashboard-mutations.ts
```

Optionally split later:

```txt
src/dashboard/web/src/queries/health.ts
src/dashboard/web/src/queries/workflows.ts
src/dashboard/web/src/queries/runs.ts
src/dashboard/web/src/queries/run-details.ts
```

Start with one or two files to avoid premature fragmentation.

### Query Client Setup

Add `@tanstack/react-query` to dependencies.

Create `query-client.ts`:

```ts
import { QueryClient } from '@tanstack/react-query'

export const dashboardQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 1000,
      gcTime: 5 * 60 * 1000,
    },
    mutations: {
      retry: 0,
    },
  },
})
```

Rationale:

- local dashboard data changes often enough that infinite stale time is wrong
- refetch-on-focus can create distracting local server traffic while developing
- one retry handles transient local server hiccups without hiding real errors
- mutation retry should default off because starting/cancelling remote work may be expensive or non-idempotent

Wrap the React root in `QueryClientProvider`.

### Query Keys

Create typed key factories. Do not use ad hoc inline arrays in components.

```ts
export const dashboardQueryKeys = {
  all: ['dashboard'] as const,
  health: () => [...dashboardQueryKeys.all, 'health'] as const,
  workflows: () => [...dashboardQueryKeys.all, 'workflows'] as const,
  workflowGraph: (workflowId: string) => [...dashboardQueryKeys.all, 'workflowGraph', workflowId] as const,
  runs: () => [...dashboardQueryKeys.all, 'runs'] as const,
  runGraph: (runId: string) => [...dashboardQueryKeys.all, 'runGraph', runId] as const,
  runDetails: (runId: string) => [...dashboardQueryKeys.all, 'runDetails', runId] as const,
}
```

Rules:

- include only server-fetch inputs in query keys
- do not include UI-only values such as selected node, active tab, modal open state, or live revision
- do not include `liveRevision` in `runDetails` keys; it should trigger invalidation/refetch, not create a new cache entry for the same resource
- include workflow/run ids exactly as server ids, not display titles

### Read Hooks

Create hooks with small, explicit contracts:

```ts
export function useDashboardHealthQuery()
export function useWorkflowsQuery()
export function useWorkflowGraphQuery(workflowId: string, options?: { enabled?: boolean })
export function useRunsQuery(options?: { refetchInterval?: number | false })
export function useRunGraphQuery(runId: string, options?: { enabled?: boolean; refetchInterval?: number | false })
export function useRunDetailsQuery(runId: string, options?: { enabled?: boolean; refetchInterval?: number | false })
```

Each hook should return the raw Query result. Components can use `data`, `isPending`, `isFetching`, `error`, and `refetch` as needed.

Use `select` only for stable, reusable projections. Do not hide important raw data too early.

### Mutation Hooks

Create mutation hooks:

```ts
export function useDryRunWorkflowMutation()
export function useStartWorkflowRunMutation()
export function useCancelWorkflowRunMutation()
export function useCancelFollowupRunMutation()
export function useApproveReviewGateMutation()
export function useCancelReviewGateMutation()
export function useStartRunFollowupMutation()
```

Each mutation should have cache effects close to the mutation definition, not scattered in UI event handlers.

Example invalidation rules:

- dry run:
  - no persistent server cache update
  - component owns returned dry-run result
- start workflow run:
  - invalidate `runs`
  - seed/patch `runs` with returned run if possible
  - optionally invalidate `runGraph(runId)` after durable run id is known
- cancel workflow run:
  - patch returned run into `runs`
  - invalidate `runGraph(runId)`
  - invalidate `runDetails(runId)`
- cancel follow-up:
  - patch returned run into `runs`
  - invalidate `runGraph(runId)`
  - invalidate `runDetails(runId)`
- approve/cancel review:
  - patch returned run into `runs` when available
  - invalidate `runGraph(runId)`
  - invalidate `runDetails(runId)`
- start follow-up:
  - invalidate `runs`
  - invalidate source `runDetails(sourceRunId)`
  - if response returns persisted/source workflow run ids, invalidate those run graphs/details too

### Cache Utility Functions

Create small cache helpers for repeated response merging:

```ts
export function mergeRunLists(active: DashboardRun[], durable: DashboardRun[]): DashboardRun[]
export function replaceRunInList(runs: DashboardRun[], run: DashboardRun): DashboardRun[]
export function upsertRunInRunsCache(queryClient: QueryClient, run: DashboardRun): void
```

Some of these already exist in `App.tsx`. Move the pure ones out if they become shared by mutations and components.

Avoid putting UI actions inside these helpers. They should only transform cache data.

## Server-State Ownership Model

### Health

Source:

- `GET /api/health`

Query:

- `dashboardQueryKeys.health()`

Owned data:

- `projectRoot`
- any future server capabilities

Consumer:

- header project root display

Migration:

- replace `projectRoot` state and `getHealth` effect with `useDashboardHealthQuery`
- derive `projectRoot = healthQuery.data?.projectRoot || ''`

Invalidation:

- manual refresh button can invalidate `health`
- no polling needed

### Workflows

Source:

- `GET /api/workflows`

Query:

- `dashboardQueryKeys.workflows()`

Owned data:

- workflow definitions list

Consumer:

- `WorkflowList`
- selected workflow lookup
- default workflow selection
- resume-run workflow lookup

Migration:

- replace `workflows` state and `listWorkflows` effect with `useWorkflowsQuery`
- preserve default selection behavior in a small effect:
  - when workflows load, if current selected id does not exist, select first workflow
  - do not make the query hook own selection

Invalidation:

- manual refresh button invalidates `workflows`
- no polling needed

### Workflow Graph

Source:

- `GET /api/workflows/:id/graph`

Query:

- `dashboardQueryKeys.workflowGraph(workflowId)`

Owned data:

- graph for a workflow definition before any run is selected

Consumer:

- `WorkflowCanvas`
- `Inspector`
- dry-run simulation

Migration:

- replace `graph` state for workflow definition mode with `useWorkflowGraphQuery(selectedWorkflowId)`
- keep local graph state only if needed for loaded run graph during intermediate migration; long-term derive graph from either workflow query or run graph query

Invalidation:

- manual refresh button invalidates current workflow graph
- selecting a different workflow switches query key

### Runs List

Source:

- `GET /api/runs`

Query:

- `dashboardQueryKeys.runs()`

Owned data:

- recent active and durable runs, merged for UI

Consumer:

- `RecentRuns`
- selected run snapshot
- active-run reconciliation
- follow-up/update handlers

Migration:

- replace `runs` state and `refreshRuns()` with `useRunsQuery`
- use a query `select` or helper to return merged list:

```ts
select: (response) => mergeRunLists(response.active, response.durable)
```

Invalidation:

- after start/cancel/follow-up/review mutations
- after terminal SSE event
- optional polling while an active run exists

Refetch:

- prefer event-driven invalidation for current active run
- consider `refetchInterval: 5000` only while active runs exist if durable run list must recover from missed events

### Run Graph

Source:

- `GET /api/runs/:id/graph`

Query:

- `dashboardQueryKeys.runGraph(runId)`

Owned data:

- workflow graph for a concrete run
- run options
- run metadata

Consumer:

- `WorkflowCanvas` in inspect mode
- selected run graph polling
- run options hydration into `dryRunOptions`

Migration:

- replace `selectRun` fetch path with state transition plus `useRunGraphQuery(selectedRunId)`
- when `runGraphQuery.data` changes:
  - set selected workflow id if needed
  - hydrate `dryRunOptions` from `response.run.options`
  - set workflow URL for compatibility until router migration
  - reset selected node if graph identity changes

Important:

- keep this hydration effect small and keyed by run id/data identity
- do not store the same graph response in local `graph` forever
- derive rendered graph from:
  - run graph query when `selectedRunId` exists
  - workflow graph query otherwise

Polling:

- replace `getRunGraph(selectedRunId)` interval with `useRunGraphQuery(selectedRunId, { refetchInterval })`
- refetch every 7000 ms only when the last known graph has active remote runs
- no polling for completed historical runs

### Run Details

Source:

- `GET /api/runs/:id/details`

Query:

- `dashboardQueryKeys.runDetails(runId)`

Owned data:

- summary markdown
- final markdown
- per-step details
- per-agent session sections
- follow-up targets/artifacts
- metadata for details modal

Consumer:

- `RunDetailsModal`
- `RunFollowupContent`

Migration:

- replace `detailsLoading`, `detailsError`, `detailsResponse`, and `refreshDetails()` with `useRunDetailsQuery(detailsRunId, { enabled: opened && Boolean(detailsRunId) })`
- keep UI-only timeline selection and tab state local
- use `query.refetch()` or `queryClient.invalidateQueries({ queryKey: runDetails(runId) })` after mutations

Polling:

- while modal is open and any entry has a cancel target, set `refetchInterval: 7000`
- when `liveRevision` changes, debounce an invalidation/refetch for the same query key
- do not put `liveRevision` in the key

Details mutation effects:

- cancel follow-up: invalidate details and run graph
- approve/cancel review: invalidate details and run graph
- follow-up submit: invalidate source details and runs

### Open Local File

Source:

- `POST /api/files/open`

Do not put this in Query initially.

Rationale:

- it has no durable cache state
- action status is button-local
- errors should remain local to the action UI

Keep `ArtifactActions` local `opening`, `cancelling`, `copied`, and `error` state unless it becomes shared.

## Live Event Integration

### Keep SSE Separate

Keep:

- `runEventsStream`
- `liveRunReducer`
- reconnect timer
- stdout/stderr accumulation
- raw event diagnostics

Do not use `useQuery` for SSE. Query is for fetch/mutate/cache. The event stream is a subscription and event reducer.

### Query Cache Bridge

Add a small bridge from SSE events to Query cache operations.

At minimum:

- on `workflow_started`:
  - seed/patch returned run id into local active run state
  - invalidate `runs`
- on `agent_status` / `step_status`:
  - reducer updates immediate UI
  - optional: do not invalidate every status event; too chatty
- on `artifact_written`:
  - invalidate `runDetails(runId)` if the details modal is open for that run
  - optional: invalidate `runGraph(runId)` if graph depends on artifact presence
- on terminal events:
  - invalidate `runs`
  - invalidate `runGraph(runId)`
  - invalidate `runDetails(runId)` if cached/open

Avoid invalidating on every event. The live reducer already updates immediate visible state. Server refetch should happen at meaningful durable boundaries.

### Active Run State

`activeRun` can remain local during the first migration because it carries UI/session behavior around the currently launched run and SSE connection.

Long-term option:

- keep only `activeRunId` locally
- derive the active run snapshot from `runsQuery.data` plus reducer state

Do not force this in Phase 1. Query migration should reduce request duplication first.

## UI State That Should Stay Local

Keep these as React state:

- `selectedWorkflowId` until router plan lands
- `selectedNode`
- `dryRunOptions`
- `dryRunResult` unless using mutation result directly
- `runOutput`
- `runRunning`
- `runError` if it includes SSE/transport errors, not just mutation errors
- `cancelRunning` during initial migration, though a cancel mutation can replace it later
- `contextModalAction`
- `contextDraft`
- `promptModalStepId`
- `detailsModalContext`
- `activeTimelineId`
- `selectionWarning`
- `detailsView`
- `contentView`
- `followupSubmitting`
- splitter state
- copy/open button feedback
- table/list search query

The rule: if the server cannot answer "what is this value on reload?", it probably does not belong in Query.

## Migration Plan

### Phase 0: Dependency And Provider

Goal: install Query infrastructure with no behavior change.

Tasks:

1. Add `@tanstack/react-query` to dependencies.
2. Create `src/dashboard/web/src/query-client.ts`.
3. Create `src/dashboard/web/src/query-keys.ts`.
4. Wrap the dashboard root in `QueryClientProvider`.
5. Do not migrate any fetches yet.

Validation:

```bash
npm run typecheck
npm run dashboard:build
```

Acceptance:

- dashboard still loads
- no visual behavior change
- no query hook use yet, or only provider-level setup

### Phase 1: Read Query Hooks

Goal: create common hooks and use them for simple reads.

Tasks:

1. Create `dashboard-queries.ts`.
2. Add:
   - `useDashboardHealthQuery`
   - `useWorkflowsQuery`
   - `useWorkflowGraphQuery`
   - `useRunsQuery`
3. Move `mergeRunLists` if needed so `useRunsQuery` can return merged runs.
4. Replace `getHealth` effect.
5. Replace `listWorkflows` effect.
6. Replace `refreshRuns` effect with `useRunsQuery`.

Do not migrate run graph/details yet in this phase.

Notes:

- Keep selected workflow state local.
- Keep the default-selected workflow effect, but make it react to `workflowsQuery.data`.
- Replace `loadingWorkflows` with `workflowsQuery.isPending`.
- Replace workflow list error handling with `workflowsQuery.error`.
- Keep existing top-level `error` state only for app-level actions that are not tied to one query, or derive the displayed error from query/mutation errors.

Validation:

```bash
npm run typecheck
npm run dashboard:build
```

Recommended smoke:

- dashboard loads workflow list
- first workflow auto-selects
- project root appears in header
- recent runs still render
- manual refresh invalidates the relevant queries

### Phase 2: Workflow Graph Query

Goal: replace manual workflow graph fetch.

Tasks:

1. Use `useWorkflowGraphQuery(selectedWorkflowId, { enabled: Boolean(selectedWorkflowId && !selectedRunId) })`.
2. Replace `loadingGraph` for workflow mode with `workflowGraphQuery.isPending || workflowGraphQuery.isFetching`.
3. Derive `currentGraph` from workflow graph query when no run is selected.
4. Preserve side effects:
   - clear dry-run simulation on workflow id change
   - reset live reducer on workflow id change
   - reset dry-run options on workflow id change
   - set URL compatibility with `?workflow=`
5. Remove direct `getWorkflowGraph` effect once behavior matches.

Validation:

```bash
npm run typecheck
npm run dashboard:build
```

Manual smoke:

- workflow switch loads correct graph
- agent toggles still work
- dry-run simulation still works
- no stale graph appears after rapidly switching workflows

### Phase 3: Run Graph Query

Goal: replace `selectRun` fetch and active run graph polling.

Tasks:

1. Add `useRunGraphQuery(selectedRunId, { enabled: Boolean(selectedRunId), refetchInterval })`.
2. Change `selectRun(run)` to:
   - set selected run id
   - clear workflow-only/transient UI where needed
   - let query load the graph
3. Hydrate state from `runGraphQuery.data`:
   - selected workflow id
   - dry-run options from `response.run.options`
   - step models via `stepModelsFromRunGraph(response.graph)`
   - selected node reset
   - compatibility URL
4. Derive `currentGraph` from run graph query when `selectedRunId` exists.
5. Replace the manual 7000 ms `getRunGraph` polling effect with query `refetchInterval`.
6. When run graph query returns a run, patch that run into `runs` query cache instead of local `setRuns`.

Refetch interval rule:

- `false` if no selected run id
- `false` if graph is absent
- `7000` if `graphHasActiveRemoteRuns(graph)` is true
- `false` otherwise

Validation:

```bash
npm run typecheck
npm run dashboard:build
```

Manual smoke:

- selecting Recent Run loads graph
- completed historical run does not poll continuously
- active run graph updates while remote work continues
- graph mode remains inspect for selected run

### Phase 4: Run Details Query

Goal: centralize run details requests and polling.

Tasks:

1. Add `useRunDetailsQuery(detailsRunId, options)`.
2. Replace `RunDetailsModal` manual fetch state with the query.
3. Convert `refreshDetails()` call sites to query invalidation/refetch.
4. Implement cancellable-entry polling as a query `refetchInterval`.
5. Implement live-revision refresh as a debounced `queryClient.invalidateQueries` or `query.refetch()`.
6. Keep timeline selection, content tab, follow-up view, and TOC state local.

Key detail:

- `detailsRunId` is the key input
- `initialSelector` is not a key input
- `liveRevision` is not a key input

Validation:

```bash
npm run typecheck
npm run dashboard:build
```

Manual smoke:

- open run details from Recent Runs
- open details from graph agent
- active details modal updates after agent result arrives
- queued/running/completed timeline labels remain correct
- cancelling/reviewing entries refreshes the modal and graph

### Phase 5: Mutations

Goal: standardize server writes and cache invalidation.

Tasks:

1. Create `dashboard-mutations.ts`.
2. Add mutation hooks for:
   - dry run
   - start workflow run
   - cancel workflow run
   - cancel follow-up run
   - approve review
   - cancel review
   - start follow-up
3. Move cache updates/invalidation into mutation `onSuccess`.
4. Replace manual mutation loading/error state gradually:
   - start with cancel/review/follow-up because they already return concrete server state
   - migrate start-run after confirming SSE handoff behavior
   - migrate dry-run last or leave it local if mutation state is not worth the churn

Cache effects:

```txt
start run:
  upsert returned run in runs cache
  invalidate runs

cancel run:
  upsert returned run in runs cache
  invalidate runGraph(runId)
  invalidate runDetails(runId)

cancel follow-up:
  upsert returned run in runs cache
  invalidate runGraph(sourceRunId)
  invalidate runDetails(sourceRunId)

approve/cancel review:
  upsert returned run when present
  invalidate runGraph(runId)
  invalidate runDetails(runId)

start follow-up:
  invalidate runs
  invalidate source runGraph/source runDetails
  invalidate persisted follow-up run graph/details if response exposes ids
```

Validation:

```bash
npm run typecheck
npm run dashboard:build
```

Manual smoke:

- start run updates Recent Runs without manual refresh
- cancel active run updates graph and details
- submit follow-up appears after response
- review approve/cancel updates step state

### Phase 6: SSE Cache Bridge

Goal: make live events and Query cache cooperate without chatty refetching.

Tasks:

1. Add a small helper that accepts `queryClient` and parsed `RunnerEvent`.
2. Call it from the existing event dispatch path after `dispatchLiveRun`.
3. On terminal events, invalidate `runs` and current run graph/details.
4. On artifact events, invalidate details for the affected run if modal is open or cached.
5. Do not invalidate on every `agent_status` or `step_status`.

Validation:

```bash
npm run typecheck
npm run dashboard:build
```

Manual smoke:

- active run reaches terminal state and recent runs list updates
- details modal gets new artifacts without manual refresh
- graph remains responsive during frequent event updates

### Phase 7: Cleanup

Goal: remove duplicate request plumbing.

Tasks:

1. Remove `refreshKey` if all callers can invalidate query keys instead.
2. Remove `refreshRuns()` callback once all uses are replaced.
3. Remove manual loading/error flags that have query/mutation equivalents.
4. Remove stale `cancelled` effect guards for migrated fetches.
5. Consolidate derived `statusText` from query states.
6. Review `App.tsx` for remaining API calls; every ordinary REST read should have a hook.

Validation:

```bash
npm run typecheck
npm run dashboard:build
npm run dashboard:smoke
```

Acceptance:

- no duplicate manual fetch logic for health/workflows/runs/graphs/details
- no global refresh key needed for normal reloads
- shared hooks are the default path for new server reads

## Request Deduplication Rules

1. Every GET endpoint used by React components must have one query hook.
2. Components must not call `getRunDetails`, `getRunGraph`, `getWorkflowGraph`, `listRuns`, or `listWorkflows` directly after migration.
3. Query keys must come from `dashboardQueryKeys`.
4. Do not include UI-only state in query keys.
5. Prefer invalidation over local refresh counters.
6. Prefer `setQueryData` only when the mutation response has the full object being cached.
7. Do not optimistically mark remote agent work as completed/running.
8. Do not invalidate high-frequency status events unless the server persisted state has likely changed.

## Error Handling Plan

Use Query errors for server reads:

- workflow list error appears where the list/status badge currently shows app error
- graph query error appears in the main status area
- run details query error appears in the modal
- runs query error should not erase the last good list unless explicitly desired

Use mutation errors for action buttons:

- dry-run/start-run errors can show in output panel
- cancel/review/follow-up errors show near the action surface
- file-open errors stay local

Avoid a single global `error` string for everything after migration. It obscures which request failed and can be overwritten by unrelated operations.

## Loading State Plan

Use:

- `isPending` for first load
- `isFetching` for background refetch
- `isMutating` or mutation-specific `isPending` for actions

Do not blank the graph/details UI on every background refetch. Keep previous data visible with a subtle loading affordance if needed.

For graph loading:

- first load: show loading state
- background poll: keep current graph visible
- workflow/run id change: show loading state for the new key

For details loading:

- first open: show loading
- background poll/live refresh: keep current details visible

## Testing Strategy

### Unit Tests

Add focused tests for pure helpers:

- query key factory returns stable keys
- run-list merge/upsert helpers preserve newest entries
- mutation cache helper replaces runs by `runId` or `id`
- graph-active polling predicate returns true only for active remote graph state

Potential test files:

```txt
tests/unit/dashboard-query-keys.test.ts
tests/unit/dashboard-query-cache.test.ts
```

### Component/Integration Tests

If dashboard test setup can support Query provider:

- render `RunDetailsModal` under a test `QueryClientProvider`
- verify one query result can populate timeline
- verify initial selector changes active timeline without refetching different keys

Do not overbuild component tests if the current test stack makes this heavy. The query hook migration should still have pure helper coverage and smoke tests.

### E2E / Smoke

Run existing:

```bash
npm run dashboard:smoke
```

Extend when practical:

- selecting Recent Run does not issue duplicate `GET /api/runs/:id/graph`
- opening details twice for the same run uses cached data while refetching in background
- cancelling a run updates Recent Runs and graph without manual refresh
- active run reaches terminal state and durable graph/details reconcile

### Required Checks

After UI-affecting phases:

```bash
npm run typecheck
npm run dashboard:build
```

The repository rule requires `npm run dashboard:build` after every UI change.

## Rollout Strategy

Use small commits:

1. Query provider + key factories.
2. Health/workflows/runs query hooks.
3. Workflow graph query.
4. Run graph query and polling.
5. Run details query.
6. Mutations.
7. SSE cache bridge.
8. Cleanup.

Each commit should preserve behavior and pass `npm run dashboard:build`.

Avoid mixing Query migration with visual polish. This migration changes state semantics; visual changes make regressions harder to review.

## Acceptance Criteria

- The dashboard has shared Query hooks for all ordinary REST reads.
- Opening the same run details from different surfaces dedupes in-flight requests.
- Selecting a run graph and opening its details does not maintain separate competing copies of the same server state.
- Mutations invalidate or patch the relevant run caches in one shared place.
- SSE remains the immediate live source for active run progress.
- Terminal SSE events trigger durable server-state reconciliation.
- Background polling is owned by Query options where applicable.
- Manual refresh uses query invalidation, not a global refresh counter.
- No UI-only state is moved into Query.
- `npm run typecheck` passes.
- `npm run dashboard:build` passes.
- `npm run dashboard:smoke` passes before final handoff.

## Risks And Mitigations

### Risk: Query Migration Hides Live State Bugs

Mitigation:

- keep `liveRunReducer` unchanged through early phases
- only bridge terminal/durable events first
- do not invalidate on every live status event

### Risk: Cache Patches Become Incorrect

Mitigation:

- prefer invalidation unless the mutation response is complete
- keep cache helper tests small and focused
- patch only `runs` list with returned `DashboardRun`; refetch graph/details when structure may have changed

### Risk: App.tsx Becomes Half Query, Half Manual For Too Long

Mitigation:

- migrate by data domain, not random call sites
- remove manual fetch code in the same phase that replaces it
- track remaining direct API reads with `rg`

### Risk: Query Refetches Too Often

Mitigation:

- disable refetch on window focus initially
- use conditional refetch intervals
- avoid invalidating on high-frequency status events
- use `isFetching` instead of clearing data

### Risk: Run Graph Hydration Effects Loop

Mitigation:

- key hydration by run id and stable response identity
- do not call `setSelectedWorkflowId` if it already matches
- do not keep two writable graph states long-term

### Risk: Router Plan Conflicts Later

Mitigation:

- keep query keys based on ids, not route implementation
- keep selection/navigation state outside Query
- Router can later read ids from routes and pass them to the same hooks

## Open Questions

1. Should React Query Devtools be added for local development only?
   - Recommendation: optional, dev-only, not needed for first migration.

2. Should `listRuns` return already-merged runs from the API instead of active/durable arrays?
   - Recommendation: not required. Keep the API as-is and merge in a shared client helper.

3. Should active run state eventually collapse to `activeRunId` plus query/cache data?
   - Recommendation: yes later, but not in the initial migration.

4. Should `runDetails` refetch on every artifact event?
   - Recommendation: only if the details modal is open for that run or if the query is already cached. Otherwise invalidate at terminal state.

5. Should dry-run use Query mutation?
   - Recommendation: yes eventually for consistent request loading/error, but it can be left local until persistent server-state hooks are stable.

## Implementation Checklist

- [ ] Add `@tanstack/react-query`.
- [ ] Add `QueryClientProvider`.
- [ ] Add query key factories.
- [ ] Add read query hooks.
- [ ] Replace health effect.
- [ ] Replace workflows effect.
- [ ] Replace runs effect.
- [ ] Replace workflow graph effect.
- [ ] Replace run graph fetch/poll.
- [ ] Replace run details fetch/poll.
- [ ] Add mutation hooks.
- [ ] Centralize mutation invalidation.
- [ ] Add SSE-to-query-cache bridge.
- [ ] Remove `refreshKey`.
- [ ] Remove obsolete manual loading/error flags.
- [ ] Add helper tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run dashboard:build`.
- [ ] Run `npm run dashboard:smoke`.

## References

- TanStack Query React Overview: https://tanstack.com/query/latest/docs/framework/react/overview
- Query Client Provider: https://tanstack.com/query/latest/docs/framework/react/reference/QueryClientProvider
- Invalidations from Mutations: https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations
- Updates from Mutation Responses: https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
- Related routing plan: `docs/ai/plans/nax-dashboard-routing.md`
- Event-driven live state plan: `docs/ai/plans/event-driven-dashboard-run-status.md`
