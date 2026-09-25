---
id: 01M3CN9TWN39AFPTE94BKAFNFG
status: draft
createdAt: 2026-09-25T09:10:16-07:00
updatedAt: 2026-09-25T09:10:16-07:00
origin: manual
type: plan
---

# Structured Findings (`findings.json`) + Handoff Targets

> Status: DRAFT v1 for review (planning-workflow round 1). Supersedes the design sketches in beads `nax-i9j`, `nax-i9j.1-.4`, `nax-u76` (written 2026-06-10 against pre-restructure paths such as `src/round-results.js`, `src/comment-markers.js`, `src/flows/*`).

## 1. Why

The product of a nax workflow is the consensus: the ranked, cross-checked list of findings that comes out of the last step. Today that output reaches the user only as markdown, and the only way to act on it is to copy and paste:

- `nax handoff` copies, opens, or re-prompts from `summary.md` (`src/cli/main.js:1159-1260`, `src/workflows/followups/handoff-sources.js`). Every source is `summaryText` markdown.
- MCP run details return markdown sections (`src/mcp/adapters/local-dashboard.js:560-597`). An MCP client that wants "the top 3 high-severity findings" has to scrape markdown itself.
- The dashboard renders findings JSON as a highlighted code block (`MarkdownRenderer.tsx`). It has no notion of a finding.

The data is already there, in a structured and reliable form:

- The bundled `review` prompts require a `## 2. Structured Findings` / `## 2. Structured Consensus` heading followed by a fenced JSON block (`workflows/review/prompts/1_review.md:41-75`, `2_cross-review.md:58`, `3_summarize-consensus.md:44-72`).
- **Measured on this repo's own `.nax/` (2026-09-25):** 11/11 real synthesize outputs contain a block that `JSON.parse` accepts, with `consensus_findings|contested_findings|merge_dependent_findings` and the documented fields. 30/32 round-1 review outputs parse. The 2 misses are codex outputs with no heading at all, not malformed JSON.
- Today nax extracts those blocks with a regex (`src/workflows/round-results.js:11-13, 195-211`) only to shrink follow-up prompts, and never parses them.

So we would be parsing data we already collect, not creating a new data source. The work is: parse it once, persist it as a first-class artifact, and route it to where work happens (GitHub issues, PR reviews, beads).

### Who benefits

| User | Today | After |
|---|---|---|
| Human after `nax run review` | Reads a long markdown consensus, then hand-creates issues | `nax handoff --to github-issues` shows a picker with S1..Sn preselected by rank, then creates labeled issues. Rerunning creates no duplicates. |
| PR-centric team | Consensus lands in a side-channel issue | `nax handoff --to pr-review` posts one advisory review with inline comments on diff lines |
| David / beads workflow | Manually transcribes findings into `br create` | `nax handoff --to beads` creates beads with severity-mapped priority and a stable `external-ref` |
| MCP client (Claude Code) | Scrapes markdown | Reads `findings` from the run details/resource as typed data |
| Future features | n/a | `when: findingsAtLeast`, model scorecard, cost-per-finding: all read `findings.json` |

## 2. Grounded current state

### 2.1 Where the text lives
- Per-agent result JSON: `.nax/workflows/<runId>/artifacts/steps/NN-<stepId>/agent-runners/<agent>.json`, `resultText` field (`buildAgentJson`, `src/workflows/artifacts/workflow-artifacts.js:177-207`).
- `workflow.json` `steps[].runs[].resultText` also holds the full text for both transports:
  - netlify-api: `session.result || runner.result` (`src/workflows/results/agent-run-results.js:634`)
  - github-actions: the reply comment body (`normalizeGithubRunResult`, `agent-run-results.js:657-671`).
- Workflow artifact writers: `workflow-artifacts.js:609-684` (`summary.md`, `usage.json`, per-step files). This is where `findings.json` gets written.

