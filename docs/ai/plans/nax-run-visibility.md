# Plan: run visibility quartet — error guidance, stalled watchdog, usage rollup, runs filter

> Four approved ideas, one theme: what a run costs, why it failed, whether it's
> actually alive, and how to find it again. All read-side, all riding plumbing
> that already exists.

Status: **DRAFT v1** (initial plan, pre-review). Owner: David. Author: Claude.

---

## 1. Goal & intent

Four user-visible outcomes, approved from the 2026-07-19 idea pass:

- **A. Actionable error guidance.** Every known failure signature from
  `netlify agents:*` explains itself in plain language with a fix, in both CLI
  output and the dashboard — generalizing what `wrapAccessError` did for the
  wrong-account case.
- **B. Stalled-run watchdog.** A run whose child/runner is nominally active
  but whose event log has gone quiet for N minutes is *named* — "Stalled ·
  last event 14m ago" — instead of spinning forever.
- **C. Per-run usage rollup.** Credits/token/cost totals visible on the run
  card, in run details, and via a `nax costs` command. The data already flows;
  today it dies in `usage.json` artifacts nobody opens.
- **D. Runs sidebar filter.** Filter the runs list by status and free text,
  mirroring the search the workflow list already has.

Why together: A and B close out the "no silent states" arc (wrong-account,
dropped messages, pipe leak — all fixed); C and D are the first "using nax at
volume" ergonomics. Every piece is read-side computation or display over
existing durable data — no protocol, storage-format, or engine changes.

---

## 2. Non-goals (explicit scope fence)

