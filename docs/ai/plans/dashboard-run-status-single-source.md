# Spec: Single-Source Run State for the Dashboard

Status: DRAFT - implementation spec
Owner: David + Claude
Scope: `src/dashboard/**`, `src/storage/local/**`, `src/workflows/**`, `src/cli/main.js`, `src/contracts/dashboard.ts`

---

## 1. Problem

A run that is genuinely completed can still show "In progress" in the dashboard. The reported run had a correct durable file:

```text
.nax/workflows/2026-06-25T20-40-58-720Z-local-smoke-test/workflow.json
  top status: completed
  steps: smoke=completed
```

The UI lied because run state currently has multiple authorities:

- Durable workflow state: `.nax/workflows/<runId>/workflow.json`
- Live dashboard registry: `src/dashboard/runtime/live-run-registry.js`
- Client-side merge/cache patches: `src/dashboard/web/src/queries/dashboard-cache.ts`, `query-event-bridge.ts`, `liveRunReducer.ts`
- Endpoint-specific fallback logic in both `src/dashboard/api/app.js` and `src/dashboard/server.js`
- Completion writes hidden inside `clearTrackedRunState(...)`

The visible bug is one symptom. The deeper problem is that status is not centrally derived or centrally written. Small differences in precedence, timing, process lifetime, and endpoint behavior create tiny state bugs.

The fix is not to patch one label. The fix is to make state authority boring.

---

## 2. Target Model

### 2.1 Source-of-Truth Rules

1. The durable workflow record is the storage source of truth.
   - APIs read from durable state once it exists.
   - Live registry entries can identify a durable run and provide streaming/cancel sidecar data.
   - Live registry status is never authoritative for a durable run.

2. Remote agent runner state is the external reality check.
   - Local durable state is read first.
   - If the durable snapshot is contradictory or stale while remote runner IDs are still active-looking, the server performs a bounded remote refresh and writes the refreshed result back to durable state.
   - The dashboard must not make a fresh remote API call for every row on every click.

3. Public API responses use one projected snapshot.
   - No endpoint returns raw `runState.status` directly.
   - No endpoint has its own status inference rule.
   - Graph/details/list all use the same projected workflow/step/agent status semantics.

4. Events are live telemetry, not durable state authority.
   - SSE events may animate the graph, show output, and trigger cache invalidation.
   - Events must not permanently patch run-list or run-detail status as if they were the read model.
   - Terminal events cause a refetch/reconciliation of durable state.

5. Completion writes are explicit.
   - `clearTrackedRunState` only clears process-exit tracking.
   - `markRunCompleted(runState)` is the only helper that writes workflow completion.

### 2.2 Clean API Shape

Break the old `/api/runs` response shape. Do not keep `active` and `durable` compatibility fields.

New shape:

```ts
export type RunsResponse = {
  runs: DashboardRun[]
  pagination?: RunsPagination
}
```

The dashboard web app consumes only `runs`. This is intentionally cleaner than preserving the old mental model.

---

## 3. Central Primitives

### 3.1 `projectRunSnapshot(runState, options)`

Add a central dashboard projection helper, likely near `src/dashboard/api/serializers.js` or in a new `src/dashboard/api/run-projection.js`.

This should be wider than `projectRunStatus(runState)`. We want one projected public model, not just one top-level label.

Responsibilities:

- Normalize and project top-level workflow status.
- Normalize and project step statuses.
- Normalize active/terminal agent-run statuses inside `steps[].runs[]`.
- Compute `resumable` from the projected state, not from stale raw state.
- Preserve links, artifacts, options, target metadata, timestamps, and raw step/run detail.
- Attach diagnostic metadata only if useful and non-invasive, for example:
  - `stateDiagnostics?: { inconsistent: boolean, reason?: string, remoteRefresh?: 'skipped' | 'attempted' | 'failed' | 'succeeded' }`

Status projection policy:

- Explicit user terminal states win unless remote evidence says active work still exists:
  - `dismissed`, `cancelled`, and explicit local cancellation should not be reopened by old remote data.
- Remote-backed active runs win over stale top-level completion:
  - If a step has remote runner IDs with active-looking statuses (`pending`, `queued`, `submitted`, `submitting`, `running`, `waiting`, `retrying`) and there is no explicit cancellation/dismissal, the snapshot should not present the workflow as completed until a bounded refresh confirms terminal remote state.
- Completed step/run evidence can upgrade stale non-terminal workflow status:
  - `runState.status = 'running'` plus all projected steps terminal-success should report `completed`.
- Failure/cancellation should propagate upward:
  - Any projected failed step/run makes workflow `failed`.
  - All relevant projected runs cancelled makes the step/workflow `cancelled`, unless there are completed results that should keep a mixed workflow visible as failed or completed according to existing semantics.