### 2.2 Structured block shapes in the wild
- **Review round 1/2** (`1_review.md:47-75`): array of `{id:"R1"|"CR1", category: defect|polish|rejected, severity, status: confirmed|likely|already_fixed|rejected, file, line, claim, evidence, suggested_fix, confidence}`.
- **Synthesize** (`3_summarize-consensus.md:44-72`): `{consensus_findings:[{id:"S1", category, severity, status: open|already_fixed|merge_dependent|dropped, file, line, claim, evidence, suggested_fix, confidence}], contested_findings:[], merge_dependent_findings:[]}`.
- **Audit flows use different headings and shapes.** Their unnumbered headings (`## Structured Findings`, `## Structured Tracking Plan`, `Structured Opportunities`, ...) do NOT match `STRUCTURED_HEADING_PATTERN`. Their fields also differ, e.g. security `SEC-1 {domain,title,kernel_axiom,attack_vector,impact,recommended_fix,verification}` and error-handling `ERR-1 {priority:P0, failure_scenario, ...}`.
- **Attribution gap:** consensus findings do not record which round-1 findings or agents they came from. `reportedBy` cannot be derived reliably today; see §3.4.

### 2.3 Integration seams that exist
- `createIssue({repo,title,body,labels})` runs `gh issue create --label ...` (`src/integrations/github/issue-plan.js:214-229`).
- `createPullRequestComment` (`issue-plan.js:246-258`).
- `runGh` with retries and auth formatting (`src/integrations/github/gh-cli.js:71`); `assertGhAuthenticated` (`:109`).
- Marker conventions (`src/integrations/github/comment-markers.js`), e.g. `<!-- netlify-agent-run-result:... -->`. Nothing upserts or dedupes on them yet.
- PR selector: `isPullRequestSelector` / `resolvePullRequestTarget` (`src/integrations/git/target.js:121, 151-180`) resolve `#123` to `headRefName`, but **`normalizeTarget` (`:126`) drops the PR number**. `pr-review` needs it (see §3.7).
- **No PR review API use, no `br` integration** anywhere in `src`.
- `br create` supports `-t/--type`, `-p/--priority`, `-d/--description`, `-l/--labels`, `--external-ref` (verified with `br create --help`).

## 3. Design

### 3.1 Core invariants
1. **Derived, never authoritative.** `findings.json` is always rebuildable from `resultText` in `workflow.json`. There is no migration: old runs get findings the first time they are requested (lazy backfill).
2. **Parsing never breaks a run.** Every parse failure becomes a `diagnostics[]` entry. Findings generation runs after the run has reached a terminal state and is wrapped so it cannot change the run's status or exit code.
3. **Stable identity.** A finding's key is `<runId>/<stepId>/<localId>` (e.g. `2026-09-25T...-review/synthesize/S3`). Every handoff target's idempotency rests on this key.
4. **Targets plan before they act.** Every target first computes a list of actions and then applies it. `--dry` prints the list and does nothing, which gives dry-run and tests the same code path.
5. **Advisory posture.** PR reviews are always `event: COMMENT`, never `REQUEST_CHANGES`. nax does not gate merges.

### 3.2 Module layout
```text
src/workflows/findings/
  extract.js     # locate + JSON.parse structured blocks in a resultText (moves the regex out of round-results.js; round-results imports it)
  normalize.js   # map known shapes (review, synthesize, generic audit) -> Finding
  artifact.js    # build/read/write findings.json for a run state (lazy backfill)
src/workflows/handoff-targets/
  github-issues.js
  pr-review.js
  beads.js
  index.js       # target registry: { id, plan(findings, ctx), apply(actions, ctx) }
```
`scripts/check-import-direction.js` is run as part of the check to confirm that `workflows/findings` depends only on `core/*` and `storage/*`. The targets depend on `integrations/github/*` plus a small `br` exec helper.

