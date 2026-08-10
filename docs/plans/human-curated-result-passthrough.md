# Plan: Human-Curated Result Passthrough (`results: selected`)

> Status: **REVISED DRAFT — grounded review integrated; implementation not started**
> Owner: David
> Scope: implement `input.results === 'selected'` so a human-review step can curate which upstream agent-run results are injected into a new run or continued as follow-up sessions.

---

## 1. Why we're building this

### 1.1 The user story

> Step 1 runs a fan-out of agents and produces N results. Step 2 is a human review gate where a person chooses which results are worth carrying forward. Step 3 receives or continues only the approved subset.

Concretely: run a council or audit, discard weak results, and pass only the useful sessions to an expensive implementation step. Today a downstream step receives all results or none; `results: selected` is accepted but has no selection behavior.

### 1.2 The gap in the existing example

`workflows/human-review-example/flow.yml` already sketches this shape and is currently disabled:

```yaml
- id: audit
  agents: [codex]
  waitFor: agent-results
- id: human-review
  action: human-review
  input:
    - step: audit
      results: all
- id: implement
  description: Implement only the changes approved at the human review gate.
  submit: follow-up
  input:
    - step: audit
      results: all
    - step: human-review
      results: all
  waitFor: agent-results
```

The implementation description promises approved-only behavior, but the first input continues every audit session. The review edge contributes nothing because a human-review step has `runs: []`.

### 1.3 Current `results` modes

`ALLOWED_INPUT_RESULTS` in `src/workflows/catalog/flows.js` is `['all', 'selected', 'peers']`:

| Mode | Current behavior |
| --- | --- |
| `all` | Every run from the source step. |
| `selected` | Accepted by validation but falls through to `all`; dashboard follow-up persistence also writes this inert marker. |
| `peers` | Completed sibling runs, excluding the calling instance when one is supplied. |

This plan makes `selected` meaningful for curated review gates without changing legacy `selected` edges that have no recorded curation.

---

## 2. Grounded execution map

### 2.1 There are two independent downstream consumption paths

The original plan incorrectly assumed all downstream consumption passed through `sourceRunsForStep`. Local execution has two paths:

1. **Prompt/context injection** — `sourceRunsForStep` in `src/workflows/engine/execution-context.js` collects input runs for:
   - the main per-instance prompt path in `local-executor.js`;
   - the `hasPriorResults` output-budget flag;
   - compact retry prompts.
2. **Session continuation** — a `submit: follow-up` step calls `completedContinuationRuns` → `continuationSourceRuns` in `local-executor.js`. This reads the first input step state's `.runs` directly to choose the inherited lineup and `existingRunnerId`s. It does not call `sourceRunsForStep`.

A correct implementation must apply recorded curation to both paths. Patching only `sourceRunsForStep` makes new-run context curation work but leaves follow-up continuation broken.

### 2.2 Current context-input semantics

`sourceRunsForStep(step, completedStepStates, { instanceId })`:

- Creates a fresh `seen` set for each input edge.
- Reads the source state's `runs` array.
- Special-cases `results === 'peers'` for completed-only and self-exclusion behavior.
- Tags returned copies with `sourceStep: input.step`.
- Deduplicates by `runnerId`, with the existing positional fallback when no runner id exists.

Any extraction of the push/dedup logic must preserve the per-edge `seen` scope and current fallback-key behavior.

### 2.3 Current continuation semantics

For `submit: follow-up`:

- Only the **first** declared input supplies sessions to continue; later inputs are read-only prompt context.
- The first input's completed runs with a `runnerId` become the inherited lineup.
- `continuationRunForInstance` pairs each inherited instance with its prior runner.
- No usable inherited runs produces `NAX_FOLLOWUP_SOURCE_UNAVAILABLE`; the executor deliberately does not fall back to fresh runners.

Therefore, a selected review used as the first input must expose its curated runs to continuation resolution even though the review state's own `runs` remains empty.

### 2.4 Human-review lifecycle and durable flow

- `createHumanReviewStepState` creates `runs: []` plus `review.status: 'awaiting_review'`.
- `requireHumanReview` persists the gate and pauses execution.
- `approveHumanReviewGate` marks the gate completed and the workflow running.
- Resume skips the completed review step and includes it in `completedStepStates`.
- `createRunState` embeds the normalized workflow at `runState.flow`; approval-time selection resolution can read the review step's declared input from that embedded flow. A separately loaded flow is the fallback for legacy state.
- The dashboard route starts an asynchronous resume; the spawned CLI performs the actual `approveHumanReviewGate` transition.

