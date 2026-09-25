---
id: 01M3CN9TY0YPY9MP9CXQSTD2HS
status: draft
createdAt: 2026-09-25T09:10:16-07:00
updatedAt: 2026-09-25T11:05:00-07:00
origin: manual
type: plan
---

# Flow Lint + Fail-Fast Across CLI, Dashboard, MCP

> Status: DRAFT v2. Codex review round 1 (Netlify runner `6ab6ae5ca90f294f6575eb87`) has been integrated, and each claim was re-verified; see §8. Supersedes beads `nax-pup.1` / `nax-pup.2` and finishes Workstream B of `docs/ai/plans/nax-tier1-tier2-plan.md`, most of which already shipped.

## 1. Why

There is already a flow validator. `validateFlowStructure` (`src/workflows/catalog/flows.js:368-578`) collects about 20 diagnostics `{stepId, code, message, hint}` and runs on every `loadFlow` via `normalizeFlow` → `assertValidFlowStructure` (`:603-613, :625-698`), with tests in `tests/unit/flows.test.js:417-553`. `normalizeFlow` also throws directly, before validation, for malformed agent config, lineup entries and zero steps (`:626-699`).

The problems are how validation is surfaced, what it misses, and drift between plan and run:

| # | Gap | Evidence | Impact |
|---|---|---|---|
| G1 | One invalid flow breaks every flow | `loadFlow` → `listFlows` (`flows.js:701-709`), which lets load/normalize throw (`:713-743`) | A typo in a custom flow breaks `nax run review`, the picker, the dashboard list and MCP `workflow_list` |
| G2 | Both dashboard servers drop diagnostics | Legacy `src/dashboard/server.js:2418-2428` sends `statusCode`/`code`/`message` but no `details`, and untyped errors become 500 `internal_error`. The newer API derives only status and code (`src/dashboard/api/app.js:237-260`) | DryRunPanel shows a generic error |
| G3 | MCP can't surface validation | `normalizeMcpError` copies `error.details` (`src/mcp/errors.js:261`), but validation lives on `error.validation`; `recoveryGuidance` has no `invalid_flow` branch (`:181-232`) | The agent can't self-correct |
| G4 | A plan doesn't pin the flow | `requestHash` covers scope, target and input only (`src/control-plane/planner.js:459-460`); start reloads the flow (`src/dashboard/runtime/local-workflow-execution.js:171-194`); `startStoredPlan` claims before executing (`src/control-plane/run-plans.js:218-232`) | An edited flow runs different steps than were approved, and drift would be recorded as a failed start |
| G5 | Lineup warnings are dropped | `resolveLineup` result ignored in validation (`flows.js:550-574`); warnings produced at `src/core/agents/instances.js:221-289` | A typo'd model id passes silently |
| G6 | Guaranteed runtime failures aren't caught | follow-up with no usable source → `NAX_FOLLOWUP_SOURCE_UNAVAILABLE` (`src/workflows/engine/local-executor.js:360-372`) | Mid-run failure after credits are spent |
| G7 | Planner prompt-size warnings never fire | `promptBytesByStep` is omitted (`src/dashboard/services/run-plans.js:159-176`; default at `planner.js:319-329`) | `context_too_large` is found only at submit |
| G8 | No `nax lint`, no CI check | `package.json`, `src/cli/commands/nax.js` | Authors (humans, and agents via the `nax-workflows` skill) can't validate without a run |

## 2. Principles
1. **One engine:** `validateFlowStructure` stays the only validator.
2. **Validate the resolved object:** load through configorama (`loadConfigFile`) exactly as runtime does.
3. **Isolation without accidental activation:** a broken flow reports its own diagnostics and never breaks others. An invalid override still **shadows** the lower-priority flow with the same id; it never silently activates it.
4. **Library code doesn't present:** catalog functions return data; only CLI renderers print.
5. **Structured all the way out:** diagnostics travel as `error.details.diagnostics` on every surface.
6. **Errors only for guaranteed failures.** Everything else is a warning.

