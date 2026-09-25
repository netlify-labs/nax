---
id: 01M3CN9TZA28X5887J7KVN23NQ
status: draft
createdAt: 2026-09-25T09:10:16-07:00
updatedAt: 2026-09-25T09:10:16-07:00
origin: manual
type: plan
---

# Mid-Step Resume: Keep Survivors, Resubmit Only What Failed

> Status: DRAFT v1 for review (planning-workflow round 1). Supersedes beads `nax-33l.2` / `nax-33l.3` / `nax-33l.4` (2026-06-10; they cite `bin/nax.js`, `src/run-state.js`, and propose `submitted-prompt-*.md` files and `schemaVersion` bumps that are unnecessary now, see §2.4). Bead `nax-33l.1` (submission backoff) is **already covered** by SDK-level retry (5 attempts, `src/integrations/netlify/local-runner.js:26-27, 832-833`) and should be closed as done or re-scoped.

## 1. Why

Default lineups are now up to 4 instances per step (`MAX_STEP_AGENT_INSTANCES = 4`, `src/core/constants.js:7`; `workflows/review/flow.yml` declares claude, gemini, codex and opencode). Recovery works one step at a time, so a single bad instance costs a full step:

- **Scenario A: interrupted mid-step.** The laptop sleeps or Ctrl-C lands after 3 of 4 instances completed and 1 failed or was never submitted. On resume, no run is pollable, so `resumeLocalFlow` falls into `executeLocalFlow` from that step. That rebuilds and **resubmits all 4** (`src/workflows/engine/local-executor.js:1206` → `:905-951`).
- **Scenario B: the earlier step finished with survivors, and a later step was interrupted.** Forward execution treats `completed_with_failures` as done and continues (`localStepProceeds`, `local-executor.js:309-312`). Resume does not:
  - `completedStepMapFromRunState` and `firstRunnableStepIndex` accept only `completed|dry-run` (`src/workflows/engine/execution-context.js:155-178`).
  - So resume **re-runs the entire earlier step**, re-billing work that forward execution had already accepted.
  - **This is a bug, not a missing feature.**
- **Scenario C: final step partial** (`NAX_PARTIAL_FINAL_STEP`) or **all-failed step** (`NAX_ALL_INSTANCES_FAILED`). The run ends `failed` (`src/cli/main.js:2940`). Failed runs are not offered for resume (`isUnfinishedRun`, `src/core/runs/resumable.js:89-101`), and there is no `nax resume` command. The only tool is `nax run --retry`, which retries **one** run that has a `runnerId` (`main.js:2425-2600`, `progress.js:318-335`), so submission-phase failures (no runner) can't be retried at all.
- **Duplicate step records.** When resume re-executes a step, `executeLocalFlow` pushes a **second** `stepState` with the same id (`local-executor.js:845-853`). Later readers use `.find(id)` and get the **old** entry: `src/dashboard/services/mutations.js:217`, `src/workflows/engine/resume.js:236`, `local-executor.js:1175`, `github-executor.js:529`. `stepOrdinal` then puts the re-run's artifacts under a new `NN-` directory (`src/workflows/artifacts/workflow-artifacts.js:48-53`). There is no occurrence in the current `.nax/` data, but the path is live.

### Goal
Resuming any unfinished or failed local (netlify-api) workflow should:
1. never resubmit an instance that already completed;
2. poll instances still in flight;
3. resubmit only failed, timed-out or never-submitted instances, using the **exact prompt originally built** for them;
4. show the plan (keep / poll / resubmit per instance) before spending credits.

## 2. Grounded current state