The review step state does not need a denormalized copy of `step.input`.

### 2.5 Dashboard data availability

The run-details payload currently exposes per-session identifiers and display metadata, but it does not expose a purpose-built review-candidate model. Its workflow-step projection also omits `select` and `input`. The UI cannot reliably infer curation candidates from timeline sections alone.

The feature therefore needs an explicit run-details curation DTO rather than a best-effort browser reconstruction.

### 2.6 Identity scope

`instanceId` is stable and unique **within one step**, but not across several source steps. Two steps can both contain `codex:auto:auto`. A bare `selectedRunIds: string[]` is therefore not a globally unambiguous selection format.

V1 keeps the authoring surface intentionally narrow: a `select: true` review must declare exactly one input edge. Selection values still use structured references containing `sourceStep` and `instanceId` so provenance is explicit and the durable/API shape does not require a migration if multi-input curation is added later.

### 2.7 Archive dependency

`futureFollowUpReferencesStep` currently protects only directly referenced source steps. In `audit → review → implement(follow-up)`, it does not recognize `audit` as the provider of the sessions that `implement` will continue through `review`. With `--archive` or `autoArchive`, candidate runners could be archived before the gate is approved.

The archive dependency check must understand this one-level curated-review indirection.

---

## 3. Revised design

### 3.1 Core invariants

1. Human-review steps remain control-plane records: `stepState.runs` stays empty.
2. Resolved curation lives under the review step's `review` metadata.
3. Both prompt injection and first-input follow-up continuation consume the same selected base pool.
4. Missing curation means legacy fallback-to-all; an explicitly recorded empty array means selected none.
5. Selection is resolved and validated before the resume process starts.
6. Existing `all`, `peers`, non-selecting reviews, and legacy dashboard follow-ups retain their behavior.

### 3.2 Authoring surface

```yaml
defaults:
  transport: netlify-api
  agents: [claude, gemini, codex]

steps:
  - id: audit
    submit: new-run
    waitFor: agent-results

  - id: review
    action: human-review
    select: true
    input:
      - step: audit
        results: all

  - id: implement
    submit: follow-up
    input:
      - step: review
        results: selected
    waitFor: agent-results
```

Rules for V1:

- `select: true` is valid only on a human-review step.
- A selecting review must have exactly one input edge.
- A downstream step requests the curated set explicitly with `{ step: review, results: selected }`.
- A selected review may be ordinary prompt context or the first continuation input.
- Curated selection is local/Netlify API only; GitHub transport receives a targeted unsupported-feature diagnostic.

`normalizeFlow` reconstructs a whitelist of step properties, so `select` must be added explicitly to normalization, serialization/public projection, JSDoc, and TypeScript contracts. Unknown top-level step fields are not preserved automatically.

### 3.3 Durable selection model

When the dashboard records a choice, the review metadata gains:

```js
review: {
  // Existing status/timestamp/reviewer fields...
  selectedRunRefs: [
    {
      sourceStep: 'audit',
      instanceId: 'claude:claude-opus-5:auto',
      runnerId: 'runner-123',
    },
  ],
  selectedRuns: [
    // Resolved AgentRun copy, including resultText/blob refs/session identity,
    // plus curatedFromStep: 'audit' for original provenance.
  ],
}
```

- `selectedRunRefs` is the durable provenance and UI rehydration model.
- `sourceStep + instanceId` is the primary identity; `runnerId` is an additional exact-match and audit field once available.
- `selectedRuns` is the approve-time snapshot used by downstream execution, so readers do not re-resolve mutable upstream state.
- `selectedRuns` is never copied into the review state's top-level `runs` array.
- `undefined` means no curation was recorded and triggers fallback-to-all.
- `[]` means the reviewer explicitly selected nothing.

All new JavaScript shapes and callbacks receive precise JSDoc types; no `any` types are introduced.

### 3.4 Candidate resolution and recording

Add a focused human-review helper, illustratively `recordHumanReviewSelection({ runState, flow, stepId, selectedRunRefs })`, that:

1. Finds the awaiting review state and its normalized flow definition through `runState.flow` or an explicitly supplied fallback flow.
2. Requires `select: true` and exactly one declared input.
3. Builds the candidate pool from that input's completed source runs.
4. Validates every structured ref, rejects duplicates and unknown/stale refs, and preserves request order.
5. Resolves refs to run snapshots and tags each copy with `curatedFromStep`.
6. Applies the zero-selection rule in §3.8.
7. Persists only the selection metadata while leaving the gate `awaiting_review`.

