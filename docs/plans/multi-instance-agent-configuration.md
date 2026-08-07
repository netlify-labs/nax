# Multi-Instance Agent Configuration

**Status:** Implementation-ready plan (draft v1, pre-refinement)
**Date:** 2026-08-07
**Scope:** `nax` core, CLI, workflow files, execution, follow-ups, persistence/artifacts, dashboard, docs
**Builds on:** `docs/plans/agent-runner-model-effort-configuration.md` (the provider/model/effort program, shipped as NAX 2.0)
**SDK impact:** none expected — `nax-agent-runner-sdk` is already per-run and catalog-free

---

## 1. Outcome

Today a workflow step runs **at most one agent per provider**. A step is a set of
providers (`claude`, `gemini`, `codex`, `opencode`), and NAX keys run identity,
status, artifacts, and follow-up continuation by that provider string. You cannot
run two Claude models on the same task.

This program makes the unit of execution an **agent instance** — a resolved
`{ provider, model, effort }` triple with a stable id — so a step can run **any
number of instances, including several of the same provider**. It must make all
four of these first-class, and every combination of them:

1. **Model bake-off** — several models of one provider on one task
   (Claude Opus 5 vs Opus 4.8 vs Opus 4.7).
2. **Effort sweep** — one model at several reasoning efforts
   (Opus 5 at Low, Medium, High).
