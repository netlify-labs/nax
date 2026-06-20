# Nax Tier 1 + Tier 2 Plan — Blob Offload, Flow Validator, Branch Truth Contract

> Status: DRAFT for review (planning-workflow). Three workstreams, dependency-ordered.
> Grounded against the actual code as of this branch; all file:line refs verified by exploration.

---

## Executive Summary

Three improvements, sequenced so each makes the next safe to build:

- **A — Prompt blob offload** (fix E2BIG argv-too-long on large fan-ins). **Already ~90% implemented and wired.** Remaining work is *prove + harden + finish*, not build.
- **B — Semantic flow validator** (fail fast before burning credits on malformed flows). Net-new, small, clean insertion point identified.
- **C — Branch Truth Contract** (one immutable resolved target threaded everywhere). Net-new, highest surface area, contains one *active* correctness hole (GitHub transport passes no ref).

The original ranking assumed A was the urgent fire and C was latent risk. Exploration changes that picture in two ways:

1. **A is much further along than believed** — so "Tier 1" for A collapses to: lock the hosted-runner blob proof into a repeatable probe, then close ~4 hardening seams.
2. **C is not purely latent** — the GitHub Actions transport records a `branch` it never actually forwards to the runner checkout, so recorded branch and reviewed code can silently disagree today. That's a live bug, not just future-proofing.

### Revised order

1. **A.0 — Lock the hosted-runner blob round-trip probe** (turn the manually verified blob-read contract into repeatable coverage).
2. **A.1 — Close blob hardening seams** (token guard, retry interaction, SIGINT cleanup, Phase-0 verification).
3. **B — Flow validator** (cheap, prerequisite gate for any future branching keys).
4. **C — Branch Truth Contract** (biggest; lands on a validated, offload-stable `workflow.json`).

---

## Open Decisions (need David)

These materially change scope — flagging before deep implementation.

### D1. The blob feature was built *ahead of* its own repeatable gating probe. Accept or re-gate?

The existing plan (`docs/ai/plans/nax-prompt-blob-offload.md`) declares task **T1 (cross-process round-trip probe) GATES T5+** and says "Do not build T5+ until T1 is green." But T5+ (offload decision, prompt rewrite, classification, cleanup) **is already built and wired** — `prepareLocalPromptDelivery` at `bin/nax.js:3849`, submission swap at `bin/nax.js:5854/5873/5934`. The underlying runner blob-read contract is now manually verified, but the probe (`tests/integration/blob-roundtrip-probe.test.js`) is still skipped-by-default and not yet a repeatable CI/release gate.

So we're in the exact state the plan warned against: dependent code shipped before the repeatable gate. **Decision:** runner blob access has now been manually verified, so A.0 is no longer a feasibility blocker. The remaining gate is to make that proof repeatable: run or automate the probe before declaring A done, and treat any future 403 / empty / principal mismatch as a release blocker.

### D2. Branch Truth Contract — does it cover the GitHub transport, or just record-and-warn?

The GitHub transport (`createIssue` at `bin/nax.js:710`, `executeGithubFlow` at `bin/nax.js:5523`) passes **no ref at all** — submission is `gh issue create` with title/body/labels. The Actions checkout target is implicit (whatever `agent-runner-action` checks out). The branch reaches the agent only as *prompt text* via `buildAutomaticContext`. So `runState.branch` and the actually-reviewed code can diverge with no error.

Truly fixing this means making the Actions side accept a ref (e.g. `workflow_dispatch --ref` or a dispatch path), which likely touches `netlify-labs/agent-runner-action` — **outside this repo.** Options:

- **(a) Record-and-warn (recommended, fits "fail closed"):** the contract records the GHA target as `sourceType: "github-actions-implicit"`, marks the SHA `unverified`, and warns loudly that the operated-on code is whatever Actions checks out. No false confidence.
- **(b) Full fix:** add a dispatch-with-ref path. Bigger, cross-repo, probably its own plan.

I recommend (a) now, (b) as a follow-up. Confirm.

### D3. Flow validator placement — single point or two-layer?

