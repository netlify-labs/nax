# Agent Runner Provider, Model, and Effort Configuration

**Status:** Implementation-ready plan  
**Date:** 2026-08-06  
**Scope:** `nax-agent-runner-sdk` and NAX, including CLI, workflow files, dashboard, artifacts, retries, and documentation  
**Source contract:** Netlify React UI at commit `0a61ba66` and the observed `bb-api` request

## 1. Outcome

NAX should let a user choose:

1. the agent provider sent as the API's `agent` field;
2. an optional provider-specific `model`;
3. an optional reasoning `effort`.

The same resolved configuration must survive every path through a run:

```text
workflow/defaults or CLI/dashboard choice
                     |
                     v
          NAX configuration resolver
                     |
             { agent, model?, effort? }
                     |
          nax-agent-runner-sdk handle
                     |
      POST runner / POST follow-up session
                     |
       response session.agent_config
                     |
       state, artifacts, resume, retry, UI
```

`Auto` is a NAX/UI selection, not an API value. It means omit the corresponding
wire field and let Agent Runner choose. NAX must never send:

```json
{ "model": "auto", "effort": "auto" }
```

The first implementation should support pinned model and effort settings on the
`netlify-api` transport. The currently pinned GitHub Action can choose only the
provider, so NAX must fail before dispatch when a pinned model or effort is used
with the GitHub transport. It must not silently discard the setting.

## 2. Terminology

The existing NAX CLI calls `claude`, `codex`, and `gemini` "models." The Agent
Runner API and React UI make the distinction explicit:

| Concept | Examples | API field |
|---|---|---|
| Agent provider | `claude`, `codex`, `gemini`, `opencode` | `agent` |
| Model | `claude-opus-4-8`, `gpt-5.6-sol` | `model` |
| Effort | `low`, `medium`, `high`, `max`/`xhigh` | `effort` |

NAX should use **agent** or **provider** for the first concept everywhere new.
The existing `--models` and `--step-models` flags currently select providers,
which is now semantically wrong. This change is an intentional hard cut:
`agents` means providers, `models` means actual provider-specific models, and
the old provider-list interpretation is removed.

## 3. Verified upstream contract

### 3.1 Request shape

The observed create request is:

```http
POST /access-control/bb-api/api/v1/agent_runners?site_id=<site-id>
Content-Type: application/json
```

```json
{
  "prompt": "Can you do security audit of the services directory please",
  "agent": "claude",
  "model": "claude-opus-4-8",
  "effort": "high",
  "file_keys": []
}
```

The React UI sends the same three configuration fields on both:

- runner creation: `POST /agent_runners?site_id=...`;
- follow-up creation: `POST /agent_runners/:runner_id/sessions`.

The response records the effective values on each session:

```json
{
  "agent_config": {
    "agent": "claude",
    "model": "claude-opus-4-8",
    "effort": "high"
  }
}
```

Source locations in the React UI checkout:

- `apps/netlify-react-ui/src/components/AgentRunners/AgentConfigModal/models.ts`
- `apps/netlify-react-ui/src/components/AgentRunners/AgentConfigModal/AgentConfigModal.tsx`
- `apps/netlify-react-ui/src/components/AgentRunners/NewTask/NewTaskInput.tsx`
- `apps/netlify-react-ui/src/components/AgentRunners/NewTask/AgentStarter/AgentStarter.tsx`
- `apps/netlify-react-ui/src/actions/typings.ts`

### 3.2 Current provider and model catalog

This is a snapshot, not an SDK protocol enum. It should be copied into NAX with
a provenance comment pointing to the React UI source file and commit.

