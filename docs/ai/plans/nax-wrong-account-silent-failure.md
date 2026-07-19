# Plan: wrong-account silent failure — preflight + error surfacing

> A machine logged into the wrong Netlify account clicks Run in the dashboard
> and *nothing happens*. No banner, no failed state with a reason, nothing.
> Fix both halves: catch the wrong account before the run, and never let a
> failure message die on the way to the UI again.

Status: **DRAFT v1** (initial plan, pre-review). Owner: David. Author: Claude.

---

## 1. Goal & intent

Two user-visible outcomes:

1. **Preflight.** `nax dashboard` and `nax run` know *at startup* whether the
   logged-in Netlify account can access the linked site, and say so plainly:
   "Logged in as david@… (team Foo) → site bar-site ✓" or "Your Netlify login
   can't access site `<id>` — you may be on the wrong account. Run
   `netlify status` / `netlify login`." Multi-account machines are the whole
   point: token *presence* is already checked; token *fitness* is not.

2. **No silent failures.** When a run fails for any reason, the reason reaches
   the dashboard UI — live via SSE, and after reconnect via the durable event
   log. Today the message is emitted and even persisted, then discarded by the
   frontend reducer. That is a bug independent of auth and gets fixed first.

Why both: preflight catches the *known* failure early with a good message, but
the event-plumbing fix is what protects us from the *next* unknown failure mode
going silent.

---

## 2. Non-goals (explicit scope fence)

- **Not** account switching. We detect and explain the wrong account; we do
  not manage Netlify CLI user switching or multiple profiles.
- **Not** the hosted-runtime path. `src/dashboard/runtime/netlify-function.js`
  → `src/dashboard/transports/netlify-api.js` already propagates typed
  401/403/404 errors correctly (`src/dashboard/api/app.js:279-281`). Local
  path only.
- **Not** a `nax doctor` command. Preflight is inline in `dashboard`/`run`.
  A standalone doctor can reuse the same module later if we want one.
- **Not** fixing the live/durable dual-source list bug — that has its own plan
  (`dashboard-run-status-single-source.md`). This plan only *adds* terminal
  events to the durable log; it does not change which source the list prefers.

---

## 3. Current architecture (grounding facts)

The local dashboard run path (all file:line verified 2026-07-19):

1. Web UI POST `/api/workflows/:id/runs` → `src/dashboard/api/app.js:447` →
   `startWorkflow` `src/dashboard/server.js:997` → `startRun`
   `src/dashboard/server.js:1182`.
2. `runWorkflowChild` `src/dashboard/transports/local-process.js:137` spawns
   `node src/cli/nax.js run <flow>` with `NAX_EVENT_FD=3` for JSONL events.
3. Child: `handleRunEngine` `src/cli/main.js:2253` prints `State: …` early
   (`src/cli/main.js:2366-2371`) — this resolves the durable run id, settles
   `run.startedPromise`, and the POST returns **202 before submission runs**.
   So the frontend's POST-error path never fires for submission failures.
4. Submission: `src/workflows/engine/local-executor.js:786` →
   `submitLocalAgentRun` `src/integrations/netlify/local-runner.js:974` →
   `netlify agents:create` via `runAsync` (`local-runner.js:614`). Wrong
   account ⇒ CLI exits non-zero (403/404 in stderr) ⇒ throw with redacted
   stderr. 401/403/404 are correctly non-retryable (`local-runner.js:653-679`).
