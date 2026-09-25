---
id: 01M3CN9TWN39AFPTE94BKAFNFG
status: draft
createdAt: 2026-09-25T09:10:16-07:00
updatedAt: 2026-09-25T12:10:00-07:00
origin: manual
type: plan
---

# Structured Findings (`findings.json`) + Handoff Targets

> Status: DRAFT v3. Codex review rounds 1 (runner `6ab6ae5ca90f294f6575eb87`) and 2 (runner `6ab6b79908b0baa3420c73b6`) have been integrated, and each claim was re-verified against the code; see §9. Implementation order across plans: flow lint → findings → mid-step resume. Supersedes the design sketches in beads `nax-i9j`, `nax-i9j.1-.4`, `nax-u76` (2026-06-10, pre-restructure paths).

## 1. Why

The product of a nax workflow is the consensus: the ranked, cross-checked list of findings from the last agent step. Today it reaches the user only as markdown:

- `nax handoff` copies, opens or re-prompts from `summary.md` (`src/cli/main.js:1159-1260`, `src/workflows/followups/handoff-sources.js`). Every source is `summaryText` markdown.
- MCP run details return markdown sections (`src/mcp/adapters/local-dashboard.js:560-597`).
- The dashboard has no findings model. Fenced JSON renders as a markdown code block (`src/dashboard/web/src/components/RunDetailsModal.tsx:1284` → `MarkdownRenderer.tsx`).

The data is already structured and reliable:

- The bundled `review` prompts require a `## 2. Structured Findings` / `## 2. Structured Consensus` heading followed by fenced JSON (`workflows/review/prompts/1_review.md:41-75`, `2_cross-review.md:56-98`, `3_summarize-consensus.md:44-89`).
- **Measured on this repo's `.nax/` (2026-09-25):** 11/11 real synthesize outputs `JSON.parse` cleanly. 30/32 round-1 outputs parse; the 2 misses are codex outputs with no heading, not malformed JSON.
- nax extracts these blocks with a regex (`src/workflows/round-results.js:10-13, 195-210`) only to shrink follow-up prompts. It never parses them.

The work is to parse once, expose the result as typed data, and route it to where work happens.

### Who benefits

| User | Today | After v1 | After v1.1 |
|---|---|---|---|
| Human after `nax run review` | Reads long markdown, hand-creates issues | `nax handoff --findings` table; `--to github-issues` creates labeled issues; rerun creates no duplicates | + PR review, beads |
| MCP client | Scrapes markdown | Reads typed `findings` from run details or a resource | same |
| David / beads workflow | Transcribes into `br create` | via github-issues | `--to beads` direct |
| Future features | n/a | `when: findingsAtLeast`, model scorecard, cost-per-finding all read one contract | |

## 2. Scope

- **v1:**
  - pure findings builder + review-consensus adapter;
  - terminal-time `findings.json` write;
  - read-only CLI (`--findings`) and MCP (summary + resource);
  - `--to github-issues`.
- **v1.1 (separate plan update once v1 ships):**
  - `--to pr-review`;
  - `--to beads`;
  - the dashboard Findings tab.
- **Later, one at a time:** named adapters for audit flows, each proven by fixture tests of its exact shape.

Why this split: v1 proves the artifact contract end to end, including one outbound target, so the feature is useful on day one. The next two targets add diff parsing and a second CLI integration, which are separate risk surfaces.

## 3. Grounded current state

### 3.1 Where the text lives
- `workflow.json` `steps[].runs[].resultText` holds the full text for both transports:
  - Netlify: supplied/run/session/runner result (`src/workflows/results/agent-run-results.js:627-645`).
  - GitHub: the reply comment body (`:657-681`).