This helper is separate from `approveHumanReviewGate`. The server records selection first; the spawned resume then performs the existing approval state transition. Calling `approveHumanReviewGate` in the server before spawning would make the subprocess fail with `no_review_gate` when it tries to approve again.

If selection persistence succeeds but spawning fails, the gate remains awaiting review with its choice saved and can be retried safely.

### 3.5 Shared base-run resolver

Extract a small result-mode-aware resolver in `execution-context.js`, illustratively:

```js
function inputRunsForEdge(input, completedStepStates) {
  const source = completedStepStates.get(input.step)
  if (input.results === 'selected' && Array.isArray(source?.review?.selectedRuns)) {
    return source.review.selectedRuns
  }
  return runsFromStep(source)
}
```

This helper chooses the base pool only:

- recorded selected array, including `[]`, for `results: selected`;
- source `.runs` for `all`, `peers`, or an uncurated legacy `selected` edge.

`sourceRunsForStep` remains responsible for peer filtering, caller-instance exclusion, provenance tagging, and per-edge dedup. The extracted `pushRun` helper must stay inside or explicitly receive the per-input `seen` set so current dedup semantics do not change.

### 3.6 Prompt/context consumption

Change `sourceRunsForStep` to iterate `inputRunsForEdge(input, completedStepStates)` instead of directly reading `runsFromStep(source)`.

Consequences:

- Main prompts receive only the curated subset.
- Compact retry prompts receive the same subset.
- The no-instance `hasPriorResults` call sees explicit empty selection and returns false.
- Downstream formatting, compaction, budget calculation, and blob offload remain unchanged.
- Returned runs are grouped under `sourceStep: review`, reflecting the explicit DAG edge, while `curatedFromStep` retains original provenance.

### 3.7 Follow-up continuation consumption

Change `continuationSourceRuns` so its first input also resolves through `inputRunsForEdge`.

For a selected review source:

- Only approved completed runs with runner ids become inherited sessions.
- The inherited lineup contains only approved instances.
- Each submitted run receives the approved source's `existingRunnerId` and SDK handle.
- Unselected sessions are neither continued nor submitted.
- An absent selection retains today's fallback-to-all behavior.

Keep `continuationRunForInstance`'s instance pairing. Add a defensive validation/error for duplicate selected `instanceId`s before constructing the inherited lineup, even though V1's single-review-input rule should prevent ambiguity.

### 3.8 Explicit zero-selection semantics

Split checkbox defaulting from empty-selection behavior:

- **UI default:** all candidates checked, matching current pass-all behavior when the reviewer makes no changes.
- **Explicit empty selection:** store `selectedRunRefs: []` and `selectedRuns: []`; never coerce either to `undefined`.
- **New-run consumer:** receives no prior results and executes contextless.
- **Follow-up consumer:** cannot continue zero sessions. If any future `submit: follow-up` step uses this review as its first `results: selected` input, reject empty approval with a clear 409/domain error before resume starts.

Skipping a downstream step when nothing is approved is potentially useful but is a separate workflow-control feature and is not implicit in this work.

### 3.9 Archive safety

Extend the static future-follow-up dependency check:

- Direct follow-up reference remains protected as today.
- If a future follow-up's first input is `{ step: review, results: selected }`, and `review` is a selecting human-review step, the review's sole input source is also protected.
- Protection applies before the review is approved because all candidate sessions may still be selected.
- Cover both global `--archive` and per-step `autoArchive: true`.

This change protects session availability; it does not redesign the broader post-follow-up archive lifecycle.

### 3.10 Dashboard/API curation contract

Add precise shared contracts for:

```ts
type ReviewRunRef = {
  sourceStep: string
  instanceId: string
  runnerId?: string
}

type ReviewRunCandidate = {
  ref: ReviewRunRef
  sourceStepTitle: string
  agent: string
  instanceLabel?: string
  model?: string
  effort?: string
  status: string
  sessionId?: string
  links: Record<string, string | undefined>
}

type RunDetailsReviewCuration = {
  stepId: string
  enabled: boolean
  candidates: ReviewRunCandidate[]
  selectedRunRefs?: ReviewRunRef[]
}
```

The run-details builder resolves this DTO server-side from the durable state plus normalized flow. It does not expose duplicate full result bodies merely to render checkboxes.