This helper must be pure. It does not call remote APIs and does not save files.

### 3.2 `refreshRunStateIfNeeded(runState, context)`

Add a bounded refresh helper for durable state before projection.

Purpose:

- Keep local-first reads fast.
- Avoid blind API calls on every dashboard click.
- Verify contradictions against remote state when local state looks wrong.

Inputs:

```js
/**
 * @param {{
 *   runState: Record<string, unknown>,
 *   projectRoot: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: Date,
 *   reason?: 'list' | 'detail' | 'graph' | 'reconcile' | 'manual',
 *   maxRemoteChecks?: number,
 *   freshnessMs?: number,
 * }} input
 */
function refreshRunStateIfNeeded(input) {}
```

Rules:

- First compute a local projection and contradiction report.
- Skip remote refresh when the projection is internally consistent.
- Skip remote refresh when there are no remote runner/session IDs.
- Skip remote refresh when a recent refresh marker exists, for example `runState.remoteStatusSyncedAt`, newer than the freshness window.
- Limit checks per request. Recommended defaults:
  - `/api/runs` list: at most 2-3 remote runner checks per request, only for rows on the current page that look active or contradictory.
  - `/api/runs/:id`, graph, details, cancel/review actions: allow a focused refresh for that single run.
  - reconciliation tick: small bounded batch per tick.
- Reuse existing sync machinery where possible:
  - `syncSubmittedFollowupRunsToWorkflow(...)` already refreshes dashboard follow-up runs.
  - Local workflow agent-run sync should reuse existing polling/normalization concepts from `local-executor`, `progress`, and artifact sync code rather than adding an unrelated Netlify client path.
- If remote refresh fails:
  - Do not block the dashboard list.
  - Return the best local projection.
  - Attach/log a warning so diagnostics can explain why state may be stale.

Important: durable state remains the storage source of truth. Remote refresh writes remote reality into durable state, then projection reads durable state.

### 3.3 `publicRunState(runState, options)`

`publicRunState` should become a thin serializer over the projected snapshot.

It should not contain independent status logic like:

```js
status: runState.status || inferRunStateStatus(runState)
```

Expected shape:

```js
function publicRunState(runState = {}, options = {}) {
  const snapshot = projectRunSnapshot(runState, options)
  return {
    runId: snapshot.runId,
    flowId: snapshot.flowId,
    flowTitle: snapshot.flowTitle,
    status: snapshot.status,
    transport: snapshot.transport,
    branch: snapshot.branch,
    target: snapshot.target,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    dir: snapshot.dir,
    summaryPath: snapshot.summaryPath,
    resumable: snapshot.resumable,
    steps: snapshot.steps,
    stateDiagnostics: snapshot.stateDiagnostics,
  }
}
```

### 3.4 `markRunCompleted(runState)`

Add a direct completion writer in the local run-state layer:

```js
function markRunCompleted(runState) {
  if (!runState) return null
  runState.status = 'completed'
  return saveRunState(runState)
}
```

Then update every success path:

```js
markRunCompleted(runState)
clearTrackedRunState(runState)
```

Confirmed current call sites include:

- `src/cli/main.js:2168`
- `src/cli/main.js:2435`
- `src/workflows/engine/local-executor.js:900`
- `src/workflows/engine/local-executor.js:933`
- `src/workflows/engine/local-executor.js:945`
- `src/workflows/engine/github-executor.js:523`
- `src/workflows/engine/github-executor.js:544`
- `src/workflows/engine/github-executor.js:565`
- `src/workflows/engine/github-executor.js:576`

Run `rg "clearTrackedRunState\\(.*completed"` during implementation and update any additional matches.

After this change, `clearTrackedRunState` must not save status.

### 3.5 `isWorkflowActive(flowId)`

Add a centralized duplicate-run guard.

Current behavior checks the live registry only. That can leave stale live entries blocking new runs, or miss durable runs that are still active after a server restart.

New behavior:

1. Inspect live registry for the workflow.
2. Resolve/bind the durable run id if possible.
3. Refresh/project the durable state if it exists and looks active or contradictory.
4. If projected durable status is active, block duplicate start.
5. If projected durable status is terminal, finalize/clear stale live registry state and allow start.

This gives the "already running" decision the same status semantics as the read API.

---

## 4. API and Endpoint Spec

### 4.1 `/api/runs`

Return:

```json
{
  "runs": [],
  "pagination": {}
}
```

Implementation:

- Read the durable page first.
- Optionally refresh only rows on that page that are active-looking or contradictory, respecting the per-request cap.
- Project every durable row through `publicRunState`.
- Overlay live sidecar metadata with `overlayLiveRuns(...)`.
- Include live-only booting rows only on the first page.
- Do not return `active` or `durable`.