- Per-agent copy: `.nax/workflows/<runId>/artifacts/steps/NN-<stepId>/agent-runners/<agent>.json` (`buildAgentJson`, `src/workflows/artifacts/workflow-artifacts.js:177-207`).
- **Artifact persistence runs on every state save, not only at the end.** `saveRunState` calls `persistWorkflowArtifacts(next, { summaryOnly: true })` after every write (`src/storage/local/run-state.js:469-476`), and step persistence cascades into it (`workflow-artifacts.js:654-688`). Terminal status is set separately in `src/cli/main.js:2923-2953`. Findings generation therefore must NOT hook into `persistWorkflowArtifacts`.

### 3.2 Structured block shapes
- **Review round 1/2:** array of `{id:"R1"|"CR1", category, severity, status, file, line, claim, evidence, suggested_fix, confidence}`.
- **Review synthesize:** `{consensus_findings:[{id:"S1", category, severity, status: open|already_fixed|merge_dependent|dropped, file, line, claim, evidence, suggested_fix, confidence}], contested_findings:[], merge_dependent_findings:[]}`.
- **Other flows vary a lot:** security `SEC-1 {domain,title,kernel_axiom,attack_vector,impact,recommended_fix,verification}`, SEO `{issue, search_impact, recommended_fix}`, analytics `{event, trigger, decision_enabled, ...}`, ideas synthesize `{consensus_winners:[{rank, idea_id_or_title, verdict, ...}]}` (ranked ideas, not findings). A generic heuristic would misread them. They are out of v1.
- **Attribution precedent:** the security synthesize prompt already asks for `"agents": ["claude", "codex"]` per consensus item (`workflows/security-audit/prompts/2_synthesize-security.md:52`). The review consensus schema has no attribution.

### 3.3 Target provenance
- `resolvePullRequestTarget` returns only `{branch, sha, fork}` (`src/integrations/git/target.js:151-180`).
- `normalizeTarget` keeps six fields and strips the rest (`:126-135`).
- `verifiedRemoteTarget` and `advisoryGithubTarget` rebuild the target without PR identity (`:183-209`).
- `legacyTargetFromRunState` re-normalizes (`:299-310`).
- The strict TS mirror is `Target` in `src/contracts/dashboard.ts:73-80`.
- The dashboard serializer passes `runState.target` through whole (`src/dashboard/api/serializers.js:67, :94`), so no serializer change is needed.
- JSDoc `TargetLike` is a loose record (`src/types.js:40-59`).

### 3.4 Handoff source resolution
`workflowSources` only offers status exactly `completed` (`handoff-sources.js:56-74`). It excludes `completed_with_failures` and `failed` runs, which can still carry a valid consensus.

### 3.5 Integration seams
- `createIssue({repo,title,body,labels})` runs `gh issue create --label ...` (`src/integrations/github/issue-plan.js:214-229`).
- `runGh` with retries (`src/integrations/github/gh-cli.js:71`); `assertGhAuthenticated` (`:109`).
- Marker conventions: `src/integrations/github/comment-markers.js`. Nothing dedupes on markers yet.
- No PR review API use and no `br` integration anywhere in `src`.

## 4. Design

### 4.1 Invariants
1. **Derived and pure.** `buildFindings(runState, flow)` is a pure function of `workflow.json` + flow declaration. It does no I/O.
2. **Writes only at terminal transitions.** Reads never write. An old run that lacks `findings.json` gets a computed artifact in memory. There is no lazy backfill to disk, no lock on reads and no migration.
3. **Never affects run outcome.** The terminal-time write is wrapped; failure logs a warning and leaves run status and exit code unchanged.
4. **Stable identity.** Key = `<runId>/<stepId>/<localId>`. All idempotency rests on it. `localId` is the model-emitted id (`S1`) for a single source run. For fan-out it is `<instanceId>:<sourceLocalId>`, with `/` and `:` inside `instanceId` percent-encoded so keys stay unambiguous; the model-emitted id is kept as `sourceLocalId`.
5. **Plan, then apply.** Every target computes `actions[]` first; `--dry` prints them. Tests and dry-run share the path.
6. **Advisory posture** (v1.1 PR reviews): always `event: COMMENT`.