| Provider | UI label | Wire model ID |
|---|---|---|
| Claude | Auto | omitted |
| Claude | Opus 5 | `claude-opus-5` |
| Claude | Opus 4.8 | `claude-opus-4-8` |
| Claude | Fable 5 | `claude-fable-5` |
| Claude | Sonnet 5 | `claude-sonnet-5` |
| Claude | Haiku 4.5 | `claude-haiku-4-5` |
| Codex | Auto | omitted |
| Codex | GPT 5.6 Sol | `gpt-5.6-sol` |
| Codex | GPT 5.6 Terra | `gpt-5.6-terra` |
| Codex | GPT 5.6 Luna | `gpt-5.6-luna` |
| Codex | GPT 5.4 Mini | `gpt-5.4-mini` |
| Gemini | Auto | omitted |
| Gemini | Gemini 3.1 Pro | `gemini-3.1-pro-preview` |
| Gemini | Gemini 3.6 Flash | `gemini-3.6-flash` |
| Gemini | Gemini 3.5 Flash Lite | `gemini-3.5-flash-lite` |
| OpenCode | Auto | omitted |
| OpenCode | Kimi K3 | `moonshotai/kimi-k3` |
| OpenCode | Kimi K2.7 Code | `moonshotai/kimi-k2.7-code` |
| OpenCode | GLM 5.2 | `z-ai/glm-5.2` |
| OpenCode | DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` |
| OpenCode | DeepSeek V4 Flash Latest | `~deepseek/deepseek-v4-flash-latest` |
| OpenCode | Grok 4.5 | `x-ai/grok-4.5` |
| OpenCode | MiniMax M3 | `minimax/minimax-m3` |

The leading `~` on the DeepSeek Flash alias is part of the wire model ID. Its
currently pinned concrete model is `deepseek/deepseek-v4-flash-0731`, but NAX
should send the alias from the catalog.

### 3.3 Current effort matrix

For a model set to Auto, all explicit effort choices are unavailable and the
wire `effort` field is omitted.

Claude, Codex, and Gemini pinned models support:

```text
Auto, Low, Medium, High
```

OpenCode has per-model constraints:

| OpenCode model | User choices besides Auto | Auto/default note | Wire translation |
|---|---|---|---|
| Kimi K3 | `low`, `high`, `max` | upstream default is `max` | unchanged |
| Kimi K2.7 Code | none | model owns its default | omit |
| GLM 5.2 | `high`, `max` | upstream default is `high` | `max` → `xhigh` |
| DeepSeek V4 Pro | `high`, `max` | upstream default is `high` | `max` → `xhigh` |
| DeepSeek V4 Flash Latest | `low`, `high`, `max` | upstream default is `high` | unchanged |
| Grok 4.5 | `low`, `medium`, `high` | upstream default is `high` | unchanged |
| MiniMax M3 | none | model owns its default | omit |

The React UI always displays **Max**. Only the resolver knows whether that
selection is transmitted as `max` or `xhigh`.

## 4. Locked design decisions

1. **The SDK owns the protocol, not the catalog.** Its public input/output types
   add `effort?: string`, just as they already accept `agent?: string` and
   `model?: string`. It forwards exact non-empty strings and remains compatible
   with new backend models without an SDK release.
2. **NAX owns the current UX catalog and validation rules.** NAX uses the
   verified React UI values for pickers, labels, known compatibility checks,
   and `max` translation.
3. **Auto means omission.** NAX normalizes Auto before calling the SDK. The SDK
   does not need an Auto sentinel.
4. **Configuration is session-specific.** Start and every follow-up can select
   a provider, model, and effort. The values are copied into SDK handles and NAX
   state so a retry or resume preserves the exact request.
5. **One provider configuration per workflow step.** Current NAX run identity
   and status maps are keyed by provider. Running two Claude models in parallel
   in the same step is out of scope for this version. Different steps may use
   different Claude configurations.
6. **OpenCode is opt-in.** Add it to supported providers and selectors, but do
   not add it to existing workflow defaults automatically.
7. **GitHub transport fails closed.** Provider selection remains supported.
   Pinned model/effort configuration requires `netlify-api` until the external
   action exposes true model and effort inputs. `transport:auto` resolves to
   `netlify-api` whenever any selected run has a pinned model or effort;
   explicit `transport:github` with either setting is a validation error.
8. **Additive persistence changes keep current schema/handle versions.** Old
   handles and artifacts with no model/effort mean Auto. No migration rewrite
   is needed.
9. **Unknown future model IDs are pass-through with a warning.** Known invalid
   combinations are errors. The backend remains the authority for a model
   newer than NAX's catalog.
10. **SDK release is `0.3.0`.** Adding optional public input/output fields is a
    backward-compatible minor release.
11. **`--models` becomes a real model flag immediately.** `--agents` selects
    providers, `--models` assigns a model to a provider, and `--efforts`
    assigns its effort. There is no provider-list compatibility mode for
    `--models` or `--step-models`.
12. **The NAX release is `2.0.0`.** Reassigning the existing `--models`,
    `--step-models`, and dashboard `models` contracts from providers to actual
    models is intentionally breaking and must ship as a NAX major release.

## 5. Public SDK change

### 5.1 Type additions

Add `effort?: string` to:

```ts
type StartInput = PromptInput & {
  siteId: string
  agent?: string
  model?: string
  effort?: string
  // existing fields...
}

type FollowUpInput = PromptInput & {
  agent?: string
  model?: string
  effort?: string
  // existing fields...
}