Overlay helper:

```js
function overlayLiveRuns({
  durableRuns,
  liveRuns,
  getDurableRun,
  includeLiveOnly,
}) {}
```

Rules:

- If live has a durable id and the durable run is in the current page, attach sidecar fields to that durable row.
- If live has a durable id but the durable run is not in the current page, call `getDurableRun(runId)` before deciding it is live-only.
- If a durable row exists, durable projected status wins.
- Never copy `live.status` onto a durable row.
- Live-only startup rows get `status: 'booting'`.
- Live-only rows are omitted on later pages.

### 4.2 `/api/runs/:id`

Resolution order:

1. Try durable run id directly.
2. If no durable run, inspect live registry and resolve/bind durable id.
3. If durable exists, refresh/project/return durable.
4. If no durable exists but live exists, return the booting/live startup fallback.
5. Otherwise 404.

Remove the `durableRunId !== runId` special case. If `active.runId === runId`, durable still wins.

### 4.3 `/api/runs/:id/graph` and `/api/runs/:id/details`

Same durable resolution as `/api/runs/:id`.

Graph/details must use projected durable steps. Otherwise the sidebar can be correct while the graph/modal remains stale.

The only live fallback is the startup window before durable state exists.

### 4.4 Events APIs

Events endpoints can still serve:

- live events for currently running dashboard-spawned runs
- durable replay from `events.jsonl`

But returned `run` metadata should follow the same durable-first rule when a durable run exists.

---

## 5. Client Spec

### 5.1 Runs Query Cache

Update `RunsResponse` in `src/contracts/dashboard.ts`:

```ts
export type RunsResponse = {
  runs: DashboardRun[]
  pagination?: RunsPagination
}
```

Update `dashboard-cache.ts`:

- Remove active-first `mergeRunLists(active, durable)`.
- `runsFromResponse(response)` returns `response.runs || []`.
- `runsFromResponses(pages)` flattens all `response.runs`, dedupes by canonical run id, and preserves server order.
- Dedupe is pagination hygiene only, not status precedence.

### 5.2 Event Cache Behavior

Update `query-event-bridge.ts`:

- `workflow_started` may patch a booting run id because durable state may not exist yet.
- `stdout`, `stderr`, `step_status`, and `agent_status` may drive live UI and graph animation.
- `workflow_completed`, `workflow_failed`, `workflow_cancelled`, and `exited` should invalidate/refetch run list, run detail, graph, and details.
- Do not permanently patch run-list status from terminal event payloads as the source of truth.

Update `liveRunReducer.ts` carefully:

- It can show live terminal status in the live output pane for immediate feedback.
- It must not be the source that powers persisted run-list/detail status after durable exists.

### 5.3 UX Notes

No major UI redesign is needed.

Expected user-visible behavior:

- Startup row may briefly show `Booting up`.
- Completed runs should flip to completed via durable refresh/refetch, not remain stuck behind a live entry.
- If remote verification is running or failed, the UI can remain quiet; diagnostics are enough unless errors affect user actions.

---

## 6. Live Registry Spec

The live registry becomes a streaming sidecar.

It may own:

- stdout/stderr buffers
- SSE clients
- recent live events
- process cancel handle
- startup durable-id binding
- duplicate-run sidecar data

It must not own:

- durable run status
- durable step status
- durable timestamps
- final workflow truth

### Event-Driven Finalization

`local-process.js` should capture terminal runner events:

- `workflow_completed` -> `completed`
- `workflow_failed` -> `failed`
- `workflow_cancelled` -> `cancelled`
- `workflow_awaiting_review` -> `awaiting_review`

When a terminal workflow event arrives:

- Update live sidecar status for streaming UX.
- Clear duplicate-run live guard if projected durable state is terminal.
- End/flush live clients as appropriate.
- Do not rely on child process `close` for correctness.

`close` remains process cleanup fallback, not the definition of workflow completion.

### Reconciliation Tick

At `/api/runs` start and on a periodic timer:

- For each live run, resolve durable id.
- Refresh/project durable state if needed.
- If projected durable status is terminal, finalize sidecar:
  - clear timer
  - null cancel handle
  - clear workflow guard
  - end clients if appropriate
  - mark evictable

---

## 7. Process Hygiene Spec

The current symptom can be fixed without process-group work, but the root cause includes lingering descendants holding pipes open.

Implement after read/write centralization unless it is small enough to include safely.

Requirements:

- Spawn `nax run` in its own process group when run from dashboard.
- On cancel/shutdown, signal the process group, not only the direct child.
- Ensure agent grandchildren do not inherit dashboard stdout/stderr/event FD in a way that prevents `close`.
- Keep FD3 event stream for the runner process itself.
- Add manual verification:
  - run Local Smoke Test
  - confirm no orphaned `codex --dangerously-bypass-approvals-and-sandbox` processes owned by PPID 1
  - confirm child `close` fires after runner exit

---

## 8. Implementation Order

We want the whole fix done, but keep commits internally staged so each layer is understandable.

### Step 1 - Projection

- Add `projectRunSnapshot`.
- Make `publicRunState` use it.
- Update graph/details serializers to consume projected steps.
- Add tests for top-level/step/run contradictions.

### Step 2 - Clean `/api/runs`

- Add `overlayLiveRuns`.
- Change `/api/runs` to return only `{ runs, pagination }`.
- Update `src/contracts/dashboard.ts`.
- Update web query helpers/tests.
- Run `npm run dashboard:build` after web changes.

### Step 3 - Detail Endpoint Consistency

- Fix `/api/runs/:id`, graph, details, and events metadata resolution.
- Remove the `durableRunId !== runId` guard.
- Add tests where live id already equals durable id and live status is stale.

### Step 4 - Bounded Remote Refresh

- Add `refreshRunStateIfNeeded`.
- Reuse existing follow-up sync.
- Add bounded refresh for contradictory local workflow state with remote runner IDs.
- Add TTL marker to avoid repeated calls while clicking around.
- Add tests with injected fake syncers proving:
  - no remote call for consistent completed runs
  - one remote call for contradictory active-looking remote runs
  - refresh warnings do not break list responses

### Step 5 - Event/Registry Reconciliation

- Capture terminal workflow events.
- Make terminal events trigger durable refetch/invalidation.
- Add live-registry reconciliation/finalization.
- Centralize duplicate-run guard through `isWorkflowActive(flowId)`.

### Step 6 - Completion Writes

- Add `markRunCompleted`.
- Replace all `clearTrackedRunState(..., { completed: true })` call sites.
- Make `clearTrackedRunState` cleanup only.
- Update tests.

### Step 7 - Process Hygiene

- Process group spawn/cancel.
- FD inheritance cleanup.
- Manual verification.

---

## 9. Test Plan

### Unit Tests

Add or update:

- `tests/unit/dashboard-api-primitives.test.js`
  - `projectRunSnapshot` upgrades stale non-terminal workflow state from completed steps.
  - remote active-looking run prevents false completed projection unless explicit cancellation/dismissal exists.
  - stored terminal cancellation/dismissal is not reopened by stale remote-looking runs.

- `tests/unit/dashboard-api-app.test.js`
  - `/api/runs` returns `runs`, not `active`/`durable`.
  - durable completed beats live running for same id.
  - live durable id outside current page is looked up before booting fallback.
  - live-only booting row appears only on first page.
  - `/api/runs/:id` durable wins even when `active.runId === runId`.

- `tests/unit/dashboard-query-cache.test.ts`
  - pages flatten from `response.runs`.
  - dedupe preserves server-authoritative row order.
  - no active-first merge remains.

- `tests/unit/graceful-run-state.test.js`
  - `markRunCompleted` writes completed for non-tracked references.
  - `clearTrackedRunState` no longer writes completion.

- `tests/unit/dashboard-local-process-transport.test.js`
  - terminal workflow event is captured before child close.

- `tests/unit/dashboard-server.test.js`
  - reconciliation finalizes stale live entries from projected durable terminal status.
  - duplicate-run guard clears stale live entry when projected durable state is terminal.

### Integration / Manual

- Run dashboard Local Smoke Test.
- Confirm sidebar and details agree after completion.
- Confirm restart shows the same completed state.
- Confirm no duplicate run guard remains after durable completion.
- Confirm process cleanup after Phase 7.
- Run `npm run dashboard:build` after dashboard web changes.

---

## 10. Non-Goals

- Do not build a new dashboard UI.
- Do not make remote refresh unbounded.
- Do not preserve the old `/api/runs` `active`/`durable` contract.
- Do not let live status become a second authority again.
- Do not fix unrelated dashboard styling or layout issues in this work.

---

## 11. Why This Simplifies State

This is simplification because it removes independent decision points:

- One public run snapshot projection replaces endpoint-specific status inference.
- One clean run-list response shape replaces active/durable client precedence.
- One completion writer replaces identity-gated completion hidden in cleanup.
- One reconciliation path replaces process-close-driven correctness.
- One active-run guard replaces live-only duplicate-run checks.
- Events become invalidation/animation, not persisted truth.

The durable file remains the storage center. Remote APIs are used only to correct contradictions, with bounded refresh and durable write-back. That keeps the model scalable without making the dashboard slow or API-hungry.
