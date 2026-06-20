# Plan — Reusable `RunDetailsModal` + Replace the Individual Agent-Result Modal

> Status: DRAFT for review (planning-workflow). UI refactor, staged, grounded against current code.
> All file:line refs verified by exploration.

---

## Executive Summary

The visualizer has two result modals:

- **Run-details modal** (`RecentRuns.tsx:333`) — rich: left timeline of steps + per-agent sessions, clickable to swap, center markdown that fills to modal bottom, right metadata panel. Opened from the run list.
- **Individual agent-result modal** (`App.tsx:1074`) — a single agent's markdown in isolation, plus a live "still running" panel. Opened from the graph (clicking an agent node's "view result").

The individual modal is conceptually a **degenerate view of the details modal** — one session entry, timeline hidden. The goal: make the details modal a reusable component and open *it* from the graph, deep-linked to the clicked agent, so the user lands on that result with the timeline beside it and can swap between sibling results.

### The big de-risk (verified)

Both modals already fetch the **same** `getRunDetails(runId)` endpoint (`api.ts:110`) and consume the **same** `RunDetailsSection`. The individual modal (`App.tsx:581-597`) just filters `details.sections` to one `kind === 'session'` section by `(stepId, agent)` then `(runnerId|sessionId)`. The server attaches full markdown to every session section (`visualize-run-details.js:99,115`). **So this refactor needs zero backend change** and no new fetch — only a client reorganization.

### The two real wrinkles

The individual modal handles an **in-progress** agent (no markdown yet): live status, runner/session IDs, "submitted after Ns" (`App.tsx:1127-1172`). Those values are render-derived (`App.tsx:815-830`) off the SSE-fed `liveRunState` — *not* a REST fetch. The details modal has none of this. So completed agents are trivial to reroute; in-progress agents need a decision (see D2).

The graph chip is also not "completed-only." The actual clickability gate is `canViewResult = active && (hasResult || Boolean(agentStatus))` (`WorkflowNode.tsx:65`) — i.e. a chip routes to `onViewAgentResult` whenever it has *any* non-empty agent status, not just completed (the tooltip titles at `WorkflowNode.tsx:18-24` enumerate the states: running/submitted/waiting/retrying/queued, abandoned, failed/cancelled). Stage 2 must preserve those paths: active live states can keep the lightweight live modal in 2b, but terminal non-completed saved sessions should still deep-link into the rich details modal.

### Staged delivery

- **Stage 0** — extract shared status/format helpers (dedup App ↔ RecentRuns). Unblocks reuse.
- **Stage 1** — extract `RunDetailsModal` component. Pure move, zero behavior change.
- **Stage 2** — open `RunDetailsModal` from the graph agent-click, deep-linked. Handle the live case per D2.

---

## Open Decisions (need David)

### D1. `RunDetailsModal` data interface — self-fetch vs prefetched?

The component needs the run's details. Options:

- **(a) Self-fetch by `runId` + `initialSelector` (recommended).** Props: `{ opened, onClose, runId, initialSelector? }`. The component calls `getRunDetails(runId)`, owns loading/error, builds the timeline, and — if `initialSelector = { stepId, agent, runnerId?, sessionId? }` is given — resolves the matching session entry to preselect; else defaults to `summary`. Both callers stay dumb (pass a runId). App stops needing to pre-fetch to find the section — the component does the match internally with the same logic that lives at `App.tsx:584-593`.
- **(b) Prefetched `detailsResponse` prop.** Caller fetches and passes the response + `initialEntryId`. More flexible, but App would fetch *and* the component would need the response threaded; more caller bookkeeping; RecentRuns would have to re-add fetch glue it currently owns.

Recommend **(a)** — it centralizes fetch + match + timeline in one place and makes both call sites one-liners.

### D2. Active live agents — 2b-first or straight to 2a?

