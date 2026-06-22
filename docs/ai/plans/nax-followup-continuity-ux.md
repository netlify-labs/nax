# Spec - Dashboard Follow-up Continuity UX

> Status: PLANNING.
> Scope: make dashboard-submitted follow-ups visible, durable, and traceable after submission.
> Out of scope: waiting for remote completion before returning from submit, GitHub Actions transport follow-ups, and redesigning the whole workflow graph.

---

## Problem

The current **Send to next agent** composer can successfully submit a follow-up, including blob-backed oversized context. The UX after submission is still incomplete:

- `node bin/nax.js dashboard --tail` shows no activity for follow-up submissions.
- True follow-up sessions on an existing runner are not attached to the source workflow state.
- The toast is the only strong signal that anything happened.
- The running remote Agent Runner can feel disconnected from the current React Flow view, Recent runs list, and run-details timeline.
- Fresh runner follow-ups become separate one-step pseudo-workflows, but continued runner follow-ups do not become any visible durable activity.

This is confusing because the user submitted from:

```text
.nax/workflows/2026-06-20T23-33-58-433Z-security-audit/
```

So the natural expectation is that the follow-up appears under that workflow's `.nax` directory and becomes visible in the current graph and details modal.

---

## Product Principle

Dashboard follow-ups should behave like child activity of the source workflow unless the user explicitly opens them as separate one-off runs.

Submitting a follow-up should answer four questions immediately:

1. What did I just submit?
2. Which source result/artifacts did it use?
3. Where is the remote Agent Runner/session?
4. Where can I see its status later?

The answer should be visible in the UI, persisted on disk, and optionally echoed in `--tail`.

---

## Current Behavior

### Backend

`POST /api/runs/:id/followups`:

1. Resolves selected follow-up target and artifacts.
2. Packages context.
3. Uses inline or blob-backed prompt delivery.
4. Calls `submitFollowupPlan`.
5. Persists submitted agent session/runner artifacts through `persistSubmittedArtifacts`.
6. Persists only fresh runner submissions as separate one-step pseudo-workflows through `persistFreshPseudoWorkflow`.
7. Returns `202` with:
   - `followup.id`
   - `followup.submissions[]`
   - `followup.persistedWorkflow` only for fresh runners
   - `followup.context`
   - `followup.warnings[]`

### UI

`RunFollowupContent`:

1. Shows a toast on success.
2. Calls `onSubmitted`.
3. Closes the composer.

`App.handleFollowupSubmitted`:

1. Refreshes runs.
2. If `persistedWorkflow` exists, opens it.
3. If no `persistedWorkflow` exists, does not select or update anything.

That means a pure "follow-up prompt on previous Agent Run" has no visible post-submit destination.

### Tail Output

`--tail` is currently wired to child `nax run` stdout/stderr and structured events. Follow-up submission happens inside the dashboard server request path, not in a child `nax run` process, so nothing is printed unless the endpoint explicitly writes follow-up events/status to the same output path.

---

## Desired UX

### Submit Flow

When the user clicks **Run follow-up**:

1. Button enters loading state.
2. Composer shows submission progress rows:
   - packaging selected artifacts
   - inline/blob context delivery
   - submitting Codex/Claude/Gemini
   - accepted remote runner/session
   - persisted local follow-up activity
3. Toast still appears, but it is not the only durable signal.
4. The composer closes after accepted submission unless there are warnings.
5. The source run details view refreshes and highlights the newly submitted follow-up.

### Source Workflow Timeline

In `RunDetailsModal` timeline, append a follow-up child row under the source step or source agent result:

```text
Audit Security
  Claude - completed
  Codex - completed
  Gemini - completed

Synthesize Security Findings
  Codex - completed
  Codex follow-up - submitted
```

For a follow-up submitted against an earlier step:

```text
Audit Security
  Claude - completed
  Claude follow-up - submitted
  Codex - completed
  Gemini - completed
```

