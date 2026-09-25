---
id: 01M3CN9TZA28X5887J7KVN23NQ
status: draft
createdAt: 2026-09-25T09:10:16-07:00
updatedAt: 2026-09-25T11:05:00-07:00
origin: manual
type: plan
---

# Mid-Step Resume: Keep Survivors, Resubmit Only What Failed

> Status: DRAFT v2. Codex review round 1 (Netlify runner `6ab6ae5ca90f294f6575eb87`) has been integrated, and each claim was re-verified; see §9. Supersedes beads `nax-33l.2` / `.3` / `.4`. `nax-33l.1` (submission backoff) is covered by SDK retry (5 attempts, `src/integrations/netlify/local-runner.js:26-27, 832-833`); close it after the focused retry-semantics test in T5.2.

## 1. Why

Lineups run up to 4 instances per step (`MAX_STEP_AGENT_INSTANCES`, `src/core/constants.js:7`). Recovery works one step at a time:

- **Scenario A: interrupted mid-step.** 3 of 4 instances completed and 1 failed or never submitted. On resume, no run is pollable, so `resumeLocalFlow` calls `executeLocalFlow` from that step and **resubmits all 4** (`src/workflows/engine/local-executor.js:1206-1213` → `:905-951`).
- **Scenario B (bug, confirmed independently by Claude and Codex):**
  - Forward execution proceeds on `completed_with_failures` (`localStepProceeds`, `local-executor.js:309-312`).
  - Resume accepts only `completed|dry-run` (`src/workflows/engine/execution-context.js:155-178`).
  - Resuming an interrupted step 2 therefore **re-runs and re-bills all of step 1**.
- **Scenario C: final step partial** (`NAX_PARTIAL_FINAL_STEP`) or **all-failed** (`NAX_ALL_INSTANCES_FAILED`). The run ends `failed` (`src/cli/main.js:2940`) and is never offered for resume (`src/core/runs/resumable.js:89-101`). `nax run --retry` retries only one run that has a `runnerId` (`main.js:2425-2600`), so submission-phase failures can't be retried.
- **Duplicate step records (bug).** Re-execution pushes a second `stepState` with the same id (`local-executor.js:845-853`). First-match readers then get the stale entry (`src/dashboard/services/mutations.js:216-218`, `src/workflows/engine/resume.js:233-241`, `local-executor.js:1174-1176`, `src/workflows/engine/github-executor.js:528-530`), and `stepOrdinal` shifts the artifact directory (`src/workflows/artifacts/workflow-artifacts.js:44-56`).

### Goal
Resuming an unfinished or failed netlify-api workflow should:
1. never resubmit a completed instance;
2. poll in-flight instances;
3. resubmit only failed, timed-out or never-submitted instances, using the **exact saved prompt**;
4. count every attempt's cost exactly once;
5. preview the plan before spending credits.

## 2. Grounded current state

### 2.1 Reusable pieces
- Prompt persisted per run: `promptText`, `compactPromptText`, `promptDelivery` (`local-executor.js:922-950`).
- Instance slot identity: `agentInstanceId` = `agent:model|auto:effort|auto` (`src/core/agents/instances.js:40-42`).
- Resubmission precedent: dashboard retry swaps a replacement run with saved `promptText` and a fresh runner (`mutations.js:293-379`; preserved by `isDashboardRetryReplacement`, `src/storage/local/run-state.js:269-277`).
- Attempt artifacts `<agent>.attempt-N.{md,json}` exist (`workflow-artifacts.js`).
- `blobRef` with `expiresAt`; `prompt_ref_expired` guidance (`src/integrations/netlify/failure-guidance.js:84-89`).
- Per-write state lock (`run-state.js:143-225`).
- `workflow.json` already has `schemaVersion: 1`.

### 2.2 Verified hazards that shape the design
- **Crash window before runs are saved.** The empty step is saved at `local-executor.js:853`. Runs are built next, and building includes prompt delivery with a synchronous `setBlob` upload (`src/workflows/engine/prompt-delivery.js:582`, called via `prepareLocalPromptDelivery` at `local-executor.js:913`). They are saved only at `:975`. A crash in that window (which includes network I/O) leaves no instance ids and no prompts.
- **Usage counts only current runs.** `usageSummariesForRunState` → `aggregateRunUsage(step.runs)` (`src/workflows/results/agent-run-results.js:222-249`). Anything stored under `raw` is ignored. The existing dashboard retry path, which swaps runs, likely drops the superseded run's usage today; T1.4 verifies this and fixes it with the same mechanism.
- **The state merge copies fields across runs.** `matchingExistingRun` matches by `runnerId`, then index + agent, then unique agent (`run-state.js:233-244`). `mergeRunDurableFields` then fills blank fields from the matched run (`:246-266`). A replacement attempt could inherit the old attempt's runner, session or result fields. Matching by `instanceId` alone doesn't fix this, because the instance is the slot, not the attempt.
- **The lock release is unconditional** (`fs.rmSync(lockDir)`, `run-state.js:163-166`), and stale detection is age-based. That is fine for a millisecond critical section, but unsafe for a lock held through a 45-minute run.
- **GitHub resume** polls saved in-flight runs and continues if they complete (`github-executor.js:549-569`); otherwise it re-executes the step (`:571-575`). It has no per-instance resubmission.

