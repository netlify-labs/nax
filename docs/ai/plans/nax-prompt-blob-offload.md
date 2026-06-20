# Nax Oversized-Prompt Blob Offload Plan

## Summary

Large fan-in workflow steps fail with `fork/exec /opt/build-bin/agent-runner:
argument list too long` (OS `E2BIG`) because the Netlify agent-runner
orchestrator passes the assembled prompt to the runner binary as a command-line
**argv**. When a step forwards prior step results (`input: results: all`), the
prompt grows past the orchestrator's exec limit and the run dies. This is a bug
in `agent-runner-orchestrator` (the prompt should go over stdin/a file, not
argv) — **we cannot fix it on our end.**

What we *can* control is the size of the prompt nax sends. This plan does two
things:

1. **Phase 0 — Fix the existing compaction safety net**, which is currently a
   no-op: the "compact retry" prompt comes out the same size as the full prompt,
   so the one automatic retry resubmits an identically-oversized prompt and
   fails again.
2. **Phase 1+2 — Add a "pass by reference" escape hatch:** when a prompt would
   exceed a safe size, nax stashes the bulky prior-results in a **Netlify Blob**
   and rewrites the prompt to keep bounded essentials inline plus a
   full-path `/opt/buildhome/node-deps/node_modules/.bin/netlify blobs:get`
   fetch instruction for the full detail. The scoped runner
   token can read the blob (verified end-to-end). The prompt stays tiny; argv
   never blows up.

This is explicitly a **temporary band-aid for a Netlify platform limitation**,
not the desired long-term architecture. The correct platform fix is for the
Netlify agent-runner/orchestrator path to stop passing large prompts through
argv and instead accept prompt/context via stdin, a mounted file, a first-class
context artifact, or a platform-native blob/reference mechanism. Until that
exists, nax has to work around the limit client-side so user workflows do not
fail.

The blob path is the reliability layer for arbitrary-size flows. Compaction,
structured-only forwarding, and summarize-before-fan-in remain valuable because
they keep the common case cheap and readable, but they are not sufficient as the
hard guarantee. The invariant after this plan: **nax never submits a prompt
larger than `NAX_SAFE_PROMPT_BYTES`; if it cannot make the prompt fit, it fails
before submission with a clear size/error report.**

The blob is **usually non-load-bearing** (hybrid design): bounded essentials stay
inline, so many synthesis steps can still produce a reasonable result if the
agent ignores the fetch instruction. For flows whose useful prior context cannot
be reduced to safe inline essentials, the blob is load-bearing and marker
verification must enforce that the agent fetched it.

---

## Why This Matters

### The failure, concretely

Run `2026-06-19T21-44-31-098Z-ideas` (the `ideas` flow) was interrupted because
step 4 **Synthesize Ideas** (codex) failed **both attempts** with:

```text
fork/exec /opt/build-bin/agent-runner: argument list too long
```

Anatomy of that prompt (`workflow.json` → synthesize run):

- `promptText`: **45,075 chars**
  - ~7,146 chars of instructions + additional context
  - ~37,929 chars of forwarded `## Prior Agent Results` (6 inlined agent outputs:
    ideate ×3, cross-score ×3 — full prose: Architecture Reports, Reality Check
    tables, rationale, Structured Ideas blocks)
- `compactPromptText`: **45,075 chars** — *identical to the full prompt*
- `promptShrinkRetryCount: 1` — the arg-limit retry fired but resubmitted the
  same-size prompt → second `E2BIG`.

**45KB is small.** Linux `ARG_MAX` is typically ~2 MB, so the orchestrator is
tripping `E2BIG` far below `ARG_MAX` — it is packing the prompt into a
constrained exec (likely alongside env/other argv). The practical takeaway:
**we must send substantially less, and we cannot assume a generous limit.**

### Why the existing safety net does nothing

The local transport already builds a `compactPromptText` per run and the runner
retries once with it on an arg-limit error (`src/local-runner.js:847`). But:

- The compaction budget is `COMPACT_LOCAL_RESULTS_TOTAL_LIMIT = 36000` (results)
  + `COMPACT_LOCAL_CONTEXT_CHAR_LIMIT = 12000` (context) + base prompt, i.e. a
  *ceiling* of ~48KB+ — **larger than the 45KB prompt that already fails.** So
  compaction has nothing to trim and `compactPromptText === promptText`.