The row should show:

- model icon
- model name
- `follow-up` marker
- status: `submitted`, `running`, `completed`, `failed`, `timeout`
- remote link
- source artifact count/context delivery if useful

Clicking the row should open the same live/no-result panel until markdown is available:

```text
No result yet. This follow-up session is still in progress.

Runner ID  ...
Session ID ...
Submitted  4:41 PM
Context    blob · 80.0 KB source context
Open in Netlify
```

### React Flow Graph

The graph should make follow-up activity visible without pretending it is a normal workflow step.

Recommended MVP graph behavior:

- Keep the original workflow nodes unchanged.
- Add a compact "Follow-up" activity pill/badge inside the source node, near the model chips.
- For each source node with follow-ups, show a small count:

```text
Follow-ups 1 running
```

- The model chip for the follow-up model should show active status if that follow-up is the newest activity for that model.
- Clicking the follow-up badge opens run details focused on the follow-up activity.

Avoid adding a full React Flow node in MVP. Full graph nodes raise layout questions:

- Is a follow-up a child of a model result or a new step?
- Does it connect to downstream workflow steps?
- How many follow-up nodes can stack before the graph becomes unreadable?

A later version can add optional expandable follow-up nodes.

### Recent Runs

The source workflow card should indicate follow-up activity:

```text
Security Audit
2 steps · 1 follow-up running
```

Fresh runner pseudo-workflows can remain separate Recent runs, but they should link back to the source workflow:

```text
Follow-up on Security Audit (Gemini)
source: Security Audit · Synthesize Security Findings
```

### Tail Output

When `nax dashboard --tail` is running, follow-up submissions should print concise lifecycle lines:

```text
[dashboard] follow-up followup-2026-... packaging 1 artifact (80.0 KB)
[dashboard] follow-up followup-2026-... context delivery: blob (80.0 KB offloaded)
[dashboard] follow-up followup-2026-... submitting codex to runner 6a37250...
[dashboard] follow-up followup-2026-... accepted codex session 6a37...
[dashboard] follow-up followup-2026-... persisted under .nax/workflows/2026-.../followups/...
```

Tail output should not try to stream remote agent stdout. Netlify Agent Runner does not expose that through this endpoint today. It should report local submission and persistence lifecycle only.

---

## Data Model

Add a durable follow-up activity ledger inside the source workflow directory:

```text
.nax/workflows/<source-run-id>/followups/<followup-id>/followup.json
.nax/workflows/<source-run-id>/followups/<followup-id>/prompt.md
.nax/workflows/<source-run-id>/followups/<followup-id>/context.md        # optional local/debug mirror
.nax/workflows/<source-run-id>/followups/<followup-id>/submissions.json
```

Also update the source `workflow.json` with a compact reference so existing graph/details builders do not need to scan the filesystem every time:

```json
{
  "followups": [
    {
      "id": "followup-2026-...",
      "status": "submitted",
      "createdAt": "2026-06-20T23:45:12.000Z",
      "updatedAt": "2026-06-20T23:45:12.000Z",
      "sourceWorkflowRunId": "2026-06-20T23-33-58-433Z-security-audit",
      "sourceStepId": "synthesize-security-findings",
      "sourceAgent": "codex",
      "sourceTargetId": "agent-result:synthesize-security-findings:...",
      "sourceArtifactIds": ["workflow-summary:summary.md"],
      "mode": "follow-up-thread",
      "context": {
        "delivery": "blob",
        "artifactCount": 1,
        "bytes": 842,
        "offloadedBytes": 82082,
        "blobRef": {
          "store": "nax-...",
          "key": "dashboard-followup-prior-results"
        }
      },
      "submissions": [
        {
          "agent": "codex",
          "mode": "continue-runner",
          "status": "submitted",
          "runnerId": "6a37250ed93f96c539a7f1c8",
          "sessionId": "6a37...",
          "links": {
            "agentRunUrl": "https://app.netlify.com/..."
          },
          "sessionArtifactPath": ".nax/agent-sessions/<id>/summary.md",
          "runnerArtifactPath": ".nax/agent-runners/<id>/summary.md"
        }
      ]
    }
  ]
}
```

