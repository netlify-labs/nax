# NAX Runs API Pagination Plan

> Status: Implemented on 2026-06-22.
> Scope: dashboard server `/api/runs`, dashboard client run list query, and Recent Runs UI.
> Primary goal: keep dashboard startup fast and predictable when `.nax/workflows` contains a large durable run history.

## Summary

The dashboard previously returned every durable run from:

```txt
GET /api/runs
```

The response shape is:

```ts
type RunsResponse = {
  active: DashboardRun[]
  durable: DashboardRun[]
}
```

The server built this by calling:

```js
listRunStates(projectRoot).map(publicRunState)
```

That is simple and correct for small histories. It becomes a scale problem as `.nax/workflows` grows:

- dashboard startup reads and serializes every durable workflow state
- client stores all runs in one React Query entry
- Recent Runs has no way to ask for "next page"
- there is no response metadata telling the UI whether history is truncated

The implemented pagination keeps the current simple UX while bounding first-page durable JSON parsing and response size.

## Why This Matters

The dashboard is used during active development. It should open quickly even in repositories with many historical agent workflows. Users mostly need:

- currently active runs
- the latest durable runs
- a way to load older runs on demand

They do not need the server to send the entire durable history on every refresh, live event invalidation, or dashboard load.

## Current State

### Server

`src/dashboard/server.js` handles `/api/runs` inline in `createRequestHandler`.

Current behavior:

- method must be `GET`
- request must pass dashboard token auth
- response includes all active runs
- response includes a paginated durable run page
- response includes durable pagination metadata

### Client

`src/dashboard/web/src/api.ts` exposes:

```ts
export function listRuns(options: { limit?: number; cursor?: string } = {}): Promise<RunsResponse>
```

`src/dashboard/web/src/queries/dashboard-queries.ts` wraps this with an infinite-query-backed `useRunsQuery`.

`src/dashboard/web/src/queries/dashboard-cache.ts` flattens and dedupes active plus durable pages for display with `runsFromResponses`.

`RecentRuns` receives the flattened run array plus pagination controls and renders the list.

### Cache Behavior

After the cache-key fix, the runs list is keyed independently from run entity keys:

```ts
dashboardQueryKeys.runs() // ['dashboard', 'runs', 'list'] invalidation prefix
dashboardQueryKeys.runsInfinite(50) // ['dashboard', 'runs', 'list', { limit: 50 }]
```

That gives this pagination work a stable base without colliding with run entity caches.

## Goals

1. Add server-side pagination for durable runs.
2. Keep active runs always included in the first response.
3. Preserve backward compatibility where practical.
4. Keep Recent Runs simple: latest runs by default, "load more" for older history.
5. Keep cache keys explicit for paginated list variants.
6. Add tests for default limit, explicit limit, cursor behavior, and response metadata.

## Non-Goals

- Do not add a database.
- Do not change durable run storage format.
- Do not paginate active runs.
- Do not implement search/filtering in this pass.
- Do not redesign the Recent Runs visual layout.
- Do not solve archival or retention policy here.

## API Design

### Request

```txt
GET /api/runs?limit=50
GET /api/runs?limit=50&cursor=<cursor>
```

Parameters:

- `limit`: optional integer, default `50`, maximum `200`.
- `cursor`: optional opaque cursor returned by the previous response.

The cursor should be opaque to the client. Internally it can initially encode an offset or durable run id. Use a simple, stable encoding that can evolve:

```txt
cursor = base64url(JSON.stringify({ offset: 50 }))
```

Offset is acceptable for local file-backed history because this is an admin/developer dashboard, not a high-concurrency public feed. If history mutates between pages, the UI can tolerate minor duplication or omission. The client should dedupe by run id when merging pages.

### Response

Extend the response shape:

```ts
type RunsResponse = {
  active: DashboardRun[]
  durable: DashboardRun[]
  pagination?: {
    durableLimit: number
    durableOffset: number
    durableTotal: number
    nextCursor: string | null
    hasMore: boolean
  }
}
```

Make `pagination` optional only for transitional compatibility. New server responses should always include it.

### Backward Compatibility

Existing clients that ignore `pagination` continue to work. They receive only the first page of durable runs once pagination is enabled, so this is a behavior change. To reduce surprise:

- choose a generous default limit
- include `durableTotal` and `hasMore`
- update Recent Runs UI in the same change