5. Failure events (child, all **durably logged** — every `emit` appends to the
   run's event log, `src/workflows/events/runner-events.js:193`):
   - `agent_status` `{status:'failed', message, phase:'submit'}`
     (`local-executor.js:814-831`; also stores `raw.submissionError` in run
     state).
   - `workflow_failed` `{message}` (`src/cli/main.js:2417` via
     `workflowStatus('failed', …)`, event type built in
     `src/workflows/events/workflow-events.js:177-178`).
6. Failure events (parent, **in-memory only** on the live run):
   - `{type:'error', message:<last stderr line>}` and `{type:'exited', …}`
     from the child close handler (`local-process.js:270-278`), recorded via
     the server eventSink (`server.js:1263-1296`). Never appended to the
     durable log; lost when the live run is evicted
     (`src/dashboard/runtime/live-run-registry.js:97`).
7. Frontend: SSE events land in `src/dashboard/web/src/App.tsx:672-735` and
   `src/dashboard/web/src/liveRunReducer.ts`.
   - Only `error` / `runner_event_error` reach the visible `errors[]`
     (`liveRunReducer.ts:152-157`) and `runError` (`App.tsx:693-695`).
   - `agent_status` keeps only the status string (`liveRunReducer.ts:122-143`);
     `workflow_failed` keeps only status/exitCode (`liveRunReducer.ts:159-171`).
     **`message` is discarded in both.** This is the core silent-failure bug:
     the reason is emitted, transported, and persisted — then dropped at the
     last hop.

Auth facts:

- Token resolution: `NETLIFY_AUTH_TOKEN`, else Netlify CLI config files —
  `readNetlifyCliToken` `src/integrations/netlify/init.js:209-234`.
- Site resolution: `NETLIFY_SITE_ID`, else `.netlify/state.json` —
  `readLinkedSiteId` `src/integrations/netlify/init.js:143-152`.
- Presence-only gate: `detectTransports`
  `src/integrations/transports.js:111-139` (CLI installed + site linked +
  token exists). No ownership check anywhere.
- `readNetlifyStatus` (`init.js:154-181`) already parses
  `netlify status --json` (account name/email/teams, siteData) but is used
  only by `nax init` and for an admin URL.
- `nax dashboard` startup (`src/cli/main.js:557-581`) does zero auth checks.
  `/api/health` (`src/dashboard/server.js:1536-1563`) reports capabilities but
  not auth state.

---

## 4. Design

Four workstreams. A and B are independent; C depends on B's event-shape
decisions; D depends on A (uses its verdict for the friendly message).

### 4.A Surface failure messages in the UI (the plumbing bug)

Smallest change, biggest safety net. Pure frontend.

- `src/dashboard/web/src/liveRunReducer.ts`:
  - `workflow_failed` with a string `message` → also append to `errors[]`
    (dedupe on exact string; keep existing status/exitCode handling).
  - `agent_status` with `status === 'failed'` and a string `message` → append
    `"<agent/step>: <message>"` to `errors[]`, still dedupe. Keep the seq
    guard as-is so replays don't double-append (dedupe covers replay overlap
    across reconnects).
- `src/dashboard/web/src/App.tsx:693`: also set `runError` when
  `data.type === 'workflow_failed'` and `data.message` is a string.
- No server change. Because the child's events are already durable (§3.5),
  this alone fixes both the live view *and* the reconnect-after-eviction view
  for every failure the child gets to report.

### 4.B Preflight module (account/site fitness check)

New file `src/integrations/netlify/preflight.js` (single responsibility; keeps
`init.js` from growing another concern):

```js
// Checks that the resolved Netlify token can access the linked site.
// Returns a verdict object; never throws.
async function checkNetlifyAccess({ projectRoot, env, fetch, timeoutMs })
// → { ok: boolean, code: 'ok'|'no_token'|'no_site'|'bad_token'|'no_access'|'network_error',
//     message: string, account: { email, slug } | null, site: { id, name, accountSlug } | null }
```

Mechanics (D1, recommended: direct API, not CLI shell-out):

1. Resolve token (`readNetlifyCliToken`) and site id (`readLinkedSiteId`).
   Missing either → `no_token` / `no_site` with the existing help text from
   `src/integrations/transports.js:116-122` reused verbatim.
2. `GET https://api.netlify.com/api/v1/user` with the bearer token →
   401 ⇒ `bad_token` ("token invalid/expired — run `netlify login`");
   200 ⇒ capture `{ email }` for the "logged in as" line.
3. `GET https://api.netlify.com/api/v1/sites/:siteId` →
   200 ⇒ `ok`, capture site `name` + `account_slug`;
   404 or 403 ⇒ `no_access` — Netlify returns 404 for sites the account
   cannot see, which is exactly the wrong-account signature:
   "Logged in as `<email>`, but that account can't access site `<siteId>`.
   You may be on the wrong Netlify account — run `netlify status` to check,
   `netlify login` to switch."
4. Any network/timeout failure ⇒ `network_error`, `ok:false` but callers
   treat it as a *warning*, never a block (offline-tolerant).