### 4.2 Flow declaration (explicit only)
New optional top-level flow key, validated by the flow validator (see `flow-lint-and-fail-fast.md`, code `invalid_findings_source`):
```yaml
findings:
  step: synthesize          # must reference an existing agent step
  adapter: review-consensus # must be a registered adapter name
```
- There is **no** "last parseable step" fallback: it would pick the `ideas` flow's ranked-ideas block, or an implementation plan. A flow without `findings:` has no findings, and the CLI says so.
- v1 registers one adapter, `review-consensus`, and adds the declaration to `workflows/review/flow.yml`.
- **`normalizeFlow` must carry the key.** It builds a fixed object and drops unknown top-level keys (`src/workflows/catalog/flows.js:643-699`). Without that, `buildFindings` would never see the declaration at runtime. Add `findings: { step, adapter } | null` to the normalized flow, the JSDoc flow typedef (`src/types.js`), the TS workflow contract (`src/contracts/workflow.ts`), and the versioned flow manifest (`flow-lint-and-fail-fast.md` §3.4).
- **No import cycle:** adapter ids live in a dependency-free constant `FINDINGS_ADAPTER_IDS` in `src/core/constants.js`. The validator in `flows.js` checks against that list; `src/workflows/findings/` registers implementations under the same ids, and a unit test asserts the two sets are equal.

### 4.3 Module layout
```text
src/workflows/findings/
  extract.js      # locate + JSON.parse structured blocks (regex moves here; round-results.js imports it with numberedOnly)
  adapters/
    review-consensus.js
  index.js        # buildFindings(runState, flow), adapter registry, readFindings (pure read), writeFindings (terminal only)
src/workflows/handoff-targets/
  index.js        # registry { id, plan(findings, ctx), apply(actions, ctx) }
  github-issues.js
```
Run `npm run check:import-direction` to confirm the layering: `findings` depends only on `core/*`, and the targets on `integrations/github/*`.

### 4.4 `findings.json` schema v1
Path: `.nax/workflows/<runId>/artifacts/findings.json`.
```json
{
  "schemaVersion": 1,
  "runId": "2026-09-25T16-02-11-000Z-review",
  "flowId": "review",
  "adapter": "review-consensus",
  "generatedAt": "2026-09-25T16:40:00.000Z",
  "source": { "stepId": "synthesize", "instanceId": "codex:auto:auto", "runnerId": "...", "sessionId": "...", "resultUrl": null },
  "target": { "branch": "fix/auth", "sha": "abc123...", "pullRequest": { "number": 123, "url": "https://github.com/o/r/pull/123" } },
  "findings": [
    {
      "key": "2026-09-25T16-02-11-000Z-review/synthesize/S1",
      "localId": "S1",
      "rank": 1,
      "bucket": "consensus",
      "title": "Token refresh races with logout",
      "category": "defect",
      "severity": "high",
      "status": "open",
      "file": "src/auth/session.ts",
      "line": 88,
      "lineEnd": null,
      "claim": "...",
      "evidence": "...",
      "suggestedFix": "...",
      "confidence": "high",
      "agents": ["claude", "gemini"]
    }
  ],
  "diagnostics": [{ "stepId": "synthesize", "instanceId": "codex:auto:auto", "code": "no_structured_heading", "message": "..." }]
}
```
Field rules for `review-consensus`:
- `rank` is the 1-based position in `consensus_findings`. `contested_findings` and `merge_dependent_findings` get `rank: null` and their own `bucket`.
- `title`: the agent's `title` if present, otherwise the first sentence of `claim`, cut to 100 characters on a word boundary.
- `severity` is normalized to `critical|high|medium|low|info`. An unknown value keeps `severityRaw`, sets `info`, and adds a diagnostic.
- `line`: an integer or null. `"88-94"` becomes `line: 88, lineEnd: 94`.
- `agents`: from the new prompt field (§4.5). It is validated against the provider names or instance labels of the source steps' lineups. Unknown entries are kept and produce a diagnostic. When absent it is `[]`, never invented.
- `target.pullRequest` is present only for PR-selector runs (§4.6).
- Typedefs `Finding` and `FindingsArtifact` go in `src/types.js`, with a TS mirror in `src/contracts/`.