### 2.3 Transport scope
v1 is netlify-api only. GitHub mid-step resubmission (new issues or comments) is deferred. CLI and dashboard retry already reject non-Netlify transports (`main.js:2434`, `mutations.js:294`).

## 3. Design

### 3.1 Phase 0: fix the confirmed bugs (ships independently)
- **`stepAllowsContinuation(status)`** in `src/core/status.js`: true for `completed | dry-run | completed_with_failures`. Used by:
  - forward execution (`localStepProceeds`);
  - `completedStepMapFromRunState` and `firstRunnableStepIndex` (`execution-context.js`);
  - `isCompletedStep` / `hasRemainingInterruptedSteps` in `src/core/runs/resumable.js`.
  It lives in core, so storage/core helpers never import engine code.
- **Final-step rejection stays separate:** only the final-step settle (`assertLocalStepOutcome`, `local-executor.js:320-337`) rejects `completed_with_failures`. `firstRunnableStepIndex` treats a final `completed_with_failures` step as not done, the same way the settle does. There is no shared predicate with a `final` flag.
- **Step state reuse:** `executeLocalFlow` reuses an existing `stepState` with the same id (the pattern in `requireHumanReview`, `local-executor.js:398-402`). Its position and `NN-` artifact directory stay the same.

### 3.2 Execution manifest saved before any network work
- Split run construction in `executeLocalFlow`:
  1. **Build intent:** for each instance, create `{ instanceId, attemptId, agent, model, effort, promptText, compactPromptText, status: 'pending' }`. Prompt text building is pure.
  2. **Save:** `stepState.runs = runs; saveRunState(runState)`. This is the manifest.
  3. **Delivery:** `prepareLocalPromptDelivery` / blob upload, recorded onto each run.
  4. Submit.