Injected `fetch` like `api-client.js:132` so unit tests use a stub transport
(unit-level stub of an external HTTP boundary, consistent with the existing
api-client tests — not a mocked-behavior test).

Wiring:

- **`nax run`** (`handleRunEngine`, `src/cli/main.js:2253`): call preflight
  before `executeLocalFlow`; on `bad_token`/`no_access` **fail fast** with the
  verdict message (exit 1) instead of burning 30-120s to a cryptic
  `agents:create` stderr. `network_error` → print warning, proceed (the run
  may still work; the CLI will produce the real error if not). Because
  dashboard runs go through the `nax run` child, this covers both entry
  points with one gate. Skip entirely for transports that don't need it
  (mock, github) — gate on the flow's resolved transport being the local
  Netlify CLI transport.
- **`nax dashboard`** (`handleDashboard`, `src/cli/main.js:557-581`): run
  preflight at startup, print one line (green check or the warning), and pass
  the verdict into server options.
- **`/api/health`** (`server.js:1536-1563`): include
  `netlifyAccess: <verdict>` so the web UI can render it.
- **Web UI**: health is already fetched; render a dismissible warning banner
  when `netlifyAccess.ok === false` (except `network_error`, shown more
  softly). Banner text = verdict message. This is what saves the demo: the
  wrong account is visible the moment the dashboard opens, before anyone
  clicks Run.

Dashboard behavior is **warn, not block** (D2): browsing past runs must keep
working on a wrong-account machine; only the run submission itself hard-fails
(via the `nax run` gate, whose message now reaches the UI thanks to 4.A).

Preflight runs once at startup + once per run submission. No caching layer,
no polling (YAGNI — a stale verdict is corrected by the per-run gate).

### 4.C Persist parent-side terminal events durably

After 4.A, the only remaining silent case is the child dying *before* it
emits `workflow_failed` (spawn failure, crash, OOM-kill). The parent-side
synthetic `error`/`exited` events exist but are in-memory only (§3.6).

- In the server's child-completion handling (`server.js:1299-1340` /
  eventSink recording at `:1263-1296`): when the durable run state is
  resolved and the child produced **no terminal workflow event**, append the
  synthetic `error` (if failed) and `exited` events to the durable log via
  `appendEventLog(eventLogPathForRunState(...))` — both already imported at
  `server.js:13` and used at `:800`.
- Seq discipline: durable log consumers filter with `since`/`seq`
  (`runner-event-log.js:79`). Parent-appended events must carry a seq higher
  than the child's last (read the log tail, continue from `lastSeq + 1`).
- Do **not** append when the child already emitted `workflow_failed`/
  `workflow_completed`/`workflow_cancelled` — avoids duplicate terminal
  events and keeps this from re-entangling with the dual-source cleanup plan.

### 4.D Friendly wrong-account failure message

For the case where preflight passed (or was skipped/offline) and
`agents:create` still fails with an access error:

- In the submission error path (`local-runner.js` around `runAsync`
  `:614`-`createAgentRunAsync` `:856`): when the CLI stderr matches
  `/(401|403|404|unauthorized|not found|access denied)/i`, wrap the thrown
  error message with the same guidance string the preflight uses (single
  source: export the message builder from `preflight.js`), keeping the
  original redacted stderr appended for debugging.
- This message then flows through the (now-fixed) event plumbing to the UI.

---

## 5. User workflows enabled

- **Demo on any machine:** open `nax dashboard` → banner immediately says
  which account you're on and whether it can reach the site. Wrong account is
  a 5-second diagnosis instead of a dead demo.
- **CLI runs:** `nax run review` on a wrong-account machine exits in ~1s with
  "logged in as X, can't access site Y, run `netlify login`" instead of a
  2-minute timeout-ish cryptic failure.
- **Any future failure:** whatever the child manages to say before dying is
  visible in the run view, live and after reload.

---

## 6. Testing strategy (TDD, uvu, `node <file>` runnable)

Write each failing test first, then the minimal fix.

- `tests/unit/live-run-reducer.test.ts` (extend existing):
  1. `workflow_failed` with message → message in `errors[]`, status updated.
  2. `agent_status` failed with message → labeled message in `errors[]`.
  3. Same event replayed (reconnect) → no duplicate entry.
  4. Events without `message` → unchanged behavior (no `undefined` entries).