Agent resolution only makes sense *after* model selection (`prepareInteractiveFlowRun`), but prompt/input/submit checks can live in `normalizeFlow` next to the existing throws. Recommended: **two-layer** — structural checks in `normalizeFlow` (`src/flows.js:167`), selection/agent checks at the post-prepare seam (`bin/nax.js:~6502`). Confirm vs. a single validator at `6502`.

### D4. Validator hard-fail vs. warn?

Should an unknown `submit`/`action` value or a missing `input.step` reference **throw** (block the run) or **warn**? I recommend throw for structural errors (missing prompt file, bad `input.step`, invalid `submit`/`action`) since they're unambiguous bugs, and warn for soft concerns. Confirm.

---

## Workstream A — Prompt Blob Offload: Prove + Harden + Finish

### Current state (verified, not assumed)

All four new modules are **complete, tested, and wired into the live submission path**:

| Module | Role | State |
|---|---|---|
| `src/netlify-blobs.js` | `setBlob/getBlob/deleteBlob` via `netlify` CLI, `--input` tempfile, bounded retry + jitter, token redaction | complete, 5 tests pass |
| `src/prompt-offload.js` | pure decision logic: `safePromptBytes` (default 16384), `blobRefForStep`, `buildBlobPayload` (sentinel), `buildFetchInstruction`, `buildInlineEssentials`, `classifyContextFetch` | complete, 6 tests pass |
| `src/blob-ref-registry.js` | append-only `.nax/blob-refs.jsonl` ledger; `addRunBlobRef`, `cleanupRunBlobRefs`, `sweepBlobRefs` (TTL) | complete, 6 tests pass |
| `src/blob-debug-cache.js` | local mirror of blob payloads under `.nax/workflows/<runId>/blobs/` | complete, 2 tests pass |

Live wiring (the path that would otherwise hit E2BIG):

- Decision/threshold: `prepareLocalPromptDelivery` — `bin/nax.js:3849`. Inline if `promptBytes <= safeBytes` (`bin/nax.js:3864`); else two-tier offload (prior-results `bin/nax.js:3923`, then full-prompt `ensureFullPromptBlobOffload` `bin/nax.js:4009`); else compact; else throw.
- Prompt swap: delivery → `run.promptText` at `bin/nax.js:5873`, submitted at `bin/nax.js:5934`.
- The actual argv chokepoint: `src/local-runner.js:474` / `:507` — `args.push('--prompt', promptText)`. Offload keeps this under budget.
- Post-hoc verification: `applyContextFetchClassification` at `bin/nax.js:4019`, called local `bin/nax.js:5765/5782`, GitHub `bin/nax.js:5470/5496`.
- Cleanup: `cleanupWorkflowBlobsForRun` on success `bin/nax.js:6556`, failure `bin/nax.js:6573`; `nax clean blobs` sweep `bin/nax.js:7029`.

Aggregate tests: 21 total, 20 pass, 1 skipped (the probe).

### A.0 — Lock the hosted-runner blob round-trip probe — `[no deps]`

The whole feature rests on one external contract: a hosted agent (pod, **scoped DevServer token**) can `blobs:get` a blob that nax wrote locally (**full PAT**). That contract has been manually verified against the live runner; the remaining work is to make the verification repeatable.

> **RUNNER ACCESS VERIFIED (2026-06-19):** Hosted Agent Runner blob read-back works in production. A pod agent (scoped token) can read a blob written by local nax (full PAT) from the same named store/key using the emitted fetch command —
> `NETLIFY_SITE_ID="${NETLIFY_SITE_ID:-$SITE_ID}" /opt/buildhome/node-deps/node_modules/.bin/netlify blobs:get nax-2026-06-20T02-49-05-599Z-review synthesize-prior-results --auth "$NETLIFY_AUTH_TOKEN"` —
> and return the expected blob payload. So: local PAT writes → pod scoped-token reads, same named store, different principals — **works.** The hardcoded CLI path exists in the pod, the token has blob-read, and site-id propagates. **A.0's load-bearing feasibility risk is retired.** The remaining A.0 task is to make this a *repeatable* check (see A.1k).
>
> **BUT — the exported artifact can still report `Offloaded context: failed`, which is a classifier/artifact defect (see A.1n).** Runner access is verified out-of-band, but `classifyContextFetch` (`src/prompt-offload.js:176`) can return `failed` when the reply matches `/blobs:get|...|NETLIFY_AUTH_TOKEN|.../` *anywhere*. A review *about* the blob feature can contain those tokens in normal prose, and the strong proof surface is the fetch command output rather than the final assistant reply. The classifier should distinguish real fetch command failure from prose that merely discusses blob fetching.