- `compactPromptForArgumentLimitRetry()` (`src/local-runner.js:424-428`)
  explicitly returns `''` when `compactPromptText.length >= promptText.length`,
  so the retry-with-compact path is a no-op precisely when it's needed most.

This is a latent correctness bug independent of blobs and worth fixing first.

---

## Current Facts (verified)

### Transport / token scope

- The hosted agent runner's `NETLIFY_AUTH_TOKEN` / `NETLIFY_API_TOKEN` is **not**
  a user PAT. It is a server-side-minted, **scoped Doorkeeper OAuth token whose
  `resource_owner` is the DevServer** (bitballoon
  `app/models/doorkeeper/access_token.rb:186` `create_dev_server_token!`; injected
  via `app/models/dev_server.rb:814-816`, `:947`, `:981-982`; env-var mapping
  happens in the external compute orchestrator).
- Scope list (`DEV_SERVER_SCOPES`) includes `blob:read`, `blob:update`,
  `blob:destroy` (not `blob:put`/`blob:get`, which belong to a different
  build-bot token). The token is bound to the DevServer's `site_id`/`account_id`
  by the API layer, has no hard TTL but is only valid while the DevServer is
  active/stopping.
- **Local** path (`agent-runner-orchestrator/src/bin-local.ts:82`) instead
  requires a user-generated PAT (full account scope). Different path; not what
  the hosted Netlify-API transport uses.

### Blob access — proven end to end

In real agent run `6a35d4c334af39f4e3db27a7`, all three commands succeeded
**inside the pod** with the scoped token:

```bash
# CLI lives at /opt/buildhome/node-deps/node_modules/.bin/netlify
NETLIFY_SITE_ID="$SITE_ID" netlify blobs:set  test-store foo "dummy data" --auth "$NETLIFY_AUTH_TOKEN"
NETLIFY_SITE_ID="$SITE_ID" netlify blobs:get  test-store foo            --auth "$NETLIFY_AUTH_TOKEN"
NETLIFY_SITE_ID="$SITE_ID" netlify blobs:list test-store                --auth "$NETLIFY_AUTH_TOKEN"
```

So the runner can `set`, `get`, and `list` blobs. The `blob:read`-vs-`blob:get`
scope-naming ambiguity is moot in practice.

### Secret safety

The pod exposes the token as the env var `$NETLIFY_AUTH_TOKEN` and the site id as
`$SITE_ID`. The prompt we write references the **literal strings**
`$NETLIFY_AUTH_TOKEN` / `$SITE_ID`; the agent's shell expands them at runtime.
**The secret value never appears in our prompt text or `.nax/` artifacts.**

### Relevant code map

| Concern | Location |
|---|---|
| Compaction constants | `bin/nax.js:113-115` |
| `formatLocalRunResults` (full block) | `bin/nax.js:3280` |
| `formatCompactLocalRunResults` | `bin/nax.js:3314` |
| `compactTextForRetry` | `bin/nax.js:3301` |
| `buildLocalAgentPrompt` | `bin/nax.js:3352` |
| `buildCompactLocalPromptForRetry` | `bin/nax.js:3376` |
| Step assembly (sourceRuns → runs) | `bin/nax.js:5101-5145` |
| Local terminal-run hook | `bin/nax.js:5025`, `:5534` (`onTerminalRun`) |
| Arg-limit retry | `src/local-runner.js:420-428`, `:833-857` |
| Structured-block extraction | `src/round-results.js:157` `extractStructuredSection`, `:224` `renderReplyBody` |
| netlify CLI spawn precedent | `src/transports.js:46` (`spawnSync('netlify', ...)`) |
| Fan-in flow example | `src/flows/ideas/flow.yml` (`input: results: all`) |

There is currently **no `nax clean` command** — blob lifecycle cleanup needs a
new hook.

---

## Goals / Non-Goals

### Goals

1. A fan-in prompt that would exceed a safe argv size never gets submitted at
   that size — it is either compacted below the safe byte budget or offloaded to
   a blob before submission.