Keep full details under `followups/<id>/followup.json`; keep `workflow.json.followups[]` compact.

### Why a source-run ledger is no longer YAGNI

The earlier MVP correctly cut a follow-up ledger because nothing consumed it. Now the UI has a concrete consumer:

- run-details timeline
- graph badges/model state
- Recent runs summary
- tail/debug output
- future sync/reconciliation

This is the point where the ledger becomes justified.

---

## Backend Design

### 1. Persist all submitted follow-ups

Create `src/followup-activity.js` with:

```js
persistFollowupActivity({
  projectRoot,
  sourceRunState,
  followup,
  promptText,
  contextPackage,
  delivery,
  submissions,
})
```

Responsibilities:

- write `followups/<followup-id>/followup.json`
- write `prompt.md`
- optionally write `context.md` for inline/local debug context
- update `workflow.json.followups[]`
- update `workflow.json.updatedAt`
- recompute source workflow status if appropriate
- keep writes atomic using existing run-state patterns

Do this for both:

- `continue-runner`
- `fresh-runner`

Fresh runners may still get separate pseudo-workflow runs, but the source workflow should also record that it launched them.

### 2. Preserve `202 submit-and-return`

Do not wait for remote completion. Persist the accepted remote runner/session as `submitted`.

The activity status should be:

- `submitted` after accepted remote session/runner
- `failed` if submission failed before acceptance
- `partial` if some selected models accepted and others failed

Remote completion can be handled later by explicit sync/polling.

### 3. Emit dashboard lifecycle events

For follow-up submissions, emit local dashboard events:

```json
{ "type": "followup_packaging", "followupId": "...", "artifactCount": 1, "bytes": 82082 }
{ "type": "followup_context_delivery", "followupId": "...", "delivery": "blob" }
{ "type": "followup_submitting", "followupId": "...", "agent": "codex", "mode": "continue-runner" }
{ "type": "followup_submitted", "followupId": "...", "agent": "codex", "runnerId": "...", "sessionId": "..." }
{ "type": "followup_persisted", "followupId": "...", "path": ".nax/workflows/.../followups/..." }
```

These are not child-process runner events. They are local server lifecycle events.

### 4. Tail output for server-side follow-ups

When `tailOutput` is true, print a concise text line for each follow-up lifecycle event.

This can be a small helper:

```js
function recordFollowupServerEvent(type, data) {
  if (tailOutput) process.stdout.write(formatFollowupTailLine(type, data) + '\n')
}
```

Do not reuse child `stdout` event semantics. This is server activity, not remote agent stdout.

### 5. Add follow-ups to run details response

Extend `buildRunDetails` response:

```ts
followups: RunFollowupActivity[]
```

Each activity should include:

- source step/agent
- source target/artifact labels
- submissions
- local paths
- status
- prompt/context delivery

`RunDetailsModal` can then render these without scanning filesystem paths itself.

### 6. Add follow-ups to graph response

Extend `flowToGraph` node data:

```ts
followups?: Array<{
  id: string
  status: string
  sourceStepId: string
  sourceAgent: string
  submissions: Array<{ agent, status, runnerId, sessionId, links }>
}>
```

Attach follow-ups to the source node by `sourceStepId`.

This is enough for MVP badges and chip status without adding new graph node types.

---

## Frontend Design

### Run details timeline

Add follow-up activity entries to `RunDetailsModal`:

- parented under the source step
- visually distinct from normal agent results
- click opens a details panel
- if submitted but no markdown, use the same `LivePanel` style with follow-up-specific wording

Suggested row text:

```text
Codex follow-up - submitted
```

For multiple submissions:

```text
Codex follow-up - submitted
Gemini fresh follow-up - submitted
```

### Run details content panel

For follow-up entries, show:

- status
- mode
- runner/session IDs
- Netlify link
- source target
- selected artifacts
- context delivery
- prompt copy/open action

If prompt was persisted:

- Results tab: no result yet / result when synced later
- Prompt tab: exact submitted follow-up prompt

### Graph badges

In `WorkflowNode`, add a compact follow-up strip below model chips when present:

```text
Follow-ups: 1 submitted
```

For one model:

```text
Codex follow-up submitted
```

Keep it quiet and utilitarian. It should not dominate the workflow node.

Click behavior:

- clicking badge opens run details with a selector for the newest follow-up activity
- clicking a model chip should prefer completed result if available, but expose newest follow-up status if it is the most recent activity for that model

### Post-submit behavior

After successful submit:

1. Refresh source run details and graph.
2. If the modal was opened from source run details:
   - close composer
   - return to results view
   - select/highlight the new follow-up timeline row
3. If fresh pseudo-workflow exists:
   - show a toast action: **Open fresh run**
   - do not automatically navigate away unless the user submitted only fresh runners
4. If mixed continue + fresh:
   - remain on source workflow
   - show both source follow-up rows and toast links

This avoids yanking the user away from the workflow they were inspecting.

### Recent runs

Add compact follow-up summary to run list cards:

```text
1 follow-up submitted
```

Status rollup:

- `running` if any follow-up is `submitted`/`running`
- `completed` only when all workflow steps and follow-ups are completed
- keep base workflow status separate in metadata to avoid confusion

MVP can show follow-up status without changing workflow status semantics if status rollup is too risky.

---

## Sync And Refresh

### MVP

Persist submitted follow-up state only. The UI shows `submitted` until the user runs a manual refresh/sync.

### Near-term

Add a refresh action for follow-up rows:

```text
Refresh follow-up status
```

This should call the existing Netlify Agent Runner session list/show path and update:

- `.nax/agent-sessions/<session-id>`
- `.nax/agent-runners/<runner-id>`
- source workflow follow-up activity
- run details sections

### Later

Background polling from the dashboard server while the page is open:

- poll submitted follow-up runners every N seconds
- stop when terminal
- append events to source workflow `events.jsonl`
- update UI through SSE

Do not implement background polling in the first continuity pass unless it is cheap. The persistence and rendering model should not depend on polling.

---

## File/Module Plan

### Backend

- `src/followup-activity.js`
  - new persistence and rollup helpers
  - unit-tested independently
- `src/dashboard/server.js`
  - call `persistFollowupActivity` for every accepted follow-up
  - emit follow-up lifecycle events
  - print follow-up tail lines when `--tail` is enabled
  - include persisted activity in response
- `src/dashboard/shared/run-details.js`
  - read source workflow follow-up activities
  - expose `details.followups`
  - create follow-up timeline-compatible objects
- `src/dashboard/shared/graph.js`
  - attach follow-ups to node data by `sourceStepId`
- `src/run-state.js`
  - optionally add helper to save workflow state after follow-up activity updates

### Frontend

- `src/dashboard/web/src/types.ts`
  - add `RunFollowupActivity`
  - add `followups` to `RunDetails`
  - add `followups` to `WorkflowGraphNodeData`
- `src/dashboard/web/src/components/RunDetailsModal.tsx`
  - render follow-up rows in timeline
  - support active follow-up entry
  - show submitted follow-up prompt/context metadata
- `src/dashboard/web/src/components/WorkflowNode.tsx`
  - render compact follow-up badge/strip
- `src/dashboard/web/src/App.tsx`
  - after submit, refresh source run graph/details
  - select new follow-up row instead of only navigating to fresh pseudo-workflow
- `src/dashboard/web/src/components/RecentRuns.tsx`
  - show follow-up count/status if available