The approve request becomes `{ stepId, selectedRunRefs?: ReviewRunRef[] }`. For a selecting review, the updated dashboard always sends an explicit array; omission remains compatible with old clients and non-selecting review gates.

### 3.11 Dashboard interaction

For an awaiting `select: true` review:

- Render the candidate list in the active review timeline panel using the existing multi-select row pattern.
- Default all candidates checked unless durable `selectedRunRefs` already exists.
- Key rows by a deterministic composite of `sourceStep`, `instanceId`, and `runnerId` rather than `instanceId` alone.
- Show enough agent/model/effort/source-step information to make the choice understandable.
- Confirm explicit zero only where allowed; show a blocking explanation when a future follow-up requires at least one session.
- Disable Continue during persistence/resume submission and preserve the current cancel behavior.

After every UI implementation change, run `npm run dashboard:build` before handoff.

### 3.12 Approve/resume sequence

1. Dashboard loads `reviewCuration` from run details and submits `selectedRunRefs`.
2. Both dashboard server adapters validate the request and call the shared record-selection helper.
3. The helper saves the awaiting gate with `selectedRunRefs` and `selectedRuns`.
4. Only after a successful save does the server call `startResumeRun`.
5. The spawned resume calls the existing `approveHumanReviewGate`, which preserves the recorded metadata while marking the gate approved.
6. Local execution resumes; both context and continuation read the same curated snapshot.

### 3.13 Backward compatibility

- A legacy `results: selected` edge whose source has no `review.selectedRuns` falls back to the source's normal `.runs`, exactly as today.
- Existing human-review steps without `select: true` retain approve/cancel behavior and need no selection payload.
- Missing `selectedRunRefs` from an older dashboard client means uncurated fallback-to-all.
- Explicit empty arrays survive save/read/JSON round-tripping and never become the missing-selection case.
- `all` and `peers` semantics remain unchanged.

### 3.14 GitHub transport boundary

GitHub execution already supports pausing at human-review steps, but it uses issue-number and fetched-comment result plumbing rather than the local run resolver. Do not reject all GitHub human-review flows.

Instead, after transport resolution and before execution, reject `select: true` curation on GitHub transport with a targeted diagnostic explaining that curated passthrough currently requires Netlify API transport. Legacy inert `results: selected` edges remain unchanged for compatibility.

---

## 4. Resolved decisions

| # | Decision | Resolution |
| --- | --- | --- |
| **D1** | Curated storage | Keep `review.selectedRuns`; leave `stepState.runs` empty. This avoids usage, projection, timeline, and artifact duplication. |
| **D2** | Selection identity | Structured `{ sourceStep, instanceId, runnerId? }` refs. `instanceId` alone is only step-local. |
| **D3** | Downstream reference | Point explicitly at the review step with `results: selected`. |
| **D4** | Opt-in | Require `select: true` on the human-review step. |
| **D5** | Selection persistence | Persist selection metadata before spawning resume, without approving the gate server-side. |
| **D6** | Follow-up support | In scope. Continuation and prompt context share the selected base pool. |
| **D7** | Legacy selected edges | Silent fallback-to-all when curation metadata is absent. |
| **D8** | UI default | All candidates checked. |
| **D9** | Explicit zero | Allowed for new-run consumers; rejected when a selected follow-up continuation depends on the gate. |
| **D10** | Multi-input reviews | V1 selecting reviews require exactly one input edge. Structured refs preserve future extensibility. |
| **D11** | Provenance | Downstream grouping uses the review edge; selected run snapshots retain `curatedFromStep`. |
| **D12** | GitHub transport | Existing human-review remains supported; `select: true` receives a targeted unsupported diagnostic. |
| **D13** | Follow-up modal unification | Deferred; it uses artifact-selection vocabulary and is a separate feature. |

---

## 5. Task breakdown

Legend: **[E]** engine, **[S]** server/API, **[W]** web UI, **[T]** tests, **[D]** docs.

### Phase 0 — Lock behavior and contracts

- **T0.1 [E/T]** Add golden tests proving an uncurated `selected` edge behaves like `all` in both `sourceRunsForStep` and first-input follow-up continuation.
- **T0.2 [E/T]** Add `select` to workflow JSDoc, normalization, public serialization/projection, and validation. Enforce human-review-only plus exactly one input. Test parse/normalize/serialize preservation.
- **T0.3 [S/T]** Define `ReviewRunRef`, candidate, curation DTO, and approve-request contracts with precise TypeScript/JSDoc shapes.
- **T0.4 [E/T]** Refactor the `sourceRunsForStep` push logic only after T0.1; preserve the per-input `seen` scope and fallback key exactly.