- **Not** `nax doctor` (idea #1) — not approved in this pass.
- **Not** gh/GitHub-transport error signatures. The table ships with Netlify
  agent-runner signatures we have actually hit; gh entries are a follow-up
  once we've captured real gh failures worth mapping.
- **Not** remote polling for the watchdog. Staleness is computed from local
  durable data only (event-log mtime). Remote refresh stays the province of
  `dashboard-run-status-single-source.md`.
- **Not** billing-grade cost accounting. Rollups display what runners
  reported; no reconciliation against Netlify invoices, no currency handling
  beyond the existing `costUsd` field.
- **Not** server-side filter/search query params. Client-side over loaded
  pages first (50/page); revisit only if real usage proves it insufficient.
- **Not** a new `stalled` status key in the status model. Stalled is a
  *decoration* on an active run, not a lifecycle state (see D2).

---

## 3. Current architecture (grounding facts, verified 2026-07-22)

Failure signatures already recognized somewhere in the codebase:

- `ACCESS_ERROR_PATTERN` + `accessDeniedMessage` — wrong-account wrap at
  submission (`src/integrations/netlify/local-runner.js:585-597`, message
  builder shared with `src/integrations/netlify/preflight.js`).
- `RETRYABLE_CAPACITY_ERROR` — "model is currently at capacity"
  (`local-runner.js:11`), auto-retried at the result level.
- `RETRYABLE_ARGUMENT_LIMIT_ERROR` — `fork/exec /opt/build-bin/agent-runner:
  argument list too long` (`local-runner.js:12`), the E2BIG fan-in failure;
  retried, but retries cannot fix it when the prompt stays oversized (see
  memory: prompt blob offload plan).
- `isRetryableSubmissionError` (`local-runner.js:668-695`) — network/429/5xx
  needles for submission retry. When retries exhaust, the raw error is thrown
  with no guidance.
- Error transport to users is DONE: thrown submission errors → run state +
  `agent_status`/`workflow_failed` events (durable) → reducer `errors[]` → UI
  banner; CLI prints via `formatCaughtError`.

Liveness data:

- Every run dir has `events.jsonl`; the child appends on every event
  (`src/workflows/events/runner-events.js:193`). Its **fs mtime** is a free
  last-activity timestamp — no parsing needed.
- Run records carry `lastEventAt`/`updatedAt` but nothing computes "quiet for
  N minutes", and no UI names the state.
- Read-side decoration seam exists: `applyArtifactStatuses` in
  `src/dashboard/shared/run-artifact-status.js`, applied in
  `src/dashboard/storage/local-runs.js` (`getRunState`, `listRunsPage`),
  gated to active-looking runs only.

Usage data:

- `UsageSummary` typedef (`src/types.js:26`): credits, tokens, `costUsd`.
- `usageForRun`, `aggregateRunUsage`, `usageSummariesForRunState`,
  `formatUsageSummary` all exist (`src/workflows/results/agent-run-results.js:216-250`).
- `workflow-artifacts.js` writes per-step and run-level `usage.json` and links
  them from summary markdown (`src/workflows/artifacts/workflow-artifacts.js:537-572`).
- Dashboard shows usage ONLY as a `usage-json` artifact link
  (`src/dashboard/shared/run-details.js:547-551`). No totals on run card,
  run details header, or anywhere glanceable. No CLI rollup across runs.

Runs list:

- `RecentRuns.tsx` — no filter. `WorkflowList.tsx:23-46` has the pattern to
  mirror: `useMemo` filter + `TextInput` with aria-label, "No matches" empty
  state.
- Pagination is server-side (50/run page, "Load older" button,
  `hasMore`/cursor from `listRunsPage`).
- Status vocabulary for a filter dropdown exists in
  `src/dashboard/web/src/status-model.ts` (statusKey buckets).

---

## 4. Design

Ordered by build sequence: A → D → B → C (A is highest leverage; D is the
smallest and immediately felt; B and C both extend the same read-side
decoration seam, B first because C reuses its publicRunState field pattern).

### 4.A Failure guidance table

New module `src/integrations/netlify/failure-guidance.js`:

```js
// Maps known agent-runner failure signatures to plain-language guidance.
// Original error detail is always preserved after the guidance sentence.
/** @typedef {{ code: string, pattern: RegExp, guidance: (ctx: { siteId?: string, email?: string, attempts?: number }) => string }} FailureSignature */
const SIGNATURES = [ ... ]
function explainFailure(detail, ctx) // → { code, message } | null
function wrapFailure(error, ctx)     // → Error with guidance prefix, or original error untouched
```

Launch table (every entry is a signature we have actually hit):

| code | pattern (essence) | guidance |
|------|-------------------|----------|
| `wrong_account` | 401/403/404/unauthorized/not found/access denied | existing `accessDeniedMessage` (absorbed from `wrapAccessError`) |
| `prompt_too_large` | `argument list too long` (E2BIG) | "The step prompt exceeds the runner's argv limit. Shrink the prompt/context or wait for blob offload; retrying will not help." |
| `model_capacity` | capacity-retry text surviving retries | "The <agent> model is at capacity. nax retried automatically; try again shortly or switch the step's agent." |
| `rate_limited` | rate limit / too many requests / 429 after retries | "Netlify API rate limit persisted through N automatic retries. Wait a minute and re-run." |
| `netlify_5xx` | 5xx/gateway after retries | "Netlify API errors persisted through N retries — likely a service issue, check status.netlify.com." |
| `token_expired` | invalid/expired token wording | "Netlify auth token is invalid or expired — run `netlify login`." (shared with preflight `bad_token` copy) |

Application points:

1. `createAgentRun` / `createAgentRunAsync` / `createAgentSession(Async)` —
   replace `wrapAccessError` call sites with `wrapFailure` (superset; keeps
   the runnerId/siteId context). Wrap AFTER `withSubmissionRetry` so retryable
   signatures only get guidance once retries exhaust, and pass the attempt
   count into the message.
2. Result-level failures: where `waitForLocalAgentRuns` normalizes a failed
   run's `resultText`, pass it through `explainFailure` and prepend guidance
   when matched (capacity/E2BIG surviving auto-retries).
3. Message-copy sharing: `accessDeniedMessage` stays in `preflight.js`
   (single source), imported by the table.

Out-of-credits: signature text unknown — we have not captured it. Ships as a
placeholder comment in the table, added the day we see the real stderr (open
question O1).

### 4.B Stalled-run watchdog

Read-side decoration, same shape as `applyArtifactStatuses`:

- Extend `src/dashboard/shared/run-artifact-status.js` (or sibling module
  `run-liveness.js` — keep them separate; different concerns):
  `applyLiveness(runState, { now, thresholdMs })`:
  - Gate: only when the *projected* status is active-looking (reuse
    `isActiveProjectedStatus` on raw fields, same trick as artifact
    hydration) — terminal runs skip everything.
  - `lastEventAt` = `fs.stat(events.jsonl).mtime` (fallback:
    `runState.updatedAt`). One stat per active run per read; active runs are
    few by definition.
  - Sets non-persisted fields: `lastEventAt` (ISO) and `stalledSinceMs`
    (number) when `now - lastEventAt > thresholdMs`.
- Threshold: default **10 minutes**, override `NAX_STALLED_AFTER_MINUTES`
  (0 disables). Env read at store creation, injectable for tests.
- `publicRunState` passes `lastEventAt`/`stalled: boolean` through;
  `src/contracts/dashboard.ts` `DashboardRun` gains
  `lastEventAt?: string; stalled?: boolean`.
- UI:
  - `RecentRuns.tsx`: when `run.stalled`, render an amber outline badge
    "Stalled" next to the status badge, tooltip "No events since <relative>".
  - Run view / details: thin amber Alert: "This run has produced no events
    since <time>. It may be stuck — you can cancel it, or resume after
    cancelling." (Buttons already exist; the alert just names the state.)
- Explicitly NOT a status-model key: cancel/resume/duplicate-run guards all
  key off active statuses; stalled runs must keep behaving as active for
  those. It is presentation metadata.

### 4.C Usage rollup

Server:

- `publicRunState` gains `usageTotals?: UsageSummary | null`:
  - Primary source: run-level `artifacts/usage.json` when present (one small
    read, only attempted when the artifacts dir exists — same lazy gating
    discipline as B).
  - Fallback: `aggregateRunUsage` over `steps[].runs[]` (already imported
    machinery; covers in-flight runs whose usage.json isn't written yet).
- `src/contracts/dashboard.ts`: `usageTotals?: { credits?: number,
  inputTokens?: number, outputTokens?: number, costUsd?: number }`.

Dashboard:

- Run card (`RecentRuns.tsx`): compact right-aligned text when totals exist —
  `$0.84` if `costUsd`, else `12.3 cr` if credits (formatting helper shared
  in `run-format.ts`; unit-testable).
- Run details modal: totals line in the summary entry's Metadata panel
  ("Usage · 3 agents · 41.2k in / 8.9k out · $0.84") plus per-step usage in
  the step card subtitle where present (`usageSummariesForRunState` shapes
  already produce per-step summaries — reuse `formatUsageSummary`).

CLI:

- `nax costs [--limit N] [--json]` (register alongside `list`): table over
  `listRunStates` — run id, flow, status, per-run totals, grand total row.
  Reuses `usageSummariesForRunState` + `formatUsageSummary`. `--json` emits
  machine-readable rows for scripts.

### 4.D Runs sidebar filter

- Pure helper `filterRuns(runs, { text, status })` in
  `src/dashboard/web/src/run-format.ts` (unit-testable without React):
  - text: case-insensitive substring over `flowTitle`, `flowId`, `runId`,
    `branch`.
  - status: statusKey bucket match (`statusKey(run.status) === status`),
    `all` passthrough. Buckets offered: All / Running / Completed / Failed /
    Cancelled (+ Stalled once B lands — composes via `run.stalled`).
- `RecentRuns.tsx`: `TextInput` (aria-label "Search runs") + compact Mantine
  `Select` for status, above the list; `useMemo` filter mirroring
  `WorkflowList.tsx:23-46`; "No matching runs" empty state.
- Pagination interplay: filter applies to loaded pages; while a filter is
  active and `hasMore`, keep "Load older" visible with the caption "searching
  loaded runs only — load older to widen". Honest about scope instead of
  pretending to search the archive.
- Count badge shows `filtered/loaded` when a filter is active.

---

## 5. User workflows enabled

- A failed fan-in run reads "The step prompt exceeds the runner's argv
  limit…" instead of a raw `fork/exec` line — in the red banner and the CLI.
- A run that hung 20 minutes ago says "Stalled · no events since 14:02" in
  the sidebar; you cancel it without wondering if you're killing live work.
- The demo closer: "that whole 3-agent review cost $0.84" — visible on the
  card the moment it finishes. `nax costs` answers "what did this week of
  runs cost?"
- "The failed security-audit run from Tuesday" = type `sec`, pick Failed.

---

## 6. Testing strategy (TDD, node:test via tsx, `node --import tsx --test <file>`)

- `tests/unit/failure-guidance.test.js` (new): every table entry — matching
  detail → guidance + original detail preserved + correct code; non-matching
  detail → error untouched; attempts count rendered; token never leaked
  (reuse redaction paths). Extend `tests/unit/local-runner.test.js`: existing
  wrong-account wrap tests keep passing through the new table (no behavior
  regression), plus an E2BIG-after-retries case.
- `tests/unit/run-liveness.test.js` (new): active run + old events.jsonl
  mtime → `stalled` true with `lastEventAt`; fresh mtime → not stalled;
  terminal run → fields absent and no fs.stat attempted (spy on injected
  stat); threshold 0 disables; missing events.jsonl falls back to updatedAt.
- `tests/unit/dashboard-local-storage.test.js` (extend): `listRunsPage` run
  carries `usageTotals` from usage.json fixture; fallback aggregation when
  usage.json absent; `stalled`/`lastEventAt` present for a stale active
  fixture.
- `tests/unit/run-format.test.ts` (extend/new): `filterRuns` text/status/
  combined/empty cases; usage compact formatter ($ vs credits vs null).
- `tests/unit/command-options.test.js`-style coverage for `nax costs`
  argument parsing; costs table assembly unit test over fixture run states
  (pristine output asserted).
- e2e (`tests/e2e/dashboard.spec.js`): stale-active fixture (old events.jsonl
  mtime) → Stalled badge visible; filter input narrows `.run-item` count and
  status select isolates Failed; completed fixture with usage.json → cost
  text on run card and totals in details modal. Guidance text e2e: reuse the
  existing failing-run path — assert banner shows mapped guidance, not raw
  stderr.
- Rule per AGENTS.md: `npm run dashboard:build` after every UI change.

---

## 7. Task breakdown & dependencies

| # | Task | Depends on | Size |
|---|------|-----------|------|
| 1 | 4.A `failure-guidance.js` table + unit tests; absorb `wrapAccessError` call sites | — | M |
| 2 | 4.A result-level guidance in waitFor normalization + e2e banner assert | 1 | S |
| 3 | 4.D `filterRuns` helper + RecentRuns UI + e2e | — | S |
| 4 | 4.B `run-liveness.js` + storage wiring + contracts | — | M |
| 5 | 4.B UI badge + details alert + e2e | 4 | S |
| 6 | 4.C `usageTotals` in publicRunState + contracts + storage tests | 4 (field pattern) | S |
| 7 | 4.C run card + details display + e2e | 6 | S |
| 8 | 4.C `nax costs` command + tests + docs page stub in site/content | 6 | M |

1↔3 independent; 4-8 sequential-ish but 3 can land any time.

---

## 8. Risks & mitigations

- **False guidance match** (generic words like "not found" in unrelated
  errors): patterns anchored to command context — the wrap only applies to
  `agents:*` submission/result paths, guidance always *prepends* and keeps
  the original detail, so a mismatch degrades to noise, never information
  loss.
- **Stalled false positives** (long-thinking agents with sparse events):
  threshold is generous (10m), configurable, and the label is soft ("may be
  stuck") with no behavior change — cancel remains a human choice.
- **fs.stat cost on list**: gated to active-looking runs only; a page of 50
  historical runs does zero extra I/O.
- **usage.json drift vs record aggregation** (both present, disagree):
  usage.json (written at completion, includes retries) wins; fallback is only
  for runs without it. Documented in the module comment.
- **Filter hides the active run** and confuses ("where did my run go?"):
  count badge shows `filtered/loaded` and empty state says "No matching runs
  — clear filter", so hidden-not-gone stays evident.

## 9. Decisions (PROPOSED — need David's call)

- **D1 — Taxonomy scope at launch**: Netlify agent-runner signatures only
  **[recommended]** vs also gh/GitHub-transport signatures. We have no
  captured gh failure worth mapping; speculative entries violate the
  "every signature actually hit" rule.
- **D2 — Stalled representation**: presentation metadata
  (`stalled`/`lastEventAt` fields) **[recommended]** vs new `stalled` status
  key. A status key ripples through statusKey/labels/cancel/resume/duplicate
  guards for zero added capability.
- **D3 — Usage display unit**: prefer `costUsd` when present, else credits
  **[recommended]** vs credits-only. Dollars are the demo-compelling number;
  credits are the fallback truth.
- **D4 — Filter mechanics**: client-side over loaded pages with honest
  "loaded runs only" caption **[recommended]** vs server-side query params.
  YAGNI until someone actually can't find a run this way.
- **D5 — `nax costs` in launch scope**: include **[recommended]** vs
  dashboard-only first. It's a thin reuse of existing aggregation and the
  scriptable `--json` face of the feature.

## 10. Open questions

- **O1**: exact out-of-credits stderr text from `netlify agents:create` —
  capture next time it happens (or provoke it deliberately on a drained
  test team) and add the table entry.
- **O2**: should the stalled threshold live in flow defaults (per-flow
  override) rather than env-only? Deferred until someone needs it.