type Session = {
  // existing fields...
  agent?: string
  model?: string
  effort?: string
}
```

No closed `Model` or `Effort` union should be exported. These values are a
backend capability surface and will change more frequently than the transport
contract.

### 5.2 Serialization and normalization

Update `packages/agent-runner-sdk/src/transport/httpTransport.ts` so both the
start and follow-up bodies include `effort` when defined. Preserve existing
omission behavior for undefined optional values.

Update `packages/agent-runner-sdk/src/transport/normalize.ts` to read:

```text
session.agent_config.agent
session.agent_config.model
session.agent_config.effort
```

Support both the existing snake/camel API styles consistently with the other
normalized fields.

### 5.3 Handles, retry, and reconciliation

Update `packages/agent-runner-sdk/src/handles.ts` so parsed and serialized
effective start/follow-up inputs retain `effort`.

Keep handle version `v: 1`:

- the property is optional;
- old handles remain valid;
- parsers already tolerate additive optional fields;
- changing the version would not provide a useful migration.

Update `packages/agent-runner-sdk/src/reconciliation.ts` so the request
fingerprint includes `effort`. A session with the same prompt/provider/model
but a different effort is not an exact reconciliation match.

All retry paths must replay the effective input stored on the handle rather
than reconstructing a partial `{ agent, model }` object.

### 5.4 SDK tests and documentation

Update:

- `test/httpTransport.test.ts` for exact create and follow-up bodies;
- `test/types.test.ts` for public input keys and normalized output;
- `test/handles.test.ts` for round trips and old-handle compatibility;
- `test/reconciliation.test.ts` for effort-sensitive fingerprints;
- `test/followUpRetry.test.ts` for exact retry preservation;
- `test/operations.test.ts` and relevant conformance tests;
- examples and package README;
- `packages/agent-runner-sdk/CHANGELOG.md`;
- canonical SDK guide at `site/content/guides/agent-runner-sdk.mdx`.

Do not edit the sanitized live-contract fixture to claim an observed field
until a real canary response has been captured and sanitized.

SDK acceptance checks:

```bash
npm run sdk:ci
npm run sdk:pack-smoke
```

## 6. NAX configuration model

### 6.1 Catalog and resolver module

Add `src/core/agents/configuration.js`, fully typed with JSDoc and no `any`.
It should be the only NAX module that knows the current model matrix.

Suggested responsibilities:

```js
/**
 * @typedef {'claude'|'codex'|'gemini'|'opencode'} AgentProvider
 *
 * @typedef {Partial<Record<AgentProvider, string>>} ProviderModelMap
 * @typedef {Partial<Record<AgentProvider, string>>} ProviderEffortMap
 *
 * @typedef {object} ResolvedAgentRunConfig
 * @property {AgentProvider} agent
 * @property {string=} model
 * @property {string=} effort
 */
```

Export:

- `SUPPORTED_AGENT_PROVIDERS`;
- the model catalog and UI metadata;
- `normalizeProviderModelMap(value)`;
- `normalizeProviderEffortMap(value)`;
- `resolveAgentRunConfig(agent, scopes)`;
- `validateAgentConfig(config)`;
- `formatAgentConfigLabel(config)`;
- effort option and notice helpers suitable for CLI and dashboard use.

Put a provenance comment above the catalog:

```text
Synced from netlify-react-ui AgentConfigModal/models.ts
at commit 0a61ba66 on 2026-08-06.
```

The catalog should be ordinary serializable data so the dashboard can consume
it from a capabilities/API response instead of maintaining a second copy.

### 6.2 Provider constants

Replace the misleading internal names with:

```js
const DEFAULT_AGENT_PROVIDERS = ['claude', 'gemini', 'codex']
const SUPPORTED_AGENT_PROVIDERS = [
  'claude',
  'gemini',
  'codex',
  'opencode',
]
```

Delete `DEFAULT_MODELS` and `DEFAULT_MODEL_CSV`. Rename every caller atomically
to `DEFAULT_AGENT_PROVIDERS` and `DEFAULT_AGENT_CSV`. No provider collection,
variable, prompt, validation message, or dashboard property should retain a
model name. Existing default provider membership stays unchanged; OpenCode is
selectable but not added to every council run.

The atomic inventory explicitly includes
`src/workflows/followups/plan.js`, which currently has a second provider list
called `DEFAULT_FOLLOWUP_MODELS` and accepts provider selections through
`models`. Rename the entire follow-up vocabulary in the same Phase 3 change:

```text
DEFAULT_FOLLOWUP_MODELS       → DEFAULT_FOLLOWUP_AGENTS
normalizeModels               → normalizeAgents
assertSupportedModels         → assertSupportedAgents
defaultModelsForTarget        → defaultAgentsForTarget
models / fallbackModels       → agents / fallbackAgents
selectedModels                → selectedAgents
missing_models / invalid_model → missing_agents / invalid_agent
```

This is part of the hard cut, not a compatibility alias.

The rest of the atomic provider rename inventory is:

| File/surface | Required rename |
|---|---|
| `src/core/agents/selection.js` | provider defaults and validation names |
| `src/cli/commands/nax.js` | workflow, hidden issue, preview, and direct-run flags/help |
| `src/cli/commands/issue.js` | provider arrays, loop variables, and prompt state |
| `src/cli/main.js` | interactive provider pickers and preview defaults |
| `src/workflows/catalog/prompts.js` | exported provider defaults |
| `src/workflows/engine/runner.js` | spawned CLI argv: agents remain agents; models become mappings |
| `src/workflows/followups/plan.js` | complete follow-up rename listed above |
| dashboard contracts/serializers/mutations | provider arrays move to `agents`/`stepAgents`; model maps take `models`/`stepModels` |
| tests, README, `site/content`, workflow skill template | examples and assertions use the new meanings |

Phase 3 is not complete while any provider list, provider picker, or provider
validation path is still named model.

### 6.3 Workflow file syntax

Keep `agents` as the provider list and make `models` and `efforts` first-class
maps keyed by provider:

```yaml
version: 1