## Server Implementation

### Helper Functions

Add helpers near the dashboard server route helpers:

- `parsePositiveInteger(value, fallback, max)`
- `encodeRunsCursor({ offset })`
- `decodeRunsCursor(cursor)`
- `paginatedDurableRuns(projectRoot, { limit, cursor })`

Behavior:

- invalid limits fall back to default
- limits above max clamp to max
- invalid cursors throw `requestError(400, 'invalid_cursor', 'Invalid runs cursor.')`
- pagination must happen before durable workflow JSON parsing; `/api/runs` must not call `listRunStates(projectRoot)` and slice afterward

### Route Handler

Update `/api/runs`:

1. auth as today
2. parse `limit` and `cursor`
3. enumerate/sort durable state files cheaply
4. slice the durable state-file list
5. parse only the selected durable page
6. return active runs plus durable page plus metadata

Pseudo-code:

```js
const page = paginatedDurableRuns(projectRoot, {
  limit: requestUrl.searchParams.get('limit'),
  cursor: requestUrl.searchParams.get('cursor'),
})
jsonResponse(res, 200, {
  active: [...runs.values()].map(publicRun),
  durable: page.items.map(publicRunState),
  pagination: page.pagination,
})
```

`paginatedDurableRuns` uses the paged durable listing helper in `src/run-state.js`, which sorts workflow state files by `workflow.json` mtime and parses only the selected page. This intentionally trades exact `updatedAt` ordering for bounded local dashboard startup cost.

## Client Implementation

### Types

Update `RunsResponse` in `src/dashboard/web/src/types.ts`:

```ts
export type RunsPagination = {
  durableLimit: number
  durableOffset: number
  durableTotal: number
  nextCursor: string | null
  hasMore: boolean
}

export type RunsResponse = {
  active: DashboardRun[]
  durable: DashboardRun[]
  pagination?: RunsPagination
}
```

### API Function

Change `listRuns` to accept options:

```ts
export function listRuns(options: { limit?: number; cursor?: string } = {}): Promise<RunsResponse>
```

Build query params only when present.

### Query Keys

Add explicit keys:

```ts
runs: () => ['dashboard', 'runs', 'list'] as const
runsInfinite: (limit: number) => ['dashboard', 'runs', 'list', { limit }] as const
```

There are two viable client approaches:

1. Keep one `useRunsQuery` for the first page and make "load more" call an imperative API function.
2. Use `useInfiniteQuery` for durable history.

The implementation uses `useInfiniteQuery`. It models cursor pagination directly and prevents home-grown page state.

Recommended hook:

```ts
useRunsInfiniteQuery({ limit: 50 })
```

Flatten pages for display:

- active runs come from the first/latest page
- durable runs from all loaded pages
- dedupe by canonical run id

### Recent Runs UI

Keep the UI restrained:

- Show the same list as today.
- Add a compact "Load older" button at the bottom when `hasMore` is true.
- Show loading state only on that button for additional pages.
- Do not add a pagination toolbar.
- Do not show technical cursor values.

Text:

- Button: `Load older`
- Optional count: `Showing 50 of 312 saved runs`

This is operational UI, not a marketing page. Keep it dense and predictable.

## Cache And Live Update Behavior

Active runs should remain first-class:

- live events can still invalidate `dashboardQueryKeys.runs()`
- first page refetch updates active runs and latest durable runs
- older pages should not refetch on every live event unless the user has them loaded and the query library decides they are stale

If using `useInfiniteQuery`, use one query key for the infinite list:

```ts
['dashboard', 'runs', 'list', { limit }]
```

Avoid including the cursor in the top-level invalidation key unless manually managing pages.

When a run completes:

- existing cache bridge invalidates run views
- runs list refetch should put the completed run into the first durable page
- client-side merge should dedupe if the run also exists in active runs briefly

## User Workflows

### Normal Dashboard Load

1. User opens dashboard.
2. Server returns active runs plus latest 50 durable runs.
3. Recent Runs renders immediately.
4. If more durable runs exist, user sees `Load older`.

### Load Older History

1. User clicks `Load older`.
2. Client requests next cursor.
3. Older durable runs append below existing runs.
4. Active runs remain at top.
5. Duplicate runs are deduped by canonical id.

### Live Run Completion