3. **Flagship-of-each** — one flagship per provider (today's default behavior).
4. **Any combination** — e.g. two Claudes + a Gemini flagship + Codex at two
   efforts, in a single step.

Two additional requirements shape the design:

- **Version rot must be avoidable.** Workflow files should rarely hardcode a
  concrete model version. A `latest`/`default` alias resolves to the current
  flagship from the catalog, and "open" instances (provider only) let the person
  choose at launch. Concrete pinning stays available for lock-down.
- **Follow-up steps inherit.** A follow-up step (e.g. Review's *Cross Review*)
  must continue the **exact instances and sessions** produced by the step it
  takes input from — not a separately declared, drift-prone list.

The end-to-end contract:

```text
workflow file / CLI / dashboard  ─┐
                                   ├─►  instance list (string-or-object, fan-out)
defaults + aliases + interactive ─┘
                                          │  resolve each instance
                                          ▼
                    [ {agent, model?, effort?, id, label} , ... ]   (unique per step)
                                          │
                                          ▼
        one AgentRun + one SDK handle per instance  (N per provider allowed)
                                          │
             follow-up steps continue each input-step instance by id
                                          │
                                          ▼
          state / artifacts / events / dashboard keyed by instance id
```

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Provider / agent** | `claude`, `gemini`, `codex`, `opencode` — the `agent` wire field. |
| **Model** | Provider-specific model id (`claude-opus-5`) or an alias (`latest`). |
| **Effort** | Reasoning level: `low`/`medium`/`high`/`max` (`max` → wire `xhigh` for the two models that require it). |
| **Agent instance** | A resolved `{provider, model, effort}` unit that maps to exactly one run. The new unit of execution. |
| **Instance id** | Stable key `provider:model:effort` (resolved catalog ids; `auto` when omitted), or a `label` when supplied. |
| **Lineup** | The ordered set of instances a step runs. |
| **Fan-out entry** | A workflow shorthand (`models: [...]` / `efforts: [...]`) that expands to the cartesian set of instances. |
| **Open instance** | An instance with no pinned model — resolved to the provider default (or chosen interactively at launch). |
| **Alias** | `latest`/`default` — a model token that resolves to the provider's current flagship at launch. |

The word **instance** replaces **provider** wherever run identity, status, or
selection is keyed. `agent` remains the provider field on the wire and in
`agent_config`.

---

## 3. Motivating use cases (user workflows)

Each use case must be expressible in the workflow file, the CLI, and the
dashboard, and must produce independent runs, artifacts, and results.

### 3.1 Model bake-off (same provider, different models)

> "Run Opus 5, Opus 4.8, and Opus 4.7 on this audit and compare."

```yaml
agents:
  - { agent: claude, models: [claude-opus-5, claude-opus-4-8, claude-opus-4-7] }
```

Expands to three instances: `claude:claude-opus-5:auto`,
`claude:claude-opus-4-8:auto`, `claude:claude-opus-4-7:auto`.

### 3.2 Effort sweep (same provider + model, different efforts)

> "Run Opus 5 at low, medium, and high and see how far reasoning gets us."

```yaml
agents:
  - { agent: claude, model: claude-opus-5, efforts: [low, medium, high] }
```

Expands to `claude:claude-opus-5:low`, `:medium`, `:high`. **This is why effort
is part of the instance id** — same provider and model, three distinct runs.

### 3.3 Flagship of each provider (today's behavior)

> "One best model from each provider." — the current council.

```yaml
agents: [claude, gemini, codex]        # bare strings = open → provider default (flagship)
# or, explicit and rot-proof:
agents:
  - { agent: claude, model: latest }
  - { agent: gemini, model: latest }
  - { agent: codex,  model: latest }
```

### 3.4 Any combination

```yaml
agents:
  - { agent: claude, models: [claude-opus-5, claude-opus-4-8] }   # bake-off
  - { agent: gemini, model: latest }                              # flagship
  - { agent: codex,  model: gpt-5.6-sol, efforts: [medium, high] } # effort sweep
```

Six instances, three providers, one step. The design goal is that **1–4 are the
same feature seen from different angles**, not four special cases.

---

## 4. Current architecture and the constraint being lifted

Verified in the current tree:

- **Run identity is provider-keyed.** Status maps (`agentStatuses`),
  `selectedAgents`/`stepAgents`, and per-run lookups assume one run per provider
  per step. This is locked decision #5 of the model/effort program:
  *"Running two Claude models in parallel in the same step is out of scope."*
  This program reopens exactly that decision.
- **Follow-up continuation matches by provider.**
  `src/workflows/followups/plan.js:97` decides `continue-runner` vs
  `fresh-runner` with `agent === targetAgent`. With two Claudes this is
  ambiguous — which Claude session does the follow-up Claude continue?
- **Workflow schema is provider-keyed.** `agents: [providers]`,
  `models: { provider: model }`, `efforts: { provider: effort }`. A map keyed by
  provider cannot hold two entries for `claude`.
- **The catalog + resolver already exist.**
  `src/core/agents/configuration.js` has the provider/model/effort catalog,
  `resolveAgentRunConfig`, `getBestModelForProvider` (flagship), and
  `getHighestEffortForModel`. These are the building blocks for aliases and
  defaults.
- **The SDK is already per-run.** `nax-agent-runner-sdk` `start`/`followUp` take
  a single `{agent, model, effort}` and return one handle. Nothing in the SDK
  enforces provider-uniqueness — that is purely NAX's keying. So N instances =
  N independent handles the SDK already supports. **No SDK release is required.**

The change is therefore almost entirely a **NAX re-keying**: from provider to
instance id, plus a schema that can express multiples, plus follow-up
inheritance.

---

## 5. Locked and proposed design decisions

Locked in conversation:

1. **Instance is the unit.** Run identity, status, selection, artifacts, and
   follow-up continuation key by **instance id**, not provider.
2. **Follow-up steps inherit.** A `submit: follow-up` step derives its instances
   from the resolved instances of the step(s) it takes `input` from, and
   continues each one's own session. Follow-up steps do not declare their own
   lineup.
3. **Avoid version rot.** Prefer aliases/defaults over pinned versions. Add a
   `latest`/`default` model alias resolving to the catalog flagship; "open"
   instances resolve to the provider default (or interactive choice).
4. **Determinism after the fact.** Aliases and defaults resolve at launch; the
   **resolved concrete** model/effort is persisted on the run and in artifacts.
   A run is reproducible from its artifact even though the flow file is
   version-free.
5. **SDK unchanged.** The catalog-free per-run SDK already supports N instances.

Proposed (confirm during refinement):

6. **Instance id = `provider:model:effort`** using resolved catalog ids
   (`auto` when omitted, `max` not the wire `xhigh`), overridable by an optional
   `label`. Duplicate ids within a step are rejected unless disambiguated by a
   distinct `label`.
7. **String-or-object schema with fan-out.** A lineup entry is either a bare
   provider string (open) or an object `{agent, model?|models?, effort?|efforts?,
   label?}`; list fields fan out to the cartesian product. Back-compatible with
   today's bare-string `agents` and provider-keyed `models`/`efforts` for the
   single-per-provider case.
8. **Multi-instance requires the Netlify API transport.** More than one instance
   per provider, or any pinned model/effort, resolves to `netlify-api`; the
   GitHub Action transport (provider-only) fails closed before dispatch.
9. **Additive persistence.** Old provider-keyed state/artifacts load as single
   `provider:auto:auto` instances. No migration rewrite; no schema-version bump.

---

## 6. Data model

### 6.1 Instance descriptor

```ts
type AgentInstance = {
  agent: AgentProvider          // 'claude' | 'gemini' | 'codex' | 'opencode'
  model?: string                // resolved concrete id, or undefined = Auto/omit
  effort?: string               // resolved catalog id ('low'..'max'), or undefined = Auto/omit
  id: string                    // stable key, see 6.2
  label?: string                // human/display + disambiguator
}
```

### 6.2 Instance id

```text
id = label ?? `${agent}:${model ?? 'auto'}:${effort ?? 'auto'}`
```

- Uses the **resolved catalog id** for model and the **catalog effort id**
  (`max`, not the wire `xhigh` — wire translation happens only at SDK send).
- `auto` marks an omitted dimension, so today's provider-only runs map cleanly to
  `claude:auto:auto` — the exact key an old artifact implies.
- Ids must be **unique within a step**. Fan-out that produces a duplicate is
  deduped; an author-written exact duplicate is an error that names the
  collision and suggests adding a `label`.

### 6.3 Model resolution ladder (per instance, at launch)

Resolve model first, then effort, in this order:

1. **Pinned concrete id** (`claude-opus-5`) → used verbatim; unknown ids pass
   through with a warning (backend validates), exactly as today.
2. **Alias** (`latest` / `default`) → `getBestModelForProvider(agent)` (the
   catalog flagship). Recorded as the resolved concrete id.
3. **Open** (no model) →
   - interactive launch: prompt (default = flagship), reusing the single-agent
     prompt we shipped;
   - non-interactive: the flagship default.
4. **Explicit `auto`** → omit the model field entirely (backend chooses); effort
   must also be Auto.

Effort then resolves against the chosen model using the existing rules
(`auto` → omit; unsupported-for-model → error; `max` → `xhigh` at send only;
open/default effort follows `getHighestEffortForModel` **only** in interactive
"best" contexts, otherwise Auto). See §8.

---

## 7. Workflow file schema

### 7.1 Lineup entries

`agents` becomes a list whose entries are **string-or-object**:

```yaml
agents:
  - claude                                   # open instance (provider default)
  - { agent: claude, model: latest }         # alias, rot-proof
  - { agent: claude, model: claude-opus-5, effort: high }   # fully pinned
  - { agent: codex,  model: gpt-5.6-sol, efforts: [medium, high] }  # fan-out (2 instances)
  - { agent: gemini, models: [gemini-3.1-pro-preview, gemini-3.6-flash] }  # fan-out (2)
```

Rules:

- A **string** entry = an open instance of that provider.
- An **object** entry may set `model` **or** `models` (list), and `effort`
  **or** `efforts` (list). List forms fan out; `models × efforts` is the
  cartesian product.
- Multiple entries with the same provider are allowed and expected.
- `label` optionally names an instance (display + duplicate disambiguation).

### 7.2 Back-compatibility

- `agents: [claude, gemini, codex]` (today's flows) → three open flagship
  instances. Unchanged behavior.
- Legacy `models: { claude: ... }` / `efforts: { claude: ... }` maps still apply
  **to the single bare-string instance of that provider**. If a provider appears
  more than once, the maps are ambiguous and become an error that points to the
  object form. This bridges the model/effort feature we just shipped without
  stranding existing flows.
- Supported in YAML, JSON, JS, TS, and TOML through the existing catalog
  normalization path in `src/workflows/catalog/flows.js`.

### 7.3 Follow-up steps inherit (no lineup)

```yaml
steps:
  - id: review
    submit: new-run
    agents:
      - { agent: claude, models: [claude-opus-5, claude-opus-4-8] }
      - { agent: gemini, model: latest }

  - id: cross-review
    submit: follow-up
    input: [{ step: review, results: all }]
    # NO agents — inherits review's resolved instances and continues each session
```

- A `submit: follow-up` step **must not** declare `agents`. Its lineup is the
  union (deduped by instance id) of the resolved instances from the step(s) named
  in `input`.
- If a `follow-up` step declares `agents`, emit a deprecation notice and ignore
  it (inherit anyway). The bundled `review` and `ideas` flows are migrated to
  drop `agents` from their follow-up steps.
- `new-run` steps (e.g. Review's `synthesize`, a single Codex) still declare
  their own lineup — inheritance applies only to continuations.

### 7.4 Aliases

- `latest` and `default` are NAX aliases → the provider flagship (`models[0]`).
- Distinct from OpenCode's backend `~…latest` ids (e.g.
  `~deepseek/deepseek-v4-flash-latest`), which are concrete wire ids that pass
  through unchanged. The plan documents both so they aren't conflated.
- Future (non-goal now): family-scoped aliases like `claude:opus:latest`.

---

## 8. Resolution, precedence, and validation

Resolution order per instance (highest wins):

1. step-specific CLI override;
2. global CLI override;
3. object entry's inline `model`/`effort` (or fan-out member);
4. legacy `models`/`efforts` map (single-per-provider only);
5. alias / default / interactive / Auto.

Then:

- resolve alias/open → concrete via §6.3;
- validate the resolved `{model, effort}` against the catalog (known
  provider/model/effort rules from the model/effort program are reused verbatim);
- translate `max` → `xhigh` only for the two models that require it, at send;
- compute the instance id; dedupe fan-out; reject author duplicates without a
  `label`;
- store the **resolved** instance on the run.

Fail before any remote mutation when:

- an instance's model belongs to a different provider;
- effort is pinned while the model is Auto;
- a known model is paired with a known-unsupported effort;
- a `follow-up` step's `input` references a step that produced no continuable
  instances;
- duplicate instance ids without distinct labels;
- multi-instance (or any pin) is requested on the GitHub transport.

---

## 9. CLI design

### 9.1 Instance syntax

`--agents` accepts a comma-separated list of instance specs
`provider[:model[:effort]]`, repeatable; model may be an alias:

```bash
nax run review \
  --agents "claude:claude-opus-5:high,claude:claude-opus-4-8,codex:latest"
```

- Effort sweep: list each — `claude:claude-opus-5:low,claude:claude-opus-5:medium,claude:claude-opus-5:high`.
- Bare `claude` = open instance.
- `--step-agents "audit=claude:latest,codex:gpt-5.6-sol"` for per-step lineups.

### 9.2 Back-compat and supersession

- `--models`/`--efforts` (provider-keyed) remain for the single-per-provider
  case and apply to bare-provider instances.
- When `--agents` carries instance specs, they are the source of truth; a
  provider that appears multiple times cannot also be addressed by
  `--models`/`--efforts` (error, points to instance syntax).

### 9.3 Interactive and single-agent

- The single-agent `nax run` flow (already: pick provider → model → effort,
  defaulting to best/highest) is unchanged; it is the "one instance" case.
- Interactive workflow launch: after selecting providers, offer **Add instance**
  (repeat a provider with a different model/effort) and the model/effort prompts
  per instance. Open instances default to the flagship.

### 9.4 Dry-run / preview labels

Show every instance explicitly, deduped, with resolved config:

```text
Claude · Opus 5 · High
Claude · Opus 4.8 · Auto
Gemini · Gemini 3.1 Pro · Auto      (from: latest)
Codex · GPT 5.6 Sol · Medium
Codex · GPT 5.6 Sol · High
```

---

## 10. Dashboard design

### 10.1 Per-instance chips

- A step renders **one chip per instance**, not per provider. Two Claude chips
  with different model/effort subtitles are normal.
- The existing chip UI (icon + name + model + effort, caret popover, equal-height
  centered content) becomes per-instance. The caret popover edits *that
  instance's* model/effort.
- Removing an instance is an explicit action on the chip (an `×` on hover, or a
  "remove" item in the popover).

### 10.2 Add-instance flow (serves all four use cases)

An **Add agent** control opens a compact picker:

1. pick a provider (icon list);
2. multi-select **models** (default: flagship) — selecting 3 models creates the
   bake-off (use case 1);
3. multi-select **efforts** (default: highest) — selecting 3 efforts on one
   model creates the sweep (use case 2);
4. it appends the cartesian set of instance chips.

Quick presets make the common combos one click:

- **Flagship of every provider** (use case 3, the current default);
- **This model × all efforts** (use case 2);
- **All models of this provider** (use case 1).

### 10.3 Follow-up display

- A `follow-up` step shows its inherited instances read-only, labeled
  *"inherited from <step>"*, so it is obvious they mirror the source step and
  are edited there.

### 10.4 Contracts and plumbing

`selectedAgents`/`stepAgents` (provider lists) become **instance descriptors**;
`models`/`stepModels`/`efforts`/`stepEfforts` fold into the instance objects.
Update together:

- `src/contracts/workflow.ts`, `src/contracts/dashboard.ts`;
- `src/dashboard/api/serializers.js`, `services/mutations.js`, `transports/*`;
- `src/dashboard/api/run-state-projection.js` and web `run-projection.ts`;
- web `App.tsx`, `WorkflowNode.tsx`, `WorkflowCanvas.tsx`, `ModelEffortFields.tsx`,
  `agent-catalog-context.tsx`.

The catalog capabilities response already carries the model/effort matrix; add
the flagship/`latest` resolution so the client and server agree on defaults.

---

## 11. Execution, follow-up, and retry plumbing

### 11.1 Materialize instances

`src/workflows/engine/local-executor.js` creates one `AgentRun` per resolved
instance (not per provider):

```js
{
  agent, model, effort,     // resolved wire values
  instanceId, instanceLabel,
  // existing run fields...
}
```

Resolution happens once when materializing; retry/resume replay the stored
resolved instance, never re-resolving aliases (a `latest` that shifted mid-run
must not change the run's model).

### 11.2 Re-key by instance

- `agentStatuses` and every provider-keyed map become instance-id-keyed.
- `src/integrations/netlify/local-runner.js` and
  `src/integrations/netlify/agent-runner-sdk.js` call `sdk.start` /
  `sdk.followUp` per instance and carry `{agent, model, effort}` through create,
  follow-up, capacity retry, prompt-shrink retry, manual retry, resume, and
  handle reconstruction.

### 11.3 Follow-up inheritance mechanics

Rewrite `src/workflows/followups/plan.js` so a follow-up step:

1. gathers the resolved instances of its `input` step(s), deduped by instance id;
2. for each, finds the prior run/session for **that instance id** (not that
   provider) and continues it (`continue-runner`);
3. reports (and skips) any input instance without a continuable session rather
   than silently starting fresh.

This replaces the `agent === targetAgent` match at line 97 with an
`instanceId === instanceId` match. `followups/runner.js` and
`followups/persistence.js` follow.

---

## 12. Persistence, artifacts, and events

- Persist the resolved instance (`agent`, `model`, `effort`, `instanceId`,
  `label`) on run checkpoints and resume snapshots.
- **Artifact paths must be instance-scoped.** Session files keyed by provider
  (e.g. `<runner>/claude.md`) collide with two Claudes; key by instance id /
  label (e.g. `<runner>/claude__opus-5__high.md`), with a filesystem-safe slug.
- Session JSON nests config under `agent_config` (`{agent, model, effort}`, as
  today) plus the instance id/label. Keep intent-vs-observed handling from the
  model/effort program (request config as intent; `agent_config` as observed;
  surface `configurationMismatch` on divergence — see the known
  follow-up-effort backend gap `nax-i28x`).
- Markdown summaries, workflow event payloads, dashboard projections, and
  round-results group by instance.
- Old artifacts with only `agent` load as `agent:auto:auto`. Additive; no schema
  bump.

---

## 13. Transport policy

| Case | Transport | Policy |
|---|---:|---|
| Single open instance per provider | Netlify API or GitHub | as today |
| Any pinned model/effort | Netlify API | `transport:auto` → `netlify-api`; explicit GitHub fails closed |
| More than one instance per provider | Netlify API | GitHub rejects before dispatch (it is provider-keyed) |

Do not encode instance config in the prompt. The pinned GitHub Action supports
provider selection only; teaching it multi-instance is out of scope.

---

## 14. Aliasing and defaults

- `getBestModelForProvider` is the single source of the flagship/default (already
  shipped). `latest`/`default` resolve through it.
- The catalog gains an explicit `defaultModel` per provider (defaults to
  `models[0]`) so "flagship" is data, not position, and can diverge from list
  order if needed.
- Resolution is at launch; artifacts record the concrete result → reproducible.
- When the catalog syncs to newer models, `latest` flows follow automatically,
  and a warning is emitted the first time a run resolves an alias so the shift
  is visible in logs.

---

## 15. SDK impact

Expected: **none.** The SDK already accepts one `{agent, model, effort}` per
`start`/`followUp` and returns independent handles; N instances are N calls.
Confirm during Phase 0 by driving two same-provider starts through the SDK in a
test. If any SDK assumption keys by provider (it should not), that becomes a
scoped SDK task; otherwise no SDK release.

---

## 16. Documentation

Update under `site/content`:

- `reference/workflow-files.mdx` — string-or-object lineup, fan-out, aliases,
  follow-up inheritance;
- `reference/commands.mdx` — instance CLI syntax;
- `guides/run-workflows.mdx`, `guides/use-the-dashboard.mdx` — the four use cases
  as walkthroughs;
- `concepts/glossary.mdx` — agent instance, instance id, lineup, alias;
- `concepts/artifacts.mdx` — instance-scoped paths;
- `for-agents.mdx`, root `README.md`, and the bundled skill
  `src/templates/skills/nax-workflows/SKILL.md`.

---

## 17. Implementation phases

### Phase 0 — Contracts, fixtures, and SDK confirmation
1. Prove the SDK runs two same-provider instances independently (test).
2. Add fixtures for each of the four use cases (workflow files + expected
   resolved lineups).
3. Inventory every provider-keyed map/status/selection site and add guard tests.

**Exit:** current behavior captured; SDK confirmed instance-agnostic.

### Phase 1 — Data model and resolver
1. `AgentInstance`, instance id, dedupe, `label`.
2. `latest`/`default` alias + `defaultModel` in the catalog.
3. Resolution ladder, fan-out expansion, validation.

**Exit:** given any §7 lineup, the resolver returns a unique resolved instance
list with warnings; exhaustive tests for the four use cases.

### Phase 2 — Schema, normalization, back-compat
1. String-or-object + fan-out normalization in `flows.js` across all formats.
2. Legacy `agents`/`models`/`efforts` bridge and ambiguity errors.
3. Migrate bundled `review`/`ideas` follow-up steps to inherit.

**Exit:** existing flows unchanged in behavior; new shapes load and normalize.

### Phase 3 — Execution, follow-up, retry, artifacts
1. Materialize one run per instance; re-key status/selection by instance id.
2. Follow-up inheritance + instance-id continuation.
3. Instance-scoped artifact paths; resolved config in state/events.
4. Retry/resume replay stored resolved instances.

**Exit:** a workflow runs multiple same-provider instances end to end; a
follow-up step continues each input instance's own session; retry/resume preserve
exact instances.

### Phase 4 — CLI
1. Instance syntax for `--agents`/`--step-agents`.
2. Back-compat supersession + ambiguity errors.
3. Interactive Add-instance; dry-run/preview per-instance labels.

**Exit:** all four use cases runnable from the CLI, TTY and non-TTY.

### Phase 5 — Dashboard
1. Per-instance chips + edit/remove.
2. Add-instance picker with multi-select models/efforts + presets.
3. Read-only inherited display on follow-up steps.
4. Contracts/serializers/projections re-keyed; catalog defaults exposed.
5. `dashboard:build` + `dashboard:typecheck` + Playwright.

**Exit:** dashboard and CLI produce the same resolved lineup for the same input.

### Phase 6 — Docs, canary, release
1. MDX, skill content, examples, help snapshots.
2. Full verification matrix + bounded live canary of each use case.
3. Human release gate for the NAX minor/major version.

**Exit:** docs, help, dashboard, artifacts, and live traffic agree.

---

## 18. Test matrix

- **Resolver:** each use case (1–4); fan-out expansion + dedupe; alias → flagship;
  open → default; duplicate id without label → error; unsupported effort → error;
  wrong-provider model → error; `max` → `xhigh` at send only.
- **Schema:** string-or-object + fan-out in YAML/JSON/JS/TS/TOML; legacy maps
  bridge; ambiguity errors; follow-up-with-declared-agents deprecation.
- **Execution/state:** two same-provider instances produce two runs, two
  artifacts, two results; instance-id status keying; resume preserves exact
  instances; retry replays resolved (not re-aliased) config.
- **Follow-up:** cross-review continues each review instance's own session by id;
  input instance without a session is reported/skipped.
- **CLI:** instance syntax; effort sweep; back-compat; non-TTY; dry-run labels;
  GitHub multi-instance fail-fast.
- **Dashboard:** add 3 models (bake-off); add 1 model × 3 efforts (sweep);
  flagship preset; inherited follow-up display; per-instance edit/remove;
  contract rejection of provider-only arrays.
- **Artifacts:** instance-scoped paths never collide for same-provider instances.

---

## 19. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Re-keying provider → instance touches many sites | Phase 0 inventory + guard tests; land core (1–3) before UI |
| `latest` shifts a run mid-flight | Resolve once at materialize; persist concrete; never re-alias on retry |
| Same-provider artifact path collisions | Instance-id/label slug in artifact paths; test explicitly |
| Follow-up can't map an input instance | Continue by instance id; report/skip unmatched, never silently fork |
| Fan-out explodes cost | Preview/dry-run shows every instance; confirm before submit; count guardrails |
| Schema churn breaks existing flows | Bare-string + legacy maps stay valid; only multiples require the object form |
| GitHub transport silently drops instances | Fail closed before dispatch for multi-instance/pins |
| Exact-duplicate instances | Reject without a distinct `label`; leaves room for future sampling feature |

---

## 20. Non-goals

- Same-config duplicate runs for sampling/variance ("best of N of the identical
  instance") — deferred; enabled later via `label`/`count`.
- Family-scoped aliases (`claude:opus:latest`).
- Teaching the GitHub Action multi-instance/model/effort.
- Dynamic catalog discovery from an undocumented endpoint.
- Changing backend behavior (including the `nax-i28x` follow-up-effort gap).

## 21. Open questions (resolve during refinement)

1. Alias token: `latest` vs `default` vs both (synonyms)? Recommend both,
   canonical `latest`.
2. Do we allow a `follow-up` step to *add* fresh instances beyond what it
   inherits, or strictly inherit? (Plan assumes strictly inherit.)
3. Artifact slug format for instance ids (readability vs length).
4. Fan-out cost guardrail: a soft cap + confirmation, or unlimited with preview?
5. Should the dashboard cap instances-per-step for UX sanity?

## 22. Definition of done

- A step runs any number of instances, including several of one provider; all
  four use cases work in workflow files, CLI, and dashboard.
- Instances are keyed by `provider:model:effort` (or `label`); duplicates handled.
- `latest`/`default` and open instances resolve to the flagship; artifacts record
  the concrete resolved config; retry/resume never re-alias.
- Follow-up steps inherit and continue each input instance's own session by id.
- Existing provider-only flows and the shipped model/effort maps keep working.
- Multi-instance and pins require the Netlify API transport; GitHub fails closed.
- No SDK release required (or a scoped one if Phase 0 finds a provider assumption).
- Docs, dashboard build, Playwright, and a live canary of each use case pass; the
  NAX version bump is handed to the user for publication.