## 3. Design

### 3.1 Discovery entries (G1)
- New `discoverFlowEntries(options)` in `flows.js` returns one typed entry per **winning id**:
  ```js
  /** @typedef {{ status: 'valid', id, flow, shadowed: FlowSourceRef[] }
   *   | { status: 'invalid', id, dir, file, source, validation: { errors, warnings }, shadowed }
   *   | { status: 'load-failed', id, dir, file, source, loadError: { code: 'flow_load_failed', message }, shadowed }} FlowEntry */
  ```
- **Source priority and duplicate-id shadowing are resolved BEFORE validation.** The highest-priority candidate for an id wins even when it is invalid. Lower candidates are listed in `shadowed`, not activated.
- Each candidate's load + `normalizeFlow` runs in its own try/catch. Throws from `normalizeFlow` before validation (malformed agent config, etc.) become `invalid` entries carrying a single diagnostic built from the thrown code and message.
- `listFlows(options)` becomes a pure wrapper that returns `entries.filter(valid).map(e => e.flow)`. It does no printing and keeps its current return type.
- `loadFlow(id)` resolves the winning entry directly:
  - `valid`: returns the flow;
  - `invalid`: throws `invalid_flow` with `details: { flowId, file, diagnostics }` (and keeps `error.validation` for existing callers);
  - `load-failed`: throws `flow_load_failed` with details;
  - missing: `Unknown flow`, whose message lists valid ids and then invalid ids separately.
- **Presentation boundaries:**
  - CLI picker (`src/cli/display/flow-list.js`): invalid entries are dimmed `(invalid: N errors)` and not selectable.
  - CLI commands print one stderr line per invalid entry (`Skipping flow "x": 2 errors. Run: nax lint x`).
  - Dashboard `listWorkflows` (`src/dashboard/storage/local-workflows.js:23`) and MCP `workflow_list` return entries with `invalid: true` and a diagnostics count.

### 3.2 Structured diagnostics everywhere (G2, G3)
- Validation throws put diagnostics in `error.details` (§3.1) and set `statusCode: 422`.
- **Both** dashboard serializers send `details`:
  - legacy `server.js:2418-2428` (`errorPayload(..., { details })`, the helper already supports it, `src/dashboard/api/errors.js:8-19`);
  - the newer `api/app.js` error path (add `detailsForError`).
- `invalid_flow` → 422 on both. This covers dry-run (`server.js:2308-2324`), run start, and run-plan (`run-plans.js:159`, where the `withHttpStatus` mapping keeps 422 rather than downgrading to 400).
- **DryRunPanel** (`src/dashboard/web/src/components/DryRunPanel.tsx`): on 422 `invalid_flow`, render a diagnostics list (step, code, message, hint). On success, render flow warnings. Run `npm run dashboard:build`.
- **MCP:** `details` already passes through. Add an `invalid_flow` branch to `recoveryGuidance`: "Fix the listed diagnostics in `<file>`, then call `workflow_plan` again; `nax lint <id> --json` shows the same list."

### 3.3 Checks
All live in `validateFlowStructure`.

| Code | Level | Rule |
|---|---|---|
| `followup_without_input` | error | `submit: follow-up` with no input entry that has a `step` (the engine uses the first such entry, `local-executor.js:346-351`) |
| `followup_source_not_agent_step` | error | That first input step is a human-review step or has no agents |
| `invalid_default_transport` | error | `defaults.transport` is not one of the values `src/integrations/transports.js` accepts |
| `transport_lineup_conflict` | error | Validate lineups with the flow's declared transport instead of the hardcoded `'auto'` (`flows.js:550`), so `github_transport_unsupported` surfaces at load time |
| `invalid_findings_source` | error | `findings.step` doesn't reference an existing agent step, or `findings.adapter` isn't registered (see `structured-findings-and-handoff-targets.md` §4.2) |
| `empty_prompt_file` | warning | The prompt file is empty or whitespace only |
| `unused_prompt_file` | warning | A `prompts/` file that no step references |
| `effort_clamped` / `effort_unavailable` / `catalog_passthrough` | warning | Carried from `resolveLineup` / `validateAgentConfig` with stepId. An unknown model stays a warning because the catalog can lag the runner |