1. Active run completes.
2. Live event invalidates runs list.
3. First page refreshes.
4. Completed run appears as durable/latest run.
5. Older pages remain loaded but are not the primary refresh target.

## Test Plan

### Unit Tests

Add server helper tests for:

- default limit
- max limit clamp
- invalid cursor returns 400
- next cursor generation
- final page has `hasMore: false`

Add client tests for:

- `listRuns({ limit, cursor })` URL construction if API tests exist
- run-list merge dedupes active and durable pages
- query keys do not collide with run entity keys

### Integration Tests

Extend dashboard server tests:

- `/api/runs` returns pagination metadata
- `/api/runs?limit=1` returns one durable run and `hasMore: true`
- next cursor returns the next durable run
- invalid cursor returns structured 400

### UI Tests

If feasible:

- Recent Runs shows `Load older` when `hasMore`
- clicking it appends older rows

Do not block the first implementation on Playwright if unit and server tests cover the behavior well.

## Implementation Phases

### Phase 1: Server Pagination Contract

Implemented:

- Added cursor helpers.
- Added pagination metadata.
- Added server tests.
- Added a paged durable state helper so the first page does not parse every workflow state.

Validation:

```bash
npm run typecheck
node --test tests/unit/dashboard-server.test.js
```

### Phase 2: Client Types And API Options

Implemented:

- Add `RunsPagination` type.
- Add `listRuns({ limit, cursor })`.
- Add query key support for paginated list shape.
- Keep existing UI on first page.

Validation:

```bash
npm run typecheck
node --import tsx --test tests/unit/dashboard-query-cache.test.ts
```

### Phase 3: Recent Runs Load More

Implemented:

- Add `useRunsInfiniteQuery` or equivalent page state.
- Flatten active/durable pages for `RecentRuns`.
- Add `Load older` button.
- Add compact count text if it fits cleanly.

Validation:

```bash
npm run dashboard:build
npm test
```

### Phase 4: Cache Bridge Review

Implemented:

- Verify live events invalidate the first page appropriately.
- Ensure old pages are not aggressively refetched.
- Confirm completed active runs dedupe against durable list.

Validation:

- focused query-event bridge tests
- manual dashboard run if practical

## Risks

- Offset cursors can shift if runs are added while the user pages. This is acceptable for the first version but should be documented in code comments.
- Infinite Query can add complexity if the current query hook structure is not ready for it.
- Recent Runs may need minor prop changes to expose `hasMore` and loading state cleanly.
- Existing tests may assume all durable runs are returned; update them deliberately.

## Acceptance Criteria

- `/api/runs` supports `limit` and `cursor`.
- `/api/runs` returns pagination metadata.
- Default dashboard load no longer serializes unlimited durable history.
- Recent Runs can load older durable runs.
- Active runs remain visible regardless of durable pagination.
- Cache invalidation remains scoped and does not collide with per-run entity keys.
- Typecheck, tests, and dashboard build pass.

## Implementation Notes

Implemented files:

- `src/run-state.js` adds `listWorkflowStatePage`, which enumerates/sorts state files, slices by offset/limit, and parses only the selected page.
- `src/dashboard/server.js` adds `/api/runs` `limit`/`cursor` handling, opaque offset cursors, durable pagination metadata, and structured `invalid_cursor` errors.
- `src/dashboard/web/src/types.ts` adds `RunsPagination` and `RunsListData`.
- `src/dashboard/web/src/api.ts` lets `listRuns` accept `{ limit, cursor }`.
- `src/dashboard/web/src/queries/dashboard-queries.ts` uses `useInfiniteQuery` for the runs list.
- `src/dashboard/web/src/queries/dashboard-cache.ts` flattens paginated run responses and invalidates the list instead of writing flat arrays into the infinite-query cache key.
- `src/dashboard/web/src/components/RecentRuns.tsx` adds the compact `Load older` button and saved-run count.

Validation coverage:

- `tests/unit/run-state.test.js` covers durable page listing without parsing all history.
- `tests/unit/dashboard-server.test.js` covers default metadata, limit, cursor, max-limit clamp, and invalid cursor behavior.
- `tests/unit/dashboard-query-cache.test.ts` covers paginated flattening and query-key non-collision.
- `tests/unit/query-event-bridge.test.ts` covers event-driven invalidation with the paginated list key.
- `tests/e2e/dashboard.spec.js` covers Recent Runs loading older durable pages.
