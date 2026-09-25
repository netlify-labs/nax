---
id: 01M3CN9TY0YPY9MP9CXQSTD2HS
status: draft
createdAt: 2026-09-25T09:10:16-07:00
updatedAt: 2026-09-25T09:10:16-07:00
origin: manual
type: plan
---

# Flow Lint + Fail-Fast Across CLI, Dashboard, MCP

> Status: DRAFT v1 for review (planning-workflow round 1). Supersedes beads `nax-pup.1` / `nax-pup.2` (2026-06-10) and finishes Workstream B of `docs/ai/plans/nax-tier1-tier2-plan.md`, most of which **already shipped**.

## 1. Why, and what changed since the beads

A common assumption, including the beads' premise, is that "there is no flow validation". **That's wrong.** `validateFlowStructure` (`src/workflows/catalog/flows.js:368-578`) already collects about 20 diagnostics `{stepId, code, message, hint}` and runs on every `loadFlow` via `normalizeFlow` → `assertValidFlowStructure` (`:603-613, :696`). It covers duplicate step ids, missing prompt files, action/submit/waitFor enums, input step references (unknown, self, future), `results` enums, model/effort maps and lineups. Tests exist (`tests/unit/flows.test.js:417-553`).

So this plan is not about building a validator. The real problems are in how validation is **surfaced**, the **cases it misses**, and **drift between plan time and run time**:

| # | Gap | Evidence | User impact |
|---|---|---|---|
| G1 | **One invalid flow breaks all flows.** `listFlows` calls `normalizeFlow` per directory and lets the throw escape | `flows.js:713-735`; `loadFlow` calls `listFlows` (`:701-709`) | A typo in a custom flow breaks `nax run review`, the picker, `dashboard` listing, and MCP `workflow_list` |
| G2 | **The dashboard turns validation failures into HTTP 500 `internal_error`**, and `error.validation` is never serialized | top-level catch `src/dashboard/server.js:2418`; `loadFlow` at `:1281, :2316` | DryRunPanel shows a generic error, not "step 2: prompt file missing" |
| G3 | **MCP gives generic recovery advice** for `invalid_flow` | `src/mcp/errors.js` `recoveryGuidance` has no branch for it | The agent can't self-correct |
| G4 | **A plan doesn't pin the flow content.** `requestHash` omits it, and the flow is re-loaded at start | `src/control-plane/planner.js:459`; `src/dashboard/runtime/local-workflow-execution.js:171` | A flow edited between `workflow_plan` and `run_start` runs different steps than were planned and approved |
| G5 | **Useful warnings are dropped.** `resolveLineup` warnings (`effort_clamped`, `effort_unavailable`, `catalog_passthrough` for unknown models) are discarded inside validation | `flows.js:550-574`; `src/core/agents/configuration.js:420-435` | A typo'd model id passes silently and fails at submit, after earlier steps spent credits |
| G6 | **Missing semantic checks** (list in §3.3) | follow-up with no completed source fails at runtime `NAX_FOLLOWUP_SOURCE_UNAVAILABLE` (`local-executor.js:367-369`) | Mid-run failure after credits are spent |
| G7 | **Planner prompt-size warnings never fire**: `promptBytesByStep` is never passed | `src/dashboard/services/run-plans.js:168` | `context_too_large` is only discovered at submit |
| G8 | **No `nax lint` command**, and no CI check for bundled flows | `package.json` scripts; `src/cli/commands/nax.js` | Flow authors (humans and agents using the `nax-workflows` skill) can't validate without attempting a run |

## 2. Design principles
1. **One engine.** `validateFlowStructure` remains the only validator. Lint, dry-run, the dashboard and MCP all call it through `loadFlow` or a new collect-mode wrapper. There is no parallel checker.
2. **Validate the resolved object.** Flows load through configorama (JS/TS/YAML/JSON/TOML with variables), so lint must load them the same way (`loadConfigFile`) and not parse the raw file.
3. **Isolation.** A broken flow reports its own diagnostics. It never hides or breaks other flows.
4. **Structured all the way out.** Diagnostics reach every surface as data (`{flowId, stepId, code, message, hint, level}`), not as a formatted string.
5. **Errors block, warnings inform.** No new hard errors for anything that works today, except G6 cases that are guaranteed runtime failures (§3.3 marks each).