If the source step has more than one completed run (fan-out), findings from each run are merged, with the fan-out `localId` rule from §4.1 and `rank: null`. Only current attempts (`step.runs`) are read, never superseded attempts (see `mid-step-resume.md` §3.3).

### 4.5 Attribution field (prompt change)
Add `"agents": ["claude", "gemini"]` (the providers whose findings the consensus item merges) to the schema in `workflows/review/prompts/3_summarize-consensus.md`. It uses the same field name and meaning as the security synthesize prompt. It is one line of prompt, it is verifiable against known lineups, and it enables the model scorecard later. Per-finding source ids (`R2`) are deliberately NOT requested; they would need a verified id grammar across rounds.

### 4.6 PR identity persisted at run creation
- `resolvePullRequestTarget` also returns `number` and `url` (add `number,url` to the `gh pr view --json` fields).
- `normalizeTarget` carries an optional `pullRequest: { number, url, isCrossRepository }`.
- **Thread it through all three PR-selector return paths in `resolveTarget`** (`src/integrations/git/target.js:215-292`):
  1. `advisoryGithubTarget` (GitHub transport);
  2. the generic non-Netlify `normalizeTarget` branch;
  3. `verifiedRemoteTarget` (Netlify transport). The PR object is passed alongside the verified branch result, because the remote resolver only knows the branch.
- `legacyTargetFromRunState` preserves it on re-normalization.
- Update the TS `Target` in `src/contracts/dashboard.ts` and the JSDoc.
- Tests cover both transports' PR-selector paths. The field is additive; old runs simply lack it.

### 4.7 Where `findings.json` is written
Only at terminal transitions in `src/cli/main.js:2923-2953` (completion and failure handling): if the flow declares `findings`, call `writeFindings(runState, flow)` once via `writeJson` (`src/storage/local/artifact-fs.js`), inside try/catch. This covers `completed`, `completed_with_failures` and `failed` runs whose source step produced results.

### 4.8 Run resolution for findings
`resolveFindingsRun(projectRoot, runId?)` is independent of `handoff-sources.js`. Its default is the latest run whose status is `completed`, `completed_with_failures` or `failed`, whose flow declares `findings`, and whose source step has at least one completed run. `readFindings` returns the file if present, otherwise `buildFindings` in memory.

### 4.9 CLI surface (v1)
```bash
nax handoff [run-id] --findings [--json]
nax handoff [run-id] --to github-issues [--select S1,S3] [--min-severity high] [--limit 5] [--include-contested] [--label extra] [--dry] [--force] [--json]
```
- In a TTY with no `--select`: a clack multiselect preselecting `bucket=consensus`, `status=open`, `rank <= 5`, and severity at or above `--min-severity` (default `low`). Rejected and dropped findings are hidden unless `--include-rejected` is set.
- Without a TTY, `--select` or `--limit` is required. It fails fast and names the flag.
- `--json` writes `{ target, planned, applied, skipped: [{key, reason, existingUrl}] }` to stdout, with decoration on stderr.
- The interactive handoff menu (`src/cli/commands/handoff.js:294-322`) gains "Create GitHub issues from findings" when the selected workflow has findings.