defaults:
  agents:
    - claude
    - codex
  models:
    claude: claude-opus-4-8
    codex: gpt-5.6-sol
  efforts:
    claude: high
    codex: high

steps:
  - id: audit
    prompt: Audit the services directory.
    agents:
      - claude
      - codex
    models:
      claude: claude-opus-5
    efforts:
      claude: high
```

The maps make the domain unambiguous:

```yaml
agents:
  - claude
models:
  claude: claude-opus-4-8
efforts:
  claude: high
```

Do not introduce a generic `agentConfig` wrapper in the public workflow
format. Models and efforts are actual named concepts and should remain visible
to schema tooling, documentation, and users.

This keeps every existing workflow that already uses `agents` structurally
valid while intentionally changing any field or CLI surface that incorrectly
used `models` for providers. Support the same shape in YAML, JSON, JavaScript,
TypeScript, and TOML through the existing catalog normalization path.

Valid explicit Auto:

```yaml
models:
  claude: auto
efforts:
  claude: auto
```

Auto in a higher-precedence scope clears an inherited pin.

### 6.4 Resolution precedence

Resolve one provider at a time, in this order:

1. step-specific CLI override;
2. global CLI override;
3. step `models[provider]` / `efforts[provider]`;
4. `defaults.models[provider]` / `defaults.efforts[provider]`;
5. Auto/omitted.

Resolve model first. Then resolve effort with these rules:

- explicit `auto` becomes undefined;
- an explicit non-Auto effort requires a resolved pinned model;
- if a higher-precedence scope changes the model but does not specify effort,
  reset effort to Auto rather than inheriting a stale effort from the old
  model;
- an effort-only higher-precedence override may use an inherited pinned model;
- validate the final known model/effort pair;
- translate `max` to `xhigh` only for the two known models that require it.

Examples:

| Defaults | Step/CLI override | Result |
|---|---|---|
| Opus 4.8/high | none | Opus 4.8/high |
| Opus 4.8/high | model Sonnet 5 | Sonnet 5/Auto |
| Opus 4.8/Auto | effort high | Opus 4.8/high |
| Opus 4.8/high | model Auto | model omitted, effort omitted |
| Auto/Auto | effort high | validation error |
| GLM 5.2/Max | none | `model=z-ai/glm-5.2`, `effort=xhigh` |

The resolver should return the exact wire configuration plus warnings. Store
the resolved wire values on the run. Display helpers can map `xhigh` back to
Max when the model is known.

### 6.5 Validation behavior

Fail before any remote mutation when:

- the provider is unsupported;
- effort is pinned while model is Auto;
- a known model belongs to a different provider;
- a known model is paired with a known unsupported effort;
- model/effort is pinned on the GitHub transport;
- a duplicate provider configuration would create ambiguous run identity.

For a non-empty model ID not in the snapshot:

- accept and pass it through;
- show a warning that the ID is not in NAX's catalog;
- let the backend validate it;
- preserve it exactly in artifacts and retries.

For an unrecognized effort on an unknown model, use the same advanced
pass-through behavior with a warning. For a known model, reject unrecognized
effort values because the compatibility matrix is known.

## 7. CLI design

### 7.1 Provider, model, and effort flags

Use these provider-selection flags:

```text
--agents <list>
--step-agents <step=agents>
```

Use these model and effort configuration flags:

```text
--models <agent=model>
--efforts <agent=effort>
--step-models <step:agent=model>
--step-efforts <step:agent=effort>
```

All four configuration flags are repeatable. A model mapping needs the provider
because one workflow may run several providers and unknown future model IDs
cannot be reliably assigned by inspecting their names.

Reject the former provider-list forms:

```text
--models claude,codex
--step-models audit=gemini,codex
```

The error should say to use `--agents` or `--step-agents`. Do not infer,
deprecate, warn-and-continue, or otherwise preserve the old meaning.

### 7.2 Single-agent command

The provider is already positional, so use direct options:

```bash
nax run agent claude \
  "Audit the services directory" \
  --model claude-opus-4-8 \
  --effort high \
  --transport netlify-api
```

`--model auto` and `--effort auto` are valid and mean omission.

### 7.3 Workflow overrides

Use repeatable, explicit provider mappings:

```bash
nax run review \
  --agents claude,codex \
  --models claude=claude-opus-4-8 \
  --efforts claude=high \
  --models codex=gpt-5.6-sol \
  --efforts codex=high
```

Step-specific form:

```bash
nax run review \
  --step-models audit:claude=claude-opus-5 \
  --step-efforts audit:claude=high