### 3.3 `findings.json` schema v1
Written to `.nax/workflows/<runId>/artifacts/findings.json`, next to `summary.md`.
```json
{
  "schemaVersion": 1,
  "runId": "2026-09-25T16-02-11-000Z-review",
  "flowId": "review",
  "generatedAt": "2026-09-25T16:40:00.000Z",
  "source": { "stepId": "synthesize", "instanceId": "codex:auto:auto", "runnerId": "...", "sessionId": "...", "resultUrl": "https://github.com/.../issues/88" },
  "target": { "branch": "fix/auth", "sha": "abc123...", "prNumber": 123 },
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
      "claim": "...",
      "evidence": "...",
      "suggestedFix": "...",
      "confidence": "high",
      "reportedBy": ["claude:R2", "gemini:R1"]
    }
  ],
  "diagnostics": [
    { "stepId": "review", "instanceId": "codex:auto:auto", "code": "no_structured_heading", "message": "..." }
  ]
}
```
Field rules:
- `rank` is the position in `consensus_findings` (1-based). `contested` and `merge_dependent` findings get `rank: null` and their own `bucket`.
- `title`: the agent-supplied `title` if present, otherwise the first sentence of `claim`, cut to 100 characters on a word boundary.
- `severity` is normalized to `critical|high|medium|low|info`. `P0..P3` maps to `critical|high|medium|low`. Unknown values keep the raw value in `severityRaw` and set `severity: "info"`, and a diagnostic is added.
- `line`: an integer or `null`. Ranges such as `"88-94"` become `line: 88, lineEnd: 94`.
- `reportedBy` is `[]` when attribution is not available. It is never invented.
- `target.prNumber` is present only when the run was started with a PR selector (§3.7).
- JSDoc typedef `Finding` / `FindingsArtifact` goes in `src/types.js`. A TS mirror goes in `src/contracts/` so the dashboard and MCP share it.

### 3.4 Which step is the source
1. If the flow declares `findings: { step: <id> }` (new, optional top-level key, validated by the flow validator; see the flow-lint plan), use that step.
2. Otherwise, use the **last step** that has at least one completed run whose `resultText` contains a parseable structured block.
3. If that step has more than one completed run (a fan-out final step), findings from all runs are merged. Each run's `localId`s are prefixed with its instance label, e.g. `claude:R1`, so keys stay unique, and `rank` is null (no consensus exists).

In the bundled `review` flow, rule 2 picks `synthesize`. That is correct without any flow edit, but the plan still adds the explicit `findings: { step: synthesize }` to `workflows/review/flow.yml` as documentation.

**Attribution (`reportedBy`):** add one optional field to the synthesize schema in `3_summarize-consensus.md`: `"sources": ["claude:R2", "gemini:R1"]`, meaning the round-1/2 ids this consensus item merges. The normalizer copies `sources` into `reportedBy` and checks each entry against the ids it actually parsed from earlier steps. Unknown ids produce a diagnostic and are kept. This costs one line of prompt and makes `reportedBy` and the future model scorecard possible. There is no fuzzy matching.

### 3.5 Extraction changes
- `extract.js` exports `findStructuredBlocks(resultText) -> Array<{heading, kind, json: unknown | null, raw, parseError?}>`.
- It widens the heading pattern to `^##\s+(?:\d+\.\s+)?Structured\s+([A-Za-z ]+)$`, so the audit flows' unnumbered headings match. `kind` is the captured noun (findings, consensus, tracking plan, ...).
- **Compatibility guard:** `round-results.js` keeps its current behavior (numbered-heading-only prompt shrinking) by calling the new extractor with `{ numberedOnly: true }`. That prevents a silent change to follow-up prompt contents for audit flows. Widening prompt shrinking is out of scope.
- The first fenced ```` ```json ```` block after the heading, and before the next `## ` heading, is the payload. If there is no fence, fall back to the first top-level `[`/`{` balanced span. Failure produces a diagnostic.

### 3.6 Normalizer shapes
| Shape detector | Maps |
|---|---|
| object with `consensus_findings` | synthesize; buckets from the three arrays |
| array of objects with `claim` | review / cross-review |
| array of objects with `title` or `recommended_fix` or `failure_scenario` | generic audit: `title`, `severity\|priority`, `file`, `line`, `claim := impact\|failure_scenario\|claim`, `suggestedFix := recommended_fix\|suggested_fix` |
| anything else | diagnostic `unrecognized_shape`, raw kept out of findings |