### 4.10 Target `github-issues`
- Title: `finding.title`. Labels: `nax-finding`, `severity:<level>`, plus `--label`. Missing labels are created with `gh label create --force`; if that fails, print a warning and create the issue without the label.
- Body: claim, evidence, suggested fix, the `file:line` link (a blob URL at `target.sha` when known), agents, a link to the consensus result, the run id, and the footer `<!-- nax-finding:<key> -->`. Add `findingMarker(key)` and `parseFindingMarker(body)` to `comment-markers.js`.
- **Idempotency:** `gh issue list --label nax-finding --state all --limit 1000 --json number,url,body`, then scan locally for the marker. This does not depend on search indexing. Existing keys are skipped and their URL reported. `--force` only skips the confirmation prompt, never dedupe.
- Creation is sequential. On partial failure, report what was created; a rerun resumes via dedupe.

### 4.11 MCP (v1, read-only)
- Run details gain `findings: { count, bySeverity, top: Finding[<=10] }`.
- New resource `nax://scopes/{scope}/runs/{id}/findings` returns the full artifact, within the existing bounds and redaction (`src/mcp/results.js`).
- There are no mutation tools; outbound side effects stay human-initiated.

### 4.12 v1.1 preview (designed now, built after v1)
- **`pr-review`:**
  - PR resolution chain: `target.pullRequest` → `--pr` → `gh pr view <branch>`.
  - Hunk parser over `pulls/{n}/files` patches; only lines proven to be in the diff are inlined, and the rest go to an "Outside this diff" section.
  - Staleness guard: if `target.sha` is not the PR head, set `commit_id` to the run SHA, or fall back to summary-only if that SHA isn't in the PR history.
  - Marker `<!-- nax-review:<runId> -->`; refuse if found, unless `--force` (which posts new, never edits).
- **`beads`:**
  - `br` on PATH plus `.beads/` are required, otherwise fail with guidance.
  - `br create "<title>" -t bug|task -p 0..4 -d ... -l nax-finding,severity:<s> --external-ref nax:<key>`.
  - Dedupe by scanning `br list --json` for the external ref. Confirm the field name and pagination (`{issues, has_more}`) at build time.
  - argv-only exec.
- **Dashboard Findings tab:** `GET /api/runs/:id/findings` plus a table in the run details modal; `npm run dashboard:build`.