- Resume reconciles **only** against the saved manifest.
- If a step exists with no manifest (a crash between the empty-step save and step 2), resume reports `resume_plan_unavailable` and points to `nax run <flow> --from-step <id>` (a new run, so there's no exact-prompt promise). No new flag is added for this.

### 3.3 Attempt model
- Every submission gets an `attemptId` (nanoid).
- `step.runs[]` stays the **current attempt per instance slot** (a projection, so every existing reader keeps working).
- Superseded attempts move to `step.attempts[]`: `{ attemptId, instanceId, agent, model, effort, status, error, failurePhase, runnerId, sessionId, usage, resultTextPath?, startedAt, finishedAt }`. The full text lives in the existing `<agent>.attempt-N` artifacts, not inline.
- **Usage:** `usageSummariesForRunState` aggregates `step.runs` + `step.attempts` exactly once, keyed by `attemptId`. Dashboard and MCP usage projections pick this up through the same function. Test: the totals after a resume equal the sum of all attempts.
- **State merge:** `matchingExistingRun` matches by `attemptId` first when both sides have one. `mergeRunDurableFields` never copies runner, session or result fields between records with **different** `attemptId`s. Legacy runs without `attemptId` keep the current fallback.

### 3.4 Instance reconciliation
Pure `reconcileStepInstances({ stepState, flowStep, completedStepStates, runState })`, which lives in `src/workflows/engine/resume.js`:

| Saved current attempt | Action |
|---|---|
| `completed` with `resultText` | `keep` |
| `submitted`/`running` with `runnerId` | `poll` |
| `failed`/`timeout`, transient or unknown code | `resubmit` |
| `failed` with `wrong_account`/`token_expired` | abort the whole resume before any submission, with guidance |
| `failed` with `prompt_too_large` | `resubmit` with `compactPromptText`, or `skip` with guidance when no shorter prompt exists |
| `cancelled`/`canceled` | `skip` unless `--include-cancelled` |
| `pending`, no `runnerId` (manifest saved, never submitted) | `submit` |

- **Instance set = the manifest, never the current flow lineup.** If the flow's lineup or prompt changed since the run started (compared with the flow digest from `flow-lint-and-fail-fast.md` §3.4, stored on the run at start), resume **refuses** with `flow_changed_since_run`.
- **Follow-up steps:** an instance continues its source runner (`existingRunnerId` from the source step's surviving current attempt). If the source instance didn't survive, the action is `skip` / `source_unavailable`, matching forward execution.

### 3.5 Execution
- `resumeLocalFlow` becomes:
  1. reconcile the first step that doesn't allow continuation (or the partial final step);
  2. preview;
  3. run `poll` + `resubmit`/`submit` through `mapInWaves` (kept runs use no slots);
  4. settle with the existing `localStepStatus` / final-step rule;
  5. `executeLocalFlow` for the remaining steps.
- One extracted `submitStepInstance(run, ctx)` is shared by forward execution, resume and dashboard retry.
- **Blob re-prepare:** if the saved `blobRef` is `cleaned`, `retained-failure` or past `expiresAt`, re-upload from `promptText` (new key); never reuse an expired ref.
- **Branch safety:** resubmission targets `runState.target`. If the remote head moved since the run started, resume **refuses** unless `--force`, and the preview names both SHAs.

### 3.6 CLI entry point and preview
```bash
nax run --resume <run-id> [--include-cancelled] [--force] [--dry]
```
- `--dry` prints the reconciliation table and exits. `--force` skips confirmation and permits a moved branch.
- Non-TTY without `--force` fails fast and names the flag.
- **Eligibility** (`isUnfinishedRun`) adds:
  1. `failed` runs with `NAX_ALL_INSTANCES_FAILED` / `NAX_PARTIAL_FINAL_STEP`, **explicit `--resume` only** (never auto-offered);
  2. `interrupted` runs with a saved step that doesn't allow continuation (the `resumable.js:55` fix).
- The TTY auto-offer (`maybeResumeUnfinishedRun`, `main.js:2688-2729`) uses the same preview.
```text
Resume 2026-09-25T16-02-11-000Z-review  (step 2/3: cross-review)
  claude:auto:auto     keep       completed 14m ago
  gemini:auto:auto     poll       running (runner 6a0e…)
  codex:auto:auto      resubmit   failed: model_capacity (attempt 2)
  opencode:auto:auto   skip       cancelled by user
Branch: fix/auth @ abc123 (unchanged)
New agent runs: 1   Kept: 1   Polling: 1
```

### 3.7 Run lock
- `<runDir>/run.lock/owner.json` = `{ pid, hostname, nonce, startedAt, command, runId }`. It reuses the mkdir-lock mechanism, extracted from `run-state.js:143-178` into `src/storage/local/run-lock.js` (not copied).
- **Acquire** at the orchestration boundary before any state mutation: the CLI run/resume handlers, and later the dashboard `startRun`/`startResumeRun` and MCP start. **Hold** through the terminal save.
- **Release** only if `owner.json` still matches this process's `pid`, `hostname` and `nonce`. Otherwise leave it alone and warn.
- **Stale** = same hostname and dead pid (`process.kill(pid, 0)` → `ESRCH`). There is no age-based expiry (runs last 25-45 minutes). A different hostname requires `--force-unlock`, which shows the owner.
- A contended resume gets `run_locked` (dashboard 409, MCP recoverable).
- The graceful-exit hook (`src/storage/local/graceful-run-state.js`) releases via the same owner check.

## 4. Scope
- **v1:** Phase 0 bug fixes; execution manifest; attempt model; reconciliation; CLI `--resume`; run lock with two-process tests.
- **Follow-up (after v1 proves the lock + shared service):** dashboard `POST /api/runs/:id/resume` + button; MCP `run_resume` on the idempotent-mutation wrapper (`src/control-plane/idempotent-mutations.js`).

## 5. Decisions (resolved 2026-09-25)
| # | Decision |
|---|---|
| D1 | `nax run --resume <run-id>` |
| D2 | Failed runs are resumable only via explicit `--resume` |
| D3 | MCP `run_resume` is a follow-up |
| D4 | Saved manifest only; refuse when it is absent (`resume_plan_unavailable`) or the flow changed (`flow_changed_since_run`) |
| D5 | Refuse a moved branch unless `--force` |
| D6 | Close `nax-33l.1` after the focused retry-semantics test; supersede `.2/.3/.4` with this plan |

## 6. Task breakdown
### Phase 0: stop the bleeding
- T0.1 **Failing test first:** a real temp `workflow.json` with step 1 `completed_with_failures` and step 2 interrupted. Resume starts at step 2 with zero step-1 submissions (inject `submitAgentRun` like `tests/integration/multi-instance-execution.test.js:63-78`).
- T0.2 `stepAllowsContinuation` in `src/core/status.js`; wire it into forward execution, the execution-context map/index, and `resumable.js`; keep final-step rejection separate.
- T0.3 **Failing test first:** re-execution yields one `stepState` per id and an unchanged `NN` artifact dir. Implement the reuse.

### Phase 1: manifest + attempts
- T1.1 Split run construction (intent → save → delivery → submit). The test kills execution after the manifest save (injected delivery throws) and asserts that `workflow.json` has every instance's `promptText` and `attemptId`.
- T1.2 `attemptId` + `step.attempts[]` + artifact linkage.
- T1.3 Merge hardening: attempt-id matching; no durable-field copy across attempts. The test uses two same-provider instances plus a replaced attempt and asserts no field bleed.
- T1.4 Usage aggregation over runs + attempts; verify whether dashboard retry currently loses usage, and switch it to the attempt model.

### Phase 2: reconcile + resume
- T2.1 `reconcileStepInstances` table tests (every row of §3.4, including source loss, auth abort, compact fallback, and flow change).
- T2.2 Extract `submitStepInstance` under the existing suites (`flow-execution.test.js`, `multi-instance-*`); use it in resume and dashboard retry.
- T2.3 Blob re-prepare (an expired ref gets a fresh key).
- T2.4 Rewrite `resumeLocalFlow`; eligibility fixes + tests in `tests/unit/run-state.test.js`.
- T2.5 `--resume` / `--dry` / `--force` / `--include-cancelled`; non-TTY guard; shared preview; CLI help guard.

### Phase 3: lock
- T3.1 `run-lock.js` (extracted mechanism, owner nonce, pid-liveness stale check, owner-checked release); acquire at the CLI boundary; graceful-exit release.
- T3.2 Two real child `node` processes against a temp run dir: the second gets `run_locked`; a killed holder is reclaimed; a replaced lock is not deleted by the old owner's release.

### Phase 4: docs + beads
- T4.1 `site/content`: the resume semantics table, cost accounting, the lock, and the GitHub limitation. CHANGELOG.

### Phase 5: bead hygiene
- T5.1 Supersede `nax-33l.2/.3/.4` with links to this plan.
- T5.2 A focused retry-semantics test on SDK submission retry (5 attempts, backoff observable via `onRetry`), then close `nax-33l.1`.

## 7. Testing strategy
- Real temp run-state files, the real `saveRunState` locking, and real child processes for the lock; only the network boundary (`submitAgentRun` / `waitForAgentRuns`) is injected, matching existing suites.
- **Assertions:**
  - submission counts per scenario A/B/C;
  - kept `resultText` byte-identical;
  - resubmitted prompt `===` saved `promptText`;
  - no duplicate step ids;
  - usage totals = sum of all attempts;
  - no field bleed across attempts.
- **Live canary (opt-in, like `scripts/run-multi-instance-canary.mjs`):** a 2-instance step with one forced failure (invalid model id); resume resubmits exactly one.
- **Acceptance:**
  1. Kill after 3 of 4 complete → `--resume` submits 1.
  2. Resuming an interrupted step 2 never resubmits step 1.
  3. A `NAX_PARTIAL_FINAL_STEP` run resumes explicitly and resubmits only the failed instance.
  4. Of two concurrent CLI resumes, one gets `run_locked`.
  5. `nax costs` includes superseded attempts.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Splitting run construction changes forward behavior | T1.1 runs under the full existing engine suites; the only behavior change is an earlier save |
| Attempt fields bloat `workflow.json` | Text stays in attempt artifacts; attempts carry metadata + usage only |
| The lock blocks after a crash on another host | `--force-unlock` showing the owner; never auto-steal across hosts |
| Phase 0 changes resume for runs already on disk | That's the fix; behavior-only, no data migration |

## 9. Review round 1 (Codex) — integration record
Every Codex claim was re-verified in code (2026-09-25).
- **Accepted:** `stepAllowsContinuation` plus a separate final-step rule, placed in core; an execution manifest before network work (the window includes a sync `setBlob`); typed attempts with usage aggregation; attempt-id merge semantics (a durable-field copy is the real bleed source); an owner-nonce lock acquired at the orchestration boundary; dashboard/MCP entry points deferred; refuse on a moved branch or a changed flow.
- **Corrected from v1:** GitHub resume does poll saved runs; "same-provider only" understated the merge hazard.

## 10. Out of scope
GitHub transport mid-step resubmission; automatic resubmission during forward execution (`onFailure: retry`, `nax-33r.1`, which will reuse `reconcileStepInstances` + `submitStepInstance`); cross-host lock coordination; changing `completed_with_failures` semantics for non-final steps.