```

Parsing should reject malformed mappings and duplicate assignments with the
conflicting option shown in the error.

### 7.4 Interactive and dry-run behavior

Interactive workflow launch:

1. select providers;
2. keep all provider configurations at Auto by default;
3. offer an optional Configure agents action;
4. for each chosen provider, select a model;
5. show only effort choices supported by that model.

Non-interactive execution must never prompt. It uses workflow/flag values and
validates them before submission.

Dry runs, confirmations, logs, and workflow previews should show:

```text
Claude · Opus 4.8 · High
Codex · Auto
OpenCode · GLM 5.2 · Max
```

For unknown IDs, show the exact raw value rather than mislabeling it Auto.

## 8. Execution, follow-up, and retry plumbing

### 8.1 Run creation

Update `src/workflows/engine/local-executor.js` so each `AgentRun` is created
with:

```js
{
  agent,
  model,   // optional resolved wire value
  effort,  // optional resolved wire value
  // existing run fields...
}
```

Resolve configuration once when materializing the run. Do not re-read mutable
defaults later during retry or resume.

Update `src/integrations/netlify/local-runner.js` so SDK calls are:

```js
sdk.start({ siteId, prompt, agent, model, effort, ... })
sdk.followUp(handle, { prompt, agent, model, effort, ... })
```

Every path must preserve the fields:

- initial runner create;
- ordinary follow-up;
- capacity retry;
- prompt-shrink retry;
- manual retry;
- resumed run;
- fallback handle reconstruction when values are present.

### 8.2 SDK adapter correction

Update `src/integrations/netlify/agent-runner-sdk.js`.

When reconstructing a handle from NAX state, include model and effort from the
specific run/session. When building a session-shaped artifact, nest all three
fields together:

```json
{
  "agent_config": {
    "agent": "opencode",
    "model": "z-ai/glm-5.2",
    "effort": "xhigh"
  }
}
```

Do not put `model` or `effort` at the session's top level.

### 8.3 Type contracts

Update JSDoc shapes in `src/types.js`:

- `WorkflowFlow.defaults.models`;
- `WorkflowFlow.defaults.efforts`;
- `WorkflowStep.models`;
- `WorkflowStep.efforts`;
- `AgentRun.model`;
- `AgentRun.effort`;
- `AgentSession.model`;
- `AgentSession.effort`;
- relevant workflow command option shapes.

All JavaScript additions must have precise JSDoc object/callback types. Do not
introduce `any`.

## 9. Persistence, artifacts, and events

Persist the resolved configuration, not merely the current catalog label.
That makes runs deterministic when the catalog later changes.

Update:

- workflow state and run checkpoints;
- agent-session JSON;
- agent-session Markdown summaries;
- workflow event payloads;
- dashboard run projections;
- resume/recovery snapshots.

Artifact representation:

```json
{
  "agent_config": {
    "agent": "claude",
    "model": "claude-opus-4-8",
    "effort": "high"
  }
}
```

Omit undefined fields. Old state/artifacts that contain only `agent` continue
to load as Auto. Additive optional fields do not require a workflow state
schema bump.

Use the response session's `agent_config` as observed execution data. Keep the
request's resolved configuration on the run as intent. If they differ, surface
both in diagnostic output rather than silently overwriting the request.

## 10. Dashboard

### 10.1 API contracts

The dashboard currently uses `models` and `stepModels` for provider lists.
Replace those meanings outright. The canonical request fields are:

```ts
type ProviderModelMap = Record<string, string>
type ProviderEffortMap = Record<string, string>

