# Multi-Instance Agent Configuration ("Arena")

**Status:** Spec v3 — interview-complete + adversarial-review integrated
**Date:** 2026-08-07
**Scope:** `nax` core, CLI, workflow files, execution scheduler, follow-ups, persistence/artifacts, dashboard, docs
**Builds on:** `docs/plans/agent-runner-model-effort-configuration.md` (provider/model/effort program, shipped as NAX 2.0)
**Target versions:** **NAX 2.1** = multi-instance execution + config (+ distinct per-instance artifacts). **NAX 2.2** = Arena comparison UI (port of PR #25842). Arena does **not** ship in 2.1.
**SDK impact:** expected none — `nax-agent-runner-sdk` is per-run and catalog-free (confirmed in Phase 0)
**Related:** upstream arena UI = netlify-react-ui **PR #25842** (closed/unmerged; pin source commit `0e33fcd18b204e5587e7c1c30d5940bfd0b9fba2`); deferred sampling = netlify-labs/nax **issue #45**

---

## 0. Decisions log

From the design interview (2026-08-07) and the adversarial review that followed. The
review's seven findings are integrated below and marked **[R#]**.

1. **Unit = agent instance** (`{provider, model, effort}` with a stable id). Run identity,
   status, selection, artifacts, and follow-up continuation re-key provider → instance id.
2. **Follow-up steps inherit** their lineup from a single designated `input` step and
   continue each instance's own session; they do not declare their own lineup.
   Lineage is **`(sourceStepId, instanceId)`**, not instance id alone **[R3]**.
3. **Default model configurable per provider** (catalog `defaultModel`): `claude →
   claude-fable-5`, `gemini → gemini-3.1-pro-preview`, `codex → gpt-5.6-sol`, `opencode →
   moonshotai/kimi-k3`.
4. **Instance identity is tuple-derived and label-independent** **[R4]**.
   `id = ${agent}:${model ?? 'auto'}:${effort ?? 'auto'}` (resolved catalog ids). `label`
   is **display-only** and never part of the key. **Exact-tuple duplicates are rejected**
   (no label escape hatch); an occurrence discriminator is added only when Best-of-N
   (issue #45) intentionally lands.
5. **Two-pass resolution avoids the transport circularity** **[R1]**:
   normalize intent → choose transport → resolve open instances. Explicit `latest`/pinned
   model/pinned effort count as **pinned intent** *before* transport selection; a bare
   open provider is **not** pinned intent.
6. **`latest`/`default` resolves at launch** to the provider default; the resolved
   concrete model is recorded on the run/artifact.
7. **Open resolution is transport-aware.** After transport is chosen: Netlify API → the
   provider `defaultModel`; GitHub Action → Auto/omit (it can't carry a model).
8. **Execution bounds simultaneous *non-terminal* runners, not submissions** **[R2]**.
   Backend caps ~5 concurrent runs and it is not user-tunable. A wave scheduler holds a
   slot until its run reaches a **terminal** state, hardcoded cap `5`.
9. **Partial failure has explicit step states** **[R5]** — success-with-failures vs
   all-failed vs final-step partial (+ exit code), plus resume/retry and a
   `completed_with_failures` status. Isolate & continue is the default.
10. **Fan-out cost guard = soft cap + confirm** above 6 instances/step. Preview always
    lists every instance.
11. **Synthesis relies on the SDK's prompt blob-offload**; no new truncation.
12. **GitHub transport: full support deferred, not dropped.** Netlify API gets everything
    now; GitHub keeps provider-only councils; pins/multi on GitHub fail closed with a
    "supported once the Action is updated" message. Updating the Action is a separate,
    later effort.
13. **This is a behavioral migration, not a purely additive minor** **[R6]**. Bare
    providers on Netlify API change from Auto → pinned default (Claude → Fable 5), and
    artifact paths gain instance scoping. Existing flows stay *syntactically* valid but
    behavior and consumer-visible paths change — documented, with compatibility measures
    (provider-path aliases for single-instance steps).
14. **Best-of-N (identical-instance sampling) is a non-goal now** (issue #45).

**Open for ratification** (see §21): whether bare providers should keep Auto and reserve
pinning for `latest` (review's alternative to decision #7), and whether Arena is truly
2.2 vs bundled into 2.1.

---

## 1. Outcome

Make the unit of execution an **agent instance** (`{provider, model, effort}` with a
stable id) so a step runs **any number of instances, including several of the same
provider**. All four use cases — and every combination — become one feature:

1. **Model bake-off** — several models of one provider.
2. **Effort sweep** — one model at several efforts.
3. **Flagship-of-each** — one default per provider (today's council).
4. **Any combination.**

**2.1 delivers** independent runs, per-instance results, and **distinct per-instance
artifacts** for every instance, comparable by opening those artifacts. **2.2 adds** the
Arena side-by-side comparison UI (§10.4). 2.1 does not depend on Arena.

```text
lineup (string-or-object + fan-out)
        │  ① normalize intent (pins/latest = pinned)         [two-pass — R1]
        ▼
  intent lineup ──► ② choose transport (pinned/multi → netlify-api)
        │                                    │
        │  ③ resolve open per transport      │
        ▼                                    ▼
   [ {agent, model?, effort?, id, label?}, … ]   unique by tuple (reject dup)  [R4]
        │  soft cap 6 → confirm
        ▼
  wave scheduler: ≤5 non-terminal runners at once  [R2]  → 1 AgentRun + 1 handle each
        │
  follow-up continues each (sourceStepId, instanceId) session; failures isolate  [R3,R5]
        ▼
  state / artifacts / events / dashboard keyed by instance id   (Arena view = 2.2)
```

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Provider / agent** | `claude`/`gemini`/`codex`/`opencode` — the `agent` wire field. |
| **Model / Effort** | Model id or `latest` alias; `low`..`max` (`max`→wire `xhigh` where required). |
| **Agent instance** | Resolved `{provider, model, effort}` → exactly one run. |
| **Instance id** | `provider:model:effort` (resolved ids; `auto` when omitted). Tuple-derived, label-independent. |
| **Lineage** | `(sourceStepId, instanceId)` — how a follow-up maps to a prior session. |
| **Lineup** | The ordered set of instances a step runs. |
| **Fan-out entry** | `models: […]` / `efforts: […]` shorthand → cartesian instances. |
| **Open instance** | No pinned model — resolves to provider default (Netlify) or Auto (GitHub). |
| **Alias** | `latest`/`default` → provider `defaultModel` at launch. |
| **Arena** | Side-by-side comparison of a step's instance outputs (2.2, PR #25842). |

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
(Effort is in the instance id, so these are three distinct instances.)
### 3.3 Flagship of each provider (today's council)
```yaml
agents: [claude, gemini, codex]     # open → per-provider default (Netlify) / Auto (GitHub)
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

Verified in the tree:

- **Run identity is provider-keyed** (status maps, selection). Locked decision #5 of the
  model/effort program — reopened here.
- **Follow-up matches by provider** — `src/workflows/followups/plan.js:97`
  (`agent === targetAgent`). Ambiguous with two Claudes.
- **Multi-input source collection preserves the source step** —
  `sourceRunsForStep` in `src/workflows/engine/execution-context.js` iterates `step.input`.
  Any inheritance keyed by instance id alone would discard that source **[R3]**.
- **Schema is provider-keyed** — `agents/models/efforts` maps can't hold two `claude`.
- **The executor fan-outs *submissions*, not bounded runs** —
  `src/workflows/engine/local-executor.js:806` `Promise.allSettled(runs.map(submit))`;
  terminal results are awaited later in `completeLocalStep` (~`:889`). Bounding submission
  promises would not bound active remote runners **[R2]**.
- **Step status is binary** — `localStepStatus` (`local-executor.js:276`) returns
  `completed` only if every run is completed/dry-run, else `failed` **[R5]**.
- **Transport is chosen from already-materialized config** —
  `src/cli/main.js` computes `materializedAgentConfigurations` *before* `let transport`,
  so transport-aware open resolution is circular unless split into two passes **[R1]**.
- **Catalog + resolver exist** — `src/core/agents/configuration.js`.
- **SDK is per-run** — N instances = N independent `start`/`followUp` calls.

---

## 5. Data model

### 5.1 Instance descriptor
```ts
type AgentInstance = {
  agent: AgentProvider
  model?: string        // resolved concrete id, or undefined = Auto/omit
  effort?: string       // resolved catalog id ('low'..'max'), or undefined = Auto/omit
  id: string            // `${agent}:${model ?? 'auto'}:${effort ?? 'auto'}`  — tuple only [R4]
  label?: string        // display-only; NEVER part of id or persistence key [R4]
}
```

### 5.2 Instance identity and duplicates **[R4]**
- **Identity is generated from the resolved tuple**, independent of `label`. `label` is a
  presentation string only; changing it must never change the key or artifact path.
- Uses resolved catalog ids; `max` (not wire `xhigh`); `auto` for omitted dimensions — so
  an old provider-only run maps to `claude:auto:auto`.
- **Exact-tuple duplicates within a step are rejected** (error names the collision). There
  is no label-based escape hatch — running the identical instance twice is Best-of-N
  (issue #45), which will add an explicit occurrence discriminator to the identity when it
  lands. This keeps the identical-sampling non-goal actually closed.

### 5.3 Artifact slug
Instance artifact paths use a **collision-resistant slug**: a readable prefix plus a short
hash of the full instance id, e.g. `claude__fable-5__high__<8hex>`. This survives model
ids that are not filesystem-safe (`z-ai/glm-5.2`, `~deepseek/…`) and guarantees no two
instances collide. See §11 for the single-instance provider-path alias.

### 5.4 Per-provider defaults
Add `defaultModel` per provider so "flagship" is configurable, not positional:
`claude → claude-fable-5`, `gemini → gemini-3.1-pro-preview`, `codex → gpt-5.6-sol`,
`opencode → moonshotai/kimi-k3`. `getBestModelForProvider` returns `defaultModel`
(fallback `models[0]`). `latest`/`default` and open instances resolve through it.

---

## 6. Resolution pipeline (two-pass) **[R1]**

A single pass is impossible because open resolution depends on transport, and transport
depends on whether anything is pinned. Split it:

**Pass 1 — normalize intent (transport-independent).**
Expand fan-out; classify each entry's model as one of `pinned-concrete`, `pinned-latest`,
or `open`; classify effort as `pinned` or `open`. `latest`/`default` and any explicit
model/effort are **pinned intent**. A bare provider is **open, not pinned**.

**Pass 2 — choose transport.**
`transport:auto` → Netlify API if the lineup has **any pinned intent** or **>1 instance
per provider**; otherwise it may use GitHub. Explicit `transport:github` with pinned intent
or multi-instance **fails closed** (§13).

**Pass 3 — resolve open instances against the chosen transport.**
Netlify API → open model = provider `defaultModel` (pinned on the wire); GitHub → open
model = Auto/omit. Then resolve effort, validate against the catalog, compute the tuple
id, dedupe fan-out, reject exact duplicates, and freeze the resolved instances on the run.
Aliases resolve **once** here; retry/resume never re-resolve.

The CLI currently materializes config before choosing transport
(`src/cli/main.js`); Phase 1 restructures this into the three passes so both the CLI and
dashboard share one ordering.

---

## 7. Workflow file schema

### 7.1 Lineup entries (string-or-object + fan-out)
```yaml
agents:
  - claude                                                # open
  - { agent: claude, model: latest }                      # pinned intent (alias)
  - { agent: claude, model: claude-opus-5, effort: high } # pinned
  - { agent: codex,  model: gpt-5.6-sol, efforts: [medium, high] }        # fan-out ×2
  - { agent: gemini, models: [gemini-3.1-pro-preview, gemini-3.6-flash] } # fan-out ×2
```
String = open; object may set `model`/`models` + `effort`/`efforts` (cartesian fan-out);
multiple same-provider entries allowed; optional display `label`.

### 7.2 Back-compatibility (a documented migration) **[R6]**
- `agents: [claude, gemini, codex]` stays valid; behavior changes on Netlify API (now
  resolves to defaults) — see §13 and the §21 ratification question.
- Legacy `models`/`efforts` maps still apply to the **single bare-string instance** of a
  provider; if a provider appears more than once, the maps are ambiguous → error → object
  form.
- All formats (YAML/JSON/JS/TS/TOML) via `src/workflows/catalog/flows.js`.

### 7.3 Follow-up steps inherit (single continuation source) **[R3]**
```yaml
- id: review
  submit: new-run
  agents:
    - { agent: claude, models: [claude-opus-5, claude-opus-4-8] }
    - { agent: gemini, model: latest }
- id: cross-review
  submit: follow-up
  input: [{ step: review, results: all }]     # continues review's instances by (review, id)
```
- A `follow-up` step continues the instances of **exactly one designated input step** (its
  *continuation source*). For 2.1, if `input` lists multiple steps, the first is the
  continuation source and the others provide **read-only context only** — they do not
  create continuations. A cross-source instance-id collision is therefore impossible
  because lineage is `(sourceStepId, instanceId)`.
- A follow-up step must not declare `agents` (deprecation notice, ignored).
- Migrate bundled `review`/`ideas` follow-up steps (`cross-review`, `cross-score`,
  `react`) to inherit; `new-run` steps (Review's single-Codex `synthesize`) keep their
  declared lineup.

### 7.4 Aliases
`latest`/`default` → provider `defaultModel`. Distinct from OpenCode backend `~…latest`
concrete ids (pass-through). Family aliases are a non-goal.

---

## 8. Execution

### 8.1 Wave scheduler — bound non-terminal runners **[R2]**
The constraint is on **simultaneously active (non-terminal) remote runners**, not
in-flight submission calls. Replace the unbounded submission fan-out
(`local-executor.js:806`) with a scheduler that:

- holds a concurrency slot from **submission through terminal state** (completed / failed /
  cancelled), not just until the submit promise resolves;
- keeps at most `MAX_PARALLEL_RUNS = 5` non-terminal runners at once (hardcoded — the API
  may not report the cap reliably and could fail under a burst; **not** user-tunable);
- submits a wave, waits for those runs to terminate (reusing the existing poll/wait in
  `completeLocalStep`, ~`:889`), then submits the next wave, preserving lineup order;
- keeps SDK capacity-retry as a backstop.

**Test the maximum simultaneous non-terminal runners**, not merely concurrent submission
calls.

### 8.2 Materialize instances
`local-executor.js` creates one `AgentRun` per resolved instance
(`{agent, model, effort, instanceId, instanceLabel}`), resolved once (§6).

### 8.3 Re-key by instance
`agentStatuses` and all provider-keyed maps become instance-id-keyed.
`local-runner.js` / `agent-runner-sdk.js` call `sdk.start`/`sdk.followUp` per instance and
carry config through create, follow-up, capacity/prompt-shrink/manual retry, resume, and
handle reconstruction.

### 8.4 Follow-up inheritance mechanics **[R3]**
Rewrite `followups/plan.js` so a follow-up gathers its **continuation source** step's
resolved instances and, for each, finds the prior run/session for that `(sourceStepId,
instanceId)` and continues it — replacing the `agent === targetAgent` match at `:97`.
Extra `input` steps are read context only. `followups/runner.js`/`persistence.js` follow.

### 8.5 Partial failure — step state machine **[R5]**
Replace the binary `localStepStatus` with:

| Situation | Step status | Notes |
|---|---|---|
| all instances completed | `completed` | as today |
| ≥1 completed, ≥1 failed | `completed_with_failures` | new; step proceeds |
| all instances failed | `failed` | step fails |
| final step, partial | `completed_with_failures` | **process exit code non-zero** so CI still signals failure |

- Follow-ups inherit **only continuable** instances; failed/uncontinuable ones are reported
  and skipped (never silently re-forked fresh).
- Resume/manual retry operate per instance: a partial step can be retried for only its
  failed instances; the succeeded instances are not re-run.
- Dashboard/events surface `completed_with_failures` distinctly (badge + per-instance
  status), so a green step with a dead instance is never silently hidden.

---

## 9. CLI

Instance syntax `provider[:model[:effort]]` (model may be `latest`), comma-lists,
repeatable; `--step-agents "step=…"`. `--models`/`--efforts` remain for single-per-provider
back-compat (multi-use → error → instance syntax). Single-agent `nax run` (provider → model
→ effort, defaults) is the one-instance case. Interactive launch offers **Add instance**;
dry-run/preview lists every resolved instance and confirms above the soft cap (6).

---

## 10. Dashboard

### 10.1–10.3 Config (2.1)
- **Per-instance chips** (not per-provider); the shipped chip UI + caret popover becomes
  per-instance; explicit per-chip remove.
- **Add-instance** picker: provider → multi-select models (default = provider default) →
  multi-select efforts (default = highest) → appends the cartesian instance chips.
  Presets: *flagship of every provider*, *this model × all efforts*, *all models of this
  provider*. Soft cap 6 → confirm.
- **Follow-up steps** show inherited instances read-only, "inherited from &lt;step&gt;".
- Contracts/serializers/projections re-key provider → instance
  (`contracts/workflow.ts`, `contracts/dashboard.ts`, `dashboard/api/serializers.js`,
  `services/mutations.js`, `transports/*`, `api/run-state-projection.js`, web
  `run-projection.ts`, `App.tsx`, `WorkflowNode.tsx`, `WorkflowCanvas.tsx`,
  `ModelEffortFields.tsx`, `agent-catalog-context.tsx`). Expose per-provider defaults in
  the capabilities response. Surface `completed_with_failures`.

### 10.4 Arena comparison — **NAX 2.2**, port of PR #25842
PR #25842 ("feat(agent-runners): add arena mode", **closed/unmerged**, source commit
`0e33fcd18b204e5587e7c1c30d5940bfd0b9fba2`) designed this: multi-select agents + arena
toggle; a `ComparisonPage` (~555 LOC) rendering **one column per runner**
(`CompareRunnerColumn.tsx`) under a `CompareHero.tsx`, reachable from the runs list;
helpers in `helpers/agentRunners.ts`. Plan: adapt into the nax dashboard (Mantine/xyflow)
as the step-level side-by-side compare, on top of the distinct per-instance artifacts.
**Shipped in 2.2, after the 2.1 execution/config core.** Pin the source commit so the port
has a stable reference even though the PR is closed.

---

## 11. Persistence, artifacts, events

- Persist resolved instance (`agent`, `model`, `effort`, `instanceId`, `label`) on
  checkpoints and resume snapshots.
- **Artifact paths** use the §5.3 collision-resistant instance slug. **Compatibility
  [R6]:** when a step has exactly **one instance of a provider**, retain the legacy
  provider-named path (`<runner>/claude.md`) as the canonical/alias path so existing
  artifact consumers keep working; use instance slugs only to disambiguate when a provider
  has **>1 instance** in the step. Document the change either way.
- Session JSON nests `agent_config` (`{agent, model, effort}`) + instance id/label; keep
  intent-vs-observed handling + `configurationMismatch` (incl. `nax-i28x`).
- Markdown/events/projections/round-results group by instance. Old artifacts (`agent`
  only) load as `agent:auto:auto`.

---

## 12. Synthesis / large inputs
Feed all instance outputs to a synthesis/judge step and rely on the SDK's existing prompt
blob-offload for oversized prompts (the E2BIG/argv work). No new truncation.

---

## 13. Transport policy

| Case | Netlify API | GitHub Action |
|---|---|---|
| Bare provider (open) | provider default (pinned) | Auto/omit (as today) |
| Pinned model/effort or `latest` | supported | **fail closed** — "supported once the Action is updated" |
| >1 instance per provider | supported | **fail closed** |

Transport is chosen in Pass 2 (§6) from **intent**, before open resolution. GitHub is not
deprecated; full support requires a separate later update to the external Action + a pinned
SHA bump. Never encode instance config in the prompt.

---

## 14. SDK impact
Expected none. Phase 0 proves two same-provider starts run independently; if any SDK path
keys by provider, that becomes a scoped SDK task, else no SDK release.

---

## 15. Documentation
`site/content`: `reference/workflow-files.mdx`, `reference/commands.mdx`,
`guides/run-workflows.mdx`, `guides/use-the-dashboard.mdx`, `concepts/glossary.mdx`,
`concepts/artifacts.mdx`, `for-agents.mdx`, root `README.md`, and
`src/templates/skills/nax-workflows/SKILL.md`. Document the behavioral migration (§13, §11)
prominently.

---

## 16. Implementation phases

- **Phase 0 — Contracts/fixtures/SDK confirmation.** Two same-provider SDK runs independent;
  fixtures for the four use cases; inventory + guard-tests for every provider-keyed
  map/status/selection/transport site.
- **Phase 1 — Data model + resolution pipeline.** `AgentInstance`, tuple id, dedupe,
  display labels; per-provider `defaultModel`; `latest`; the **two-pass intent → transport
  → resolve** pipeline (§6) shared by CLI + dashboard; fan-out; validation.
- **Phase 2 — Schema/normalization/back-compat.** String-or-object + fan-out across
  formats; legacy-map bridge + ambiguity errors; migrate bundled follow-up steps to inherit.
- **Phase 3 — Execution.** Wave scheduler bounding **non-terminal** runners (cap 5); one
  run per instance; instance-id status keying; follow-up `(sourceStepId, instanceId)`
  continuation; partial-failure state machine + exit codes; instance-slug artifacts +
  single-instance provider-path alias; retry/resume replay.
- **Phase 4 — CLI.** Instance syntax; back-compat supersession; interactive Add-instance;
  preview + soft-cap confirm.
- **Phase 5 — Dashboard config (2.1).** Per-instance chips + edit/remove; Add-instance
  picker + presets + soft cap; inherited follow-up display; re-keyed contracts;
  `completed_with_failures`; build + typecheck + Playwright.
- **Phase 6 — Docs, canary, 2.1 release.** MDX/skill/examples/help; full verification;
  bounded live canary of each use case (incl. a partial-failure run); human gate for 2.1.
- **Phase 7 — Arena comparison (NAX 2.2).** Port PR #25842 into the nax dashboard; its own
  version + release gate.

---

## 17. Test matrix

- **Resolver/pipeline:** two-pass ordering (transport:auto + bare provider is deterministic);
  `latest` = pinned intent forces netlify-api; open → default (Netlify) vs Auto (GitHub);
  fan-out expand + dedupe; **exact-tuple duplicate → error** (no label bypass); wrong-provider
  model / unsupported effort → error; `max`→`xhigh` at send only.
- **Schema:** string-or-object + fan-out in all formats; legacy-map bridge + ambiguity;
  follow-up-with-declared-agents deprecation.
- **Scheduler:** 9 instances never exceed 5 **non-terminal** runners (assert active count,
  not submission count); wave ordering; capacity-retry backstop.
- **Follow-up:** cross-review continues each review instance by `(review, id)`;
  multi-input follow-up continues only the source step; failed instance skipped;
  same tuple in two input steps does not collide.
- **Partial failure:** one-success + failures → `completed_with_failures`; all-failed →
  `failed`; final-step partial → non-zero exit; retry re-runs only failed instances; resume
  preserves succeeded instances.
- **Identity/artifacts:** id is label-independent (relabeling doesn't move the key);
  instance slugs never collide for same-provider instances; single-instance step keeps the
  provider-named path.
- **CLI/dashboard:** instance syntax; effort sweep; presets (bake-off / sweep / flagship);
  soft-cap confirm; GitHub pin/multi fail-fast; contract rejects provider-only arrays.

---

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Transport/open circular resolution | Two-pass pipeline (§6); tests assert deterministic order [R1] |
| Capping submissions ≠ capping active runs | Slot held to terminal; test non-terminal count [R2] |
| Multi-input follow-up lineage ambiguity | Lineage `(sourceStepId, instanceId)`; single continuation source [R3] |
| Mutable label as key / accidental sampling | Tuple-only id; reject exact dups; label display-only [R4] |
| Partial failure undefined | Explicit step state machine + exit codes + retry semantics [R5] |
| "Additive" overstated / consumer path breaks | Document migration; provider-path alias for single-instance [R6] |
| Arena scope creep into 2.1 | Arena is 2.2; 2.1 DoD needs distinct artifacts only [R7] |
| Backend falls over on bursts | Hardcoded wave cap 5; capacity-retry backstop |
| `latest` shifts mid-run | Resolve once; persist concrete; never re-alias |
| Fan-out cost | Soft cap 6 + confirm; preview lists all |

---

## 19. Non-goals
Best-of-N sampling (issue #45); family aliases; updating the GitHub Action;
dynamic catalog discovery; backend changes (incl. `nax-i28x`); Arena UI in 2.1;
user-tunable parallel cap.

## 20. Definition of done (2.1)
- A step runs any number of instances incl. several of one provider; all four use cases
  work in workflow files, CLI, and dashboard, producing distinct per-instance artifacts.
- Identity is tuple-derived and label-independent; exact-tuple duplicates rejected.
- Two-pass resolution is deterministic for `transport:auto`; open resolves per transport;
  `latest`/defaults recorded concrete; retry/resume never re-alias.
- Follow-ups continue by `(sourceStepId, instanceId)` from a single source; partial
  failures yield `completed_with_failures` with correct exit codes and per-instance retry.
- The scheduler never exceeds 5 non-terminal runners (verified by active-count test).
- Existing provider-only flows and shipped model/effort maps still load; the behavioral
  migration is documented; single-instance steps keep provider-named artifact paths.
- GitHub keeps provider-only councils; pins/multi fail closed with a clear "later" message.
- No SDK release required (or a scoped one if Phase 0 finds a provider assumption).
- Docs, dashboard build, Playwright, and a live canary of each use case (+ a partial
  failure) pass; NAX 2.1 handed to the user for publication.
- **Arena (2.2)** is specced against pinned commit `0e33fcd…` for a follow-on release.

## 21. Open questions (ratify before build)
1. **Bare-provider default vs Auto [R6].** Keep decision #7 (bare → provider default on
   Netlify), or adopt the review's alternative (bare stays Auto; only `latest`/explicit
   pins), which keeps councils behavior-identical and avoids forcing netlify-api? *Leaning:
   keep default but document the migration; confirm.*
2. **Arena in 2.1 or 2.2 [R7].** Spec says 2.2. Confirm, or pull Arena into 2.1.
3. Multi-input follow-up: read-only extra inputs (this spec) vs allowing multiple
   continuation sources with explicit lineage.
4. Artifact slug format (readability vs hash length).