**Action:**
```bash
NAX_NETLIFY_BLOB_ROUNDTRIP_E2E=1 NETLIFY_SITE_ID=<real-site> \
  node tests/integration/blob-roundtrip-probe.test.js
```

**Validate three specific risk points the wiring depends on:**
1. The hard-coded runner CLI path `RUNNER_NETLIFY_CLI_PATH = /opt/buildhome/node-deps/node_modules/.bin/netlify` (`src/prompt-offload.js:6`, emitted in fetch instruction `:137`) actually exists in the pod.
2. The runner env exposes a usable `NETLIFY_AUTH_TOKEN` + `SITE_ID` with `blob:read`.
3. A blob written by the local principal is readable by the pod principal in the same named store.

Runner blob access has already been verified, so this is now a **regression-locking** step, not a feasibility gate: capture it as a credentialed CI job (A.1k) so a runner-image change, token-scope change, or CLI-path change fails loudly. **Do not rely on the unit tests for this — they mock the API.**

### A.1 — Close hardening seams — `[runner access verified; A.0 regression lock in progress]`

Concrete gaps exploration found in the wired code:

**A.1a — Local-path token/site guard.** `setBlob` needs `netlify.siteId` + `NETLIFY_AUTH_TOKEN`. The GitHub path guards explicitly (`bin/nax.js:1042/1078` throw "Netlify site context is required"). The **local** `ensureStepBlobOffload` path needs an equivalent guard or graceful compact-fallback when the token is absent — otherwise offload silently fails at submit. *Test:* offload attempted with no token → falls back to compact-if-safe or fails pre-submit with a clear message, never a raw CLI error.

**A.1b — Retry-path interaction.** `src/local-runner.js:848` still holds the older "compact on argv-limit retry" logic (`compactPromptForArgumentLimitRetry`). With offload now producing a small wrapper up front, confirm `waitForLocalAgentRuns` (`src/local-runner.js:815-892`) does not re-expand or double-compact an already-offloaded prompt, and that `run.blobRef` survives a retry. *Test:* an offloaded run that triggers the arg-limit retry keeps its blob wrapper and `blobRef` intact.

**A.1c — Phase-0 compaction no-op.** The original plan's Phase 0 (`docs/ai/plans/nax-prompt-blob-offload.md:285-306`) fixed a no-op where `compactPromptText === promptText` because the compaction ceiling (~48KB) exceeded the failing prompt (45KB). **Verify whether this actually landed.** *Test (red→green):* oversized fan-in → `compactPromptText` bytes `< promptText` bytes **and** `<= NAX_SAFE_PROMPT_BYTES`. If still failing, fix the budget derivation so compact targets ≤ safe bytes, not 48KB.

**A.1d — SIGINT cleanup.** Cleanup fires on success/failure but exploration flagged that interrupted runs (Ctrl-C) may orphan blobs until the 24h TTL sweep. Confirm the graceful-shutdown path calls `cleanupWorkflowBlobsForRun`; if not, wire it. *Test:* simulated interrupt leaves refs marked `pending-cleanup` and the sweep collects them.

**A.1e — Artifact serialization.** `src/workflow-artifacts.js` is modified in the working tree — confirm it serializes the new `promptDelivery`/`blobRefs`/`contextFetchStatus` fields into run artifacts so visualize/handoff can show offload state. *Test:* a run with an offloaded step round-trips its blob metadata through artifact build.

**A.1f — `getBlob` is dead code outside tests.** Decide: wire it into a nax-side read path (e.g. `nax show`/visualize reconstructing full prompt) or annotate it as intentionally runner-only. No code change required if the latter — just remove the ambiguity.