Items whose `status` is `rejected` or `dropped` are kept, with that status, and handoff targets exclude them by default. This keeps the artifact faithful to the agent output while keeping handoff useful.

### 3.7 PR number persistence
Update `resolvePullRequestTarget` / `normalizeTarget` (`src/integrations/git/target.js:126-180`) so the target carries `pullRequest: { number, url, isCrossRepository }` when the source is a PR selector. This field is additive and has no reader changes. `pr-review` resolves the PR in this order:
1. `findings.target.prNumber`
2. `--pr <n>`
3. `gh pr view <branch> --json number` (the open PR for the run's branch)
4. otherwise, an error that asks for `--pr`.

### 3.8 When `findings.json` is generated
- **Eagerly:** at workflow terminal state, in the same place that writes the workflow `summary.md` (`workflow-artifacts.js:609-684`), wrapped in try/catch with a warning. It also runs for `completed_with_failures` final states and for runs that ended `failed` but have partial results (useful for handoff).
- **Lazily:** `readFindings(runState)` rebuilds it from `workflow.json` if the file is missing or the artifact `schemaVersion` is older. It writes atomically through `src/storage/local/artifact-fs.js` (`writeJson`). Old runs get backfilled the first time `nax handoff --to ...` or the MCP resource touches them.

### 3.9 CLI surface
```bash
nax handoff [run-id] --to github-issues [--select S1,S3] [--min-severity high] [--limit 5] [--include-contested] [--label extra] [--dry] [--force] [--json]
nax handoff [run-id] --to pr-review    [--pr 123] [--min-severity medium] [--dry] [--force] [--json]
nax handoff [run-id] --to beads        [--select ...] [--min-severity ...] [--limit N] [--dry] [--json]
nax handoff [run-id] --findings        # print findings table (or JSON with --json); read-only
```
- `--to` without `--select` in a TTY opens a clack multiselect. It preselects consensus findings with `rank <= 5`, `status: open` and severity at or above `--min-severity` (default `low`). Rejected and dropped findings are hidden unless `--include-rejected` is set.
- Without a TTY, `--to` requires `--select` or `--limit`. It fails fast and names the missing flag, and never prompts.
- `--json` writes one machine-readable result `{ target, planned:[...], applied:[...], skipped:[{key, reason, existingUrl}] }` to stdout. Decoration goes to stderr.
- `run-id` defaults to the latest completed workflow run. This reuses the resolution in `handoff-sources.js`.
- The interactive handoff menu (`handoff.js:294-322`) gets three new entries when the selected source is a workflow that has findings: "Create GitHub issues from findings", "Post findings as PR review", "Create beads from findings".

### 3.10 Target: `github-issues`
- Title: `finding.title`. Labels: `nax-finding`, `severity:<level>`, plus `--label` values.
- Missing labels are created with `gh label create --force`. If label creation fails, a warning is printed and the issue is created without that label.
- Body template, in markdown: claim, evidence, suggested fix, the `file:line` link (a blob URL at `target.sha` when known), reported-by, a link back to the consensus issue/result, the run id, and a marker footer:
  ```text
  <!-- nax-finding:<key> -->
  ```
- **Idempotency:** before creating anything, run `gh issue list --label nax-finding --state all --limit 1000 --json number,url,body` and scan the bodies locally for the marker. This does not depend on GitHub search indexing HTML comments. Keys that already exist are skipped and the existing URL is reported. `--force` does not bypass dedupe; it only skips the confirmation prompt. If a user deletes the label, dedupe misses that issue; this is documented.
- Sequential creation, not parallel, so rate limits and partial failures are easy to reason about. On failure it reports what was created so far, and the next run picks up via dedupe.
- Adds `findingMarker(key)` / `parseFindingMarker(body)` to `comment-markers.js`.

### 3.11 Target: `pr-review`
- One review per run: `POST repos/{o}/{r}/pulls/{n}/reviews` via `gh api`, with `event: COMMENT`, `body` = consensus overview + an "Outside this diff" section + marker `<!-- nax-review:<runId> -->`, and `comments[] = {path, line, side: "RIGHT", body}`.
- **Line mapping:** fetch `gh api repos/{o}/{r}/pulls/{n}/files --paginate` and parse each file's `patch` hunk headers into right-side line sets.
  - A finding is inline-able only if `file` is in the PR and `line` falls on an added or context line of a hunk.
  - Otherwise it goes in the summary's "Outside this diff" list with a file link.
  - This avoids GitHub's 422 errors on out-of-diff lines.
- **Staleness guard:** if `findings.target.sha` differs from the PR's current `headRefOid`, add a warning line to the review body and set `commit_id` to the run's SHA (GitHub then shows the comments as outdated, not misplaced). If that SHA is not in the PR's history, fall back to summary-only (no inline comments) and print a warning.
- **Idempotency:** list existing reviews and look for the marker. If found, refuse with the link unless `--force`. `--force` posts a new review; it never edits an old one.

### 3.12 Target: `beads`
- Preconditions: `br` is on `PATH` and a `.beads/` directory exists at the project root. If either is missing, fail with guidance. There is no silent file fallback in v1 (YAGNI; the beads sketch's markdown-export fallback is dropped, see D3).
- Per finding:
  ```bash
  br create "<title>" -t <bug|task> -p <P> -d "<body>" -l nax-finding,severity:<s> --external-ref nax:<key>
  ```
  - Type is `bug` when `category=defect`, otherwise `task`.
  - Priority: `critical → 0`, `high → 1`, `medium → 2`, `low → 3`, `info → 4`.
- **Idempotency:** `br list --json --limit 0` (all), scanning `external_ref` for `nax:<key>`. Before implementing, confirm the exact JSON field name and the `--limit` semantics with the real `br` output: the list output here is paginated (`{issues, has_more, ...}`).
- Execution is argv-only (`execFile`); no shell interpolation of finding text.

### 3.13 MCP and dashboard surfaces
- **MCP:** run details (`local-dashboard.js:560-597`) gain `findings: { count, bySeverity, top: Finding[<=10] }`. A new resource `nax://scopes/{scope}/runs/{id}/findings` returns the full artifact, within the existing 256KB/64KB bounds and redaction (`src/mcp/results.js`). Handoff targets are NOT exposed as MCP mutation tools in v1: creating issues or reviews is outward-facing and deserves a human in the loop. Revisit later with the existing idempotent-mutation machinery (`src/control-plane/idempotent-mutations.js`).
- **Dashboard (phase 4, optional in v1, see D4):** a "Findings" tab in the run details modal with a table (rank, severity, title, file:line, reported-by) and copy buttons, fed by `GET /api/runs/:id/findings`. Run `npm run dashboard:build` after the UI change (AGENTS.md).

## 4. Decisions needed (David)
- **D1. Source-step rule.** Explicit `findings.step` with a last-parseable-step fallback (recommended), or explicit-only?
- **D2. Audit flows in v1?** The generic normalizer is cheap, but audit shapes vary more. Recommended: include it; unrecognized shapes produce a diagnostic, not a crash.
- **D3. Beads without `br`:** fail with guidance (recommended, YAGNI), or write a `findings-beads.md` export as the beads sketch proposed?
- **D4. Dashboard Findings tab** in this plan (phase 4) or as a separate follow-up?
- **D5. Synthesize prompt `sources` field.** This is a prompt change to a bundled flow. It changes every future consensus output slightly (one more field). OK?
- **D6. MCP mutation tools for handoff targets:** deferred (recommended) or in scope?

## 5. Task breakdown

### Phase 0: Extraction foundation (no user-visible change)
- T0.1 Move the regex and block location into `src/workflows/findings/extract.js`; `round-results.js` consumes it with `numberedOnly: true`. Existing round-results tests must stay green unchanged. **Test first:** golden tests using real `resultText` samples copied from `.nax/` into `tests/fixtures/findings/` (redacted), covering synthesize, review, cross-review, the no-heading codex case, and an audit sample.
- T0.2 `normalize.js` shape detectors + field rules (§3.3, §3.6). Table-driven unit tests: every severity mapping, the line-range split, title derivation, and unknown shapes producing diagnostics.

### Phase 1: `findings.json` artifact
- T1.1 `artifact.js` build/read/write with lazy backfill; typedefs in `src/types.js` + `src/contracts/`.
- T1.2 Eager write at terminal state (workflow-artifacts writer). The test asserts that a thrown normalizer error does not change run status.
- T1.3 Persist `pullRequest` in the target (`target.js`), with tests on the `#123` path.
- T1.4 Add `findings: { step }` to `review/flow.yml` (validated by the flow-lint plan's validator), plus the `sources` field in the synthesize prompt (D5).
- T1.5 `nax handoff --findings [--json]` read-only table.

### Phase 2: Handoff targets
- T2.1 Target registry + plan/apply contract + `--dry`/`--json` rendering; CLI flag wiring in `src/cli/commands/nax.js:502-528`; non-TTY guard.
- T2.2 `github-issues`: markers, label ensure, dedupe scan, sequential create.
- T2.3 `beads`: preflight, mapping, dedupe via external-ref, argv-safe exec.
- T2.4 `pr-review`: PR resolution chain, hunk parser, inline vs outside-diff split, staleness guard, marker refusal.
- T2.5 Interactive handoff menu entries.

### Phase 3: MCP
- T3.1 Findings summary in run details + the findings resource; schema in `src/mcp/schemas.js`; MCP integration test (`tests/integration/mcp-local-e2e.test.js`) asserts the resource round-trip.

### Phase 4: Dashboard (per D4)
- T4.1 `GET /api/runs/:id/findings` + Findings tab; Playwright assertion in `tests/e2e/dashboard.spec.js` with a fixture run; `npm run dashboard:build`.

### Phase 5: Docs
- T5.1 `site/content` guide page: the findings schema, each target, idempotency guarantees, the advisory posture. README gets a short blurb that links to it. CHANGELOG entry.

## 6. Testing strategy
- **Unit (uvu/node test, matching existing `tests/unit` style):** extract, normalize, artifact build/backfill, marker helpers, hunk parser, and the target `plan()` functions. These are pure, with real fixture text.
- **Real-service checks (no mocks, per repo rules):** the `apply()` paths are verified against a sandbox GitHub repo and a scratch `.beads` workspace in an opt-in integration test gated by env (`NAX_E2E_GITHUB_REPO`), following the canary pattern in `scripts/run-mcp-agent-canary.mjs`: fail closed without explicit repo bounds, and assert the second run skips everything (idempotency).
- **Seams:** the `gh` and `br` exec functions are injected parameters, so `plan()` tests don't need them. `apply()` is only tested for real.
- **Acceptance:**
  1. After `nax run review`, `nax handoff --to github-issues --limit 5` creates 5 labeled issues, and rerunning creates 0.
  2. `--to pr-review` on a `#123` run posts 1 review with inline comments for in-diff findings, and rerunning refuses with a link.
  3. `--to beads --limit 3` creates 3 beads with mapped priorities, and rerunning creates 0.
  4. A run with a malformed agent block yields a `findings.json` whose diagnostics name the step and instance, and the run status is unchanged.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Agents drift from the schema | Tolerant normalizer + diagnostics; measured parse rate is high (30/32, 11/11) |
| `gh issue list` limit of 1000 misses old markers on huge repos | Documented; dedupe also scoped by label; revisit with search API if it happens |
| Line mapping wrong → 422 from GitHub | Only inline lines proven to be in the diff; everything else goes to the summary |
| Stale findings posted on a moved PR | SHA staleness guard (§3.11) |
| Widening the heading regex changes follow-up prompts | `numberedOnly` guard keeps prompt shrinking unchanged |
| `br` JSON shape changes | Verify at implementation; the `br` exec helper isolates parsing |

## 8. Out of scope
Fuzzy dedupe across agents; editing or closing previously created issues; Linear/Jira targets; MCP mutation tools (D6); a model scorecard (consumes this later); widening follow-up prompt shrinking to audit flows.