- A follow-up of a follow-up is valid and stays unchecked.
- **Human review:** `defaultAction` and `timeout` are stored but never acted on (`src/workflows/human-review.js:69-70`), so there is nothing to validate; checks arrive with the behavior.
- Every error carries a fix hint, e.g. `followup_without_input`: "Add `input: [{ step: <earlier-step-id>, results: all }]` or change `submit` to `new-run`".

### 3.4 Plan pins an execution manifest (G4)
- **`flowManifest(flow)`:** a versioned object `{ manifestVersion: 1, flowId, steps: [ordered normalized steps], prompts: [{ stepId, sha256 }] }`. `flowDigest` = sha256 of its canonical JSON (ordered arrays, sorted object keys).
- `prepareWorkflowPlan` (`planner.js:319`) stores `flowDigest` on the plan and includes it in the `requestHash` inputs.
- **Execution-backend hook:** `validatePlan(plan)` is called by `startStoredPlan` **before** `claimStart` (`run-plans.js:218`). It reloads the winning flow entry and recomputes the digest.
  - On mismatch: throw recoverable `flow_changed_since_plan` (409) without touching plan state. The plan stays `prepared`, so re-planning is clean and nothing is recorded as a failed start.
  - An invalid entry at start: `invalid_flow` 422, same rule.

### 3.5 Planner prompt size (G7)
Pass `promptBytesByStep` = exact static prompt-file bytes + explicitly supplied context bytes (plan input `context` / `--context-file`). Documented as a **lower bound**: auto-context depends on checkout state and is not run at plan time, and prior-round results are unknown.

### 3.6 `nax lint` (G8)
```bash
nax lint [flow...] [--json] [--strict]
```
- No args: all winning entries from every source.
- Human output: `✔ review` / `✖ custom-audit (2 errors, 1 warning)`, then `steps[<i>] <stepId> <code>: <message>` with an indented `fix:`. Shadowed candidates are listed as info. Color only on a TTY.
- `--json`: `{ flows: [{ id, file, status, errors, warnings, shadowed }], summary: { total, invalid, warnings } }` on stdout only.
- Exit codes: 0 with no errors, 1 on any error; `--strict` also exits 1 on warnings.
- Register in `src/cli/commands/nax.js`, with the handler in `src/cli/commands/handlers.js`. Update `npm run check:cli-help`.
- **CI:** add a `check:flows` script (`node src/cli/nax.js lint --strict` over bundled `workflows/`) and chain it into `release:verify`. The `nax-workflows` skill template (`src/templates/skills/nax-workflows/SKILL.md`) tells agents to run `nax lint <id> --json` after authoring.

### 3.7 CLI `--dry` / run
No new wiring: `handleRunEngine` validates via `loadFlow` before submission (`src/cli/main.js:2773`). Confirm the carried warnings (§3.3) are not printed twice by `printFlowPlan` (`main.js:1743-1767`).

## 4. Decisions (resolved 2026-09-25)
| # | Decision |
|---|---|
| D1 | Skip invalid winners in ordinary listings, printed only at CLI presentation boundaries; invalid overrides shadow |
| D2 | Reject `flow_changed_since_plan`, checked before the start is claimed |
| D3 | The digest includes exact prompt bytes, via a versioned manifest |
| D4 | `catalog_passthrough` is a warning |
| D5 | HTTP 422 for `invalid_flow`, through one consistent serializer path on both servers |

## 5. Task breakdown
### Phase 0: isolation (G1)
- T0.1 Failing tests first, using temp flow dirs across two sources:
  - valid + invalid siblings: `listFlows` returns the valid one only, and `loadFlow('valid')` works;
  - an invalid high-priority override of a valid lower-priority flow: `loadFlow(id)` throws `invalid_flow` and does NOT return the lower flow;
  - `normalizeFlow` pre-validation throw → `invalid` entry;
  - configorama syntax error → `load-failed`.