- **(a) Port live status into `RunDetailsModal`.** The component accepts an optional live-context prop; when the active entry's section has no markdown and the agent is in-progress, it renders the live panel (status, runner/session, submitted-after). One modal everywhere; delete the individual modal. More work, pulls App's SSE-derived live values into the component's contract.
- **(b) Keep the small modal *only* for active live/no-artifact states.** In `openAgentResult`, branch on live status: active (`running|submitted|waiting|retrying|queued`) → show today's lightweight live modal; dry-run → preserve today's "No results from dry runs" small-modal path; terminal saved states (`completed|failed|cancelled|abandoned|timeout|error`) → open `RunDetailsModal`. Two modals coexist, but the rich one covers saved artifacts immediately.

Recommend **Stage 2b first** (most value, low risk), then fold in **2a** later to collapse to a single modal. Confirm whether you want to skip straight to 2a.

### D3. Shared helpers — extract a module (Stage 0) or just export in place?

`runId`, `recordValue`, `recordList`, `isDoneStatus`, `agentLabel`, `statusLabel`, `statusColor`, `statusBadgeTone`, `statusBadgeStyle`, `statusBadgeColor`, `workflowName` are duplicated/near-duplicated across `App.tsx:91-167` and `RecentRuns.tsx:37-95`. Recommend a small **Stage 0**: move them to `web/src/run-format.ts` and import from both. Removes duplication and resolves the "App badge helpers are private" blocker the reuse needs. Confirm vs. just exporting from one file.

Use App's status vocabulary as the canonical superset when reconciling: it already covers `waiting`, `retrying`, `queued`, and `error` (`App.tsx:142-146`), while `RecentRuns` currently only covers `running|submitted|interrupted` and `failed|timeout|cancelled|dismissed` (`RecentRuns.tsx:76-80`). This is a deliberate behavior-preserving broadening for graph/live states, not a blind dedupe.

### D4. Tighten `links` type? (minor)

`RunDetailsSection.links` is `Record<string, string>` (`types.ts:186`) but the UI depends on `links.sessionUrl` / `links.agentRunUrl` (`App.tsx:1107`, `RecentRuns.tsx:480` era). Recommend tightening to `{ sessionUrl?: string; agentRunUrl?: string }` while we're in here. Trivial; confirm.

---

## Current-State Map (verified)

### Run-details modal (the component to extract)

Owned by `RecentRuns` (`web/src/components/RecentRuns.tsx`):

- **State:** `detailsOpen`, `detailsLoading`, `detailsError`, `detailsResponse` (`:203-206`); `activeTimelineId` (`:233`); reset-to-summary effect (`:239-241`).
- **Fetch:** `openRunDetails(run)` → `getRunDetails(id)` (`:208-222`).
- **Derived:** `buildStepItems` (`:113`), `buildTimelineEntries` (`:227`, body ~`:140-199`), `parentTimelineEntries` (`:228-232`), `activeEntry` (`:236`), `workflowName` (`:97`).
- **Render:** Modal (`:333`), timeline (`:356-408`), content (title via `timelineContentTitle` `:101`, badge, `ArtifactActions` `:428`, markdown `:431`), metadata (`RunDetailsMetadata` `:447`/`:456`).
- **Sub-components (modal-only):** `ArtifactActions` (`:483`), `RunDetailsMetadata` (`:456`), `MetadataRow` (`:473`), helpers `stepDescription` (`:133`), `timelineBullet` (`:107`), `timelineContentTitle` (`:101`).
- **Shared with the run *list* (must remain available to RecentRuns):** `runId`, `statusColor`, `statusBadgeStyle`, `agentLabel`, `recordValue`, `recordList` — used by the list UI at `:253-327`, not just the modal. (→ this is why D3 wants a shared module, not a wholesale move into the component.)

### Individual agent-result modal (the call site to reroute)

In `web/src/App.tsx`:

- **Open trigger:** graph node "view result" → `onViewAgentResult` (`types.ts:55`, wired `App.tsx:927`) → `openAgentResult(node, agent)` (`:559-603`); sets `agentResultContext = { node, agent }` (`:563`; type `:40-43`).
- **Run id source:** `selectedRunId || activeRun?.runId` (`:562`) — ambient app state, not on the node.
- **Fetch + match:** `getRunDetails(runId)` (`:581`) → filter `kind==='session' && stepId===node.stepId && agent===agent` (`:584-588`) → prefer `runnerId|sessionId` exact (`:589-592`) → else `[0]` (`:593`) → `setAgentResultSection` (`:597`). **Same endpoint/data as RecentRuns.**
- **Completed render:** badge + runner/session badges + Netlify link + path + markdown (`:1091-1126`) — already uses `run-details-modal-content/body` classNames (`:1084`).
- **Live/dry-run render:** status badge + "still in progress" + runner/session/submitted-after (`:1127-1172`), values render-derived (`:815-830`) from `liveRunState.rawEvents`/`agentStatuses`, fed by the SSE EventSource (`:661`, reducer `liveRunReducer.ts:85,127-136`). Early-returns before fetch when active live or dry-run (`:567-574`).
- **Important graph behavior:** the chip click gate is `canViewResult = active && (hasResult || Boolean(agentStatus))` (`WorkflowNode.tsx:65`) — completed results, active live states, and terminal non-completed states all route to `onViewAgentResult`. Do not key the new rich-modal path only off `completedRunForAgent` (`App.tsx:560`, returns undefined for failed/cancelled → today's match falls to `sections[0]`); use the latest saved `runForAgent` (`App.tsx:107-113`) for `runnerId`/`sessionId` so failed/cancelled/retried artifacts resolve exactly.
- **Private helpers needed for reuse:** `agentLabel` (`:91`), `statusBadgeColor` (`:149`), `statusBadgeStyle` (`:153`), `statusBadgeTone` (`:142`) — currently module-private to App.

### API / types (no change required)

- `getRunDetails(id)` → `GET /api/runs/{id}/details` (`api.ts:110-112`); no single-agent endpoint exists (`api.ts` exports list confirmed).
- `RunDetailsResponse = { run: VisualizeRun, details: RunDetails }` (`types.ts:200`); `RunDetails.sections: RunDetailsSection[]` (`types.ts:197`).
- `RunDetailsSection` (`types.ts:174-189`) carries `id, kind, stepId, stepTitle, agent, status, runnerId, sessionId, markdown, path, absolutePath, links, usage`.
- Server: `buildRunDetails` (`visualize-run-details.js:62-132`) emits a `session` section per `agent-runners/*.md` (attempts excluded, `:40`), each with full markdown.

---

## Stage 0 — Extract shared status/format helpers `[no deps]`

**Goal:** one source of truth for status/format helpers; unblock reuse of App's private badge helpers.

**Create `web/src/run-format.ts`** exporting: `runId`, `recordValue`, `recordList`, `isDoneStatus`, `agentLabel`, `statusLabel`, `statusColor`, `statusBadgeTone`, `statusBadgeStyle`, `statusBadgeColor`, `workflowName`.

- Reconcile the two copies. They're near-identical but not identical; confirm `statusColor` (RecentRuns `:66`) vs `statusBadgeColor` (App `:149`) and use App's broader status set as the canonical tone mapping unless a visual regression is found. Keep both exported names as thin wrappers if call sites read better with both (`statusColor` for Mantine `color`, `statusBadgeColor` for badge call sites). **Diff them before merging — do not assume identical.**
- Update `App.tsx` and `RecentRuns.tsx` to import from `run-format.ts`; delete the local copies.

**Test/verify:** `npm run typecheck` clean; run list + both modals render identical badges/labels (visual smoke). Zero behavior change intended except the intentional status-vocabulary broadening above.

**Risk:** a subtle behavioral diff between the two helper copies. Mitigation: diff first, unify deliberately.

---

## Stage 1 — Extract `RunDetailsModal` component `[Stage 0]`

**Goal:** move the run-details modal into a standalone, reusable component with no behavior change for RecentRuns.

**Create `web/src/components/RunDetailsModal.tsx`.** Interface (per D1a):

```ts
type RunDetailsModalProps = {
  opened: boolean
  onClose: () => void
  runId: string
  initialSelector?: { stepId: string; agent: string; runnerId?: string; sessionId?: string }
}
```

Move into it:
- State: `detailsLoading`, `detailsError`, `detailsResponse`, `activeTimelineId`.
- Fetch: on `opened && runId` (effect), call `getRunDetails(runId)`; guard against stale responses with a cancellation flag or request id keyed by `runId` + `initialSelector`; on the current response only, build timeline and resolve initial entry: if `initialSelector` matches a session section → `session:${section.id}`; else `summary`.
- Helpers (move; modal-only): `buildStepItems`, `buildTimelineEntries`, `stepDescription`, `timelineBullet`, `timelineContentTitle`, types `StepItem`/`TimelineEntry`.
- Sub-components (move): `ArtifactActions`, `RunDetailsMetadata`, `MetadataRow`.
- Shared helpers come from `run-format.ts` (Stage 0).

**Update `RecentRuns.tsx`:** drop the modal JSX + modal state + moved helpers; keep run-list rendering. Replace with:

```tsx
const [detailsRunId, setDetailsRunId] = useState('')
// run click → setDetailsRunId(runId(run))
<RunDetailsModal opened={Boolean(detailsRunId)} onClose={() => setDetailsRunId('')} runId={detailsRunId} />
```

(RecentRuns passes no `initialSelector` → defaults to `summary`, exactly today's behavior.)

**Test/verify:** open details from the run list → identical to before (timeline, swap, markdown fill, metadata, artifact actions, Netlify link). `npm run typecheck` clean. This stage is a pure extraction — diff should show moves, not logic changes.

**Risk:** the reset-to-summary timing (`RecentRuns.tsx:239-241`) must be replicated as "resolve initial entry on each new response," keyed on runId. Mitigation: explicit effect keyed on `detailsResponse.run` + `initialSelector`, plus stale-fetch suppression so a slow previous modal open cannot overwrite the active details response.

---

## Stage 2 — Open `RunDetailsModal` from the graph `[Stage 1]`

**Goal:** clicking an agent node opens the rich modal, deep-linked to that agent, with sibling-swap.

**Wire in `App.tsx`:**
- Add state: `detailsModalRunId`, `detailsModalSelector`.
- In `openAgentResult(node, agent)` (`:559`):
  - Compute live status (existing derivation, `:822-824`).
  - Read the latest saved run with `runForAgent(node, agent)`, not only `completedRunForAgent(node, agent)`. Pull `runnerId`/`sessionId` from that saved run when present.
  - **Per D2b:** if status ∈ `{running, submitted, waiting, retrying, queued}` → keep today's lightweight live modal path (no change). If status is `dry-run` and no saved markdown exists → keep today's "No results from dry runs" small-modal path. **Else** for saved terminal states (`completed|failed|cancelled|abandoned|timeout|error`) → `setDetailsModalRunId(selectedRunId || activeRun?.runId)` and `setDetailsModalSelector({ stepId: node.stepId, agent, runnerId, sessionId })`.
  - If there is no `runId` for a rich-modal-eligible click, show an error like "Load a saved workflow run before opening agent results." Avoid the current "completed workflow run" wording, since failed/cancelled saved runs are valid rich-modal targets.
- Render `<RunDetailsModal opened={Boolean(detailsModalRunId)} onClose={...} runId={detailsModalRunId} initialSelector={detailsModalSelector} />`.
- The component self-fetches and preselects the clicked agent's session entry; user can swap via the timeline.

**Section match** lives inside `RunDetailsModal` as a small pure helper (so it can be unit-tested or at least reviewed independently):

1. Filter `kind==='session' && stepId === selector.stepId && agent === selector.agent`.
2. If `runnerId` or `sessionId` is supplied, prefer an exact `runnerId` or `sessionId` match.
3. If there is exactly one candidate, use it.
4. If there are multiple candidates and no exact match, do **not** blindly pick `sections[0]`; surface a clear unresolved-selection state while leaving the timeline usable, or fall back to `summary` with an alert explaining that the exact session could not be resolved.

This is intentionally stricter than today's `App.tsx:584-593` fallback-first logic because the shared modal will become the canonical way to inspect retries/follow-ups and terminal non-completed sessions.

**Test/verify:**
- Click a completed agent in the graph → rich modal opens on that agent's result; timeline shows siblings; swapping works; markdown fills.
- Click an in-progress agent → today's live modal (2b).
- Click a failed/cancelled/abandoned saved agent → rich modal opens on that exact saved session when `runnerId`/`sessionId` is present.
- Click a dry-run agent → today's "No results from dry runs" path remains.
- Run-list open path unaffected.

**Stage 2a (later, optional):** add an optional live-context prop to `RunDetailsModal`; when the active entry's section has no markdown and the agent is in-progress, render the ported live panel. Then delete the individual modal and the 2b branch. Decide after 2b ships.

**Risk:** run-id ambiguity — `openAgentResult` uses `selectedRunId || activeRun?.runId` (`:562`). If the clicked node belongs to a run other than the selected/active one, the wrong details could load. Mitigation: confirm the graph only ever shows the selected/active run's nodes (it does today — `graph` is for the loaded run). Prefer deriving a run id from node/run metadata in the future if multi-run graphs appear.

---

## Dependency Graph

```
Stage 0 (shared helpers) ──► Stage 1 (extract RunDetailsModal) ──► Stage 2 (graph rewire, 2b)
                                                                         └─► Stage 2a (port live, delete small modal) [later]
```

Stage 0 and 1 are zero-behavior-change and independently shippable/committable. Stage 2 is the user-visible feature.

---

## Testing Strategy

- **Typecheck/build:** `npm run typecheck` + `npm run visualize:build` must stay clean after each stage.
- **Existing E2E harness (use it):** there IS a Playwright smoke spec — `npm run visualize:smoke` (`playwright test tests/e2e/visualize.spec.js`). Read it first to see what it already covers; run it after each stage, and extend it in Stage 2 to assert that a graph agent-click opens the rich modal on the correct entry and that sibling-swap works. This is the real regression guard for Stages 1–2, not just manual smoke.
- **Pure matcher unit test:** extract the section-match logic as a pure function and unit-test it with the repo's Node test runner (no rendering needed) — cover: exact `runnerId`/`sessionId` match, single-candidate, multi-candidate-no-exact (the stricter unresolved path), and no-match. This is the highest-value test because the matcher is where Stage 2 changes behavior.
- The `buildTimelineEntries` initial-entry resolution is also pure-testable the same way.
- **Manual smoke per stage** (above). Stages 0–1 must be visually identical to pre-refactor.
- Pristine console — no new warnings/errors.

---

## Risks

1. **Helper drift (Stage 0):** two copies may differ subtly. → diff before unifying.
2. **Extraction logic drift (Stage 1):** an accidental behavior change during the move. → keep it a pure move; review the diff for logic edits.
3. **Stale details fetch (Stage 1):** a slower previous `getRunDetails` response could overwrite a newer open. → add cancellation/request-id guarding in the self-fetching modal.
4. **Wrong session selected (Stage 2):** fallback-first matching can show the wrong retry/follow-up artifact. → use latest saved `runForAgent` metadata and require exact runner/session match when multiple candidates exist.
5. **Live UX regression (Stage 2):** mishandling active live or dry-run agents. → 2b preserves the existing lightweight modal for active live/no-artifact states; saved terminal artifacts reroute.
6. **Run-id ambiguity (Stage 2):** ambient run id may not match the clicked node in a hypothetical multi-run graph. → confirmed single-run today; note for future.

---

## Next Step (planning-workflow)

Resolve D1–D4 (I recommend: D1a self-fetch+selector, D2 2b-then-2a, D3 extract `run-format.ts`, D4 tighten `links`). Then implement Stage 0 → 1 → 2b in order, committing each. Optional GPT Pro review pass on this doc first if desired, though this is a contained refactor where the staged extraction is the main safeguard.