2. The arg-limit retry actually produces a smaller prompt (fix the no-op).
3. Offloaded context is reachable by the agent in-pod and the blob is
   non-load-bearing when bounded essentials are sufficient.
4. We can *detect* weak evidence that an agent ignored the fetch instruction,
   classify confidence, and escalate according to cost-aware policy.
5. Blob set/get/delete calls have bounded retry behavior so transient Netlify or
   network failures do not kill a flow immediately.
6. Blobs created for a run are cleaned up at flow completion; crash leftovers are
   sweepable from a local registry.
7. The feature degrades gracefully and falls back through a defined chain.
8. The workaround stays isolated enough that it can be removed or simplified
   once the Netlify platform supports large prompt/context delivery natively.

### Non-Goals

- Fixing the orchestrator's argv exec (not ours).
- Treating blob offload as the permanent ideal architecture. It is a pragmatic
  temporary compatibility layer for the current Netlify runner limitation.
- GitHub Actions transport (this path is the Netlify-API/local transport;
  GHA has its own size handling — out of scope here).
- A general blob-backed prompt cache or cross-run context store.
- Changing flow-authoring semantics of `input:` / `results: all`.

---

## Design Overview

### Submission invariant and escalation chain

For each runner prompt, decide how to deliver oversized content by size. Fan-in
steps prefer prior-result offload so bounded essentials remain inline; first
steps or oversized base prompts fall back to full-prompt offload. The invariant
is stricter than "retry after E2BIG": **never submit a prompt whose UTF-8 byte
length is greater than `NAX_SAFE_PROMPT_BYTES`.**

```
assemble full prompt
        │
        ├─ full bytes ≤ SAFE_PROMPT_BYTES ───────► send inline (today's behavior)
        │
        ├─ fan-in prompt unsafe ─────────────────► PRIOR-RESULT BLOB OFFLOAD
        │                                          ├─ inline: bounded essentials
        │                                          ├─ blob:   full prior prose
        │                                          └─ prompt: fetch instruction + marker
        │
        ├─ base/full prompt still unsafe ────────► FULL-PROMPT BLOB OFFLOAD
        │                                          ├─ blob:   complete prompt
        │                                          └─ prompt: small fetch wrapper + marker
        │
        ├─ compact bytes ≤ SAFE_PROMPT_BYTES ────► send compacted inline (Phase 0 fallback)
        │
        └─ otherwise ───────────────────────────► fail before submit
                                                   │
                                                   └─ blobs:set fails after retries
                                                        ├─ compact still fits ─► compacted inline
                                                        └─ compact too large ─► fail before submit
```

All thresholds are **byte**-based (UTF-8), not char-based, and conservative,
because the real orchestrator limit is unknown and demonstrably < 45KB.

This makes the four known approaches complementary:

- **Lower compaction ceiling:** fixes today's no-op retry.
- **Proactive compaction:** avoids paying for a doomed first submission.
- **Structured/bounded forwarding:** gives agents useful inline essentials.
- **Blob offload:** handles the unbounded case and is the only current path that
  can support arbitrarily large fan-in context.

### Temporary workaround boundary

Keep the workaround behind small, named APIs (`src/netlify-blobs.js`, prompt
offload decision helpers, and cleanup helpers) rather than spreading blob
details through every workflow path. The intended future migration is:

1. Netlify platform adds native large-context delivery for agent runs.
2. nax switches the offload adapter to that native mechanism, or deletes the
   adapter if prompts can be submitted directly without argv limits.
3. Existing flow semantics remain unchanged; only the transport implementation
   changes.

This boundary matters because the blob path exists to preserve reliability while
the platform is constrained. It should not become an accidental permanent
workflow contract unless Netlify formalizes that contract.

### Hybrid offload (chosen design)

```
PROMPT (inline, small):
  <step instructions>
  ## Prior Agent Results (essentials)
  <bounded essentials per agent: structured JSON when available, otherwise a
   compact head/tail summary with metadata and a pointer to the blob>

  ## Full detail (optional, recommended)
  Before doing anything else, run:
    NETLIFY_SITE_ID="${NETLIFY_SITE_ID:-$SITE_ID}" /opt/buildhome/node-deps/node_modules/.bin/netlify blobs:get nax-<runId> <stepId>-prior-results --auth "$NETLIFY_AUTH_TOKEN"
  It returns the full prior-round prose. Read it, then echo the line
  "NAX-CONTEXT-LOADED <marker>" and proceed.

BLOB (nax-<runId> / <stepId>-prior-results):
  ## Prior Agent Results
  <full formatLocalRunResults() prose — the ~38KB block>
```