### A.1g–A.1m — Defects from the multi-model consensus review

A code review (Claude/Gemini/Codex consensus, pinned SHA `5c428117`) found seven open findings in the wired blob code. Folding them in by severity:

**A.1g — Standalone `nax issue` offload crashes (S1, HIGH).** `bin/nax.js:1077` — the standalone `nax issue` path calls the GitHub plan offload (`ensureGithubPlanBlobOffload`) without `stepState`, then dereferences `stepState.promptBlobRef`. It throws, gets caught as an offload failure, and **silently degrades to compact fallback** — so offload never runs for standalone issues and the failure is easy to miss. *Fix:* add the immediate `stepState?.promptBlobRef` guard, then thread real `runState`/`stepState`/`projectRoot` through the standalone path so it shares the normal step offload helper. *Test:* no-stepState issue path offloads (or cleanly falls back) without throwing.

**A.1h — Standalone `nax issue` blobs leak (S2, HIGH).** `src/blob-ref-registry.js:79` — standalone issue blobs aren't registered because there's no `projectRoot`/run context, so `nax clean blobs` can never sweep them. Same root cause as A.1g; fix together by threading context. *Test:* every successful upload (including no-stepState issue path) registers a sweepable ref.

**A.1i — Fetch command hardcodes the runner CLI path (S3, MEDIUM).** `src/prompt-offload.js:6` — `RUNNER_NETLIFY_CLI_PATH` and the env contract are baked in. Acceptable for today's hosted Netlify pod (the consensus *dropped* the "breaks GitHub Actions now" framing — C1 — since the agent fetch runs in the Netlify pod regardless of dispatch transport), but it's a latent portability flaw. *Fix:* render the fetch command behind a transport/runner capability — hosted path as default, explicit override / PATH fallback for other runtimes. (Supersedes the looser A.0 risk-point #1; keep the probe check.)

**A.1j — GitHub cleanup race (S4, MEDIUM).** `bin/nax.js:6556` — end-of-flow cleanup can delete a GitHub offload blob before an async remote consumer fetches it, when a step doesn't wait for agent results. *Fix:* for GitHub transport, delay deletion until consumer completion or a recorded context-fetch confirmation; otherwise leave the ref for later sweep. (Distinct from A.1d's SIGINT orphan case — this is premature deletion, not a missed one.)

**A.1k — Probe is opt-in, default CI blind (S5, MEDIUM).** Same gap as A.0. *Fix:* run the credentialed roundtrip probe in a scheduled or release-gated job, or a lighter smoke check when creds are present — so the highest-risk external contract (token, site-id, runner path, blob-read) regresses loudly.

**A.1l — Dead `inlineOnlyNeedles` branch (S6, LOW polish).** `src/prompt-offload.js:179` — `classifyContextFetch` has an unreachable branch; production callers never pass needles. *Fix:* either feed real inline-only needles from delivery metadata (richer diagnostics) or remove the branch + parameter.

**A.1m — Registry never compacted (S7, LOW polish).** `src/blob-ref-registry.js:13` — append-only `.nax/blob-refs.jsonl` grows unbounded across status transitions. *Fix:* compact during `nax clean blobs` by keeping only the latest record per blob id.

**A.1n — `classifyContextFetch` false-positive + wrong-surface proof (MEDIUM-HIGH, found live).** `src/prompt-offload.js:168-186`. Two coupled bugs, demonstrated by run `6a3602fc…`:
1. **Content-blind error regex** (`:176`): matches `blobs:get` / `NETLIFY_AUTH_TOKEN` / `blob.*error` *anywhere in the reply*, so any agent reply that merely *discusses* blob fetching (a code review of this feature, an agent that quotes the fetch instruction, a summary mentioning auth) is mislabeled `failed`. Pure false-positive.
2. **Proof read from the wrong surface** (`:171-172`): the sentinel/marker are the strong evidence, but they're only matched against the final assistant reply. Agents fetch the blob *early* (via a tool/command call) and use it; they don't reliably re-echo `NAX-CONTEXT-LOADED <marker>` at the end. The sentinel demonstrably came back in the **command output** of run `6a3602fc…`, not the final prose. *Fix:* detect the sentinel in the run's command/tool transcript (where `blobs:get` output actually lands), not just `run.resultText`; and anchor the error branch to genuine fetch failure (non-zero exit / error in the command result), never to prose content. *Verify:* what surface `applyContextFetchClassification` (`bin/nax.js:4019`) actually passes as `reply` — if it's only the final reply, the transcript needs threading in. This is the same function as A.1l (dead `inlineOnlyNeedles` branch) — fix together. It's also the concrete instance of the dueling-wizards warning about fragile substring classification.