type StartWorkflowRequest = {
  agents?: string[]
  stepAgents?: Record<string, string[]>
  models?: ProviderModelMap
  efforts?: ProviderEffortMap
  stepModels?: Record<string, ProviderModelMap>
  stepEfforts?: Record<string, ProviderEffortMap>
  // existing fields...
}
```

Do not accept the old provider-list types for `models` or `stepModels`.
Validation should reject them and direct callers to `agents` or `stepAgents`.
Responses and client code use the same names and meanings as the CLI and
workflow format.

Update the shared contract, serializers, mutation service, transports, and
run-state projection together:

- `src/contracts/dashboard.ts`;
- `src/dashboard/api/serializers.js`;
- `src/dashboard/services/mutations.js`;
- `src/dashboard/transports/local-in-process.js`;
- `src/dashboard/transports/local-process.js`;
- `src/dashboard/transports/netlify-api.js`;
- `src/dashboard/api/run-state-projection.js`.

Expose the NAX model catalog through the dashboard capabilities response so the
web client does not duplicate IDs or effort rules.

### 10.2 UI behavior

Add an Agent configuration drawer/modal following the established React UI
interaction:

- provider tabs;
- model cards or selector;
- Auto model first;
- effort choices that react to the selected model;
- Max displayed as Max even when the wire value is `xhigh`;
- a clear notice when effort is unavailable;
- exact unknown model values preserved when editing existing state.

Apply it to:

- workflow launch;
- single-agent launch;
- follow-up launch.

For a follow-up, initialize configuration from the source session/run.
Switching provider initializes that provider's saved selection or Auto.

When the selected transport is GitHub Actions, disable pinned configuration and
show:

> Provider-specific model and effort settings require the Netlify API
> transport. GitHub Actions currently supports provider selection only.

Any dashboard implementation that changes UI must run:

```bash
npm run dashboard:build
```

Also run the dashboard typecheck and smoke test before handoff.

## 11. Transport capability policy

| Transport | Provider | Model | Effort | Policy |
|---|---:|---:|---:|---|
| Auto | Yes | Yes | Yes | Resolve to Netlify API if any selected run pins model/effort |
| Netlify API via SDK | Yes | Yes | Yes | Full support |
| Pinned GitHub Action | Yes | No | No | Fail early for non-Auto model/effort |

The inspected pinned action input named `default-model` is a legacy alias for
the agent provider. It is not a provider-specific model selector and must not
be reused for the new `model` field.

Do not encode model/effort in the prompt as a workaround. That would be
non-deterministic, invisible to `agent_config`, and misleading in artifacts.

Transport resolution must inspect the resolved run configurations before
dispatch. An explicit GitHub selection fails if any selected run is pinned;
Auto selects `netlify-api` in that case. Auto may retain the existing transport
selection behavior when every model and effort is omitted.

Supporting model and effort in the GitHub transport later requires a separate
change to the external action's inputs and dispatch contract, followed by a
pinned action SHA update in NAX.

## 12. Documentation

User-facing documentation is canonical under `site/content`. Update:

- `site/content/reference/workflow-files.mdx`;
- `site/content/reference/commands.mdx`;
- `site/content/guides/run-workflows.mdx`;
- `site/content/guides/use-the-dashboard.mdx`;
- `site/content/guides/agent-runner-sdk.mdx`;
- `site/content/concepts/glossary.mdx`;
- `site/content/concepts/transports.mdx`;
- `site/content/concepts/artifacts.mdx`;
- `site/content/for-agents.mdx`.

Also update:

- root `README.md`;
- workflow examples;
- `src/templates/skills/nax-workflows/SKILL.md`;
- CLI help snapshots/checks.

Documentation must explain:

- provider versus model versus effort;
- Auto omission semantics;
- provider/model compatibility;
- OpenCode's per-model effort limitations;
- Max-to-`xhigh` translation as an implementation detail;
- unknown model warning/pass-through behavior;
- GitHub transport limitations;
- the breaking change that provider lists now use `--agents` and
  `--step-agents`.

## 13. Implementation phases

### Phase 0 — Contract fixtures and terminology guardrails

1. Add focused test fixtures representing create and follow-up requests with
   `agent`, `model`, and `effort`.
2. Add the verified catalog snapshot and provenance note to the plan/test
   fixtures.
3. Inventory every current `models`/`stepModels` use that actually contains
   providers and add guard tests requiring it to be renamed or rejected.
4. Characterize GitHub dispatch and prove that provider is its only real
   configuration dimension.

**Exit:** tests capture the current behavior and the new wire contract without
changing production execution.

### Phase 1 — SDK `0.3.0`

1. Add optional `effort` to public inputs and normalized sessions.
2. Serialize it on create and follow-up.
3. Preserve it in handles, retry, ambiguity errors, and reconciliation.
4. Update SDK tests, examples, README, changelog, and canonical site guide.
5. Run SDK CI and pack smoke.
6. Set the package version to `0.3.0` without publishing or creating a release
   tag.

**Exit:** the packed SDK supports exact effort forwarding and old handles still
parse.

### Phase 2 — Human SDK publication checkpoint

Stop and hand the package to the user:

```text
Version: 0.3.0
Working directory:
/Users/david/dotfiles/clis/netlify-agent-executor/packages/agent-runner-sdk
Publish command:
npm publish
```

Do not run `npm publish`. Wait for explicit confirmation before registry
verification, tagging, or continuing the NAX dependency rollout.

After confirmation:

1. verify `nax-agent-runner-sdk@0.3.0`;
2. create/push the package-specific tag only through the approved release
   process;
3. update NAX's exact dependency and lockfile from `0.2.0` to `0.3.0`.

### Phase 3 — NAX core and CLI

1. Add provider constants, model catalog, resolver, and validation.
2. Normalize defaults/step `models` and `efforts` maps.
3. Add `--agents` and `--step-agents`, and remove provider parsing from
   `--models` and `--step-models`.
4. Make `--models`, `--efforts`, `--step-models`, and `--step-efforts` the
   canonical workflow configuration flags.
5. Materialize model/effort on each run.
6. pass the exact values through create, follow-up, retries, and resume;
7. add GitHub transport fail-fast validation;
8. update state, artifacts, events, logs, and previews.

**Exit:** a non-interactive workflow can pin different configurations by step,
and every resumed/retried request preserves its original resolved values.

### Phase 4 — Dashboard

1. Replace provider list contracts with `agents`/`stepAgents` and make
   `models`/`stepModels` actual model maps.
2. expose the server-side catalog;
3. add the configuration UI to workflow, single-agent, and follow-up launches;
4. display resolved configuration in run details and history;
5. add GitHub transport capability messaging;
6. run dashboard build, typecheck, and smoke tests.

**Exit:** dashboard and CLI produce the same resolver output for the same
selection.

### Phase 5 — Documentation and canary

1. Update canonical MDX, generated skill content, examples, and help text.
2. Run the complete repository verification matrix.
3. Run bounded live canaries using a disposable/test site.
4. Capture and sanitize real contract evidence only after observing it.
5. Set the NAX package version to `2.0.0` without publishing or creating a
   release tag.
6. Stop and provide the human release handoff:

   ```text
   Version: 2.0.0
   Working directory:
   /Users/david/dotfiles/clis/netlify-agent-executor
   Publish command:
   npm publish
   ```

7. Wait for explicit publication confirmation before verifying, tagging, or
   continuing the NAX rollout.

**Exit:** documentation, help, dashboard, artifacts, and actual API traffic use
the same terminology and values, and NAX `2.0.0` is ready for human
publication.

### Phase 6 — Downstream consumer rollout (separate repo)

The SDK ships from this repo but is consumed elsewhere. Revenue Engine
(`/Users/david/projects/revenue-engine`) depends on `nax-agent-runner-sdk`
pinned to `0.2.0` in the root, `services/ops-stack`, and `services/api`
manifests. It has three runtime adapters, one mutation-gated live contract
probe, and one additional type-only import surface. A `0.3.0` bump is backward
compatible, so nothing breaks on the old pin; this phase is what lets those
consumers actually *select* model and effort. It runs in the Revenue Engine
repo, not here, and only after Phase 2 publishes `0.3.0`.

Consumer inventory (verified at `nax-agent-runner-sdk@0.2.0`):

| Consumer/import surface | Call site | Current input | Rollout work |
|---|---|---|---|
| Ops RCA function | `clients/frontend/netlify/functions/lib/ops-agent-runner.ts` | `sdk.start`, threads `agent` + conditional `model`, no `effort` | add `effort` forwarding and its config source |
| Ops RCA finisher | `services/ops-stack/src/lib/agent-runner-finisher.ts` | reconstructs input as `agent: matched.agent` on reconcile | carry `model`/`effort` through the reconcile/retry path |
| Site customization | `services/api/src/lib/artifact-adapters/site/customization-runner.ts` | `effectiveStartInput()` hardcodes `agent: 'codex'`, no model/effort | add optional `model`/`effort` and a config source |
| Site realtime contract probe | `services/api/scripts/probe-site-realtime-contract.mjs` | mutation-gated `sdk.start` followed by exact-input reconciliation and stop; model/effort omitted | verify the probe on `0.3.0`; keep Auto as its default and optionally accept explicit canary model/effort inputs |
| Shared artifact type surface | `services/api/src/lib/artifact-adapters/realize-refs.ts` | type-only `BlobRef` import | no runtime threading; include it in the post-bump API typecheck |

Steps:

1. Bump the exact `nax-agent-runner-sdk` pin from `0.2.0` to `0.3.0` in the
   root, `services/ops-stack`, and `services/api` manifests, update the
   `pnpm-workspace.yaml` allowlist entry, and refresh the lockfile. The
   `clients/frontend` Netlify function resolves the root pin.
2. Thread optional `model`/`effort` into each `StartInput`/`FollowUpInput`
   builder above, omitting undefined fields exactly as the SDK does. Do not
   hardcode a model; source it from the consumer's own configuration.
3. Preserve `model`/`effort` across the finisher's reconciliation and retry
   paths so a resumed Ops RCA run replays its original resolved configuration.
4. Update the consumers' body-asserting tests for the new optional fields:
   `ops-agent-runner.test.ts`, `agent-runner-finisher.test.ts`,
   `agent-runner-usage.test.ts`, and `customization-runner.test.ts`.
5. Decide whether `agent-runner-usage` records should persist model/effort for
   reporting; treat that as a Revenue Engine product decision, not an SDK one.
6. Run the services/api typecheck to verify both the contract probe import and
   the type-only `BlobRef` surface, then run the mutation-gated probe only in an
   approved canary environment.

**Exit:** each Revenue Engine runtime adapter runs on `0.3.0` and can pass
model/effort end to end, with retries/reconciliation preserving the resolved
configuration; the contract probe and type-only import compile against
`0.3.0`; no consumer regresses on runs that omit both fields.

**Out of scope for this plan:** the concrete UX in Revenue Engine for choosing
model/effort (env var, request field, admin control) is that repo's decision.
This plan only guarantees the SDK surface and documents the threading required.

## 14. Test matrix

### 14.1 Resolver

Cover:

- Auto model omits model and effort;
- all listed provider/model pairs;
- all allowed effort values;
- every known rejected OpenCode effort;
- GLM and DeepSeek Pro `max` → `xhigh`;
- other Max-capable models keep `max`;
- model override resets stale inherited effort;
- effort-only override uses an inherited pinned model;
- explicit Auto clears inherited values;
- unknown model pass-through warning;
- known model/wrong provider error;
- duplicate/conflicting CLI assignment errors.

### 14.2 SDK and transport

Assert exact bodies for:

- create with all three fields;
- create with Auto-normalized omissions;
- follow-up with a changed model/effort;
- capacity retry;
- follow-up retry;
- ambiguous create reconciliation;
- ambiguous session reconciliation.

Ensure effort changes the reconciliation fingerprint.

### 14.3 Workflow formats

Load and normalize `models` and `efforts` in:

- YAML;
- JSON;
- JavaScript;
- TypeScript;
- TOML.

Files with string `agents` arrays remain valid because that field already has
the correct provider meaning.

### 14.4 CLI

Cover:

- `--agents`;
- real model mappings through `--models`;
- rejection of provider lists passed through `--models`;
- real model mappings through `--step-models`;
- rejection of provider lists passed through `--step-models`;
- `--efforts` and `--step-efforts`;
- all four workflow configuration mapping flags;
- direct `run agent --model --effort`;
- non-TTY behavior;
- dry-run labels;
- Auto transport selecting `netlify-api` for pinned model/effort;
- GitHub transport fail-fast before dispatch.

### 14.5 State and artifacts

Cover:

- resolved config in run checkpoints;
- exact config after process resume;
- nested `agent_config`;
- request versus observed response mismatch;
- Markdown rendering;
- dashboard projections and event streaming.

### 14.6 Dashboard

Cover:

- catalog loading;
- provider tab switching;
- effort choices changing with model;
- Auto omission;
- Max display and wire translation;
- follow-up defaults from the source session;
- unknown existing model preservation;
- GitHub capability notice;
- rejection of provider arrays in dashboard `models`/`stepModels`.

### 14.7 Live canary

Use a bounded test site and harmless prompts:

1. Claude + `claude-opus-4-8` + `high`;
2. Claude Auto with both fields omitted;
3. OpenCode + `z-ai/glm-5.2` + UI Max, verifying wire/response `xhigh`;
4. follow-up with explicit model/effort;
5. response session persists all fields under `agent_config`;
6. retry/resume preserves exact values.

Do not use the user's production example site as an automated canary unless the
user explicitly places it in scope.

## 15. Verification commands

During focused implementation:

```bash
npm run sdk:ci
npm run sdk:pack-smoke
npm run check
npm test
npm run check:cli-help
```

After dashboard changes:

```bash
npm run dashboard:typecheck
npm run dashboard:build
npm run dashboard:smoke
```

Before release handoff, also run `git diff --check` and confirm generated
dashboard assets correspond to the final source state.

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| React UI catalog changes independently | Keep catalog provenance, add a sync checklist/test fixture, and allow unknown IDs with warnings |
| Existing NAX "model" terminology causes incorrect plumbing | Rename every provider collection atomically and reject the old flag/request shapes |
| GitHub Action silently ignores settings | Capability validation fails before dispatch |
| Effort inherited after a model change is invalid | Higher-scope model change resets lower-scope effort to Auto |
| `max` versus `xhigh` leaks into UX | Resolver owns wire translation; display helper maps back to Max |
| Retry reconstructs partial input | Persist resolved model/effort on runs and SDK handles; replay stored effective input |
| Old artifacts fail to load | Treat missing optional config as Auto; keep schema and handle versions |
| Catalog becomes an SDK compatibility constraint | Keep the SDK string-based and catalog-free |
| OpenCode is unexpectedly added to costly defaults | Support it explicitly without changing existing default councils |

## 17. Non-goals

- dynamically discovering the model catalog from an undocumented endpoint;
- running multiple models from the same provider concurrently in one step;
- changing Agent Runner backend behavior;
- teaching the current GitHub Action model/effort support in this work;
- encoding settings into prompts;
- automatically changing existing workflow defaults to pinned models;
- publishing either package without the required human handoff.

## 18. Definition of done

- SDK create and follow-up accept, serialize, normalize, persist, retry, and
  reconcile `effort`.
- NAX distinguishes provider, model, and effort in code, help, docs, and UI.
- Every current React UI model is selectable with the correct effort matrix.
- Auto omits fields; GLM/DeepSeek Pro Max sends `xhigh`.
- Workflow defaults, step overrides, CLI overrides, dashboard choices, retries,
  and resumes all resolve predictably.
- Providers are represented only by `agents`; actual model IDs are represented
  only by `models`; old provider-style model flags and dashboard requests fail.
- GitHub transport rejects unsupported pinned configuration before mutation.
- Netlify API canaries verify create, follow-up, response persistence, and
  retry/resume.
- Required SDK, repository, CLI-help, dashboard build, and dashboard smoke
  checks pass.
- SDK `0.3.0` and NAX `2.0.0` are handed to the user for publication; no
  automated registry publication occurs.
- Downstream Revenue Engine consumers (Ops RCA function, ops-stack finisher,
  site customization adapter, contract probe, and type-only import) have a
  tracked Phase 6 rollout to `0.3.0` with model/effort threaded where
  applicable.
