# Multi-Instance Agent Configuration ("Arena")

**Status:** Interview-complete spec (v2) — ready for GPT Pro refinement / beads conversion
**Date:** 2026-08-07
**Scope:** `nax` core, CLI, workflow files, execution scheduler, follow-ups, persistence/artifacts, dashboard, docs
**Builds on:** `docs/plans/agent-runner-model-effort-configuration.md` (provider/model/effort program, shipped as NAX 2.0)
**Target version:** NAX **2.1** (additive, back-compat; ships after 2.0 is published)
**SDK impact:** expected none — `nax-agent-runner-sdk` is already per-run and catalog-free (confirmed in Phase 0)
**Related:** upstream arena UI = netlify-react-ui **PR #25842**; deferred sampling idea = netlify-labs/nax **issue #45**

---

## 0. Decisions log (from design interview, 2026-08-07)

These are settled; the body elaborates each.

1. **Unit = agent instance** (`{provider, model, effort}` with a stable id). Run identity, status, selection, artifacts, and follow-up continuation re-key from provider → instance id.
2. **Follow-up steps inherit** their lineup from the step they take `input` from and continue each instance's own session; they do not declare their own lineup.
3. **Default model is configurable per provider** (catalog `defaultModel`): `claude → claude-fable-5`, `gemini → gemini-3.1-pro-preview`, `codex → gpt-5.6-sol`, `opencode → moonshotai/kimi-k3`. "Best/flagship" is data, not list position.
4. **Open instance resolution is transport-aware.** On Netlify API a bare provider resolves to its default model (pinned). On the GitHub Action transport it stays Auto/omit (the Action can't carry a model). This changes existing council behavior **on Netlify API only** (they now pin the default model).
5. **`latest`/`default` alias resolves at launch** to the provider default; the resolved concrete model is recorded on the run/artifact (rot-proof flows, reproducible runs).
6. **Comparison = "arena mode"** — port netlify-react-ui PR #25842's side-by-side comparison (`ComparisonPage`/`CompareHero`/`CompareRunnerColumn`) into the nax dashboard, plus keep distinct per-instance artifacts. **Documented here; built in a later phase, not now.**
7. **Cross-review stays N-runs-per-step.** Step 1 = each instance reviews; step 2 = each instance re-reads the *others'* step-1 results once (via inheritance + `input: results: all`). Not N×N pairwise.
8. **Fan-out cost guard = soft cap + confirm.** Preview always lists every instance; above **6** instances/step require an explicit confirm. No hard block.
9. **Execution runs in waves.** The backend caps parallel runs (~5) and users can't change it. NAX gets a **bounded wave scheduler with a hardcoded cap of 5** (not auto-detected — the API may not report it reliably), replacing today's fire-all.
10. **Synthesis relies on SDK prompt blob-offload** for large multi-instance inputs; no new truncation.
11. **Partial failure isolates & continues.** A failed instance doesn't fail the step; the follow-up inherits only continuable instances; failures are reported/skipped.
12. **GitHub transport: full support is deferred, not dropped.** Netlify API gets everything now. GitHub keeps working provider-only (as today); pinned model/effort or multi-instance on GitHub **fails closed** with a "supported once the Action is updated" message. Updating the external GitHub Action is a separate later effort, out of scope here.
13. **Best-of-N (identical-instance sampling) is a non-goal now** — instances are unique by `provider:model:effort`; tracked as issue #45.

---

## 1. Outcome

Today a workflow step runs **at most one agent per provider** — NAX keys run
identity, status, artifacts, and follow-up continuation by the provider string
(`claude`). This program makes the unit of execution an **agent instance**
(`{provider, model, effort}` with a stable id), so a step can run **any number of
instances, including several of the same provider**, and all four of these — and
every combination — become the same feature:

1. **Model bake-off** — several models of one provider (Opus 5 vs Opus 4.8 vs Opus 4.7).
2. **Effort sweep** — one model at several efforts (Opus 5 at Low/Medium/High).
3. **Flagship-of-each** — one default per provider (today's council).
4. **Any combination** — e.g. two Claudes + a Gemini + Codex at two efforts, in one step.

```text
workflow file / CLI / dashboard  ─┐
                                   ├─►  lineup: string-or-object entries + fan-out
per-provider defaults + `latest` ─┤
interactive choice (open)        ─┘
                                          │  resolve each entry (transport-aware)
                                          ▼
             [ {agent, model?, effort?, id, label?}, ... ]   (unique per step)
                                          │  soft cap 6 → confirm
                                          ▼
      wave scheduler (≤5 concurrent) → one AgentRun + one SDK handle per instance
                                          │
     follow-up steps continue each input-step instance by id (isolate failures)
                                          │
                                          ▼
   state / artifacts / events / dashboard (+ arena compare) keyed by instance id
```

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Provider / agent** | `claude`, `gemini`, `codex`, `opencode` — the `agent` wire field. |
| **Model** | Provider model id (`claude-opus-5`) or an alias (`latest`/`default`). |
| **Effort** | `low`/`medium`/`high`/`max` (`max` → wire `xhigh` for the two models that require it). |
| **Agent instance** | A resolved `{provider, model, effort}` that maps to exactly one run — the new unit of execution. |
| **Instance id** | Stable key `provider:model:effort` (resolved catalog ids; `auto` when omitted), or a `label`. |
| **Lineup** | The ordered set of instances a step runs. |
| **Fan-out entry** | A shorthand (`models: […]` / `efforts: […]`) expanding to the cartesian set of instances. |
| **Open instance** | An instance with no pinned model — resolves to the provider default (or interactive choice). |
| **Alias** | `latest`/`default` — resolves to the provider's configured default model at launch. |
| **Arena** | The side-by-side comparison of a step's instance outputs (from PR #25842). |

"Instance" replaces "provider" wherever run identity/status/selection is keyed;
`agent` remains the provider field on the wire and in `agent_config`.

---

## 3. Motivating use cases

Each must be expressible in workflow file, CLI, and dashboard, and produce
independent runs, artifacts, and results, comparable in the arena view.

### 3.1 Model bake-off
```yaml
agents:
  - { agent: claude, models: [claude-opus-5, claude-opus-4-8, claude-opus-4-7] }
```
→ `claude:claude-opus-5:auto`, `claude:claude-opus-4-8:auto`, `claude:claude-opus-4-7:auto`.

### 3.2 Effort sweep
```yaml
agents:
  - { agent: claude, model: claude-opus-5, efforts: [low, medium, high] }
```
→ `claude:claude-opus-5:low`, `:medium`, `:high`. **This is why effort is in the instance id.**

### 3.3 Flagship of each provider (today's council)
```yaml
agents: [claude, gemini, codex]          # bare strings = open → per-provider default
```
On Netlify API this now resolves to the configured defaults (Claude → **Fable 5**,
Gemini → 3.1 Pro, Codex → GPT 5.6 Sol). On GitHub it stays Auto/omit (§13).
Rot-proof explicit form: `- { agent: claude, model: latest }`.

### 3.4 Any combination
```yaml
agents:
  - { agent: claude, models: [claude-opus-5, claude-opus-4-8] }
  - { agent: gemini, model: latest }
  - { agent: codex,  model: gpt-5.6-sol, efforts: [medium, high] }
```
Six instances, three providers, one step.

---

## 4. Current architecture and the constraint being lifted

Verified in the tree:

- **Run identity is provider-keyed** (`agentStatuses`, `selectedAgents`/`stepAgents`,
  per-run lookups) — locked decision #5 of the model/effort program, now reopened.
- **Follow-up matches by provider** — `src/workflows/followups/plan.js:97`
  (`agent === targetAgent`). Ambiguous with two Claudes.
- **Schema is provider-keyed** — `agents: [providers]`, `models: {provider: model}`,
  `efforts: {provider: effort}` can't hold two `claude` entries.
- **Executor fires all runs at once** — `src/workflows/engine/local-executor.js:806`
  `Promise.allSettled(runs.map(...))`, no concurrency limit (fine for ≤4, exceeds
  the ~5 backend cap for big fan-outs).
- **Catalog + resolver exist** — `src/core/agents/configuration.js`
  (`resolveAgentRunConfig`, `getBestModelForProvider`, `getHighestEffortForModel`).
- **SDK is per-run** — `start`/`followUp` take one `{agent, model, effort}` and
  return one handle; no provider-uniqueness assumption. N instances = N calls.

The change is a NAX **re-keying** (provider → instance id) + a schema that
expresses multiples + follow-up inheritance + a wave scheduler + the arena view.

---

## 5. Data model

### 5.1 Instance descriptor
```ts
type AgentInstance = {
  agent: AgentProvider           // 'claude' | 'gemini' | 'codex' | 'opencode'
  model?: string                 // resolved concrete id, or undefined = Auto/omit
  effort?: string                // resolved catalog id ('low'..'max'), or undefined = Auto/omit
  id: string                     // label ?? `${agent}:${model ?? 'auto'}:${effort ?? 'auto'}`
  label?: string                 // display + duplicate disambiguator
}
```

### 5.2 Instance id
- Resolved catalog ids; `max` (not wire `xhigh`); `auto` for omitted dimensions —
  so an old provider-only run maps to `claude:auto:auto`.
- **Unique within a step.** Fan-out dupes are deduped; an author-written exact
  duplicate is an error naming the collision and suggesting a `label`.

### 5.3 Model resolution ladder (per instance, at launch)
1. **Pinned concrete id** → verbatim; unknown ids pass through with a warning.
2. **Alias** (`latest`/`default`) → the provider's configured `defaultModel`.
3. **Open** (no model) → **transport-aware** (§13): Netlify API → `defaultModel`;
   GitHub → Auto/omit. Interactive launch prompts (default = `defaultModel`).
4. **Explicit `auto`** → omit model; effort must be Auto too.

Effort resolves against the chosen model with the existing rules (`auto` → omit;
unsupported-for-model → error; `max` → `xhigh` at send only). Resolution happens
**once** at materialize; retry/resume never re-resolve an alias.

### 5.4 Per-provider defaults (catalog)
Add `defaultModel` per provider so "flagship" is configurable, not positional:
```
claude   → claude-fable-5
gemini   → gemini-3.1-pro-preview
codex    → gpt-5.6-sol
opencode → moonshotai/kimi-k3
```
`getBestModelForProvider` returns `defaultModel` (falling back to `models[0]`).

---

## 6. Workflow file schema

### 6.1 Lineup entries (string-or-object + fan-out)
```yaml
agents:
  - claude                                                # open (provider default / Auto on GitHub)
  - { agent: claude, model: latest }                      # alias
  - { agent: claude, model: claude-opus-5, effort: high } # pinned
  - { agent: codex,  model: gpt-5.6-sol, efforts: [medium, high] }        # fan-out ×2
  - { agent: gemini, models: [gemini-3.1-pro-preview, gemini-3.6-flash] } # fan-out ×2
```
- String = open instance. Object may set `model`/`models` and `effort`/`efforts`;
  list forms fan out (`models × efforts` cartesian). Multiple same-provider entries
  allowed. Optional `label`.

### 6.2 Back-compatibility
- `agents: [claude, gemini, codex]` unchanged structurally; resolves per §5.3.
- Legacy `models`/`efforts` maps still apply to the **single bare-string instance**
  of a provider; if a provider appears more than once, the maps are ambiguous → error
  pointing to the object form.
- Supported in YAML/JSON/JS/TS/TOML via `src/workflows/catalog/flows.js`.

### 6.3 Follow-up steps inherit (no lineup)
```yaml
- id: review
  submit: new-run
  agents:
    - { agent: claude, models: [claude-opus-5, claude-opus-4-8] }
    - { agent: gemini, model: latest }
- id: cross-review
  submit: follow-up
  input: [{ step: review, results: all }]        # inherits review's instances + sessions
```
- A `follow-up` step **must not** declare `agents`; its lineup is the union
  (deduped by id) of the resolved instances of its `input` step(s), continuing each
  session. A declared lineup on a follow-up step → deprecation notice, ignored.
- The bundled `review` and `ideas` flows are migrated to drop `agents` from their
  follow-up steps (`cross-review`, `cross-score`, `react`). `new-run` steps (e.g.
  Review's single-Codex `synthesize`) keep declaring their lineup.

### 6.4 Aliases
- `latest`/`default` → provider `defaultModel`. Distinct from OpenCode backend
  `~…latest` ids (concrete wire ids, pass-through). Family aliases (`claude:opus:latest`)
  are a non-goal.

---

## 7. Resolution, precedence, validation

Precedence per instance (highest wins): step CLI override → global CLI override →
object inline (or fan-out member) → legacy `models`/`efforts` map (single-per-provider) →
alias/default/interactive/Auto.

Then: resolve alias/open → concrete (transport-aware); validate against the catalog
(reuse the model/effort program's known-rules); `max`→`xhigh` at send; compute id;
dedupe fan-out; reject unlabeled duplicates; store the resolved instance on the run.

Fail before any remote mutation when: model belongs to another provider; effort pinned
while model Auto; known model + unsupported effort; a `follow-up` `input` references a
step with no continuable instances; duplicate ids without labels; pinned/multi-instance
on the GitHub transport.

---

## 8. Execution: wave scheduler, follow-up, retry

### 8.1 Wave scheduler (new)
The backend caps parallel runs at ~5 and it is not user-tunable. Replace the
fire-all `Promise.allSettled` at `local-executor.js:806` with a **bounded scheduler**:

- concurrency = hardcoded constant `MAX_PARALLEL_RUNS = 5` (documented as the
  observed backend default; **not** auto-detected — the API may not report it
  reliably and could fail under a burst);
- run instances in waves of ≤5, preserving lineup order for start ordering;
- integrate with existing capacity-retry as a backstop (if the backend still
  rejects, the SDK retry handles it).

Applies within a step (all a step's instances target one site → cap is per-step).

### 8.2 Materialize instances
`local-executor.js` creates one `AgentRun` per resolved instance:
```js
{ agent, model, effort, instanceId, instanceLabel, /* existing fields */ }
```
Resolve once; retry/resume replay the stored resolved instance.

### 8.3 Re-key by instance
`agentStatuses` and all provider-keyed maps become instance-id-keyed.
`src/integrations/netlify/local-runner.js` and `agent-runner-sdk.js` call
`sdk.start`/`sdk.followUp` per instance and carry `{agent, model, effort}` through
create, follow-up, capacity retry, prompt-shrink retry, manual retry, resume, and
handle reconstruction.

### 8.4 Follow-up inheritance mechanics
Rewrite `src/workflows/followups/plan.js` so a follow-up step gathers its `input`
steps' resolved instances (deduped by id) and, for each, finds the prior run/session
for **that instance id** and continues it — replacing the `agent === targetAgent`
match at line 97. `followups/runner.js` and `persistence.js` follow.

### 8.5 Partial failure (isolate & continue)
A failed instance does not fail the step. Successful instances produce results; the
follow-up inherits only continuable instances; failed/uncontinuable instances are
reported and skipped (never silently re-forked as fresh).

---

## 9. CLI design

Instance syntax `provider[:model[:effort]]` (model may be `latest`), comma-lists,
repeatable:
```bash
nax run review --agents "claude:claude-opus-5:high,claude:claude-opus-4-8,codex:latest"
nax run review --step-agents "audit=claude:latest,codex:gpt-5.6-sol"
```
- Effort sweep = list each. Bare `claude` = open.
- `--models`/`--efforts` remain for single-per-provider back-compat; a provider used
  multiple times cannot also be addressed by them (error → instance syntax).
- Single-agent `nax run` prompt (provider → model → effort, best/highest defaults) is
  the one-instance case, unchanged.
- Interactive workflow launch: after providers, offer **Add instance** and per-instance
  model/effort prompts (open defaults to the provider default).
- Dry-run/preview lists every instance deduped with resolved config; the soft cap (>6)
  requires confirmation.

---

## 10. Dashboard

### 10.1 Per-instance chips
One chip per instance (not per provider); two Claude chips with different subtitles are
normal. The shipped chip UI (icon + name + model + effort, caret popover, equal-height
centered content) becomes per-instance; the caret edits that instance. An explicit
remove affordance per chip.

### 10.2 Add-instance flow (serves all use cases)
An **Add agent** control: pick provider → multi-select **models** (default = provider
default) → multi-select **efforts** (default = highest) → appends the cartesian set of
instance chips. Quick presets: *Flagship of every provider* (use case 3), *This model ×
all efforts* (use case 2), *All models of this provider* (use case 1). Soft cap 6 →
confirm.

### 10.3 Follow-up display
A follow-up step shows its inherited instances read-only, labeled "inherited from
&lt;step&gt;".

### 10.4 Arena comparison (port of PR #25842) — documented, built later
netlify-react-ui PR #25842 ("feat(agent-runners): add arena mode") already designed
this:
- **Multi-select agents** + an *arena mode* toggle on the new-task control.
- A **ComparisonPage** (`pages/AgentRunners/ComparisonPage.tsx`, ~555 LOC) rendering
  **one column per runner** via `CompareRunnerColumn.tsx` under a `CompareHero.tsx`
  summary, reachable from the runs list.
- Helpers in `helpers/agentRunners.ts` for arena state + navigation paths.

Plan: adapt this into the nax dashboard (Mantine/xyflow) as the step-level compare view
— side-by-side columns of each instance's result, plus the existing distinct per-instance
artifacts. **This is a later phase; this program does not build it, only specs the target.**

### 10.5 Contracts/plumbing
`selectedAgents`/`stepAgents` (provider lists) → instance descriptors;
`models`/`stepModels`/`efforts`/`stepEfforts` fold into instance objects. Update together:
`src/contracts/workflow.ts`, `contracts/dashboard.ts`, `dashboard/api/serializers.js`,
`services/mutations.js`, `transports/*`, `api/run-state-projection.js`, web
`run-projection.ts`, `App.tsx`, `WorkflowNode.tsx`, `WorkflowCanvas.tsx`,
`ModelEffortFields.tsx`, `agent-catalog-context.tsx`. Expose per-provider defaults in the
capabilities response so client and server agree.

---

## 11. Persistence, artifacts, events

- Persist resolved instance (`agent`, `model`, `effort`, `instanceId`, `label`) on run
  checkpoints and resume snapshots.
- **Instance-scoped artifact paths** — provider-keyed session files (`<runner>/claude.md`)
  collide for two Claudes; key by instance slug (`<runner>/claude__opus-5__high.md`),
  filesystem-safe.
- Session JSON nests `agent_config` (`{agent, model, effort}`) + instance id/label; keep
  intent-vs-observed handling and the `configurationMismatch` diagnostic (incl. the
  `nax-i28x` follow-up-effort backend gap).
- Markdown summaries, event payloads, dashboard projections, round-results group by
  instance. Old artifacts (`agent` only) load as `agent:auto:auto`. Additive; no schema
  bump.

---

## 12. Synthesis / large inputs

A synthesis/judge step may receive many instance outputs. Feed them all and rely on the
SDK's existing **prompt blob-offload** for oversized prompts (the E2BIG/argv work); no new
truncation or pre-summarization. (Keeps synthesis faithful; offload is already the tested
path for large prompts.)

---

## 13. Transport policy

| Case | Netlify API | GitHub Action |
|---|---|---|
| Bare provider (open) | resolve to provider default (pinned) | Auto/omit (as today) |
| Pinned model/effort | supported | **fail closed** — "supported once the Action is updated" |
| >1 instance per provider | supported | **fail closed** (Action is provider-keyed) |

GitHub is **not deprecated** — it keeps running provider-only councils exactly as today.
Full model/effort/multi-instance on GitHub requires updating the external Action's inputs
and dispatch, then a pinned-SHA bump in NAX — a **separate later effort, out of scope
here**. Never encode instance config in the prompt.

---

## 14. SDK impact

Expected **none** — the SDK already runs N independent `{agent, model, effort}` calls.
Phase 0 proves two same-provider starts run independently. If any SDK path keys by
provider (it should not), that becomes a scoped SDK task; otherwise no SDK release.

---

## 15. Documentation

Update under `site/content`: `reference/workflow-files.mdx` (string-or-object, fan-out,
aliases, inheritance), `reference/commands.mdx` (instance syntax),
`guides/run-workflows.mdx` + `guides/use-the-dashboard.mdx` (the four use cases + arena),
`concepts/glossary.mdx` (instance, id, lineup, alias, arena), `concepts/artifacts.mdx`
(instance-scoped paths), `for-agents.mdx`, root `README.md`, and
`src/templates/skills/nax-workflows/SKILL.md`.

---

## 16. Implementation phases

### Phase 0 — Contracts, fixtures, SDK confirmation
Prove two same-provider SDK runs are independent; fixtures for all four use cases;
inventory + guard-tests for every provider-keyed map/status/selection site.

### Phase 1 — Data model and resolver
`AgentInstance`, instance id, dedupe, labels; per-provider `defaultModel`;
`latest`/`default` alias; transport-aware open resolution; ladder + fan-out + validation.

### Phase 2 — Schema, normalization, back-compat
String-or-object + fan-out normalization across all formats; legacy-map bridge + ambiguity
errors; migrate bundled `review`/`ideas` follow-up steps to inherit.

### Phase 3 — Execution
Wave scheduler (cap 5); one run per instance; re-key status/selection by instance id;
follow-up inheritance + instance-id continuation; partial-failure isolation;
instance-scoped artifacts; resolved config in state/events; retry/resume replay.

### Phase 4 — CLI
Instance syntax for `--agents`/`--step-agents`; back-compat supersession + ambiguity
errors; interactive Add-instance; dry-run/preview per-instance labels + soft-cap confirm.

### Phase 5 — Dashboard (config)
Per-instance chips + edit/remove; Add-instance picker (multi-select models/efforts +
presets + soft cap); read-only inherited follow-up display; contracts/serializers/projections
re-keyed; catalog defaults exposed; `dashboard:build` + typecheck + Playwright.

### Phase 6 — Arena comparison (port PR #25842)
Adapt the arena comparison (columns per instance + hero) into the nax dashboard. Separate,
later phase; can ship after the core.

### Phase 7 — Docs, canary, release
MDX/skill/examples/help; full verification matrix; bounded live canary of each use case;
human gate for NAX 2.1 publication.

---

## 17. Test matrix

- **Resolver:** each use case; fan-out expand + dedupe; alias → configured default;
  open → default (Netlify) vs Auto (GitHub); duplicate id w/o label → error; unsupported
  effort → error; wrong-provider model → error; `max`→`xhigh` at send only.
- **Schema:** string-or-object + fan-out in YAML/JSON/JS/TS/TOML; legacy-map bridge;
  ambiguity error; follow-up-with-declared-agents deprecation.
- **Scheduler:** 9 instances run in waves of ≤5; ordering; capacity-retry backstop.
- **Execution/state:** two same-provider instances → two runs/artifacts/results; instance-id
  status keying; resume preserves exact instances; retry replays resolved (not re-aliased).
- **Follow-up:** cross-review continues each review instance's own session by id; failed
  instance reported/skipped; step succeeds with the rest.
- **CLI:** instance syntax; effort sweep; back-compat; non-TTY; dry-run labels + soft-cap
  confirm; GitHub pin/multi fail-fast.
- **Dashboard:** add 3 models (bake-off); 1 model × 3 efforts (sweep); flagship preset;
  inherited follow-up display; per-instance edit/remove; contract rejects provider-only arrays.
- **Artifacts:** instance-scoped paths never collide for same-provider instances.
- **Arena (Phase 6):** comparison page renders one column per instance from a completed
  multi-instance step.

---

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Provider→instance re-key touches many sites | Phase 0 inventory + guard tests; land core (1–3) before UI |
| Backend falls over on bursts | Hardcoded wave cap 5, waves, capacity-retry backstop |
| `latest` shifts a run mid-flight | Resolve once at materialize; persist concrete; never re-alias on retry |
| Same-provider artifact collisions | Instance-slug paths; explicit test |
| Open-default behavior change surprises GitHub users | Transport-aware: GitHub stays Auto; only Netlify pins the default |
| Fan-out cost blowups | Soft cap 6 + confirm; dry-run lists every instance + cost |
| Follow-up can't map an input instance | Continue by instance id; report/skip, never silent fresh fork |
| Schema churn breaks existing flows | Bare-string + legacy maps stay valid; multiples require object form |
| Large synthesis prompts | Rely on tested SDK prompt blob-offload |

---

## 19. Non-goals

- **Best-of-N sampling** of identical instances — deferred (issue **#45**).
- Family-scoped aliases (`claude:opus:latest`).
- Updating the GitHub Action for model/effort/multi-instance (separate later effort).
- Dynamic catalog discovery; changing backend behavior (incl. `nax-i28x`).
- Building the arena comparison UI in the core phases (Phase 6 / later).
- User-tunable parallel-run cap.

---

## 20. Definition of done

- A step runs any number of instances, incl. several of one provider; all four use cases
  work in workflow files, CLI, and dashboard.
- Instances keyed by `provider:model:effort` (or `label`); duplicates handled.
- Per-provider `defaultModel` (Claude → Fable 5) drives open/`latest`; resolution is
  transport-aware and recorded concrete; retry/resume never re-alias.
- Follow-up steps inherit and continue each input instance's own session by id; partial
  failures isolate.
- Execution respects the wave cap (5); fan-outs preview and soft-cap-confirm at 6.
- Existing provider-only flows and the shipped model/effort maps keep working.
- GitHub transport keeps provider-only councils; pins/multi fail closed with a clear
  "later" message.
- No SDK release required (or a scoped one if Phase 0 finds a provider assumption).
- Docs, dashboard build, Playwright, and a live canary of each use case pass; NAX 2.1 is
  handed to the user for publication.
- Arena comparison (PR #25842 port) is specced for a follow-on phase.
```