**Consensus invariant confirmations (no action, but lock these in):**
- C2 **dropped** — do *not* add best-effort truncation on offload failure. Keep fail-before-submit; this matches the plan's no-silent-context-loss invariant. Improve diagnostics only.
- File-backed registry stays (no Netlify DB) — the real issues are registration (A.1h) and compaction (A.1m).

### A — Definition of done

- Hosted-runner read-back **proven** manually and locked into a credentialed regression job (A.1k).
- A.1a–A.1e tests written (TDD) and green; A.1f decided.
- A.1g + A.1h (the two HIGH consensus defects) fixed with regression tests.
- A.1n (classifier false-positive — the real cause of the misleading `failed` status) fixed with regression tests, read from the command transcript.
- A.1i–A.1m triaged: mediums fixed or explicitly deferred, lows scheduled as polish.
- A full ideas-flow fan-in run that previously E2BIG'd now completes, with `NAX_SAFE_PROMPT_BYTES` tuned against the real run.

---

## Workstream B — Semantic Flow Validator

### Goal

A pure validator that runs on the **resolved** flow object after config load and before any agent submission, returning *all* errors at once with step ids and fix hints — so a typo'd `input.step` or missing prompt file fails in <1s instead of mid-run after spending credits.

### Why on the resolved object, not raw syntax

Flows are loaded via `configorama` (`src/flows.js:1`, called `:236`) which evaluates JS/TS/JSON/YAML/TOML and resolves variable references. Validating raw file syntax would reject legitimate dynamic config. Validate the post-`normalizeFlow` object.

### Current validation (the baseline)

`normalizeFlow` (`src/flows.js:167-212`) throws on only two things:
- no steps (`src/flows.js:171-173`)
- unsupported `waitFor` (`src/flows.js:194-196`)

It does **not** check prompt existence, `input.step` references, agent names, or `submit`/`action` modes — all copied verbatim and only failing lazily mid-run (or silently degrading).

### Checks to add

| # | Check | Today's failure mode | Seam |
|---|---|---|---|
| 1 | Every `step.prompt` resolves to an existing file | lazy throw at execution `src/prompts.js:88` | mirror `path.resolve(flow.dir, step.prompt)` + `fs.existsSync` (`src/flows.js:260`) |
| 2 | Every `input[].step` references an existing, **earlier** step id | silent empty results `bin/nax.js:3548-3561` → degraded prompt, burned credits | walk `flow.steps`, build id set, enforce earlier-than ordering |
| 3 | Every `step.agents`/`defaults.agents` entry is known | only CLI-supplied selections checked, not flow-declared agents | `flowAgentSet(flow)` `src/agent-selection.js:82` is the seam; needs a known-agent allowlist |
| 4 | `submit ∈ {new-run, follow-up}`, `action ∈ {issue, comment}` | any string falls through to default silently `src/flows.js:200,203` | enum check |

### Placement (two-layer — see D3)

- **Structural** (checks 1, 2, 4): inside/next to `normalizeFlow` (`src/flows.js:167`), alongside the existing no-steps/`waitFor` throws.
- **Agent/selection** (check 3): post-`prepareInteractiveFlowRun` at `bin/nax.js:~6502`, where `assertValidAgentSelection` (`src/agent-selection.js:120`) already lives and the *selected* models are known.

Gate **before** the dry-run/run split at `bin/nax.js:6506` so dry-run also validates (catch errors without a transport).

### Design notes