### 2.1 What's already right (reuse, don't rebuild)
- The prompt is persisted per run: `run.promptText` + `compactPromptText` + `promptDelivery` (`local-executor.js:922-950`). Resubmitting the identical prompt is possible without rebuilding context against a branch that has moved.
- Instance identity: `agentInstanceId` = `agent:model|auto:effort|auto` (`src/core/agents/instances.js:40-42`); legacy fallback `sourceRunInstanceId` (`execution-context.js:205-208`).
- A resubmission precedent exists. Dashboard retry (`src/dashboard/services/mutations.js:293-379`) swaps a replacement run into an active step using saved `promptText` and a fresh runner, and `saveRunState` preserves it (`isDashboardRetryReplacement`, `src/storage/local/run-state.js:269-277`).
- Per-attempt artifacts already exist (`<agent>.attempt-N.{md,json}`, `workflow-artifacts.js`).
- Blob-offloaded prompts record `blobRef` with `expiresAt` and status; `prompt_ref_expired` is a known failure code (`src/integrations/netlify/failure-guidance.js:84-89`).
- The per-write lock (`workflow.json.lock`, mkdir-based, stale removal, `run-state.js:143-225`) prevents torn writes.

### 2.2 What's missing
- Instance-level reconciliation on resume.
- Resume eligibility for `failed` runs, and for `interrupted` runs whose partial step was saved (`hasRemainingInterruptedSteps` returns false as soon as it sees a saved, incomplete step, `resumable.js:55`).
- An explicit, scriptable resume entry point (today resume is TTY-only via `maybeResumeUnfinishedRun`, `main.js:2688-2729`, skipped under `--yes`/`--dry-run`).
- A run-level lock. A dashboard resume (`startResumeRun`, `src/dashboard/server.js:1744-1809`) and a CLI resume can both execute the same run. The dashboard only checks its own registry (`server.js:292-315`).

### 2.3 Transport scope
- **v1 covers the netlify-api transport only.**
- GitHub resume (`resumeGithubFlow`, `github-executor.js:506-566`) has no survivors path: it throws on any non-completed step. Resubmitting there means new issues or comments, which have different idempotency concerns. It is deferred; CLI retry and dashboard retry already reject non-Netlify transports (`main.js:2434`, `mutations.js:294`).

### 2.4 Why no schema bump
- `workflow.json` already has `schemaVersion: 1`.
- Everything needed is additive fields on runs (`raw.previousAttempts[]`, `resumeAction`), which old readers ignore. The `saveRunState` merge matches runs by `runnerId`, then by index plus agent. §3.5 adds `instanceId` matching first, so reordered or replaced runs don't cross-merge.

## 3. Design

### 3.1 Fix resume/forward divergence first (Scenario B + duplicates)
- `completedStepMapFromRunState` also accepts `completed_with_failures`. `firstRunnableStepIndex` treats it as done **unless it is the final step**, because in forward execution a partial final step throws `NAX_PARTIAL_FINAL_STEP`, i.e. it is not done. This mirrors `assertLocalStepOutcome` (`local-executor.js:320-337`) exactly: one shared predicate `stepSatisfied(stepState, { final })` in `execution-context.js`, used by both paths.
- `executeLocalFlow` **reuses** an existing `stepState` with the same id instead of pushing a new one (the same pattern as `requireHumanReview`, `local-executor.js:398-402`).
  - The step's position in `runState.steps` and its `NN-` artifact directory stay the same.
  - Superseded runs move into `raw.previousAttempts` (see §3.4).

These two changes alone stop the worst credit waste. They should ship first, even if the rest is delayed.

### 3.2 Instance reconciliation
A new pure function in `src/workflows/engine/resume.js` (or a sibling `reconcile.js`):
```js
/**
 * @returns {Array<{ instanceId, action: 'keep'|'poll'|'resubmit'|'submit'|'skip', reason, run }>}
 */
reconcileStepInstances({ flowStep, stepState, completedStepStates, options })
```
- **Desired instances:**
  - For a new-run step, the saved step's run `instanceId`s (identity is taken from what was actually planned, not re-resolved from a flow that may have been edited).
  - Plus any instances in the flow lineup that have no saved run (`submit`, e.g. the process died before submission). If the flow's lineup changed since the run started, the resume preview shows `flow changed` and uses **saved** instances only. See D4.