- T0.2 `discoverFlowEntries` + `listFlows` wrapper + `loadFlow` resolution.
- T0.3 Picker, dashboard list and MCP list consume entries; CLI stderr skip line.

### Phase 1: structured surfacing (G2, G3)
- T1.1 `details` + 422 on both dashboard servers (route tests for each).
- T1.2 DryRunPanel diagnostics + Playwright case with an invalid fixture flow; `npm run dashboard:build`.
- T1.3 MCP `recoveryGuidance` branch; stdio integration test asserts the diagnostics array.

### Phase 2: checks (G5, G6)
- T2.1 One failing fixture test per new code (exactly one targeted diagnostic with stepId and hint).
- T2.2 Implement; carry lineup warnings; declared-transport validation.
- T2.3 Run all bundled `workflows/*` through lint. Any new error on a bundled flow goes to David before changing the flow.

### Phase 3: manifest pinning + prompt size (G4, G7)
- T3.1 `flowManifest` / `flowDigest` + `requestHash`; `validatePlan` hook before `claimStart`. Tests in `control-plane-planner.test.js` + `mcp-plan-tools.test.js`: plan → edit prompt → start → 409, and the plan status is still `prepared`.
- T3.2 `promptBytesByStep` lower bound; an oversized static prompt produces a plan warning.

### Phase 4: `nax lint` + CI + docs
- T4.1 Command, renderers, exit codes, CLI help guard.
- T4.2 `check:flows` + `release:verify`; skill template.
- T4.3 `site/content` "Validate your flow" section listing every code with its fix; CHANGELOG.

## 6. Testing strategy
- Validator: pure tests (the existing `existsSync` injection) plus real temp-dir suites.
- CLI: `node src/cli/nax.js lint ... --json` as a subprocess, asserting stdout JSON and exit code.
- Dashboard: route tests on both servers + Playwright.
- MCP: extend `tests/integration/mcp-local-e2e.test.js` (invalid flow diagnostics; `flow_changed_since_plan` leaves the plan re-plannable).
- **Acceptance:**
  1. A broken custom flow doesn't block `nax run review --dry --force`.
  2. `nax lint` reports every defect in one pass, then exits 1.
  3. A broken override does not silently run the bundled flow of the same id.
  4. The dashboard dry-run shows diagnostics, not "internal error".
  5. MCP returns diagnostics with specific guidance.
  6. A prompt edit after planning → 409, and the plan is not marked failed.
  7. 0 credits spent on any §3.3 error.

## 7. Risks
| Risk | Mitigation |
|---|---|
| New errors break a working flow | Errors only for guaranteed failures; T2.3 gates bundled flows |
| Hidden flows surprise users | stderr skip line, `Unknown flow` lists invalid ids, picker shows them, `nax lint` shows shadowing |
| The digest is sensitive to prompt whitespace | Intentional: prompts are behavior. Recovery is one re-plan |
| Two dashboard servers drift | Shared `detailsForError` helper used by both |

## 8. Review round 1 (Codex) — integration record
Every Codex claim was re-verified in code (2026-09-25).
- **Accepted:** discovery/validation/presentation split with shadowing preserved (`seenIds` is set only after a successful normalize, `flows.js:726-729`); digest verification before `claimStart`; versioned manifest; empty prompt downgraded to a warning; human-review checks dropped (`defaultAction` defaults to `pause` and is never acted on); prompt-size claim bounded to static + explicit context.
- **Found in verification, missed by Codex:** the legacy `server.js` serializer also drops `details`; both servers need the fix.

## 9. Out of scope
`nax flow new` scaffolder (`nax-pup.3`); control-flow keys (`when:`, `onFailure`); prompt template validation (no templating engine exists); JSON Schema export.
