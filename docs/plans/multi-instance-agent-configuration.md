# Multi-Instance Agent Configuration ("Arena")

**Status:** NAX 2.1 implementation complete and live-verified; awaiting required human publication gates. NAX 2.2 Arena UI deferred.
**Date:** 2026-08-07
**Scope:** `nax` core, CLI, workflow files, execution scheduler, follow-ups, persistence/artifacts, dashboard, docs
**Builds on:** `docs/plans/agent-runner-model-effort-configuration.md` (implemented as NAX 2.0; publication pending)
**Target versions:** **NAX 2.1** = multi-instance execution + config + distinct per-instance artifacts. **NAX 2.2** = Arena comparison UI (port of PR #25842).
**SDK impact:** expected none — SDK is per-run and catalog-free (confirmed in Phase 0)
**Related:** arena UI = netlify-react-ui **PR #25842** (closed/unmerged; pin source commit `0e33fcd18b204e5587e7c1c30d5940bfd0b9fba2`); deferred sampling = netlify-labs/nax **issue #45**

**Verification:** `npm run release:verify` passed, including the dashboard build and 15/15
Playwright tests. The gated live canary passed all four use cases plus partial-failure and
all-failed scenarios; see [the canary evidence](../ai/multi-instance-live-canary-evidence.md).

---

## 0. Decisions log

Interview (rounds 1–7, 2026-08-07) + adversarial review. Review findings marked **[R#]**.

1. **Unit = agent instance** (`{provider, model, effort}` + stable id). Run identity, status,
   selection, artifacts, and follow-up continuation re-key provider → instance id.
2. **Instance identity is tuple-derived and label-independent** **[R4]**.
   `id = ${agent}:${model ?? 'auto'}:${effort ?? 'auto'}`. `label` is display-only, never a
   key. **Exact-tuple duplicates are rejected** (no label escape); occurrence discriminator
   arrives only with Best-of-N (issue #45).
3. **Default model configurable per provider** (catalog `defaultModel`): `claude →
   claude-fable-5`, `gemini → gemini-3.1-pro-preview`, `codex → gpt-5.6-sol`, `opencode →
   moonshotai/kimi-k3`.
4. **Bare provider = Auto on the wire; the flagship is a UI/CLI pre-selection only**
   (round 5). A bare provider sends no model (today's behavior preserved, GitHub keeps
   working, no forced transport). Interactive `nax run` prompts and the dashboard
   **Add-instance / chip-edit** pickers pre-select the provider `defaultModel`; accepting it
   creates a pinned instance. Existing bare-provider chips render **Auto** on load
   (opening + running a bundled flow never silently changes transport). This also
   **dissolves the R1 transport circularity** — open is Auto regardless of transport.
5. **Transport is chosen from intent, then resolution completes** **[R1]** (§6). Explicit
   model / `latest` / pinned effort / >1-instance-per-provider are pinned intent →
   Netlify API. Open bare instances contribute no pinned intent and resolve to Auto
   independent of transport (no circular dependency).
6. **`latest`/`default` resolves at launch** to the provider `defaultModel`; the concrete
   result is recorded on the run/artifact (with `resolvedFrom` provenance).
7. **Follow-up steps inherit from a single continuation source** **[R3]** (the first
   `input` step); extra inputs are read-only context. Lineage is `(sourceStepId,
   instanceId)`. Follow-up steps declare no lineup.
8. **Wave scheduler bounds simultaneous *non-terminal* runners** **[R2]**, hardcoded cap
   `5`, **per workflow run** (concurrent runs on one site rely on SDK capacity-retry as a
   backstop). A slot frees at **result-ready** (landing/PR/deploy continues async, outside
   the cap).
9. **Partial failure** **[R5]**: each instance auto-retries within its budget; then —
   ≥1 survivor → `completed_with_failures`, workflow continues with survivors only;
   **all instances failed → `failed`, and the workflow halts (later steps do not run)**;
   final-step partial → non-zero exit code.
10. **Unsupported effort in a fan-out clamps to the nearest supported effort** (round 5),
    with a logged warning.
11. **Fan-out cost guard = count-based soft cap + confirm** above 6 instances/step (no
    credit math).
12. **Synthesis relies on SDK prompt blob-offload**; no new truncation.
13. **GitHub transport: full support deferred, not dropped.** Explicit `transport:github`
    with any pinned/multi instance **fails the whole flow** before dispatch. Netlify API
    gets everything now. Updating the external Action is a separate later effort.
14. **This is a documented migration, not purely additive** **[R6]**: artifact paths gain
    instance scoping (with a provider-path alias for single-instance steps). Behavior on
    the wire is unchanged for bare providers (decision #4), so no council behavior change.
15. **Arena UI = NAX 2.2** **[R7]**; 2.1's comparison is the distinct per-instance
    artifacts. **Best-of-N sampling** is a non-goal (issue #45).
16. **Re-run vs retry of `latest`** (my call; user deferred): retry of a run **replays the
    recorded concrete**; a fresh run **re-resolves `latest`** against the current catalog.

---

## 1. Outcome

Make the unit of execution an **agent instance** so a step runs **any number of instances,
including several of the same provider**. All four use cases become one feature:

1. **Model bake-off** — several models of one provider.
2. **Effort sweep** — one model at several efforts.
3. **Flagship-of-each** — one default per provider (today's council).
4. **Any combination.**

**2.1 delivers** independent runs, per-instance results, and **distinct per-instance
artifacts**. **2.2 adds** the Arena side-by-side comparison UI (§10.4).

```text
lineup (string-or-object + fan-out)
        │  normalize intent (pins/latest/effort = pinned; bare = open/auto)
        ▼
  choose transport from intent (pinned/multi → netlify-api)     [no circularity — R1/#4]
        │
        │  resolve: open → auto (wire); latest/default → defaultModel; clamp effort
        ▼
   [ {agent, model?, effort?, id, label?}, … ]   unique by tuple (reject dup)  [R4]
        │  count soft cap 6 → confirm
        ▼
  wave scheduler: ≤5 non-terminal runners; slot frees at result-ready  [R2]
        │
  follow-up continues each (sourceStepId, instanceId); auto-retry; survivors proceed;
  all-failed halts the workflow                                          [R3,R5]
        ▼
  state / artifacts / events / dashboard keyed by instance id   (Arena view = 2.2)
```

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Provider / agent** | `claude`/`gemini`/`codex`/`opencode` — the `agent` wire field. |
| **Model / Effort** | Model id or `latest`; `low`..`max` (`max`→wire `xhigh` where required). |
| **Agent instance** | Resolved `{provider, model, effort}` → one run. |
| **Instance id** | `provider:model:effort` (resolved ids; `auto` when omitted). Tuple-derived, label-independent. |
| **Lineage** | `(sourceStepId, instanceId)` — how a follow-up maps to a prior session. |
| **Lineup / Fan-out** | Ordered instance set; `models:[…]`/`efforts:[…]` → cartesian. |
| **Open instance** | No pinned model — Auto on the wire; UI pre-selects the default. |
| **Alias** | `latest`/`default` → provider `defaultModel` at launch. |
| **Arena** | Side-by-side comparison of a step's instance outputs (2.2). |

---

## 3. Motivating use cases

### 3.1 Model bake-off
```yaml
agents:
  - { agent: claude, models: [claude-opus-5, claude-opus-4-8, claude-opus-4-7] }
```
### 3.2 Effort sweep
```yaml
agents:
  - { agent: claude, model: claude-opus-5, efforts: [low, medium, high] }
```
(Effort is in the id, so three distinct instances.)
### 3.3 Flagship of each provider (today's council)
```yaml
agents: [claude, gemini, codex]     # bare = Auto on the wire; UI pre-selects flagship
```
### 3.4 Any combination
```yaml
agents:
  - { agent: claude, models: [claude-opus-5, claude-opus-4-8] }
  - { agent: gemini, model: latest }
  - { agent: codex,  model: gpt-5.6-sol, efforts: [medium, high] }
```

---

## 4. Current architecture and the constraints being lifted

- **Run identity is provider-keyed** (status maps, selection) — locked decision #5 of the
  model/effort program, reopened.
- **Follow-up matches by provider** — `followups/plan.js:97` (`agent === targetAgent`).
- **Multi-input source collection preserves source** — `sourceRunsForStep` in
  `engine/execution-context.js` iterates `step.input` **[R3]**.
- **Schema is provider-keyed** — `agents/models/efforts` maps can't hold two `claude`.
- **Executor fan-outs *submissions*, not bounded runs** — `local-executor.js:806`
  `Promise.allSettled(runs.map(submit))`; terminal results awaited later in
  `completeLocalStep` (~`:889`) **[R2]**.
- **Step status is binary** — `localStepStatus` (`local-executor.js:276`) **[R5]**.
- **Transport chosen from already-materialized config** —
  `materializedAgentConfigurations` before `let transport` in `src/cli/main.js`; would be
  circular under transport-aware open resolution, but decision #4 makes open Auto (no
  transport dependence) so the circularity disappears **[R1]**.
- **Catalog + resolver exist** — `src/core/agents/configuration.js`.
- **SDK is per-run** — N instances = N independent calls.

---

## 5. Data model

### 5.1 Instance descriptor
```ts
type AgentInstance = {
  agent: AgentProvider
  model?: string        // resolved concrete id, or undefined = Auto/omit
  effort?: string       // resolved catalog id ('low'..'max'), or undefined = Auto/omit
  id: string            // `${agent}:${model ?? 'auto'}:${effort ?? 'auto'}` — tuple only [R4]
  label?: string        // display-only; never part of id or artifact key [R4]
  resolvedFrom?: 'latest' | 'default' | 'open' | 'pinned'   // provenance for re-run/repro
}
```

### 5.2 Identity and duplicates **[R4]**
Identity is generated from the resolved tuple, independent of `label`. Uses resolved
catalog ids; `max` (not wire `xhigh`); `auto` for omitted dims (so old provider-only runs
map to `claude:auto:auto`). **Exact-tuple duplicates within a step are rejected**; running
the identical instance twice is Best-of-N (issue #45), which will add an occurrence
discriminator to the identity.

### 5.3 Artifact slug
When a provider appears more than once in a step, sanitize the resolved tuple components
into `provider__model__effort`, for example `claude__claude-opus-5__high`. This safely
normalizes non-filesystem-safe catalog model ids (`z-ai/glm-5.2`, `~deepseek/…`); exact
tuples are rejected and the supported catalog tuples remain distinct. See §11 for the
single-instance provider-path alias.

### 5.4 Per-provider defaults
`defaultModel` per provider (`claude → claude-fable-5`, `gemini → gemini-3.1-pro-preview`,
`codex → gpt-5.6-sol`, `opencode → moonshotai/kimi-k3`). `getBestModelForProvider` returns
it (fallback `models[0]`). Used by `latest`/`default` and by UI pre-selection — **not** by
wire resolution of a bare provider (that stays Auto).

---

## 6. Resolution pipeline

Ordered, but no longer circular (decision #4):

1. **Normalize intent.** Expand fan-out. Classify model as `pinned-concrete`,
   `pinned-latest`, or `open`; effort as `pinned` or `open`. Explicit model/`latest`/effort
   = pinned intent; bare provider = open. (In interactive UI/CLI, accepting the pre-selected
   flagship happens *before* this — it arrives as a pinned-concrete instance.)
2. **Choose transport.** `transport:auto` → Netlify API if any pinned intent or >1 instance
   per provider; else GitHub is allowed. Explicit `transport:github` + any pinned/multi →
   **fail the whole flow** (§13).
3. **Resolve.** `latest`/`default` → `defaultModel` (record `resolvedFrom`); open → Auto
   (omit); pinned → verbatim (unknown ids pass through with a warning). Resolve effort;
   **clamp** an unsupported effort to the nearest supported one (log a warning); validate;
   compute tuple id; dedupe fan-out; reject exact duplicates; freeze on the run. Aliases
   resolve **once**; retry/resume never re-resolve.

Phase 1 restructures `src/cli/main.js` (currently intent-before-transport) into these steps,
shared by CLI + dashboard.

### 6.1 Effort clamping (decision #10)
For an unsupported requested effort, map to the nearest supported effort by rank
(`low < medium < high < max`), rounding **up** on ties (below-min → min; above-max → max),
and log a warning. Example: `[low, medium, high]` on GLM 5.2 (supports `high`, `max`) →
`high` (with a warning that low/medium were clamped); the three-way fan-out dedupes to one
instance.

---

## 7. Workflow file schema

### 7.1 Lineup entries
```yaml
agents:
  - claude                                                # open (Auto on wire)
  - { agent: claude, model: latest }                      # pinned intent (alias)
  - { agent: claude, model: claude-opus-5, effort: high } # pinned
  - { agent: codex,  model: gpt-5.6-sol, efforts: [medium, high] }        # fan-out ×2
  - { agent: gemini, models: [gemini-3.1-pro-preview, gemini-3.6-flash] } # fan-out ×2
```
String = open; object may set `model`/`models` + `effort`/`efforts` (cartesian); multiple
same-provider entries allowed; optional display `label`.

### 7.2 Back-compatibility
- `agents: [claude, gemini, codex]` unchanged in behavior (bare = Auto, decision #4).
- Legacy `models`/`efforts` maps apply to the **single** bare-string instance of a provider;
  a provider used more than once → ambiguity error → object form.
- All formats via `src/workflows/catalog/flows.js`.

### 7.3 Follow-up steps inherit (single source) **[R3]**
```yaml
- id: review
  submit: new-run
  agents:
    - { agent: claude, models: [claude-opus-5, claude-opus-4-8] }
    - { agent: gemini, model: latest }
- id: cross-review
  submit: follow-up
  input: [{ step: review, results: all }]   # continues review's instances by (review, id)
```
- A follow-up continues the instances of **exactly one continuation source** — the first
  `input` step. Extra `input` steps are read-only context only. Lineage is `(sourceStepId,
  instanceId)`, so cross-source id collisions can't occur.
- A follow-up must not declare `agents` (deprecation notice, ignored).
- Migrate bundled `review`/`ideas` follow-up steps (`cross-review`, `cross-score`, `react`)
  to inherit; `new-run` steps keep their declared lineup.

### 7.4 Aliases
`latest`/`default` → `defaultModel`. Distinct from OpenCode backend `~…latest` concrete ids
(pass-through). Family aliases are a non-goal.

---

## 8. Execution

### 8.1 Wave scheduler — bound non-terminal runners **[R2]**
Replace the unbounded submission fan-out (`local-executor.js:806`) with a scheduler that:

- holds a slot from submission until the run reaches **result-ready** (its result exists);
  landing (PR merge / deploy) then proceeds **asynchronously, outside the cap** (decision #8);
- keeps at most `MAX_PARALLEL_RUNS = 5` non-terminal runners at once (hardcoded; not
  auto-detected, not user-tunable), **per workflow run**;
- submits a wave, waits for those runs to reach result-ready (reusing the poll/wait in
  `completeLocalStep`, ~`:889`), then the next wave, preserving lineup order;
- relies on SDK capacity-retry as a backstop (incl. cross-run contention on a shared site).

Tests assert the maximum simultaneous **non-terminal runners**, not submission calls.

### 8.2–8.3 Materialize + re-key
One `AgentRun` per resolved instance (`{agent, model, effort, instanceId, instanceLabel,
resolvedFrom}`), resolved once. `agentStatuses` and all provider-keyed maps become
instance-id-keyed; `local-runner.js`/`agent-runner-sdk.js` carry config through create,
follow-up, capacity/prompt-shrink/manual retry, resume, handle reconstruction.

### 8.4 Follow-up inheritance **[R3]**
Rewrite `followups/plan.js` to continue the **continuation source** step's instances by
`(sourceStepId, instanceId)`, replacing the provider match at `:97`.

### 8.5 Partial failure — state machine **[R5]**, decision #9
- Each instance auto-retries within its retry budget (capacity + configured retries).
- After retries, classify the step:

| Situation | Step status | Workflow |
|---|---|---|
| all completed | `completed` | continue |
| ≥1 completed, ≥1 failed | `completed_with_failures` | continue; follow-up ← survivors only |
| **all failed** | `failed` | **halt — later steps do not run** |
| final step, partial | `completed_with_failures` | **non-zero exit code** |

- Manual retry of a failed instance in a partial step runs standalone; it does not
  retroactively re-thread into an already-run follow-up (re-running the flow is the clean
  path). Resume/retry re-runs only failed instances; survivors are not re-run.
- Dashboard/events surface `completed_with_failures` distinctly (badge + per-instance
  status).

### 8.6 Re-run vs retry of `latest` (decision #16)
Retry of a run replays the recorded concrete instance (never re-alias). A fresh run of a
`latest`/open flow re-resolves against the current catalog; `resolvedFrom` records origin so
the difference is visible in artifacts.

---

## 9. CLI

Instance syntax `provider[:model[:effort]]` (`latest` allowed), comma-lists, repeatable;
`--step-agents "step=…"`. `--models`/`--efforts` remain for single-per-provider back-compat
(multi-use → error → instance syntax). Single-agent `nax run` (provider → model → effort,
flagship pre-selected) is the one-instance case; **non-interactive bare providers stay Auto**
(no pre-select). Interactive workflow launch offers **Add instance**. Dry-run/preview lists
every resolved instance and confirms above the soft cap (6, count-based).

---

## 10. Dashboard

### 10.1–10.3 Config (2.1)
- **Per-instance chips**; the shipped chip UI + caret popover becomes per-instance; explicit
  per-chip remove. **Existing bare-provider chips render Auto on load** (decision #4) — no
  silent transport switch.
- **Add-instance** picker: provider → multi-select models (**flagship pre-selected**) →
  multi-select efforts (highest pre-selected) → appends the cartesian instance chips.
  Presets: *flagship of every provider*, *this model × all efforts*, *all models of this
  provider*. Count soft cap 6 → confirm.
- **Follow-up steps** show inherited instances read-only, "inherited from &lt;step&gt;".
- Re-key contracts/serializers/projections provider → instance (`contracts/workflow.ts`,
  `contracts/dashboard.ts`, `dashboard/api/serializers.js`, `services/mutations.js`,
  `transports/*`, `api/run-state-projection.js`, web `run-projection.ts`, `App.tsx`,
  `WorkflowNode.tsx`, `WorkflowCanvas.tsx`, `ModelEffortFields.tsx`,
  `agent-catalog-context.tsx`). Expose per-provider defaults in capabilities. Surface
  `completed_with_failures`.

### 10.4 Arena comparison — **NAX 2.2**, port of PR #25842
PR #25842 ("feat(agent-runners): add arena mode", closed/unmerged, source commit
`0e33fcd18b204e5587e7c1c30d5940bfd0b9fba2`): multi-select agents + arena toggle; a
`ComparisonPage` (~555 LOC) rendering **one column per runner** (`CompareRunnerColumn.tsx`)
under a `CompareHero.tsx`; helpers in `helpers/agentRunners.ts`. Adapt into the nax dashboard
(Mantine/xyflow) as the step-level side-by-side compare over the distinct per-instance
artifacts. **Shipped in 2.2, after the 2.1 core.**

---

## 11. Persistence, artifacts, events

- Persist the resolved instance (`agent`, `model`, `effort`, `instanceId`, `label`,
  `resolvedFrom`) on checkpoints and resume snapshots.
- **Artifact paths** use the §5.3 slug. **Compatibility [R6]:** when a step has exactly one
  instance of a provider, retain the legacy provider-named path (`<runner>/claude.md`) as
  the canonical/alias; use instance slugs only to disambiguate a provider with >1 instance.
- Session JSON nests `agent_config` (`{agent, model, effort}`) + instance id/label; keep
  intent-vs-observed + `configurationMismatch` (incl. `nax-i28x`).
- Markdown/events/projections/round-results group by instance. Old artifacts load as
  `agent:auto:auto`.

---

## 12. Synthesis / large inputs
Feed all instance outputs to a synthesis/judge step; rely on the SDK's prompt blob-offload
for oversized prompts. No new truncation.

---

## 13. Transport policy

| Case | Netlify API | GitHub Action |
|---|---|---|
| Bare provider (open) | Auto/omit | Auto/omit (as today) |
| Pinned model/effort or `latest` | supported | **fail the whole flow** (explicit github) |
| >1 instance per provider | supported | **fail the whole flow** |

`transport:auto` chooses Netlify API when any pinned intent or multi-instance is present
(§6). GitHub is not deprecated; full support needs a separate Action update + pinned-SHA
bump. Never encode instance config in the prompt.

---

## 14. SDK impact
Expected none. Phase 0 proves two same-provider starts run independently; else a scoped SDK
task.

---

## 15. Documentation
`site/content`: `reference/workflow-files.mdx`, `reference/commands.mdx`,
`guides/run-workflows.mdx`, `guides/use-the-dashboard.mdx`, `concepts/glossary.mdx`,
`concepts/artifacts.mdx`, `for-agents.mdx`, root `README.md`, and
`src/templates/skills/nax-workflows/SKILL.md`. Document the artifact-path change (§11) and
that bare providers remain Auto (§4).

---

## 16. Implementation phases

- **Phase 0 — Complete.** SDK two-same-provider confirmation; fixtures for the four use cases;
  inventory + guard-tests for every provider-keyed map/status/selection/transport site.
- **Phase 1 — Complete.** `AgentInstance`, tuple id, dedupe, labels, `resolvedFrom`; per-provider
  `defaultModel`; `latest`; the resolution pipeline (§6) + effort clamping; fan-out;
  validation; restructure `main.js` intent → transport → resolve.
- **Phase 2 — Complete.** String-or-object + fan-out across formats; legacy-map bridge + ambiguity;
  migrate bundled follow-up steps to inherit.
- **Phase 3 — Complete.** Wave scheduler (non-terminal cap 5, result-ready slot release); one run per
  instance; instance-id status keying; `(sourceStepId, instanceId)` continuation;
  partial-failure state machine (survivors proceed, all-failed halts, exit codes);
  instance-slug artifacts + single-instance provider alias; retry/resume replay.
- **Phase 4 — Complete.** CLI instance syntax; back-compat; interactive Add-instance; preview + soft
  cap.
- **Phase 5 — Complete.** Dashboard config: per-instance chips (Auto on load) + edit/remove;
  Add-instance picker (flagship pre-select) + presets + soft cap; inherited follow-up
  display; re-keyed contracts; `completed_with_failures`; build + typecheck + Playwright.
- **Phase 6 — Awaiting human publication.** Docs and live canary are complete, including
  partial-failure and all-failed runs. NAX 2.0 must pass its human publication gate before
  the NAX 2.1 publication gate can proceed.
- **Phase 7 (NAX 2.2) — Not started.** Arena comparison port of PR #25842 (@ `0e33fcd…`);
  blocked on the NAX 2.1 human publication gate and followed by its own release gate.

---

## 17. Test matrix

- **Resolver/pipeline:** transport:auto + bare provider is deterministic and Auto on the
  wire; `latest` = pinned intent → netlify-api; effort clamp to nearest (+ warning);
  fan-out dedupe; **exact-tuple duplicate → error**; wrong-provider / unsupported (post-clamp
  impossible) → error; `max`→`xhigh` at send.
- **Schema:** string-or-object + fan-out in all formats; legacy-map bridge + ambiguity;
  follow-up-with-declared-agents deprecation.
- **Scheduler:** 9 instances never exceed 5 **non-terminal** runners (assert active count);
  slot frees at result-ready while landing continues; wave ordering; capacity-retry backstop.
- **Follow-up:** continues each source instance by `(sourceStepId, instanceId)`; extra input
  = context only; same tuple in two inputs doesn't collide.
- **Partial failure:** auto-retry then survivors → `completed_with_failures` continue;
  all-failed → `failed` + workflow halts; final-step partial → non-zero exit; retry re-runs
  only failed; resume preserves survivors.
- **Identity/artifacts:** id label-independent (relabel doesn't move key); slugs never
  collide; single-instance step keeps the provider path.
- **CLI/dashboard:** instance syntax; effort sweep; presets; non-interactive bare = Auto;
  bare chips Auto on load; Add-picker flagship pre-select; soft-cap confirm; explicit-github
  + pin fails whole flow; contract rejects provider-only arrays.

---

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Transport/open circularity | Dissolved: bare = Auto (decision #4); transport from intent only [R1] |
| Capping submissions ≠ active runs | Slot to result-ready; test non-terminal count [R2] |
| Multi-input follow-up ambiguity | `(sourceStepId, instanceId)`; single continuation source [R3] |
| Mutable label as key / accidental sampling | Tuple-only id; reject exact dups [R4] |
| Partial failure undefined | State machine + exit codes + all-failed halt [R5] |
| Consumer artifact-path break | Provider-path alias for single-instance steps [R6] |
| Arena scope creep | Arena is 2.2; 2.1 needs distinct artifacts only [R7] |
| Cross-run contention on a site | Per-run cap 5 + SDK capacity-retry backstop |
| Silent effort clamp surprises | Clamp is logged; documented mapping |
| `latest` drift | Resolve once per run; retry replays concrete; `resolvedFrom` recorded |
| Fan-out cost | Count soft cap 6 + confirm; preview lists all |

---

## 19. Non-goals
Best-of-N sampling (issue #45); family aliases; updating the GitHub Action; dynamic catalog
discovery; backend changes (incl. `nax-i28x`); Arena UI in 2.1; user-tunable parallel cap;
credit-cost estimation.

## 20. Definition of done (2.1)
- A step runs any number of instances incl. several of one provider; all four use cases work
  in workflow files, CLI, and dashboard, producing distinct per-instance artifacts.
- Identity is tuple-derived, label-independent; exact-tuple duplicates rejected.
- Bare providers stay Auto on the wire (no council behavior change); flagship is a UI/CLI
  pre-selection; `latest`/defaults recorded concrete with provenance; retry replays, re-run
  re-resolves.
- Transport is chosen from intent (deterministic); effort clamps to nearest (logged).
- Follow-ups continue by `(sourceStepId, instanceId)` from a single source; auto-retry then
  survivors proceed; all-failed halts; correct exit codes.
- Scheduler never exceeds 5 non-terminal runners (active-count test); slot frees at
  result-ready.
- Existing flows and shipped model/effort maps still load; single-instance steps keep
  provider-named artifact paths.
- Explicit GitHub + pin/multi fails the whole flow with a clear "later" message.
- No SDK release required (or scoped if Phase 0 finds a provider assumption).
- Docs, dashboard build, Playwright, and a live canary of each use case (+ partial and
  all-failed) pass; NAX 2.1 handed to the user for publication.
- **Arena (2.2)** specced against pinned commit `0e33fcd…`.
