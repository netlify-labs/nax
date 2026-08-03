# Agent Runner SDK — Specification

**Status:** SPEC v8 (2026-08-02) — discovery + two requirements interviews + **five review rounds** integrated, every backend claim code-verified against `platform/bitballoon`. Self-contained (no references to prior versions). **Bead-ready**; §11 = Phase-0 verifications only.
**Package:** **`nax-agent-runner-sdk`** (unscoped; npm-available, checked 2026-08-02) — standalone workspace package in this repo (`github.com/netlify-labs/nax`), published independently. nax depends on it; so do Revenue Engine (RE) and the GitHub Action.
**Mission:** *"Centralize the agent runner calls into this one package"* — one SDK used by RE, nax, and the GitHub Action; one place changes when the runner API moves.
**Repository checkpoint:** Add and commit this specification before converting it to beads. Until that happens the file is untracked and its review history exists only in conversation context, which is not an implementation dependency.

---

## 0. Identity: a stateless engine over caller-persisted handles

> The SDK holds no hidden instance state. Anything that must survive a process boundary (RE's Lambda ↔ EventBridge finisher) lives in a serializable **`RunHandle`** / **`SessionHandle`** the caller persists.

```ts
type PromptInput =
  | { prompt: string; promptRef?: never }
  | { prompt?: never; promptRef: BlobRef }

type LandingMode = 'pr' | 'merge' | 'publish' | 'none' | 'auto'
type RunnerMode = 'normal' | 'create' | 'ask'

type StartInput = PromptInput & {
  siteId: string
  agent?: string
  model?: string
  branch?: string
  deployId?: string
  mode?: RunnerMode
  fileKeys?: string[]
  land?: LandingMode
  deadlineMs?: number
  retryBudget?: { capacity: number }
  requestId?: string                  // caller may provide; otherwise SDK generates one before transmission
}

type FollowUpInput = PromptInput & {
  agent?: string
  model?: string
  mode?: RunnerMode
  fileKeys?: string[]
  requestId?: string
}

type WithRequestId<T> =
  T extends { requestId?: string }
    ? Omit<T, 'requestId'> & { requestId: string }
    : never
type EffectiveStartInput = WithRequestId<StartInput>       // distributive: preserves the PromptInput union
type EffectiveFollowUpInput = WithRequestId<FollowUpInput>

type BaseHandle = {
  v: number                          // handle schema version (serde migration)
  runnerId: string
  siteId: string
  agent: string
  origin?: OriginInfo                // runner code_origin + site/account provider once known
  input: EffectiveStartInput         // FULL effective input, including the generated correlation requestId
  policy: { landing: LandingMode; deadlineAt: number; retryBudget: { capacity: number } }
  retries: {
    capacity: number
    lastAttempt?: {
      attempt: number
      category: FailureCategory
      code: string
      scheduledAt: number
      delayMs: number
    }
  }
  landing?: LandingProgress          // completed landing steps (resumable land, §6.1)
  currentSessionId: string           // the session whose outcome/commit we track (§6.1 step 2)
}

type RunHandle = BaseHandle & { kind: 'run' }
type SessionHandle = BaseHandle & {
  kind: 'session'
  sessionId: string                  // invariant: sessionId === currentSessionId
  sessionInput: EffectiveFollowUpInput
}
type Handle = RunHandle | SessionHandle

type LandingProgress = {
  prUrl?: string
  committedSessionIds?: string[]
  expectedPrHeadSha?: string          // compare-and-swap guard for GitHub merge
  mergedSha?: string
  published?: boolean
}
```
- `start(input) → RunHandle`; the SDK generates `requestId` before transmission when absent, stores the effective input on the handle, and resolves the synchronously-created initial session so `currentSessionId` is present before returning.
- `followUp(handle, input) → SessionHandle` returns a **full-fidelity handle**: it copies the run input/policy/retry/landing state and adds the effective follow-up input plus `sessionId === currentSessionId`. `reconcileSession` returns the same shape. Nothing required for later `land`/`retry` is lost at the handle transition.
- Snapshot/result ops accept `Handle`; `land(handle) → { handle, landing }`; `stop(handle)` and `retry(handle)` return the same handle kind with updated state (`retry(RunHandle)` creates a replacement runner; `retry(SessionHandle)` creates a replacement follow-up session on the same runner).
- `run(input, opts) → RunOutcome<RunHandle>` is the in-process convenience (`start`→`waitFor`→`land`), deadline/retry enforced inside the call.
- **Out-of-band (RE):** `start()` → persist handle → finisher rehydrates each tick → `getSnapshot()`; terminal-success → `land(handle)`; deadline via `policy.deadlineAt` → `stop()`; bounded retry via `shouldRetry` → `retry(handle)`.
- `serializeHandle`/`parseHandle` (version-stamped).
- Ambiguous creations (runner **and** session) recover via explicit reconciliation — §6.7.

---

## 1. Decisions (all locked)

| # | Decision | Choice |
|---|---|---|
| D1 | Run model | All async; handles as above. |
| D2 | Packaging & source | Workspace pkg `packages/agent-runner-sdk`, npm **`nax-agent-runner-sdk`**. **TypeScript source** → CJS + ESM + `.d.ts`; `engines.node >= 18`; nax consumes built CJS (the auth plan's CJS/JSDoc constraint is amended to the artifact level). |
| D3 | Transport | HTTP (default) + opt-in CLI (`netlify` binary, zero-config, never an npm dep; min-version gate §3.2) behind one `Transport`. |
| D4 | Auth | Netlify service PAT for all runner ops. **GitHub token OPTIONAL — only for `land:'merge'`** (PR auto-merge via the GitHub API). RE supplies its netlify-labs org token (already in SSM); nax + GH Action are PR-only. Token precedence (matches the auth plan): **per-call `opts.token` > constructor `token` > env `NETLIFY_AUTH_TOKEN` > CLI-config discovery**. The `NETLIFY_AGENT_RUNNER_TOKEN` alias is deliberately absent — the auth plan's sole-env-token contract stands; RE passes its token explicitly. |
| D5 | Large prompts | Blob-offload (Phase 2); `BlobStore` contract §7; hard max-size ceiling. |
| D6 | Auto-retry | Transient only (capacity/5xx/rate-limit), retry-safe ops only (D17); argv-too-long surfaced, never silently mutated. |
| D7 | Failure taxonomy | Core runner/transport taxonomy + optional GitHub extension. |
| D8 | Idempotency | Caller-owned; the persisted handle is the dedupe anchor; every runner/session create gets a cryptographically random **server-visible `requestId` marker** in the submitted prompt wrapper. Ambiguity → marker-based reconciliation (§6.7), never blind replay or prompt-similarity auto-adoption. |
| D9 | Landing | Origin-specific (§6.1). First landing = **`pull_request` member action directly** (backend creates branch+PR from the runner's working diff; rejects if a PR exists). Follow-ups = **`commit`** to the existing PR branch, tracked **per-session**: resume via the current session's `commit_sha`, never runner-level `merge_commit_sha`. **Merge = GitHub API with the optional token**, guarded by the expected PR head SHA (compare-and-swap; head drift never merges). The backend has no merge-PR action; `merge_target` = target→PR-branch conflict resolution. `netlify-git` → `publish_to_production`. zip/drop → explicit `unsupported`. Main always rejected; runners don't create result branches. |
| D10 | API-drift | Unknown **additive** fields ignored (log-once); missing/malformed required identity/state (`runnerId`, `sessionId` where required, `state`) → typed **`invalid-api-shape`**. Two canaries (§9). |
| D11 | Cost/cancel | `stop()` = DELETE-cancel; `run()` deadline auto-cancels; out-of-band deadline caller-enforced via `policy.deadlineAt`. **`usage: Usage \| null` on every `RunResult` variant.** RE persists usage to its AI-usage entity (separate RE plan). |
| D12 | No-op detection | `changes: 'changed' \| 'unchanged' \| 'unknown'` (tri-state; unknown ≠ unchanged). |
| D13 | Follow-ups | `followUp(handle, input) → SessionHandle`; snapshot/result ops accept either handle kind (a SessionHandle scopes attribution to its sessionId). RE v1 builds no chat — reps use the Netlify site's own agent UI. |
| D14 | Progress | Optional poll-driven `onProgress(event)` on `run()`/`waitFor()`. |
| D15 | Agent/model | Default `agent: 'claude'`; per-run override. |
| D16 | Landing modes | `'pr'` (create PR, stop — nax/GH-action default) \| `'merge'` (PR + GitHub-API merge; requires `githubToken` else typed `github-token-required`) \| `'publish'` (netlify-git) \| `'none'` \| `'auto'` (resolve by origin; GitHub → merge iff `githubToken` configured, else PR with `merged:false`). |
| D17 | Per-op retry | Operation-specific (§3.1). Create POSTs replayed **only on provably-pre-transmission failure**; post-write ambiguity → typed `create-ambiguous` / `session-create-ambiguous` carrying the effective input + bounded request window for reconciliation (§6.7); session 409 → typed `session-already-active` (adopt only on exact request-marker match). |
| D18 | Result shape | `RunResult` discriminated union + **`RunOutcome<H extends Handle> { result, landing?, handle: H }`** as `run()`'s return. Landing outcomes have a home: `merged:false`, unsupported, PR/merge failures. Reconciliation returns a discriminated union (`matched` / `none` / `ambiguous`), never nullable handles. Typed member action/input map. |
| D19 | BlobStore | Contract + lifecycle §7; retain-until-TTL on `failed`; typed `prompt-ref-expired`. |
| D20 | Build/CI | tsup/tsc build with package-local **`strict: true`, `noImplicitAny: true`, `useUnknownInCatchVariables: true`**; node:test via tsx; public examples typechecked; `check-import-direction.js` extended to `packages/`; `npm pack` smoke (CJS + ESM import); Node 18/20/22 matrix; **manual releases** with package-specific git tags (`nax-agent-runner-sdk-vX.Y.Z`) so independent SDK semver cannot collide with nax's root `vX.Y.Z` tags. |
| D21 | Auth-consolidation | The plan (`docs/ai/plans/nax-authenticated-request-consolidation.md`, FINAL v3, never implemented) is **implemented directly inside the SDK package, in TS**; its behavior contracts + characterization tests carry over; the plan doc gets a home amendment (incl. the D4 env-alias note). nax imports the core back. |
| D22 | Migration proof | nax migrates in Phase 1 — **ALL runner call-sites** (local-runner path, hosted-dashboard `netlify-api` transport, preflight). **nax's existing prompt-prep/offload/cleanup layer stays wrapped around the SDK during Phase 1** (no prompt-size regression); swaps to SDK prompt-delivery in Phase 2. |
| D23 | Coding installation | **Org-wide on netlify-labs** → vended repos auto-covered; Phase-0 smoke assert only. |
| D24 | Canary infra | netliclaw + dedicated `agent-sdk-canary` site/repo (netlify-labs); hard credit budget; branch/PR auto-prune. |

---

## 2. Endpoint (settled; kebab mystery resolved)

**Snake, top-level, `DELETE`=cancel** — verified in bitballoon Rails routes AND `bitballoon-openapi` (no kebab runner path exists anywhere): `POST /api/v1/agent_runners?site_id=`, `GET /:id`, `GET /agent_runners` (site-scoped index — used by reconciliation §6.7), `GET|POST /:id/sessions`, `DELETE /:id` (202) = cancel; members `archive`/`pull_request`/`commit`/`revert`/`rebase`/`merge_target`/`sync_git_origin`/`publish_to_production`/`diff`; account-level `GET /api/v1/{account_slug}/agent_runners`.

nax "works fine" because its runs go `netlify-api` transport → `local-runner.js` → the **netlify CLI** (snake). The kebab paths exist only in `api-client.js` — self-described *"Provisional Agent Runner endpoints used by the hosted dashboard transport"* — placeholders this migration deletes. Keep `apiStyle: 'v1' | 'bb-api'` for the legacy camel fallback.

---

## 3. Architecture

```
nax-agent-runner-sdk  (packages/agent-runner-sdk; TypeScript → CJS + ESM + .d.ts)
├── auth/                   # auth-consolidation core in TS (D21): token discovery (per-call > ctor > env > CLI config),
│                           #   preflight, user-agent, value-free telemetry hook
├── transport/{httpTransport,cliTransport}.ts
├── client.ts               # core ops + listRunners(siteId) + listAccountRunners + typed member(runnerId, action, input)
├── engine.ts               # start / run / waitFor / getSnapshot / getResult / land / stop / followUp / shouldRetry / retry
│                           #   + reconcileCreate / reconcileSession (§6.7)
├── landing/                # githubPr (+ optional GitHub-API merge) | netlifyGitPublish | unsupported — session-aware, resumable (§6.1)
├── github/mergePr.ts       # the ONLY GitHub-API touchpoint: merge a PR with the optional githubToken
├── prompt-delivery/        # Phase 2: inline | compact | blob(+fetch-instruction+sentinel); default Netlify-Blobs store (§7)
├── result.ts               # RunResult/RunOutcome/LandingOutcome/ReconciliationResult unions
├── retry.ts                # per-operation retry policy (D17)
├── failures/{core,github}.ts   # taxonomy (harvested GH-action model + nax failure-guidance)
├── recovery.ts             # reconcile prior state → { confidence, recoveryAction }  [GH state-reconciliation]
├── presenters/ (optional)  # result/status renderers [GH generate-*-comment]
├── runtime.ts              # local | netlify-build | agent-runner
└── index.ts                # createAgentRunnerSdk(opts) + Handle serde
```

### 3.1 `Transport` + per-operation retry
```ts
type RunnerPage = {
  items: Runner[]
  nextPage?: number
  total?: number
}

interface Transport {
  createRunner(input, opts?): Promise<Runner>        // POST /agent_runners?site_id= — replay only if provably never sent; ambiguous → create-ambiguous
  createSession(id, input, opts?): Promise<Session>  // POST /:id/sessions — same; ambiguous → session-create-ambiguous; 409 → session-already-active
  getRunner(id, opts?): Promise<Runner>              // GET — freely retryable
  listRunners(query, opts?): Promise<RunnerPage>     // GET index: created_at filters, backend sorts last_session_created_at; SDK paginates
  listSessions(id, opts?): Promise<Session[]>        // GET (OLDEST-FIRST) — freely retryable
  cancelRunner(id, opts?): Promise<void>             // DELETE (202) — idempotent
  member(id, action, input, opts?): Promise<...>     // typed map: pull_request | commit | merge_target | sync_git_origin | diff | revert | publish_to_production | archive
}
// opts?: { token?, signal? }
```
- GET/DELETE → backoff-retry on `408/409/425/429/≥500`.
- Create POSTs → replay only on provably-pre-transmission failure (DNS failure, ECONNREFUSED, connect-phase timeout). Post-write resets/read-timeouts/ambiguous statuses → typed ambiguity carrying `{ effectiveInput, sentAt, failedAt }` (§6.7).
- Token redaction on every error detail; `errorCodeForStatus` (401→auth, 403→permission, 404→not_found, 400/422→validation, 429→rate_limited); `onTelemetry` value-free (method, pathname, status only — per the auth plan).

### 3.2 cliTransport — `netlify --version` gate on first use: below tested minimum → typed `cli-transport-incompatible`; binary absent → `cli-transport-unavailable`. (The GH action pins `netlify-cli@24.8.1` for exactly this reason.)

---

## 4. Public API

```ts
import { createAgentRunnerSdk, isAgentRunnerSdkError } from 'nax-agent-runner-sdk'
import type { SessionHandle } from 'nax-agent-runner-sdk'

const sdk = createAgentRunnerSdk({
  token,
  ...(githubToken ? { githubToken } : {}),
  transport: 'http',
  apiStyle: 'v1',
  fetch,
  sleep,
  blobStore,
  onTelemetry,
})

// ── in-process ──
const outcome = await sdk.run({ siteId, prompt, land: 'merge', deadlineMs, retryBudget: { capacity: 1 } }, { onProgress })
// RunOutcome: { result: RunResult, landing?: LandingOutcome, handle: RunHandle }

// ── out-of-band (RE Lambda ↔ EventBridge finisher) ──
let handle = await sdk.start({ siteId, prompt, land: 'merge', deadlineMs })
// persist … later:
handle = sdk.parseHandle(stored)
const snap = await sdk.getSnapshot(handle)            // { kind:'running', state, latestStep } | { kind:'terminal', result }
if (snap.kind === 'terminal' && snap.result.status === 'succeeded') {
  const landed = await sdk.land(handle)               // { handle, landing: LandingOutcome } — resumable, session-aware
  handle = landed.handle
}
if (Date.now() > handle.policy.deadlineAt) await sdk.stop(handle)
if (snap.kind === 'terminal' && snap.result.status === 'failed' && sdk.shouldRetry(handle, snap.result.failure)) {
  handle = await sdk.retry(handle, { failure: snap.result.failure }) // backoff + checkpoint; semantic input + deadline preserved
}

// ── ambiguity recovery (§6.7); examples are typechecked in CI ──
try {
  handle = await sdk.start(input)
} catch (error: unknown) {
  if (!isAgentRunnerSdkError(error, 'create-ambiguous')) throw error
  const reconciled = await sdk.reconcileCreate(error.effectiveInput, error.window)
  if (reconciled.kind !== 'matched') {
    // `ambiguous` includes safe candidate IDs/timestamps for escalation; `none` is distinct.
    throw new Error(`Runner creation reconciliation required: ${reconciled.kind}`)
  }
  handle = reconciled.handle
}

let sessionHandle: SessionHandle
try {
  sessionHandle = await sdk.followUp(handle, followInput)
} catch (error: unknown) {
  if (!isAgentRunnerSdkError(error)) throw error
  if (error.code !== 'session-create-ambiguous' && error.code !== 'session-already-active') {
    throw error
  }
  const reconciled = await sdk.reconcileSession(handle, error.effectiveInput, error.window)
  if (reconciled.kind !== 'matched') {
    throw new Error(`Session creation reconciliation required: ${reconciled.kind}`)
  }
  sessionHandle = reconciled.handle
}

const sSnap = await sdk.getSnapshot(sessionHandle)    // SessionHandle → session-scoped attribution
const sLand = await sdk.land(sessionHandle)           // full handle retains policy + landing progress
const cls   = sdk.classifyFailure(signal)
await sdk.client.member(handle.runnerId, 'pull_request', input)   // typed escape hatch
```

### 4.1 `LandingOutcome`
```ts
type LandingOutcome =
  | { kind: 'merged';      prUrl: string; mergeSha: string; deployUrl? }
  | { kind: 'prOpen';      prUrl: string; merged: false }              // land:'pr', or 'auto' without githubToken
  | { kind: 'published';   deployUrl? }                                 // netlify-git
  | { kind: 'unsupported'; reason: string }                             // zip/drop origin
  | { kind: 'failed';      step: 'commit' | 'pr' | 'merge' | 'publish'; failure: FailureClassification }
  | { kind: 'skipped' }                                                 // land:'none'
```

### 4.2 Reconciliation results
```ts
type ReconciliationCandidate = {
  runnerId: string
  sessionId?: string
  createdAt: number
}

type ReconciliationResult<H extends Handle> =
  | { kind: 'matched'; handle: H }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: ReconciliationCandidate[] }
```
Candidate payloads never include prompts, tokens, or response bodies. `none` and `ambiguous` are intentionally distinct so callers can escalate or clean up known candidates without parsing logs.

---

## 5. `RunResult` — discriminated union

```ts
type RunResult =
  | { status: 'succeeded'; runnerId; sessionId; resultText; usage: Usage | null;
      changes: 'changed' | 'unchanged' | 'unknown'; diff?: DiffRef; deployUrl?; links }
  | { status: 'failed';    runnerId; sessionId?; failure: FailureClassification; usage: Usage | null }
  | { status: 'cancelled'; runnerId; sessionId?; usage: Usage | null }
  | { status: 'timedOut';  runnerId; sessionId?; usage: Usage | null; cancelledRunner: boolean }
```
`usage` nullable but present on **every** variant. Landing state lives in `LandingOutcome`, never in `RunResult`.

```ts
type RunOutcome<H extends Handle = RunHandle> = {
  result: RunResult
  landing?: LandingOutcome
  handle: H
}
```
Runner execution and landing are deliberately separate dimensions: an agent run may succeed while landing returns `{ kind: 'failed', ... }`. `run()` returns the outcome rather than throwing for a classified landing failure; transport/programmer errors still throw typed SDK errors.

---

## 6. Key behaviors

### 6.1 Landing — origin-specific, session-aware, resumable (verified against bitballoon + the GH action)
Backend facts: runners don't create result branches (`result_branch` legacy); `commit_to_branch` rejects main and is **not idempotent** (literal FIXME); each follow-up session's commit is tracked on **that session's `commit_sha`** (`agent_runner_session.rb:110`; the commit worker applies each uncommitted session as its own commit) while runner-level `merge_commit_sha` **lingers from earlier sessions**; `create_pull_request` requires `git_host=='github'` + `installation_coding_id` and rejects if `pr_url` exists; `publish_to_production` requires `code_origin=='netlify-git'`; PR/merge-commit steps have atomic in-progress guards.

`land(handle) → { handle, landing }`:
- **`githubPr`** (GitHub origin):
  1. **First landing** (no `pr_url`): `pull_request` member action directly — poll `pr_url`/`pr_is_being_created`/`pr_error`.
  2. **Follow-up landing** (PR exists): `commit` member action; **track completion via the CURRENT session** — `handle.currentSessionId` (and, for `SessionHandle`, the equal `sessionId`) → that session's `commit_sha`. Runner-level `merge_commit_sha` is never used to decide whether *this* session's commit finished. Poll the session's `commit_sha` while reading `merge_commit_error` and `merge_commit_is_being_created` from the runner (the sessions API does not serialize those runner-level fields), then record the session ID in `landing.committedSessionIds`.
  3. **Merge** (`'merge'`, or `'auto'`+token): via `github/mergePr.ts` with `githubToken`, using an expected-head compare-and-swap:
     - Read the PR. If already merged, return `merged`.
     - Wait until the current session's `commit_sha` exists and backend PR/target-sync flags are settled. Then read the live PR `head.sha` and persist it as `landing.expectedPrHeadSha` **before** the merge call. Do not equate the session commit SHA with the PR head: the backend may legitimately merge a newer target branch into the PR branch after PR creation.
     - Call GitHub's merge endpoint with `sha: landing.expectedPrHeadSha`. A head mismatch / GitHub `409` becomes typed `pr-head-changed`; it never retries or merges a newer head implicitly. Keep `422` in the general validation mapping, but do not classify every `422` as head drift.
     - Crash resume reuses the persisted expected SHA; a lost successful response is reconciled by re-reading the PR's merged state.
     - No token → `github-token-required` (or `prOpen` for `'auto'`).
- **`netlifyGitPublish`**: `publish_to_production` (atomic; already-in-progress surfaced as in-flight, re-polled).
- **`unsupported`** (zip/drop): explicit outcome.
- **Resumable:** each step consults live state (`pr_url`, `pr_state`, session `commit_sha`, in-progress flags, GitHub merged-state) and skips completed steps; progress recorded in `handle.landing`; crash-recovery tested (§9).
- Consumers: RE = `'merge'`; nax + GH Action = `'pr'` (GH-action auto-merge = recorded future option).

### 6.2 Retry — capacity/rate-limit/platform-server auto-retry via `shouldRetry` + `retry(handle, { failure })`, bounded by `policy.retryBudget` and the original absolute deadline. `run()` applies the same allowlist in-process. `retry(RunHandle)` copies the semantic start input and creates a replacement runner; `retry(SessionHandle)` copies `sessionInput` and creates a replacement follow-up session on the same runner. Both use the injected exponential-jitter policy, generate a **new requestId for the new logical create attempt**, update the returned handle's effective input/current session, increment the retry counter, persist safe category/code/schedule metadata through `onRetryCheckpoint` before replacement I/O, and **preserve the original `deadlineAt`**. Replacement-run ambiguity is reconciled without resetting the original policy or consumed budget. Reusing a prior request marker across logical attempts is forbidden. A transport replay after a provably-pre-transmission failure remains the same logical attempt and keeps its marker. Auth, validation, argv-too-long, prompt/blob, API-drift, ambiguity/session-conflict, terminal, timeout/cancel, and GitHub head-drift failures never auto-retry.
### 6.3 Idempotency — caller-owned; handle = anchor; ambiguity → §6.7.
### 6.4 Cost/cancel — D11. · 6.5 No-op — D12.
### 6.6 Drift boundary — additive unknown fields ignored (log-once); missing/malformed `runnerId`/`sessionId`(where required)/`state` → typed `invalid-api-shape`.

### 6.7 Ambiguity reconciliation (runner AND session)
The backend has no first-class idempotency/correlation field. Prompt/agent/branch similarity alone is not causal: if our request never arrived while another caller submitted identical input, automatically adopting that run would be incorrect. Until the backend gains a dedicated field, the SDK uses a cryptographically random, server-visible request marker:

```text
<!-- agent-runner-sdk-request-id:<uuid> -->
```

- Before transmitting a runner/session create, the SDK resolves `requestId` (caller-supplied UUID or `crypto.randomUUID()`), appends the reserved marker to the submitted inline prompt or blob-fetch wrapper, and retains the unmarked user prompt plus `requestId` in the effective input. Caller-supplied IDs are format-validated and documented as unique **per logical create attempt**. The marker is metadata, not an instruction; the SDK strips its exact reserved form from normalized titles/results. User text is never trusted as the marker source.
- Post-write ambiguity becomes typed **`create-ambiguous`** / **`session-create-ambiguous`** carrying `{ effectiveInput, window: { sentAt, failedAt } }`. The error may contain the caller's original prompt in memory but telemetry, logs, and `ReconciliationCandidate` never serialize it.
- Reconciliation searches `[sentAt - clockSkewAllowance, failedAt + clockSkewAllowance]`, converting explicitly to the backend's Unix-second `from`/`to` filters. It paginates **all** bounded results; the backend currently sorts by `last_session_created_at`, not `created_at`, so ordering is never used as a correctness condition.
- **`reconcileCreate(effectiveInput, window) → ReconciliationResult<RunHandle>`**: list candidate runners, fetch their initial sessions, and require an exact request-marker match. Prompt/agent/branch/model serve only as defensive consistency checks after the marker matches. One exact match → `matched` with a handle rebuilt from the effective input and original policy; `deadlineAt` is based on the original `sentAt`, never the reconciliation time. Zero → `none`; more than one → `ambiguous` with safe candidate IDs/timestamps.
- **`reconcileSession(handle, effectiveFollowUpInput, window) → ReconciliationResult<SessionHandle>`**: same design over `listSessions(runnerId)`. A `session-already-active` 409 adopts the active session only on exact request-marker match; otherwise the original 409 is surfaced. The returned `SessionHandle` copies the complete base handle and sets `sessionId === currentSessionId`.
- **Phase-0 verify:** `from`/`to` filters, pagination headers, `created_at`, and exact preservation/readability of the request marker in session `prompt` (§11.3).

---

## 7. `BlobStore` contract + prompt-delivery lifecycle (Phase 2)

Prompts > `safeBytes` (default 16 KB, `NAX_SAFE_PROMPT_BYTES`) offload to a blob the runner fetches via a shell fetch-instruction with sentinel verification (`confirmed | failed | probable | suspect`).

`safeBytes` applies to the **final submitted prompt**, including the request-ID marker. The SDK exports `requestMarkerOverheadBytes`; Phase-1 nax adapters subtract that fixed UTF-8 overhead before invoking the existing compact/offload preparation, and Phase-2 SDK delivery reserves it internally. A prompt exactly at the old boundary therefore cannot become an argv regression merely because correlation metadata was added.

```ts
interface BlobRef  {
  store: string
  key: string
  tenant: string
  expiresAt: number                  // Unix epoch milliseconds
}
interface BlobStore {
  put(key: string, bytes: Uint8Array, opts: { ttlSeconds: number; tenant: string }): Promise<BlobRef>
  delete(ref: BlobRef): Promise<void> // full identity prevents cross-store/cross-tenant deletion
  runnerFetchInstruction(ref: BlobRef): { shell: string; sentinel: string }
}
```
- Ships a default **Netlify-Blobs store** (runner-side fetch uses `netlify blobs:get` in-runner); injectable for tests/alternatives.
- Lifecycle (tested): TTL on every put; **delete on terminal-success, cancel, timeout**; **retain-until-TTL on `failed`** so `retry(handle)` can reuse `input.promptRef`; expired ref on retry → typed **`prompt-ref-expired`** (caller re-provides the prompt); tenant-scoped keys (RE keys by site/artifact); fetch authorization = the runner's own site scope; **hard max size** → typed `prompt-too-large` even after compaction; cleanup failure = log + best-effort, never fails the run.
- Until Phase 2, nax's existing prep layer wraps the SDK (D22); RE (Phase-3 consumer) arrives after SDK delivery exists.

---

## 8. Packaging, build & CI

- npm workspaces at the repo root; `packages/agent-runner-sdk`; nax depends on the **published** version (workspace-linked in dev).
- TS source → tsup/tsc → CJS + ESM + `.d.ts`; `engines.node >= 18`; own tsconfig (root excludes `packages/`) with `strict`, `noImplicitAny`, and `useUnknownInCatchVariables` enabled.
- `scripts/check-import-direction.js` extended to scan `packages/` — the SDK imports no `cli`/`dashboard`/heavy deps.
- Tests: node:test via tsx. CI: strict typecheck, tests, a compiled public-API example, `npm pack` smoke (install tarball in a scratch project; import from CJS and ESM), Node 18/20/22 matrix.
- Public docs: package-local README for npm plus the canonical user-facing SDK guide under `site/content/`; both document token precedence, landing modes, handle persistence/versioning, request-marker reconciliation, and failure/result unions. Examples share the compiled source fixture so docs cannot drift from the exported types.
- Releases: manual `npm version <semver> --tag-version-prefix=nax-agent-runner-sdk-v && npm publish` from the package dir. Independent semver; SDK tags cannot collide with nax's root `vX.Y.Z` tags.

---

## 9. Testing + canaries

- **Transport contract tests** — exact snake paths/verbs/bodies for every op + members; `bb-api` variant; paginated list behavior without assuming `created_at` ordering; per-op retry (create-POST never replayed post-write; ambiguity classification; session-409); per-call token; token-precedence characterization (per-call > ctor > env > CLI config); telemetry value-free assertion; token redaction.
- **Engine/Handle tests** — serde round-trip incl. version-stamp migration; deadline (in-process auto-cancel; out-of-band via `deadlineAt`; **preserved across `retry` and reconciliation**); `shouldRetry`/`retry` budget; every retry rotates `requestId` while preserving semantic input/promptRef; `prompt-ref-expired`; full-fidelity `RunHandle → SessionHandle` transition (policy/input/retries/landing preserved; `sessionId === currentSessionId`); SessionHandle attribution; `RunResult` invariants; `RunOutcome` landing propagation.
- **Landing tests** — all strategies from stubbed origin payloads; **first-landing = direct PR**; **follow-up commit tracked via the session's `commit_sha`, explicitly NOT runner-level `merge_commit_sha`** (stale runner-level SHA regression); runner-level `merge_commit_error`/in-progress handling; GitHub merge passes the persisted expected head SHA; a legitimate backend target-branch merge may make PR `head.sha` differ from the session commit and is captured before CAS; subsequent head change / `409` → `pr-head-changed` and no merge; lost merge response + already-merged resume; `github-token-required`; **crash-recovery** between every step; missing-Coding-installation → typed failure.
- **Reconciliation tests** — marker generated before transmission and preserved in the effective input; marker survives inline and blob-wrapper delivery; `create-ambiguous` → `reconcileCreate` (`matched` keeps ORIGINAL policy/deadline; `none`; `ambiguous` exposes safe candidates); identical prompt/agent/branch with a different marker is never adopted, even inside the window; lower/upper clock-skew bounds and all-page traversal; `reconcileSession` incl. 409-adopt-only-on-exact-marker-match.
- **Drift tests** — additive unknown fields tolerated; missing `runnerId`/`state` → `invalid-api-shape`.
- **Failure-taxonomy tests** — ported from the GH action (every core category has a profile; GitHub extension separate) + nax `failure-guidance` signatures folded in.
- **Prompt-delivery/BlobStore lifecycle tests** — inline/compact/blob boundaries at the final decorated `safeBytes` (request-marker overhead included); sentinel verdicts; delete/retain rules; `delete(ref)` preserves store+tenant identity; TTL expiry; tenant isolation; ceiling; cleanup tolerance.
- **Auth characterization tests** — carried over verbatim from the auth-consolidation plan (D21).
- **Canaries (D24):** (a) cheap-frequent: one create (trivial prompt) + immediate cancel, response-shape assert; (b) full-lifecycle, infrequent, **hard credit budget**, on the dedicated `agent-sdk-canary` site/repo (netliclaw / netlify-labs): short real run → terminal → session attribution → usage → diff → PR → **merge with the expected-head SHA** → verify merge → revert/reset the disposable fixture → delete the canary branch. This continuously proves RE's GitHub token scope and merge behavior, not merely PR creation.

---

## 10. Phasing (vertical slices, prove early)

- **Phase 0 — facts + auth core + transport:** §11 verifications; implement the auth-consolidation core in-package (TS, contracts + characterization tests preserved); strict package tsconfig; `Transport` + `httpTransport` + paginated list + per-op retry + ambiguity classification carrying effective inputs/windows + contract tests. **Unblocks RE (`revenue-engine/docs/plans/create-flow-ux.md` §10.5).**
- **Phase 1 — engine + PROVE with nax:** engine ops + full-fidelity Run/Session handles + Handle serde + `result.ts`/`RunOutcome`/reconciliation unions + session-aware resumable `land` (githubPr incl. expected-head merge + unsupported) + marker-based `reconcileCreate`/`reconcileSession` + `runtime.ts`; packaging/CI + compiled public example + package README/canonical `site/content` guide. **Migrate ALL nax runner call-sites** (local-runner, dashboard `netlify-api` transport, preflight) with nax's prompt-prep layer retained around the SDK. Publish `nax-agent-runner-sdk@next`. *(RE needs Phase 0 + this.)*
- **Phase 2 — resilience + delivery:** SDK `prompt-delivery/` + BlobStore (+ default Netlify-Blobs store; nax swaps onto it); `failures/core`; capacity auto-retry; full-lifecycle canary. **Migrate the GH Action** (PR-only).
- **Phase 3 — extensions:** `failures/github`; `recovery`; presenters; `cliTransport`; `netlifyGitPublish`. **Migrate RE's site adapter** (`land:'merge'`).
- **Phase 4 — opportunistic:** netlifactory / orchestrator.

---

## 11. Phase-0 verifications (no open decisions)

1. **Landing fields end-to-end:** origin detection from runner `code_origin` plus site `build_settings.provider` / account-list `site_git_provider` (runner payloads do not serialize `git_host`); PR polling fields; **session `commit_sha` visibility via the sessions API**; runner-level `merge_commit_error` and `merge_commit_is_being_created`.
2. **D23 smoke:** `installation_coding_id` present on a fresh vended netlify-labs repo.
3. **Reconciliation queries:** `GET /agent_runners?site_id=&from=&to=` filters, pagination headers/limits, and exact request-marker preservation/readability through the sessions API. Do not expect `created_at` ordering: backend source sorts `last_session_created_at`.
4. **GitHub merge mechanics:** PR number/repo derivable from the runner and site payloads; merge with the netlify-labs org token on a vended repo while passing the expected head `sha`; verify a mismatched head returns `409` without merging.
5. `file_keys`/attachments — deferred (API accepts; runner FS doesn't materialize them per verified memory).
6. RE AI-usage accounting — separate RE-side plan (persists `usage` to RE's AI-usage entity).

---

## 12. Acceptance

- Stateless engine over serializable, **full-fidelity** handles; `followUp`/`reconcileSession` preserve run policy/input/retries/landing state and set the current session identity; out-of-band orchestration keeps the original deadline.
- Runner/session ambiguity reconciliation is causal: a unique server-visible request marker, bounded clock-skew-aware windows, all-page traversal, and discriminated `matched`/`none`/`ambiguous` results; prompt similarity alone never auto-adopts a run.
- Landing matches the real backend: direct PR creation; follow-up commits tracked per-session (never trusting stale runner-level `merge_commit_sha`); GitHub merge uses an optional token **and the persisted expected head SHA** (head drift fails closed); PR-only without a token; publish for netlify-git; explicit unsupported for zip/drop; never touches main.
- Honest results: `RunOutcome` carries landing outcomes; `usage` on every variant; tri-state `changes`; `invalid-api-shape` on broken identity; env-token contract = `NETLIFY_AUTH_TOKEN` only.
- Fully specified blob lifecycle; per-op retries with create-POSTs never blind-replayed; the auth-consolidation core implemented once, in the SDK; every nax call-site + the GH Action + RE import it; the provisional kebab client is gone.
- The npm README and canonical `site/content` guide ship with typechecked examples and match the published API.