- **Classification per saved run:**
  | Saved state | Action |
  |---|---|
  | `completed` with `resultText` | `keep` |
  | `submitted`/`running` with `runnerId` (`shouldPollLocalRun`) | `poll` |
  | `failed`/`timeout`, error code transient or unknown | `resubmit` |
  | `failed` with code `wrong_account`/`token_expired` | `skip`, and the whole resume aborts before any submission with the failure guidance message (the environment must be fixed first; resubmitting would fail the same way) |
  | `failed` with `prompt_too_large` | `resubmit` using `compactPromptText` (mirrors `--retry`'s compact path); if there is no shorter prompt, `skip` with guidance |
  | `cancelled`/`canceled` | `skip` (the user chose this), unless `--include-cancelled` |
  | `pending`, no `runnerId`, no error (died before submit) | `submit` |
- **Follow-up steps:** an instance continues its **source runner** (`existingRunnerId` from the source step's surviving run, matched by instance id, `local-executor.js:380-383`). If that source instance didn't survive, the action is `skip` with reason `source_unavailable`; the same rule applies in forward execution.

### 3.3 Execution
- `resumeLocalFlow` (`local-executor.js:1141-1216`) replaces its two branches (`poll-then-continue` vs `re-execute-step`) with:
  1. Reconcile the first unsatisfied step.
  2. Show the preview (§3.6).
  3. Run the `poll` and `resubmit`/`submit` actions together through `mapInWaves` (`MAX_PARALLEL_RUNS`). Kept runs occupy no slots.
  4. Settle the step with the existing `localStepStatus` / `assertLocalStepOutcome`.
  5. Continue to the remaining steps with `executeLocalFlow`.
- **Resubmission** reuses the submission path of `executeLocalFlow` (one extracted `submitStepInstance(run, ctx)` helper, so forward, resume and dashboard retry share it, instead of adding a fourth copy).
  - The prompt is `run.promptText` (or the compact variant, per §3.2).
  - Delivery is re-prepared: if the saved `blobRef` is `cleaned`, `retained-failure` or past `expiresAt`, the prompt is re-uploaded from `promptText` via `prepareLocalPromptDelivery` (`src/workflows/engine/prompt-delivery.js`). The expired ref itself is never reused.
  - New-run steps get a fresh runner. Follow-up steps use `existingRunnerId` from the source.
- **Branch safety:** resubmission targets `runState.target` / `runState.branch` (never the current checkout). If the remote branch head has moved since the run started, the preview says `branch moved: abc123 → def456`. The prompt's pinned SHA text is kept, so the agent still reviews what its peers reviewed. See D5.

### 3.4 Attempt history
- Before a run is replaced, push `{ status, error, runnerId, sessionId, failurePhase, finishedAt }` into `run.raw.previousAttempts[]` and write the existing `<agent>.attempt-N` artifacts.
- The replacement run keeps the same `instanceId`, `instanceLabel`, `model` and `effort`, and sets `raw.resumeAction = 'resubmit' | 'submit'` and `raw.resumedFrom = <previous runnerId|null>`.
- Usage: previous attempts' usage stays counted in `usage.json`. Nothing that was spent is ever un-counted; `nax costs` reports the true total.

### 3.5 State merge hardening
- `matchingExistingRun` (`run-state.js:233-244`) matches by `instanceId` first (when both sides have one), then the current fallbacks. Without this, a resubmitted instance at index 2 could merge durable fields from the wrong old run when lineups have two instances of one provider (e.g. `codex:gpt-5:high` and `codex:gpt-5:low`, which is valid since multi-instance).
- Test first: two instances of the same agent where one is replaced, asserting no field bleed.

### 3.6 Entry points and preview
- **CLI:**
  ```bash
  nax run --resume [run-id] [--include-cancelled] [--force] [--dry]
  ```
  - `run-id` defaults to the latest resumable run.
  - `--dry` prints the reconciliation table and exits. `--force` skips the confirmation.
  - Non-TTY without `--force` fails fast and names the flag.
  - The existing TTY auto-offer (`maybeResumeUnfinishedRun`) uses the same preview.
  - See D1 for flag vs subcommand.
- **Preview:**
  ```text
  Resume 2026-09-25T16-02-11-000Z-review  (step 2/3: cross-review)
    claude:auto:auto     keep       completed 14m ago
    gemini:auto:auto     poll       running (runner 6a0e…)
    codex:auto:auto      resubmit   failed: model_capacity (attempt 2)
    opencode:auto:auto   skip       cancelled by user
  Branch: fix/auth @ abc123 (unchanged)
  New agent runs: 1   Kept: 1   Polling: 1
  ```
- **Eligibility:** `isUnfinishedRun` gains:
  1. `failed` runs whose error code is `NAX_ALL_INSTANCES_FAILED` or `NAX_PARTIAL_FINAL_STEP` (explicit `--resume` only, **not** auto-offered: an auto-prompt on every failed run would be noisy; see D2);
  2. `interrupted` runs with a saved unsatisfied step (fixes `resumable.js:55`).
- **Dashboard:** new `POST /api/runs/:id/resume` → `startResumeRun` (already exists for review approval) with the same reconciliation, plus a "Resume" button on failed and interrupted runs in the run details modal that shows the preview table first (`npm run dashboard:build`).
- **MCP:** a `run_resume` tool built on the idempotent-mutation wrapper (`src/control-plane/idempotent-mutations.js`, keyed by `request_id`), returning the reconciliation. See D3.

### 3.7 Run-level lock
Needed as soon as resume is reachable from CLI, dashboard and MCP at once.
- `<runDir>/run.lock` directory holding `owner.json` `{ pid, hostname, startedAt, command, runId }`. It reuses the mkdir-lock helper already in `run-state.js:143-178` (extracted into `src/storage/local/artifact-fs.js` or a small `run-lock.js`, not copied).
- Acquired by `executeLocalFlow` / `resumeLocalFlow` for the life of the execution, and released on completion, failure, and the graceful-exit hook (`src/storage/local/graceful-run-state.js`).
- **Stale** means: same hostname and the pid is not alive (`process.kill(pid, 0)` throws `ESRCH`). If the hostname is different, treat the lock as live and require `--force-unlock`. There are no timeouts: long runs are normal (25-45 minutes).
- A resume against a locked run fails with `run_locked` naming the pid and command. The dashboard maps this to 409, and MCP treats it as recoverable with guidance.
- The existing dashboard duplicate check stays. The lock is the cross-process backstop.

## 4. Decisions needed (David)
- **D1.** Entry point: `nax run --resume [run-id]` (recommended, sits next to `--retry`), or a new `nax resume` subcommand?
- **D2.** Auto-offer failed runs in the TTY resume prompt, or only via explicit `--resume` (recommended)?
- **D3.** MCP `run_resume` tool in v1, or later?
- **D4.** Flow lineup edited since the run started: resume with saved instances only (recommended), or refuse?
- **D5.** Branch head moved since the run started: resubmit with the original pinned-SHA prompt plus a warning (recommended), or refuse unless `--force`?
- **D6.** Close `nax-33l.1` as done (SDK retry covers it), and retire the `nax-33l.2/.3/.4` beads in favor of this plan?

## 5. Task breakdown
### Phase 0: Stop the bleeding (bug fixes; ship independently)
- T0.1 **Failing test first:** a run state where step 1 is `completed_with_failures` and step 2 is `interrupted`. Resume must start at step 2 and submit zero step-1 runs (inject `submitAgentRun` like `tests/integration/multi-instance-execution.test.js:63-78`).
- T0.2 Shared `stepSatisfied` predicate; use it in `completedStepMapFromRunState`, `firstRunnableStepIndex`, `assertLocalStepOutcome`, and `resumable.js` `isCompletedStep`.
- T0.3 **Failing test first:** re-executing a step produces exactly one `stepState` per id, and the artifact dir `NN` is unchanged. Implement the stepState reuse in `executeLocalFlow`.
- T0.4 `matchingExistingRun` instance-id-first (§3.5) with the same-provider two-instance test.

### Phase 1: Reconciliation core
- T1.1 `reconcileStepInstances` pure function + table-driven tests covering every row of §3.2, including follow-up source loss, the auth-code abort, and compact-prompt fallback.
- T1.2 Extract `submitStepInstance` from `executeLocalFlow` (a refactor under the existing tests: `flow-execution.test.js`, `multi-instance-*`), then use it in resume and dashboard retry.
- T1.3 Blob re-prepare for expired or cleaned refs; a test with an expired `blobRef` asserts a fresh upload, never the old key.
- T1.4 Attempt history (`raw.previousAttempts`, attempt artifacts, usage totals preserved).

### Phase 2: Resume flow + eligibility
- T2.1 Rewrite `resumeLocalFlow` around reconcile → preview → execute → continue.
- T2.2 `isUnfinishedRun` / `hasRemainingInterruptedSteps` fixes + tests in `tests/unit/run-state.test.js`.
- T2.3 `--resume [run-id]` flag, `--dry`, `--force`, `--include-cancelled`, non-TTY guard; the preview renderer is shared with the TTY auto-offer; CLI help guard.

### Phase 3: Run lock
- T3.1 Extract the mkdir-lock helper; `run.lock` acquire/release/stale logic; graceful-exit release.
- T3.2 Tests with two real child processes (spawn `node` workers against a temp run dir): the second resume gets `run_locked`, and a killed holder's lock is reclaimed.
- T3.3 Dashboard 409 mapping + MCP recoverable code.

### Phase 4: Dashboard + MCP surfaces
- T4.1 `POST /api/runs/:id/resume` + Resume button with preview; Playwright case; `npm run dashboard:build`.
- T4.2 MCP `run_resume` (per D3) on the idempotent wrapper; stdio integration test for replay safety (same `request_id` twice → one execution).

### Phase 5: Docs + bead hygiene
- T5.1 `site/content` guide: the resume semantics table, cost implications, the lock, and the GitHub transport limitation. CHANGELOG entry.
- T5.2 Update or close the `nax-33l*` beads per D6.

## 6. Testing strategy
- The engine seams already accept injected `submitAgentRun` / `waitForAgentRuns` (`executeLocalFlow` signature, `local-executor.js:815`). Tests use real run-state files in temp dirs and the real `saveRunState` locking. Only the network boundary is injected, matching existing suites.
- **Assertions that matter:**
  - a submission-count assertion per scenario A/B/C;
  - completed runs' `resultText` is untouched byte-for-byte;
  - the resubmitted prompt `===` the saved `promptText`;
  - no duplicate step ids;
  - usage totals include superseded attempts.
- **Live canary (opt-in, gated like `scripts/run-multi-instance-canary.mjs`):** a 2-instance step where one instance is forced to fail (invalid model id → `unsupported` at the runner). Resume must resubmit exactly one instance.
- **Acceptance:**
  1. Kill nax after 3 of 4 instances complete; `nax run --resume` submits exactly 1.
  2. Resuming an interrupted step 2 never resubmits step 1's survivors.
  3. A `NAX_PARTIAL_FINAL_STEP` run can be resumed explicitly and resubmits only the failed instance.
  4. A concurrent dashboard + CLI resume: one wins, the other gets `run_locked`.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Resubmitting a prompt whose embedded prior results reference runners that were since archived | The prompt text is self-contained (results are inlined or blob-offloaded); the blob is re-prepared per T1.3 |
| Two same-provider instances cross-merge on save | T0.4 instance-id-first matching |
| The lock blocks a legit run after a crash on another host | `--force-unlock` with the owner shown; never auto-steal across hosts |
| Phase 0 changes resume behavior for runs already on disk | That's the intent (it fixes re-billing); the change is behavior-only, with no data migration |
| GitHub-transport users expect the same thing | Explicit error: "Mid-step resume supports netlify-api runs; GitHub runs resume at step level" |

## 8. Out of scope
GitHub transport mid-step resume; automatic resubmission during forward execution (that's `onFailure: retry`, bead `nax-33r.1`, which will reuse `reconcileStepInstances` + `submitStepInstance`); cross-host lock coordination; changing `completed_with_failures` semantics for non-final steps.