## 3. Design

### 3.1 Collect-mode listing (G1)
- `listFlows(options)` gains `{ includeInvalid = false }`.
  - Each directory is loaded in its own try/catch.
  - Failures become `InvalidFlowEntry { id, dir, file, source, invalid: true, validation: { errors, warnings }, loadError?: { code: 'flow_load_failed', message } }`. Syntax and configorama errors land in `loadError`.
- **Default (`includeInvalid: false`):** invalid entries are filtered out and a one-line stderr warning is printed per invalid flow (`Skipping flow "x": 2 errors. Run: nax lint x`). Valid flows keep working. **This is a behavior change:** today everything throws. It is the fix.
- `loadFlow(id)` of an invalid flow throws the existing `invalid_flow` error with `error.validation` (unchanged contract). An unknown id still throws `Unknown flow`, and the message now also lists invalid flow ids separately.
- **Picker** (`src/cli/display/flow-list.js`): with `includeInvalid: true`, invalid flows are shown dimmed as `(invalid: N errors)` and are not selectable. Choosing one prints its diagnostics.
- **Dashboard** `listWorkflows` (`src/dashboard/storage/local-workflows.js:23`) and MCP `workflow_list` include invalid entries with `invalid: true` and a diagnostics count, so users can find the problem.

### 3.2 Structured diagnostics on every surface (G2, G3)
- **Dashboard API:** map `code === 'invalid_flow'` to HTTP **422** `{ error: { code: 'invalid_flow', message, details: { flowId, diagnostics: [...] } } }` in the dashboard error serializer (`src/dashboard/api/errors.js`), so the top-level catch no longer turns it into a 500.
  - This applies to the dry-run (`server.js:2308-2324`), run start (`:2335`), and run-plan (`run-plans.js:159`) endpoints.
- **DryRunPanel** (`src/dashboard/web/src/components/DryRunPanel.tsx`): on 422 `invalid_flow`, render a diagnostics list (step, code, message, hint) instead of the stderr blob. On success, also render `flow.warnings` returned by the endpoint.
  - The subprocess dry-run is kept as is; it already includes lineup warnings in stdout.
  - Run `npm run dashboard:build` after the change.
- **MCP:** `normalizeMcpError` passes `details.diagnostics` through into `structuredContent`. `recoveryGuidance` gets an `invalid_flow` branch: "Fix the listed diagnostics in `<file>`, then call `workflow_plan` again. `nax lint <id> --json` gives the same output."

### 3.3 New checks (G5, G6)
All of them go inside `validateFlowStructure`, so every surface gets them for free.

| Code | Level | Rule | Why this level |
|---|---|---|---|
| `followup_without_input` | error | `submit: follow-up` requires `input[0]` | Guaranteed runtime failure (`completedContinuationRuns` has no source) |
| `followup_source_not_agent_step` | error | `input[0].step` of a follow-up must be a non-human-review step with agents | Same |
| `empty_prompt_file` | error | Prompt file exists but is 0 bytes or whitespace only | An agent run with no instructions is always a mistake |
| `invalid_default_transport` | error | `defaults.transport ∉ {auto, github-actions, netlify-api}`, including the aliases accepted in `src/integrations/transports.js` | Unknown value falls through today |
| `transport_lineup_conflict` | error | `defaults.transport` is `github-actions` and a step pins models, efforts or multiple instances of one provider | `resolveLineup` already throws `github_transport_unsupported` at run time; validate with the declared transport instead of hardcoded `'auto'` (`flows.js:550`) |
| `invalid_review_config` | error | Human-review step: `defaultAction ∉ {approve, cancel}` or `timeout` unparsable | Currently unchecked (`src/workflows/human-review.js`) |
| `invalid_findings_source` | error | New `findings.step` key (see the findings plan) must reference an existing step | Keeps the new key honest |
| `effort_clamped` / `effort_unavailable` / `catalog_passthrough` | warning | Carry `resolveLineup` / `validateAgentConfig` warnings into `validation.warnings` with stepId | Stops dropping them (G5). `catalog_passthrough` (unknown model id) stays a warning because the catalog can lag the runner |
| `unused_prompt_file` | warning | A file in the `prompts/` directory that no step references | Cheap signal of a typo'd `prompt:` path |