- `tests/unit/netlify-preflight.test.js` (new): stub fetch; cases: ok,
  no_token, no_site, 401 user, 404 site, 403 site, network error → verdict
  codes + messages; token never appears in messages (reuse `redactToken`).
- `tests/unit/run-preflight-gate.test.js` (new): `handleRunEngine` gate —
  no_access ⇒ fails fast before executor invoked; network_error ⇒ proceeds
  with warning; mock/github transport ⇒ preflight not called. (Structure this
  as a testable seam, mirroring how other main.js handlers are tested — see
  existing `tests/unit/command-options.test.js` pattern.)
- `tests/unit/dashboard-event-stream.test.js` (extend): child exits non-zero
  without terminal workflow event ⇒ durable log gains `error`+`exited` with
  ascending seq; child that did emit `workflow_failed` ⇒ no parent append.
- `tests/unit/local-runner.test.js` (extend, file exists): access-flavored
  stderr ⇒ wrapped guidance message, original detail preserved, redaction
  intact.
- e2e sanity (`tests/e2e/dashboard.spec.js`): run view shows failure banner
  text when a run fails (drive with mock/failing child).

---

## 7. Task breakdown & dependencies

| # | Task | Depends on | Size |
|---|------|-----------|------|
| 1 | 4.A reducer + App.tsx message surfacing (tests first) | — | S |
| 2 | 4.B `preflight.js` module + unit tests | — | M |
| 3 | 4.B wire `nax run` fail-fast gate | 2 | S |
| 4 | 4.B wire `nax dashboard` startup line + `/api/health` field | 2 | S |
| 5 | 4.B web UI banner from health verdict | 4 | S |
| 6 | 4.C parent terminal-event durable append (seq-safe) | — | M |
| 7 | 4.D friendly wrong-account wrap in local-runner | 2 | S |

Order: 1 → 2 → 3 → 4 → 5 → 7 → 6. Task 1 first because it is the safety net
for everything else and the cheapest to verify; 6 last because 1 shrinks its
blast radius to the child-died-early corner.

---

## 8. Risks & mitigations

- **Netlify API shape drift** (`/user`, `/sites/:id`): both are long-stable
  v1 endpoints; verdict treats unexpected shapes as `network_error` (warn,
  never block).
- **False block from preflight** (API hiccup blocking a run that would work):
  only `bad_token`/`no_access` block; anything ambiguous is a warning.
- **Duplicate error lines in UI** (agent_status + workflow_failed + error all
  carrying similar text): dedupe on exact string in reducer; acceptable to
  show two distinct phrasings rather than risk showing zero.
- **Seq collisions in durable log** from parent appends: read-tail-continue
  discipline + test coverage in task 6.
- **Startup latency** for dashboard: two small GETs with a short timeout
  (~3s cap), non-blocking for server listen (print/emit verdict when ready).

## 9. Decisions (RESOLVED 2026-07-19)

- **D1 — Preflight mechanism**: resolve site id + token from config files
  first (`readLinkedSiteId`/`readNetlifyCliToken`), then check access with a
  direct API call (`/user` + `/sites/:id`). Never depend on
  `netlify status --json` for this — it errors when the CWD isn't a linked
  folder ("You don't appear to be in a folder that is linked to a project"),
  which is orthogonal to what we're checking. `netlify api getSite` shell-out
  is an acceptable fallback but not needed when direct fetch works.
- **D2 — Dashboard startup behavior**: warn + banner. Browsing old runs on a
  wrong-account machine keeps working; only run submission hard-fails.
- **D3 — Where the run gate lives**: in the `nax run` child, before
  `executeLocalFlow`. One gate covers CLI and dashboard-spawned runs.
- **D4 — 4.C scope**: parent appends terminal events only when the child
  emitted no terminal workflow event.

## 10. Open questions

- Does the web UI already have a banner/toast component to reuse for the
  health verdict, or is this the first global banner? (Check during task 5.)
- Should `nax init` also run the full preflight at the end (it already does
  presence checks at `init.js:400,496`)? Cheap add via the same module —
  propose yes, as a follow-up task if David wants it.