If the structured block is missing for a given agent, do **not** rely only on
`renderReplyBody(... structuredOnly)`, because many flows do not define a
structured JSON section. Use a generic bounded essentials builder:

1. Prefer `renderReplyBody(run.resultText, { structuredOnly: true })` when it
   returns a real structured section.
2. Otherwise include the run metadata, source step, agent, result byte count, and
   a compact head/tail excerpt within a per-run budget.
3. If even the excerpt cannot fit, include only metadata plus "full report is in
   the blob" so the prompt still remains well-formed.

---

## Detailed Design

### Phase 0 — Fix the compaction no-op

**Problem:** compaction ceiling (~48KB) > failing prompt (45KB), so compact ==
full and the retry is a no-op.

**Changes:**

1. Introduce a single byte-based budget, e.g. `SAFE_PROMPT_BYTES` (default
   conservative, see Configuration). Derive the compaction targets from it so
   the compact prompt is *guaranteed* meaningfully smaller than a prompt that
   tripped the limit — target the compact prompt at ≤ `SAFE_PROMPT_BYTES`
   (e.g. ~16–20KB), not 48KB.
2. Make `formatCompactLocalRunResults` budget-aware end to end: results +
   context + base must fit the target; if not, trim results first, then context.
3. Keep `compactPromptForArgumentLimitRetry`'s guard, but it will now reliably
   return a smaller prompt because the budget is below the failure point.

**Test (red→green):** build a fan-in step whose full prompt exceeds the limit;
assert `compactPromptText` bytes `< promptText` bytes **and** `compactPromptText`
bytes `≤ SAFE_PROMPT_BYTES`. (Today this fails: both are 45,075.)

This phase ships value with zero dependency on blobs.

### Phase 1 — Blob offload core (hybrid)

#### 1a. Cross-process round-trip probe (do this first — de-risks everything)

The verified probe did `set` **and** `get` in the *same* run. The real flow is
**nax (local, full PAT) writes → a different agent run (pod, scoped token)
reads** — different principals, same site, same named store. Netlify named
stores are site-global and persistent, so this *should* work, but it is a
different path than what's proven.

**Probe:** nax writes a known blob locally; spawn a throwaway one-shot agent run
whose prompt is only "run `/opt/buildhome/node-deps/node_modules/.bin/netlify blobs:get …` and echo the value + a marker";
confirm the value comes back. Green light → proceed. If it 403s or returns
empty, stop and rethink (store scoping / principal mismatch).

#### 1b. Blob I/O module — `src/netlify-blobs.js`

Thin `spawnSync` wrappers around the netlify CLI (mirrors
`src/transports.js:46`). Two-line file header comment per repo rules.

```
setBlob({ store, key, value, siteId, token, cliPath })  // temp file + netlify blobs:set <store> <key> --input <path>
getBlob({ store, key, siteId, token, cliPath })         // for the probe / tests
deleteBlob({ store, key, siteId, token, cliPath })      // cleanup
```

- Write `value` to a temporary file and call `netlify blobs:set <store> <key>
  --input <path> --auth <token>`. The local CLI supports `--input`; do not place
  blob payloads in argv.
- Delete the temporary file in `finally`, including failed upload attempts.
- Auth from the local `NETLIFY_AUTH_TOKEN` (full PAT) and `NETLIFY_SITE_ID`.
- Unit tests assert argv construction and error mapping with a fake `runCommand`
  (no live API). Real API is exercised only by the 1a probe and an opt-in e2e.

#### 1b-2. Smart retries for blob operations

Blob writes/deletes are control-plane operations on the critical path. They need
the same kind of bounded retry behavior as other Netlify submissions so a 429,
5xx, timeout, connection reset, or short-lived CLI/API failure does not kill a
multi-step flow.

Add a shared retry helper for blob CLI calls:

- Default attempts: 3.
- Backoff: exponential with jitter, e.g. 750ms, 1500ms, 3000ms plus jitter.
- Retryable failures: process timeout, `ETIMEDOUT`, `ECONNRESET`,
  `ECONNREFUSED`, `EAI_AGAIN`, HTTP 408/409/425/429/500/502/503/504 in stderr or
  parsed CLI output.
- Non-retryable failures: auth/scope errors, missing site, invalid store/key,
  malformed command, and 4xx responses other than the retryable list.
- Log retry attempts with store/key/operation and sanitized errors; never log
  token values or blob payloads.
- Preserve final failure detail in the thrown error so the fallback chain can
  explain why offload failed.

`setBlob` must retry before falling back to compacted inline. `deleteBlob` should
retry too, but deletion failure is best-effort and should be recorded for later
sweeping rather than failing the flow. `getBlob` uses the same helper for the
cross-process probe and opt-in e2e tests.

#### 1c. Store / key naming

- Store: `nax-<runId>` (one logical store namespace per run; cleanup deletes the
  registered keys in that store).
- Key: `<stepId>-prior-results` (one payload per fan-in step; all agents in a
  step share the same prior-results).
- Both are deterministic so a resumed run reuses/overwrites rather than
  duplicating.

#### 1d. Prompt assembly — offload path

In step assembly (`bin/nax.js:5101-5145`), after computing `sourceRuns` and the
full `roundResults`:

1. Build the full prompt and measure UTF-8 bytes.
2. If full prompt bytes `<= NAX_SAFE_PROMPT_BYTES`, send inline.
3. Build the compact prompt and measure UTF-8 bytes as a fallback/retry artifact.
4. If the full prompt is unsafe and the step has prior fan-in results, offload
   before the first submit. Do not prefer lossy compacted inline over offload for
   ordinary fan-in, because the blob is the only current path that preserves the
   complete prior prose while staying under the argv limit.
5. Prior-results offload path:
   - `inlineEssentials` = bounded essentials per run, wrapped in the existing
     `<details><summary>Agent from step</summary>` shape.
   - `blobPayload` = full `formatLocalRunResults(sourceRuns)`.
   - Prepend a deterministic blob-only sentinel to `blobPayload`, e.g.
     `NAX-BLOB-SENTINEL <sentinel>`. The sentinel must not appear in inline
     essentials, so its presence in the final reply is stronger evidence that
     the agent actually read the blob.
   - `setBlob({ store: 'nax-'+runId, key: stepId+'-prior-results', value: blobPayload, ... })`
     with smart retries.
   - `roundResults` for the prompt = `inlineEssentials` + the fetch-instruction
     block (see 1e).
   - Persist a `blobRefs` entry on `stepState`/`runState` for cleanup and resume.
   - If `setBlob` throws after retries, or blob offload is explicitly disabled,
     fall back to compacted inline only if the compacted prompt is within
     `NAX_SAFE_PROMPT_BYTES`; otherwise hard-fail before submission with
     full/compact/offload sizes and sanitized blob error text.
6. If there are no prior results, or the prior-results offloaded prompt still
   exceeds `NAX_SAFE_PROMPT_BYTES` because the base prompt/context is too large,
   offload the complete prompt instead:
   - `blobPayload` = full `promptText` with the deterministic blob-only sentinel
     prepended.
   - `key` = per-agent full prompt key, e.g. `stepId-agent-full-prompt`, so
     multi-agent first steps cannot reuse the wrong model-specific prompt.
   - Submitted prompt = small fetch wrapper that tells the agent to read the
     blob as its complete prompt before doing any other work.
7. Build `promptText` with `buildLocalAgentPrompt` as today. Assert final prompt
   bytes `<= NAX_SAFE_PROMPT_BYTES` before storing/submitting the run.

Keep `compactPromptText` as the next fallback rung even on the offload path.

#### 1e. Fetch-instruction template

A single source-controlled template (a prompt fragment) so wording is
consistent and testable. Uses the exact, proven invocation:

```text
## Prior round context (full detail)

Before you do anything else, fetch the full prior-round results for this run:

    NETLIFY_SITE_ID="${NETLIFY_SITE_ID:-$SITE_ID}" /opt/buildhome/node-deps/node_modules/.bin/netlify blobs:get nax-<runId> <stepId>-prior-results --auth "$NETLIFY_AUTH_TOKEN"

Read the returned Markdown, then echo the context marker and the NAX-BLOB-SENTINEL
line from the top of the blob so we know you loaded it:

    NAX-CONTEXT-LOADED <marker>
    NAX-BLOB-SENTINEL <the exact sentinel value from the blob>

The inline "essentials" above are a summary; the blob has the complete prose.
```