A follow-up of a follow-up step is valid today and stays unchecked. Every new error needs a fix hint, e.g. `followup_without_input`: "Add `input: [{ step: <earlier-step-id>, results: all }]` or change `submit` to `new-run`".

### 3.4 Plan pins the flow (G4)
- **`flowDigest`:** sha256 over a canonical JSON of the normalized flow, keyed by step id plus each referenced prompt file's bytes. Computed in `prepareWorkflowPlan` (`planner.js:319`) and stored on the plan. It is added to `requestHash` inputs.
- At `run_start` from a plan, recompute the digest from the freshly loaded flow. On mismatch, reject with new recoverable code `flow_changed_since_plan` (HTTP 409). Guidance: "Flow `<id>` changed after planning. Call `workflow_plan` again."
- There is no silent re-plan: approval semantics (the plan the human or agent saw) are the point of plans.

### 3.5 Planner prompt-size (G7)
Pass `promptBytesByStep` from `run-plans.js:168`, computed as static prompt-file bytes plus the auto-context estimate the CLI already computes, so `context_too_large` warnings fire at plan time. Prior-round results are unknown at plan time; the doc comment says the check is a lower bound.

### 3.6 `nax lint` (G8)
```bash
nax lint [flow...] [--json] [--strict]
```
- No args: all flows from every source (bundled, project `.nax/flows` or equivalent `flowSources`), using `includeInvalid: true`.
- Human output: per flow `✔ review` or `✖ custom-audit (2 errors, 1 warning)`, then diagnostics as `steps[<i>] <stepId> <code>: <message>` with an indented `fix:` hint. Colors and boxes only on a TTY.
- `--json`: `{ flows: [{ id, file, valid, errors: [...], warnings: [...] }], summary: { total, invalid, warnings } }` on stdout only.
- Exit codes: 0 when there are no errors, 1 when any flow has errors; `--strict` also exits 1 on warnings.
- Register in `src/cli/commands/nax.js` and wire the handler in `src/cli/commands/handlers.js`. Update the CLI help snapshot guard (`npm run check:cli-help`).
- **Repo CI:** add `check:flows` → `nax lint --strict` over bundled `workflows/`, and chain it into `release:verify`. Update the `nax-workflows` skill template (`src/templates/skills/nax-workflows/SKILL.md`) to tell agents to run `nax lint <id> --json` after authoring.

### 3.7 CLI `--dry` and run
No wiring change is needed: `handleRunEngine` already validates via `loadFlow` before anything is submitted (`src/cli/main.js:2773`). With §3.1 the error now names only the broken flow, and with §3.3 more defects are caught. `printFlowPlan` (`main.js:1743-1767`) already prints flow warnings; confirm the carried lineup warnings (§3.3) are not printed twice.

## 4. Decisions needed (David)
- **D1.** Default listing skips invalid flows with a stderr warning (recommended), or keeps today's all-fail behavior outside the picker?
- **D2.** `flow_changed_since_plan`: reject (recommended), or warn and proceed?
- **D3.** Include prompt file **contents** in `flowDigest` (recommended: prompt edits change what agents do), or only the flow structure?
- **D4.** `catalog_passthrough` (unknown model id): warning (recommended) or error?
- **D5.** HTTP 422 for `invalid_flow` (recommended) vs 400, to match the existing `invalid_*` → 400 mapping in `run-plans.js:71`? 422 separates "your request is malformed" from "the flow on disk is broken", but it is a new status in the API.