### Phase 1 — Selection and engine consumption

- **T1.1 [E/T]** Add `inputRunsForEdge` with selected-array/fallback semantics and unit tests for curated subset, explicit empty, and absent fallback.
- **T1.2 [E/T]** Make `sourceRunsForStep` consume `inputRunsForEdge`; test provenance, dedup, peers unchanged, compact retry, and `hasPriorResults` for empty selection.
- **T1.3 [E/T]** Make `continuationSourceRuns` consume `inputRunsForEdge`; assert the inherited lineup and `existingRunnerId`s contain only approved sessions. Add absent-fallback, empty, and duplicate-instance defensive cases.
- **T1.4 [E/T]** Implement selection candidate resolution and `recordHumanReviewSelection` using `runState.flow` with a loaded-flow fallback. Test structured matching, stale/duplicate/unknown refs, all selected, explicit none, and metadata preservation during later approval.
- **T1.5 [E/T]** Add the empty-selected-follow-up preflight/domain error while allowing contextless new-run consumption.
- **T1.6 [E/T]** Extend archive dependency detection through a selecting review gate. Test `--archive` and `autoArchive: true` before approval.

### Phase 2 — Server and run-details API

- **T2.1 [S/T]** Build `reviewCuration` in run details from the normalized flow and durable upstream runs; include current refs without duplicating result bodies.
- **T2.2 [S/T]** Extend both approve route implementations to validate `selectedRunRefs`, record selection, and only then call `startResumeRun`.
- **T2.3 [S/T]** Cover old-client omission, non-selecting review approval, invalid/stale refs, zero-follow-up rejection, persistence failure, and capability gates.
- **T2.4 [S/T]** Prove a spawn failure leaves an awaiting, retryable gate with its recorded selection and does not mark it approved.

### Phase 3 — Dashboard UI

- **T3.1 [W/T]** Render the purpose-built candidate DTO as a checkbox list in the review timeline panel, defaulting to all selected and restoring durable choices.
- **T3.2 [W/T]** Thread structured refs through the API client and mutation; use composite row keys and preserve loading/cancel behavior.
- **T3.3 [W/T]** Add empty-selection confirmation for allowed new-run cases and blocking copy for follow-up continuation.
- **T3.4 [W/T]** Add component tests covering defaults, rehydration, subset payload, explicit empty, retry state, and accessibility labels.
- **T3.5 [W]** Run `npm run dashboard:build` after the UI changes and fix any build/type failures.

### Phase 4 — Transport boundary, integration, and docs

- **T4.1 [E/T]** Add a targeted runtime/preflight diagnostic for `select: true` with resolved GitHub transport; prove ordinary GitHub human-review still works.
- **T4.2 [T]** Add a local integration fixture for fan-out → review → selected new-run context.
- **T4.3 [T]** Add a local integration fixture for fan-out → review → selected follow-up. Assert only selected runner ids become `existingRunnerId`s and unselected sessions are not submitted.
- **T4.4 [T]** Add durable JSON round-trip coverage proving `[]` and `undefined` remain distinct.
- **T4.5 [D]** Rewrite and re-enable `workflows/human-review-example/flow.yml` as the selected follow-up fixture, explicitly using Netlify API transport.
- **T4.6 [D]** Update canonical user-facing docs under `site/content` for `select`, `results: selected`, local-only scope, default-all behavior, explicit-zero behavior, and the single-input V1 constraint.

### Phase 5 — Deferred follow-up work

- **T5.1** Specify multi-input curation, including cross-step identity, repeated runner/session dedup, and continuation ambiguity.
- **T5.2** Specify downstream skip semantics for an empty approved selection.
- **T5.3** Specify unification with the dashboard follow-up modal's artifact/run selection vocabulary.

**Critical path:** T0.1/T0.2/T0.3 → T1.1 → T1.2/T1.3 → T1.4/T1.5/T1.6 → T2.1/T2.2 → T3.1/T3.2/T3.3 → T3.4/T3.5 → T4.3/T4.5/T4.6.

---

## 6. Testing strategy and acceptance criteria

### 6.1 Engine matrix