- Return a `{ errors: [{ stepId, code, message, hint }], warnings: [] }` shape — accumulate all, don't fail on first (lets the user fix everything in one pass).
- Pure function, no I/O except `fs.existsSync` for prompt paths. Unit-testable with fixture flows.
- Reuse this same validator later as `nax doctor`/`nax lint` rather than building a parallel checker (avoids drift — the synthesis's explicit warning about duplicated doctor checks).

### Tests (TDD)

- Missing prompt file → error with step id + resolved path.
- `input.step` pointing at nonexistent id → error; pointing at a *later* step → error.
- Unknown agent in flow declaration → error naming the agent + the flow's known set.
- `submit: "bogus"` / `action: "bogus"` → error with allowed values.
- Valid flow (e.g. `src/flows/error-handling/flow.yml`) → no errors.
- All errors returned together, not just the first.

---

## Workstream C — Branch Truth Contract

### Goal

Resolve **one immutable target** `{ branch, ref, sha, sourceType }` at run start, persist it in `workflow.json`, and have every downstream consumer read *that* instead of re-deriving the branch ad-hoc. Fail **closed** when the target can't be proven.

### The problem, concretely

The target is derived **ad-hoc and repeatedly** — no single resolution point. At least these sites independently call `currentGitBranch` or equivalent:

- `src/local-runner.js:390` `currentGitBranch`
- `src/review-context.js:56` `resolveCurrentBranch`, `:251` `resolveRemoteBranchSha`, `:43` `resolvePinnedSha`
- `bin/nax.js:512` `resolveWorkflowBranch` (closest thing to a resolver today), `:541` `remotePinnedOptions`, `:496` `resolvePullRequestBranch`
- Ad-hoc re-derivations: `bin/nax.js:2141, 5825, 6206, 6426, 2580, 7106`

`workflow.json` (`createRunState` at `src/run-state.js:196`) carries **no target metadata** in its schema; `branch`/`branchSource` are bolted on *after* normalization at `bin/nax.js:6533-6534`, and `context.pinnedSha` lands inconsistently. Resume re-derives with `runState.branch || options?.branch || currentGitBranch` fallbacks (`bin/nax.js:6206, 6426`) — the prime silent-divergence risk.

### Design

**C.1 — Single resolver.** Consolidate `resolveWorkflowBranch` + `resolveRemoteBranchSha` + `currentGitBranch` into one `resolveTarget({ options, projectRoot, transport })` returning:

```
{
  branch,        // resolved name
  ref,           // symbolic ref
  sha,           // 40-char, or null if unverified
  sourceType,    // "explicit-branch" | "pull-request" | "current-branch"
                 //   | "github-actions-implicit" | "dry-run"
  verified,      // bool — sha proven against remote
  caveats: []    // e.g. "unpushed", "detached-head", "fork-pr", "gha-implicit"
}
```

Fail closed: if it can't prove the target for a transport that needs it (netlify-api requires a pushed SHA), **throw** rather than guess. Detached HEAD / unpushed / fork-PR populate `caveats` and, where the transport can't honor them, error.

**C.2 — Persist in schema.** Extend `createRunState` (`src/run-state.js:196`) to accept and store an immutable `target`. Remove the post-hoc `runState.branch =` assignments at `bin/nax.js:6533-6534` (keep a read-through alias if needed for compat — *ask before adding any back-compat*, per repo rule).

**C.3 — Thread the target** (replace ad-hoc re-derivations):
- Context/prompt: `readAutoContext` `bin/nax.js:440` → `buildFlowRunContext` `:554` → `buildAutomaticContext` `src/review-context.js:208` (reads target instead of re-resolving).
- Submission: `createAgentRun`/`createAgentRunAsync` `src/local-runner.js:461/490` (`--branch` from target), `submitLocalAgentRun` `:608`, internal re-runner `src/workflow-runner.js:28`.
- Resume: `bin/nax.js:6206, 6426` read `runState.target`, never re-derive.

**C.4 — Project into artifacts.** `src/workflow-artifacts.js` builders (`:163, :250, :367, :378, :507`) include target fields. (File already modified in tree — fold in.)

**C.5 — Surface in visualization.** `src/visualize-server.js:443/456` expose target; `web/src/types.ts:105/138`; `web/src/components/RecentRuns.tsx:458`; add a target panel to `web/src/components/DryRunPanel.tsx` (currently shows no branch/sha).

**C.6 — GitHub transport gap** (see D2). `createIssue` `bin/nax.js:710` / `executeGithubFlow` `:5523` pass no ref. Per D2(a): record `sourceType: "github-actions-implicit"`, `verified: false`, and warn that operated-on code = whatever Actions checks out. Full dispatch-with-ref fix deferred.

### Edge cases the resolver must handle (current behavior noted)

- **Detached HEAD:** `currentGitBranch` returns `''` silently (`src/local-runner.js:395`); `resolveWorkflowBranch` throws except dry-run substitutes `'(dry run)'` (`bin/nax.js:516`). New resolver: `caveat: detached-head`, require explicit `--branch` for transports needing it.
- **Unpushed branch:** `resolveRemoteBranchSha` throws (`src/review-context.js:272`). Interactive warn `confirmRemoteRunnerCanMissLocalChanges` (`bin/nax.js:611`) is **skipped under `--yes`/`--dry`/non-TTY** → CI silently proceeds. New resolver: surface `caveat: unpushed` even in non-TTY.
- **Fork PRs:** only `headRefName` resolved (`bin/nax.js:500`); `parseRemoteBranchTarget` assumes `origin` (`src/review-context.js:242`). `caveat: fork-pr`, sha likely unverifiable.
- **CI env:** no `GITHUB_REF` reads anywhere. GHA recorded branch never forwarded (the D2 gap).

### Tests (TDD)

- `resolveTarget` for each `sourceType` returns expected shape; unverifiable SHA → `verified: false` + caveat, and **throws** for netlify-api.
- `createRunState` persists `target`; resume reads it without re-deriving (mock a branch change → resume still targets the original).
- Artifact + visualize projections include target.
- GHA path records `github-actions-implicit` + warns.

---

## Cross-Workstream Dependency Graph

```
A.0 repeatable probe ────────► A.1 hardening (a–f) ──► A done
                                                         │
B validator (independent, no deps on A) ─────────────────┤
                                                         ▼
                                          C Branch Truth Contract
                                          (lands on offload-stable +
                                           validated workflow.json)

Critical path: A.1 → C
B parallelizes immediately (no deps).
```

Why C last: it touches the most surfaces (`workflow.json` schema, ~6 derivation sites, artifacts, visualize, both transports). Doing it after A stabilizes `prepareLocalPromptDelivery`/`workflow.json` and after B can validate the flow means one pass over shared plumbing instead of repeated retrofits.

---

## Consolidated Testing Strategy

- All TDD, `node --test`, real data/real APIs per repo rules (no mocks in e2e).
- Test output must stay pristine; capture and assert intentional error output.
- A.0 is the only test requiring a live site; it turns the manually verified hosted-runner blob-read contract into repeatable coverage.
- B and C are unit-testable with fixture flows / mocked git via temp repos (real `git`, not stubbed).

---

## Risks

1. **A.0 fails** → large amount of already-wired blob code is dead. Mitigation: it's isolated behind named modules; fall back to Phase-0 + structured-only forwarding without ripping out the modules.
2. **C becomes a sprawling refactor** (6+ derivation sites, two transports, web UI). Mitigation: single `resolveTarget` + schema change first, then thread incrementally; each threaded site is independently testable. Fail closed prevents partial-contract drift (artifacts say one SHA, runner checks out another).
3. **GHA gap (D2)** can't be fully closed in this repo. Mitigation: record-and-warn now, defer dispatch-with-ref.
4. **Validator false positives** (B) reject valid dynamic flows. Mitigation: validate resolved object only, semantic invariants not syntax.

---

## Next Step (planning-workflow)

Per the workflow: extended-reasoning review pass (GPT Pro / cross-model) on this doc, integrate revisions in place, then convert the task breakdown to a beads graph with the dependencies above. Resolve D1–D4 before beads conversion — they change task shape.