## 5. Task breakdown
### Phase 0: Isolation (G1), highest value, smallest change
- T0.1 Failing test first: a fixture flow directory with one valid and one invalid flow. `listFlows()` returns the valid one, `listFlows({includeInvalid:true})` returns both, and `loadFlow('valid')` succeeds.
- T0.2 Implement collect-mode + stderr skip warning + the `Unknown flow` message listing invalid ids.
- T0.3 Picker shows invalid flows dimmed; dashboard/MCP lists carry `invalid` + count.

### Phase 1: Structured surfacing (G2, G3)
- T1.1 Dashboard error mapping → 422 with diagnostics (unit test on the serializer + route test).
- T1.2 DryRunPanel diagnostics rendering + Playwright case using an invalid fixture flow; `npm run dashboard:build`.
- T1.3 MCP error passthrough + `recoveryGuidance` branch; MCP stdio integration test asserts the diagnostics array.

### Phase 2: New checks (G5, G6)
- T2.1 One failing test per new code in `tests/unit/flows.test.js` (a fixture per defect, asserting exactly one targeted diagnostic with stepId and hint).
- T2.2 Implement the checks; carry lineup warnings; declared-transport lineup validation.
- T2.3 Confirm all bundled flows are still valid (`workflows/*`). Fix any that aren't, or ask David if a fix changes behavior.

### Phase 3: Plan pinning + prompt size (G4, G7)
- T3.1 `flowDigest` in the planner + `requestHash`; mismatch → `flow_changed_since_plan`. Tests in `control-plane-planner.test.js` + `mcp-plan-tools.test.js`: plan, edit the prompt file, start, get 409.
- T3.2 Pass `promptBytesByStep`; a test where an oversized static prompt produces a plan warning.

### Phase 4: `nax lint` + CI
- T4.1 Command, human and JSON renderers, exit codes; CLI help guard.
- T4.2 `check:flows` script + `release:verify` chain; skill template update.
- T4.3 Docs: `site/content` flow-authoring page gets a "Validate your flow" section listing every diagnostic code with its fix; CHANGELOG.

## 6. Testing strategy
- Pure validator tests with real fixture flow directories (the existing `existsSync` injection in `validateFlowStructure` stays for unit speed; a second suite hits the real filesystem via temp dirs).
- CLI tests invoke `node src/cli/nax.js lint ... --json` as a subprocess and assert stdout JSON plus the exit code (real process, no mocks).
- Dashboard: route test + Playwright e2e with an invalid fixture flow.
- MCP: extend `tests/integration/mcp-local-e2e.test.js` for invalid-flow diagnostics and `flow_changed_since_plan`.
- **Acceptance:**
  1. With one broken custom flow present, `nax run review --dry --force` still works and prints a one-line skip warning.
  2. `nax lint` lists every defect in one pass with path, code and hint, and exits 1.
  3. The dashboard dry-run of a broken flow shows the diagnostics list, not "internal error".
  4. MCP `workflow_plan` on a broken flow returns diagnostics plus specific guidance.
  5. Editing a prompt after `workflow_plan` makes `run_start` fail with `flow_changed_since_plan`.
  6. Credits spent on any defect in §3.3: 0.

## 7. Risks
| Risk | Mitigation |
|---|---|
| New errors break a flow that works today | Each new error is proven to be a guaranteed runtime failure (§3.3); T2.3 runs all bundled flows; ask before tightening anything else |
| Silent skipping hides a flow the user expects | The skip warning goes to stderr on every listing; `Unknown flow` lists invalid ids; the picker shows them |
| Digest too sensitive (whitespace in prompt) | Intentional: a prompt change is a behavior change. The error is recoverable with one re-plan |
| Double-printing warnings in `--dry` | Explicit dedupe check in T2.2 |

## 8. Out of scope
`nax flow new` scaffolder (bead `nax-pup.3`); control-flow keys (`when:`, `onFailure`); template placeholder validation (there is no templating engine today); JSON Schema export for editors.