| Source state / edge | New-run context | Follow-up continuation |
| --- | --- | --- |
| No curation metadata + `selected` | Falls back to all | Inherits all completed sessions |
| Non-empty `selectedRuns` | Injects only selected runs | Inherits only selected sessions |
| Explicit `selectedRuns: []` | No prior-result context | Rejected before resume |
| `all` | Unchanged | Unchanged |
| `peers` | Unchanged per-instance filtering | Existing first-input lineage behavior unchanged |

### 6.2 Must-have assertions

- Review `stepState.runs` remains empty after selection and approval.
- Usage totals, projected sessions, and step artifacts contain upstream runs only once.
- Selection save/read/JSON round-trip preserves `[]` versus missing metadata.
- Prompt grouping reports the review edge while `curatedFromStep` records the original source.
- A selected follow-up submits exactly the selected count and uses exactly their runner ids.
- Unselected runners remain untouched.
- Candidate sessions are not archived before a future selected follow-up consumes them.
- Invalid, duplicate, or stale selection refs fail before resume starts.
- Old clients and old persisted `selected` edges retain pass-all behavior.
- Ordinary non-selecting human-review works on both current transports.

### 6.3 Test locations

- `tests/unit/flow-execution.test.js` or focused execution-context tests for base-pool and prompt behavior.
- `tests/unit/multi-instance-execution.test.js` for continuation lineup and runner pairing.
- Human-review unit tests for selection resolution, persistence, approval preservation, and zero rules.
- Archive tests beside existing `futureFollowUpReferencesStep` coverage.
- Dashboard server/API tests for the DTO and two approve adapters.
- Dashboard component tests plus an E2E covering untick → Continue → selected-only continuation.

---

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Context filtering works but continuation still reads empty review runs | Shared `inputRunsForEdge` is required by both consumption paths; selected follow-up is on the critical path. |
| Curated copies double-count usage or render duplicate sessions | Keep top-level review `runs` empty and add usage/projection/artifact regression tests. |
| Same `instanceId` appears in several source steps | V1 requires one review input and persists structured source-aware refs. |
| Empty selection is confused with missing legacy metadata | Preserve `[]` versus `undefined` through storage and test it explicitly. |
| Empty follow-up produces a confusing executor failure | Reject before resume with a targeted error; retain executor defense in depth. |
| Candidate runners are archived before continuation | Traverse the selecting review indirection in future-follow-up dependency checks. |
| Selection is saved but approval subprocess fails to start | Keep the gate awaiting and make the saved choice safely retryable. |
| Server approves twice | Selection recording does not transition gate status; spawned resume remains the sole approver. |
| UI reconstructs the wrong candidate pool | Server emits a purpose-built curation DTO from durable state plus normalized flow. |
| GitHub silently ignores curation | Reject only `select: true` on resolved GitHub transport with a targeted diagnostic. |
| `selectedRuns` increases workflow-state size | Store existing result/blob references, not expanded blob contents; selection remains bounded by the step lineup. |

---

## 8. Out of scope

- GitHub-transport curated passthrough.
- Multi-input selecting reviews.
- Automatic downstream-step skipping when zero results are approved.
- Per-artifact or sub-run curation.
- Automated, non-human selection policies.
- Dashboard follow-up modal selection unification.

---

## 9. Key implementation references

- Context resolution: `src/workflows/engine/execution-context.js` — `sourceRunInstanceId`, `sourceRunsForStep`.
- Continuation resolution: `src/workflows/engine/local-executor.js` — `continuationSourceRuns`, `completedContinuationRuns`, `continuationRunForInstance`.
- Archive dependency: `src/workflows/engine/local-executor.js` — `futureFollowUpReferencesStep`, `archiveEligibleCompletedLocalRuns`.
- Human review: `src/workflows/human-review.js` — state creation, find, approve, cancel.
- Durable embedded flow: `src/storage/local/run-state.js` — `createRunState`.
- Flow validation/normalization: `src/workflows/catalog/flows.js`.
- Dashboard run details: `src/dashboard/shared/run-details.js`, `src/contracts/dashboard.ts`, `RunDetailsModal.tsx`.
- Dashboard approval: `src/dashboard/server.js`, `src/dashboard/api/app.js`, `src/dashboard/transports/local-in-process.js`, `src/cli/main.js`.
- Usage/artifacts: `src/workflows/results/agent-run-results.js`, `src/workflows/artifacts/workflow-artifacts.js`.
- GitHub review support: `src/workflows/engine/github-executor.js`.
- Canonical docs: `site/content`.
- Example: `workflows/human-review-example/flow.yml`.