## 5. Decisions (resolved 2026-09-25)
| # | Decision |
|---|---|
| D1 | Explicit `findings: { step, adapter }` only; no heuristic fallback |
| D2 | Audit flows deferred; add named adapters one at a time with fixture proof |
| D3 | `beads` target (v1.1) fails with guidance when `br` is unavailable; no markdown export |
| D4 | Dashboard tab is v1.1 |
| D5 | Add the `agents` attribution field (security-prompt precedent), not per-finding source ids. David approved this against Codex's "defer" |
| D6 | No MCP mutation tools |
| D7 | `github-issues` ships in v1 (David approved this against Codex's "defer all targets"); `pr-review` and `beads` in v1.1 |

## 6. Task breakdown (v1)

### Phase 0: extraction
- T0.1 Move block location into `findings/extract.js`; `round-results.js` uses it with `{ numberedOnly: true }`, so follow-up prompt contents are unchanged. Existing round-results tests stay green unmodified.
- T0.2 Golden fixtures in `tests/fixtures/findings/` copied (redacted) from real `.nax/` results: synthesize with 3/7/10 findings, the no-heading codex output, a malformed-JSON sample (hand-edited from a real one), and a security synthesize sample (to prove it is ignored without a declaration).

### Phase 1: artifact
- T1.0 Normalize and type the `findings` declaration (`normalizeFlow`, JSDoc, TS contract, manifest), with `FINDINGS_ADAPTER_IDS` in `src/core/constants.js`. Failing test first: a flow with `findings:` loads and keeps the key; an unknown adapter gives `invalid_findings_source`. This lands together with the lint plan's validator work.
- T1.1 `review-consensus` adapter + field rules; table tests for every rule.
- T1.2 `buildFindings` / `readFindings` / `writeFindings`, with typedefs and the TS contract.
- T1.3 Terminal-time write in `main.js:2923-2953`. The test asserts that a throwing adapter leaves the run status unchanged, and that `saveRunState` never writes `findings.json`.
- T1.4 PR identity in the target (§4.6), covering all three return paths plus legacy re-normalization, with PR-selector tests for GitHub, Netlify and the generic branch.
- T1.5 `findings:` declaration in `workflows/review/flow.yml` + the `agents` field in the synthesize prompt.
- T1.6 `resolveFindingsRun` with the status eligibility matrix.
- T1.7 `nax handoff --findings [--json]`.

### Phase 2: github-issues
- T2.1 Target registry, plan/apply, `--dry`/`--json`, non-TTY guard, flag wiring in `src/cli/commands/nax.js:502-528`, CLI help guard (`npm run check:cli-help`).
- T2.2 Markers, label ensure, dedupe scan, sequential create, partial-failure report.
- T2.3 Handoff menu entry.

### Phase 3: MCP
- T3.1 Findings summary + resource + schema (`src/mcp/schemas.js`); round-trip in `tests/integration/mcp-local-e2e.test.js`.

### Phase 4: docs
- T4.1 `site/content` guide page (schema, the `findings:` declaration, github-issues idempotency); README blurb; CHANGELOG.

## 7. Testing strategy
- **Pure units:** extract, adapter, build/read, markers, and target `plan()`, all over real fixture text.
- **Process-boundary tests (no function mocks):**
  - Subprocess tests run the real CLI against temp `.nax/` fixtures.
  - `PATH` is prefixed with a fake `gh` executable (a small node script) that records its argv to a file and returns protocol-real JSON captured from actual `gh` output.
  - They cover label ensure, the dedupe scan (existing marker → skip), sequential create, partial failure mid-list and rerun idempotency.
  - Only the process/network boundary is replaced, as the repo rules require.
- **Live canary (opt-in, in addition):** against a sandbox repo gated by `NAX_E2E_GITHUB_REPO`, following the fail-closed pattern of `scripts/run-mcp-agent-canary.mjs`: a second run must create 0.
- **Acceptance:**
  1. After `nax run review`, `nax handoff --to github-issues --limit 5` creates 5 labeled issues, and rerunning creates 0.
  2. A `completed_with_failures` review run still yields findings.
  3. A malformed block yields diagnostics naming step and instance, with the run status unchanged.
  4. MCP returns typed findings for the run.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Agents drift from the schema | Tolerant adapter + diagnostics; measured parse rate is high |
| 1000-issue list cap on huge repos | Documented; scoped by label |
| Agents omit or misname `agents` | Validated against lineups; diagnostic only |
| PR identity missing on older runs | v1 doesn't need it; the v1.1 PR chain falls back to `--pr` / `gh pr view` |

## 9. Review round 1 (Codex) — integration record
Every Codex claim was re-verified in code (2026-09-25).
- **Accepted:** terminal-only writes because persistence runs on every save; pure reads with no disk backfill; PR identity across all target builders + TS contract; findings run resolution independent of handoff sources; explicit source, no fallback (the `ideas` final step proves the risk); audit adapters deferred; fake-executable boundary tests.
- **Corrected from Codex:** the `serializers.js` citation was `publicFlow`. The target is passed through whole, so there is no serializer change.
- **Kept against Codex:** the `agents` field (security precedent) and `github-issues` in v1 (D5, D7).

### Review round 2 (Codex) — integration record
Re-verified in code (2026-09-25).
- **Accepted (blocking):** `normalizeFlow` drops unknown keys (`flows.js:643`), so the `findings` declaration must be normalized, typed and in the manifest (T1.0); the adapter-id constant avoids a validator ↔ findings cycle. PR identity must go through the third, generic `normalizeTarget` path in `resolveTarget`, not just the two named builders.
- **Accepted (nice-to-have):** a canonical fan-out `localId` with encoding; findings read only current attempts.

## 10. Out of scope
Fuzzy cross-agent dedupe; editing or closing created issues; Linear/Jira; MCP mutations; model scorecard; widening follow-up prompt shrinking to audit flows.