- `<marker>` is a short per-step random-ish token (derive from runId+stepId so
  it's deterministic and verifiable, not `Math.random`).
- `<sentinel>` is deterministic per offloaded payload and is written only inside
  the blob, not in the inline prompt. The prompt must not reveal the sentinel
  value; it only asks the agent to echo the sentinel line after fetching the blob.
- Literal `$SITE_ID` / `$NETLIFY_AUTH_TOKEN` — never interpolated by nax.

### Phase 2 — Lifecycle, verification, fallback

#### 2a. Context fetch verification

When parsing an agent reply for a step that was offloaded, treat
`NAX-CONTEXT-LOADED <marker>` as a **weak signal**, not proof. Agents can fetch
and read the blob correctly but forget to echo the marker, and synthesize-class
reruns are expensive. Do not automatically rerun based only on a missing marker.

Instead compute a fetch-confidence status:

- `confirmed`: reply includes `NAX-CONTEXT-LOADED <marker>` and/or the
  blob-only `NAX-BLOB-SENTINEL <sentinel>`.
- `probable`: marker/sentinel missing, but the answer references blob-only
  details or otherwise demonstrates it used context beyond the inline
  essentials.
- `suspect`: marker/sentinel missing and the answer appears context-starved
  (generic, asks for missing context, only restates inline essentials, or lacks
  expected synthesis across offloaded prior results).
- `failed`: explicit blob fetch/auth/read error appears in the agent reply.

Persist `contextFetchStatus`, `contextFetchSignals`, and
`contextFetchConfirmed: status === "confirmed" || status === "probable"` on the
run. Surface `suspect`/`failed` states in the run summary and visualize UI so a
quietly-under-informed synthesis is visible rather than silent.

Add an explicit context policy on each offloaded run:

- `contextFetchPolicy: "optional"` when bounded inline essentials are believed
  sufficient for a useful answer. Missing marker/sentinel records a visible
  warning only unless the status is `failed`.
- `contextFetchPolicy: "required"` when the compacted/essential prompt is only a
  pointer and the full blob content is load-bearing. Required mode does **not**
  rerun on a marker false negative alone. The first implementation records
  `suspect`/`failed` as visible run metadata and requires manual retry/review;
  automatic rerun can be added later only behind an explicit opt-in and only for
  `suspect` or `failed`, never for "marker missing" by itself.

The default can be `"optional"` for the current ideas-style structured flows,
but arbitrary-size support requires `"required"` mode for steps where bounded
essentials are not enough.

#### 2b. Cleanup

- Persist every offloaded blob in a local registry. `runState.blobRefs` is the
  source of truth, mirrored into a small `.nax/blob-refs.jsonl` append-only
  registry so cleanup can recover after crashes or interrupted runs.
- `blobRefs` shape:
  `{ runId, stepId, store, key, marker, createdAt, status, cleanupAttempts,
  lastCleanupError }`.
- On terminal **flow** completion, after all artifacts are persisted, delete all
  blob refs for that run with retrying `deleteBlob`. This should run once per
  flow rather than after the first terminal agent result, because later runs in
  the same step may still need the shared prior-results blob.
- On interrupted/failed flows, attempt best-effort cleanup for blobs that are no
  longer needed by any pending/submitted run; otherwise leave refs marked
  `pending-cleanup`.
- Cleanup failures do not fail the workflow result. They are logged, persisted
  on the ref, and shown in summaries as operational warnings.
- Add an orphan sweep: a `nax clean blobs` subcommand (or minimally a
  `--clean-blobs` path on the next run start) that reads the local registry,
  deletes refs whose run is terminal/absent or older than a TTL, and marks refs
  cleaned. Do not depend on listing all `nax-*` stores; the CLI lists keys within
  a known store, not stores globally.

#### 2c. Fallback chain (explicit)

`inline if safe → blob offload for unsafe fan-in with retrying setBlob → if blob
is disabled/unavailable, compacted inline only if still safe → hard fail before
submit with a clear message naming the step, full bytes, compact bytes, safe byte
budget, blob store/key, and sanitized offload error.` Never silently truncate
without logging what was dropped.

---

## Data Flow

```
nax (local, full PAT)                    Netlify Blobs            agent runner pod (scoped token)
─────────────────────                    ─────────────           ──────────────────────────────
assemble fan-in prompt
  │
  ├─ final prompt would exceed safe byte budget?
  │      │ yes
  │      ├─ blobs:set nax-<run>/<step> with retries ──►  [stored]
  │      ├─ persist blob ref registry
  │      └─ prompt = essentials + fetch-instruction + marker
  │
  └─ submit run (small prompt) ───────────────────────────────►  exec agent-runner (argv OK)
                                                                    │
                                          [read] ◄─ blobs:get ──────┤ FIRST: fetch full detail
                                                                    │ echo marker + blob-only sentinel
                                                                    └─ produce synthesis
  parse reply ◄───────────────────────────────────────────────────┘
  classify context confidence; warn/manual retry/optional rerun according to policy
on flow terminal: retrying blobs:delete for registered refs ──►  [removed]
```

---

## Security Considerations

- **No secret in artifacts:** prompt carries literal `$NETLIFY_AUTH_TOKEN`,
  expanded only in-pod. Verified pattern.
- **Token scope:** the in-pod token is DevServer-scoped, not a user PAT — blast
  radius is the run's site/account, which is already the case for every agent
  run. Offload introduces no new credential exposure.
- **Blob content is run context, not secrets:** prior agent prose. Same
  sensitivity as the `.nax/` artifacts already written to disk. Still, scope the
  store to the run and delete at flow completion so it doesn't linger.
- **Local write path:** use `blobs:set --input <tempfile>` so a huge payload
  never appears on the local argv either.
- **Retry logging:** blob retry logs must include operation/store/key/attempt and
  sanitized errors only. Never print tokens or blob payload excerpts.

---

## Configuration

| Name | Default | Meaning |
|---|---|---|
| `NAX_SAFE_PROMPT_BYTES` | conservative (e.g. 16384) | Target max bytes for a submitted prompt; drives compaction + offload thresholds |
| `NAX_PROMPT_BLOB_DISABLE` | unset | Escape hatch to disable offload (fall back to compaction only) |
| `NAX_BLOB_RETRY_ATTEMPTS` | `3` | Attempts for blob set/get/delete control-plane calls |
| `NAX_BLOB_CLEANUP_TTL_HOURS` | `24` | Age after which registry refs are eligible for orphan cleanup |

Exact defaults to be tuned against real runs; start low and raise only with
evidence, given the observed sub-45KB failure.

---

## Testing Strategy (TDD, `node --test` per repo)

1. **Phase 0 (unit):** oversized fan-in → `compactPromptText` bytes `<`
   `promptText` bytes and `≤ NAX_SAFE_PROMPT_BYTES`. (Currently fails.)
2. **Blob module (unit):** `setBlob/getBlob/deleteBlob` build correct argv with
   `--input <tempfile>` for writes; temp file is removed; error from `runCommand`
   maps to a thrown sanitized error.
3. **Blob retry (unit):** retryable failures are retried with bounded attempts;
   auth/validation failures are not retried; delete failures are persisted for
   sweep without failing the flow.
4. **Offload decision (unit):** below threshold → inline unchanged; unsafe fan-in
   → prompt contains essentials + fetch instruction + marker, and `setBlob` uses
   deterministic store/key; full prose absent from the submitted prompt. Unsafe
   first-step/base prompt with no prior results → prompt contains only the small
   full-prompt fetch wrapper, uses a per-agent full-prompt key, and excludes the
   full prompt body. Blob disabled/failing falls back to compact only when compact
   is still within the safe byte budget.
5. **Essentials extraction (unit):** with/without a structured block, inline
   section is well-formed and bounded (uses real `renderReplyBody`, no mocks).
6. **Fallback (unit):** `setBlob` throws after retries → prompt falls back to
   compacted inline only if it is under `NAX_SAFE_PROMPT_BYTES`; otherwise fails
   before submission with sizes.
7. **Context fetch verification (unit):** marker/sentinel present → `confirmed`;
   missing marker but blob-only details present → `probable`; generic output →
   `suspect`; explicit blob error → `failed`. Missing marker alone must not
   trigger rerun.
8. **Required-policy guard (unit):** required policy plus `suspect`/`failed`
   marks the run for manual review by default. Missing marker alone must never
   force an automatic rerun.
9. **Cross-process round-trip (e2e, opt-in, real API):** nax writes a blob with
   a sentinel → a real one-shot agent run reads it back and echoes marker +
   sentinel. This is the gating proof for Phase 1; no mocks (repo rule).
10. **Cleanup (unit + e2e):** flow terminal completion deletes recorded blob refs;
   interrupted runs leave pending-cleanup refs; orphan sweep removes stale refs
   from the local registry.

Test output must stay pristine; capture and assert any intentional error output.

---

## Open Questions / Residual Risks

1. **Cross-process read (HIGH, gating):** proven only same-run. Phase 1a probe
   resolves it before any wiring. If it fails, the whole approach is blocked and
   we fall back to Phase 0 + aggressive structured-only forwarding.
2. **What exactly is the orchestrator's exec limit?** Unknown; <45KB observed.
   We pick a conservative `SAFE_PROMPT_BYTES` and can tune. Worth a one-off
   bisection probe (submit increasing prompt sizes) to find the real ceiling.
3. **Agent compliance with the fetch instruction:** mitigated by hybrid (inline
   essentials), marker/sentinel signals, and context-starvation classification,
   but not eliminated. Optional mode makes weak evidence visible; required mode
   does not burn credits on marker false negatives unless auto-rerun is
   explicitly enabled and the result is `suspect`/`failed`.
4. **Blob operation transient failures:** mitigated by smart retries and by
   falling back to safe compacted inline only when that prompt is under budget.
   Persistent blob write failure plus oversized compact prompt is a hard
   pre-submit failure.
5. **Cleanup after crashes:** terminal flow cleanup handles normal completion;
   `.nax/blob-refs.jsonl` plus `nax clean blobs` handles interrupted runs and
   local process crashes.
6. **`blobs:set` value delivery:** local CLI supports `--input <path>`; use that
   path rather than argv payloads.
7. **Missing `react` results in the example run:** the failed synthesize prompt
   contained only 6 of 9 expected forwarded blocks (react's 3 absent). Possibly
   a separate truncation/ordering bug in fan-in assembly — investigate
   independently; not blocking this plan but noted.
8. **Resume semantics:** deterministic store/key means a resumed run overwrites
   its blob safely; verify resume doesn't delete a blob a later step still needs.

---

## Task Breakdown (dependency-ordered)

```
T0  Phase-0 compaction fix + test                         (no deps)        ── ships standalone value
T1  Cross-process blob round-trip probe (1a)              (no deps)        ── GATES T5+
T2  src/netlify-blobs.js using --input tempfiles           (no deps)
T3  Smart retry helper for blob set/get/delete             (T2)
T4  Safe-budget prompt policy + generic essentials builder (T0)
T5  Offload decision + prompt rewrite (essentials+fetch)  (T1, T3, T4)
T6  Fetch-instruction template + marker generation        (T5)
T7  Fallback chain wiring (setBlob fail → safe compact)   (T0, T5)
T8  Context confidence classifier + optional/required policy (T6)
T9  Flow-terminal cleanup + blobRefs registry persistence (T5)
T10 Orphan sweep (nax clean blobs slice)                  (T9)
T11 e2e round-trip + cleanup tests (real API, opt-in)     (T5, T9)
T12 Tune thresholds against real ideas-flow run           (all)
```

Critical path: **T1 → T5 → T6 → T8**. T0 and T2 parallelize immediately. Do not
build T5+ until T1 is green.

---

## Next Step (planning-workflow)

This is the revised plan. Per the planning workflow, the next step is an
extended-reasoning review pass (GPT Pro / cross-model) before converting to
beads:

> Carefully review this entire plan … propose revisions for better
> architecture, robustness, performance, and usefulness, with rationale and
> git-diff-style changes.

Then integrate revisions in-place, and convert the task breakdown into a beads
graph (see `beads-workflow`) with the dependencies above.