---

## Testing Plan

### Unit

- `followup-activity.test.js`
  - persists continue-runner follow-up under source workflow
  - persists fresh-runner source link plus pseudo-workflow
  - writes prompt/context files
  - updates `workflow.json.followups[]`
  - handles partial submission warnings
- `dashboard-run-details.test.js` or existing `dashboard-server.test.js`
  - details response includes follow-ups
  - source step association is correct
  - prompt path/content is exposed for follow-up entries
- `dashboard-graph.test.js`
  - graph node includes follow-up summary
  - follow-up status does not erase original completed result status
- `dashboard-server.test.js`
  - `--tail` formatter produces useful lines
  - submit response includes `persistedFollowupActivity`

### E2E

- Submit follow-up on existing thread:
  - toast appears
  - composer closes
  - timeline shows `Codex follow-up - submitted`
  - clicking row shows runner/session IDs and Netlify link
- Submit mixed follow-up + fresh models:
  - source timeline shows all submissions
  - fresh pseudo-workflow still appears in Recent runs
  - UI remains on source workflow unless only fresh submissions were requested
- Run `nax dashboard --tail`:
  - follow-up submission prints packaging, delivery, submission, accepted, persisted lines

---

## Rollout Stages

### Stage 1 - Durable follow-up activity

Add source workflow follow-up ledger and persist all accepted submissions. Return the persisted activity in the API response.

This fixes the "in the ether" problem at the data layer.

### Stage 2 - Run details timeline

Render persisted follow-up activities in `RunDetailsModal` under their source step/model.

This gives the user an immediate place to inspect the submitted follow-up.

### Stage 3 - Post-submit navigation

After submit, refresh source graph/details and select the new follow-up activity row. Keep fresh pseudo-workflow navigation as an explicit toast action unless the submission was fresh-only.

This makes the UX feel connected.

### Stage 4 - Tail output

Emit server-side follow-up lifecycle lines when `--tail` is enabled.

This fixes the terminal observability gap without pretending remote Agent Runner stdout is available.

### Stage 5 - Graph and Recent run polish

Add follow-up badges to workflow nodes and follow-up summary text to Recent runs.

This makes follow-ups discoverable after the modal is closed.

### Stage 6 - Sync/polling

Add manual refresh first. Consider background polling later if users need live completion updates.

---

## Open Questions

1. Should follow-up activity make the source workflow status `running`, or should base workflow status stay `completed` with separate follow-up status?

   Recommendation: keep base workflow status unchanged and show follow-up status separately. Changing completed workflows back to running will surprise users and may affect resume logic.

2. Should mixed submissions auto-open a fresh pseudo-workflow?

   Recommendation: no. Stay on the source workflow and show all follow-up submissions there. Offer toast actions for fresh run views.

3. Should follow-up rows live under the source step or under the source agent result?

   Recommendation: visually under the source step, adjacent to the source agent result, with label `Codex follow-up`. This matches the existing timeline hierarchy without adding another nesting level.

4. Should the follow-up ledger live only as files under `followups/`, or also inside `workflow.json`?

   Recommendation: both. Full details in `followups/<id>/followup.json`, compact index in `workflow.json.followups[]` for fast graph/list rendering.

5. Should `--tail` stream remote completion?

   Recommendation: not in this pass. Print local submission/persistence lifecycle only. Remote completion needs a separate polling/sync design.

---

## Success Criteria

- After submitting a follow-up on an existing thread, the current source workflow view visibly changes.
- A user can close and reopen `nax dashboard` and still see the submitted follow-up attached to the source workflow.
- `--tail` prints enough local lifecycle information that the terminal user knows what was submitted and where it was persisted.
- Fresh and continued follow-ups both have a durable source-workflow reference.
- No UI state is fabricated without persisted backing.
- Existing workflow execution, resume, and run list behavior remain compatible.
