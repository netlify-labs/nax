# Workflow Artifact Persistence Spec

> Status: partially superseded by `docs/plans/artifact-directory-restructure.md` and the current implementation.
>
> The active artifact layout is `.nax/workflows/<workflow-run-id>/workflow.json`, `.nax/workflows/<workflow-run-id>/artifacts/`, `.nax/agent-runners/<runner-id>/`, and `.nax/agent-sessions/<session-id>/`. Older examples in this document that mention `.nax/runs/<run-id>/run.json` or `artifacts/steps/<step>/runs/` describe the pre-restructure design, not current behavior.

## Summary

Add durable, generic artifact persistence for `nax` workflow output so completed multi-agent results survive later step failures, CI job failures, terminal interruption, retried agents, and transport differences. Persistence is built on top of the already-normalized run shape produced by `lib/agent-run-results.js` and the run state managed by `lib/run-state.js`.

The motivating use case is `review`, but this is implemented as a workflow-level artifact layer because `nax` already runs `review`, `ideas`, and `do-next` remotely and all three benefit equally. Future flows with branching execution are an explicit design consideration.

## Problem

Multi-agent workflows are expensive and long-running. A `review` run has three phases (first round, cross review, synthesize) and each phase has multiple agents. Today, completed output lives in transport-specific places:

- Local transport: `.nax/runs/<run-id>/run.json` and raw Netlify API responses.
- GitHub transport: GitHub issue/comment bodies, marker-emitted result blobs.
- CI: ephemeral runner logs, lost when the job ends.

When step 2 or 3 fails, completed work from earlier steps is hard to recover. The CLI should deliberately produce a clean, stable artifact tree per run so output survives later failures, can be uploaded from CI, and can power future retry/resume features without parsing transport internals.

## Goals

- Persist completed agent output as soon as each run reaches terminal state, not only when a step finishes.
- Preserve every retry attempt rather than overwriting it, so flaky agents leave a forensic trail.
- Use one writer for local and GitHub transports.
- Keep `run.json` the single source of truth for run state; artifacts are derived views.
- Make CI output downloadable through `actions/upload-artifact` and visible inline in the GitHub Actions run UI via `$GITHUB_STEP_SUMMARY`.
- Default-on with no new flag required.
- No new dependencies. No new hosted services.

## Non-Goals

- No hosted artifact backend.
- No changes to Netlify Agent Runner APIs.
- No redesign of `run-state.js`.
- No interactive artifact browser yet.
- No artifact-driven retry command yet.
- No persistence of secrets, environments, or raw command payloads.

## Current Relevant Architecture

### Run state

`lib/run-state.js` creates and saves workflow state at `.nax/runs/<run-id>/run.json`:

```js
{
  schemaVersion,
  runId,
  flowId,
  flowTitle,
  transport,
  projectRoot,
  createdAt,
  updatedAt,
  options,
  steps,
  dir
}
```

`runState.dir` is the resolved per-run directory and the natural parent for artifacts.

### Normalized run results

`lib/agent-run-results.js` already produces a transport-agnostic run shape:

```js
{
  runnerId,
  sessionId,
  agent,
  status,
  resultText,
  usage,
  creditLimitExceeded,
  stepsCount,
  deployUrl,
  prUrl,
  issueUrl,
  commentUrl,
  links,
  rawResult
}
```

This is the contract the artifact writer consumes. The artifact writer never parses Netlify CLI JSON, GitHub comments, or marker syntax directly.

### Completion paths

- `completeLocalStep()` in `bin/nax.js` waits on local Netlify agent runs, normalizes completed runs via `agent-run-results`, adds Netlify UI links, and mutates `stepState.runs`.
- `completeGithubStep()` in `bin/nax.js` waits on GitHub issue result comments, calls `normalizeGithubRunResult()`, and mutates `stepState.runs`.

Both are the integration points for artifact persistence.

### CI workflow

`.github/workflows/run-nax.yml` executes `nax run <flow> --transport netlify-api` on an ephemeral runner. Artifacts must be uploaded before the job ends and surfaced in the GitHub Actions UI to be useful.

## Source-Of-Truth Decision

`run.json` remains the single source of truth for workflow state. The artifact directory is a strict projection of `run.json` plus the human-facing renderings of `resultText`. There is no `manifest.json` because it would duplicate `run.json` fields and create drift risk between the resume code path and the artifact code path.

Consequence: any consumer that wants programmatic metadata for the whole run reads `run.json`. Consumers that want per-step or per-agent slices read `artifacts/steps/<NN>-<id>/step.json` and `artifacts/steps/<NN>-<id>/runs/<agent>.json`, which are stable projections.

## Directory Layout

For every run:

```text
.nax/runs/<run-id>/
  run.json                       # source of truth (unchanged)
  artifacts/
    summary.md                   # TOC + inline per-agent result text
    usage.json                   # aggregated usage across all steps
    steps/
      01-review/                 # zero-padded execution-order prefix
        step.json                # per-step projection of run.json
        summary.md               # step header + per-agent results inline
        usage.json               # aggregated usage for this step
        runs/
          claude.md              # latest attempt convenience copy
          claude.json            # latest attempt convenience copy
          claude.attempt-1.md    # immutable first terminal attempt
          claude.attempt-1.json
          claude.attempt-2.md    # immutable second terminal attempt, if any
          claude.attempt-2.json
          gemini.md
          gemini.json
          codex.md
          codex.json
      02-cross-review/
        ...
      03-synthesize/
        ...
.nax/runs/latest -> <run-id>     # symlink to most recent run dir
```

### Step directory ordinal

The `NN-` prefix is a zero-padded ordinal reflecting **execution order**, not declaration order. It is taken from the index of the step entry in `runState.steps[]` at the time of persistence. This matters because future flows will branch, loop, and conditionally skip steps; `runState.steps[]` is the authoritative execution log, and step IDs can repeat. Padding width is 2 (`01`..`99`), which is comfortably above any expected flow length.

If the same `step.id` appears twice in `runState.steps[]` (a future re-execution scenario), each instance gets its own `NN-<id>/` directory because the ordinal differs.

### Retry attempts

When an agent run reaches a terminal state and another attempt for the same agent later lands, every attempt is preserved under an immutable filename. `runs/<agent>.attempt-1.{md,json}` is the first terminal attempt, `attempt-2` is the second, and so on. These files are never renamed after they are written.

The newest terminal attempt is also copied to `runs/<agent>.{md,json}` as a convenience pointer for humans and simple consumers. Those latest-copy files may be overwritten when a later attempt lands, but immutable `attempt-N` files are append-only. `step.json.runs[]` references both the latest copy and the historical immutable attempts so consumers can reconstruct the retry chain without depending on mutable filenames.

### `latest` symlink

After every `saveRunState()`, `.nax/runs/latest` is updated to point at the current run directory. `cat .nax/runs/latest/artifacts/summary.md` always shows the most recent run. The symlink is recreated atomically (create `latest.tmp` symlink, remove old `latest`, then rename `latest.tmp` to `latest`). If symlink creation fails (e.g., filesystem doesn't support it), the failure is swallowed when debug logging is not enabled and printed to stderr only when artifact debug mode is enabled. It must never block persistence.

## File Schemas

### `artifacts/summary.md`

Top-level human-facing file. Contains a header, table of contents anchored to each step, then each step's content inlined.

```markdown
# Review · 2026-05-20T20:39:05Z

- Run ID: `2026-05-20T20-39-05-695Z-review`
- Flow: `review`
- Transport: `netlify-api`
- Status: completed
- Usage: 2,949,800 tokens · 161 steps · 369.14 credits

## Contents

1. [Review](#review)
2. [Cross Review](#cross-review)
3. [Synthesize](#synthesize)

---

## Review

- Status: completed
- Usage: 661,381 tokens · 46 steps · 145.98 credits

### Codex

- Runner: `6a0df23585d8ee407fd30199`
- Session: `6a0df375cb57f944ee2ca251`
- Usage: 661,381 tokens · 46 steps · 145.98 credits
- Netlify: https://app.netlify.com/projects/.../agent-runs/...

<full Codex result text>

### Claude

...

### Gemini

...

---

## Cross Review

...

## Synthesize

...
```

### `artifacts/usage.json`

Aggregated usage, derived from `usageSummariesForRunState()`.

```json
{
  "schemaVersion": 1,
  "runId": "2026-05-20T20-39-05-695Z-review",
  "total": {
    "totalTokens": 2969324,
    "stepsCount": 161,
    "totalCreditsCost": 369.14,
    "creditLimitExceeded": false
  },
  "steps": [
    {
      "id": "review",
      "title": "Review",
      "usage": { "totalTokens": 661381, "stepsCount": 46, "totalCreditsCost": 145.98 }
    }
  ]
}
```

### `artifacts/steps/<NN>-<id>/step.json`

Per-step projection. Contains everything needed to reconstruct the step independently.

```json
{
  "schemaVersion": 1,
  "ordinal": 1,
  "id": "review",
  "title": "Review",
  "action": "issue",
  "status": "completed",
  "agents": ["claude", "gemini", "codex"],
  "startedAt": "2026-05-20T20:39:08.000Z",
  "completedAt": "2026-05-20T20:51:42.000Z",
  "usage": {
    "totalTokens": 661381,
    "stepsCount": 46,
    "totalCreditsCost": 145.98
  },
  "runs": [
    {
      "agent": "codex",
      "status": "completed",
      "runnerId": "6a0df23585d8ee407fd30199",
      "sessionId": "6a0df375cb57f944ee2ca251",
      "resultPath": "runs/codex.md",
      "metadataPath": "runs/codex.json",
      "attempts": [],
      "usage": { "totalTokens": 661381, "stepsCount": 46, "totalCreditsCost": 145.98 },
      "links": {
        "sessionUrl": "https://app.netlify.com/projects/.../agent-runs/..."
      }
    },
    {
      "agent": "gemini",
      "status": "completed",
      "runnerId": "...",
      "resultPath": "runs/gemini.md",
      "metadataPath": "runs/gemini.json",
      "attempts": [
        { "resultPath": "runs/gemini.attempt-1.md", "metadataPath": "runs/gemini.attempt-1.json", "status": "failed" }
      ],
      "usage": { "...": "..." }
    }
  ]
}
```

`attempts[]` is ordered by attempt number ascending (`attempt-1`, `attempt-2`, ...). The root run entry still represents the latest terminal attempt.

### `artifacts/steps/<NN>-<id>/summary.md`

Same shape as the top-level `summary.md`, scoped to one step.

### `artifacts/steps/<NN>-<id>/usage.json`

```json
{
  "schemaVersion": 1,
  "stepId": "review",
  "usage": { "totalTokens": 661381, "stepsCount": 46, "totalCreditsCost": 145.98, "creditLimitExceeded": false }
}
```

### `artifacts/steps/<NN>-<id>/runs/<agent>.json`

Self-contained: includes the full `resultText`. Consumers can rely on a single file without reading the `.md` sibling.

```json
{
  "schemaVersion": 1,
  "runId": "2026-05-20T20-39-05-695Z-review",
  "stepId": "review",
  "stepTitle": "Review",
  "stepOrdinal": 1,
  "agent": "codex",
  "status": "completed",
  "runnerId": "6a0df23585d8ee407fd30199",
  "sessionId": "6a0df375cb57f944ee2ca251",
  "attemptOf": null,
  "submittedAt": "2026-05-20T20:39:09.000Z",
  "completedAt": "2026-05-20T20:51:42.000Z",
  "usage": {
    "totalTokens": 661381,
    "stepsCount": 46,
    "totalCreditsCost": 145.98018,
    "creditLimitExceeded": false
  },
  "links": {
    "sessionUrl": "https://app.netlify.com/projects/.../agent-runs/...",
    "agentRunUrl": "...",
    "deployUrl": "",
    "prUrl": "",
    "issueUrl": "",
    "commentUrl": ""
  },
  "error": "",
  "resultText": "## 1. Repository State\n\n..."
}
```

For an attempt record (`<agent>.attempt-N.json`), `attemptOf` is set to the agent name and `status` reflects the failed attempt's terminal state.

### `artifacts/steps/<NN>-<id>/runs/<agent>.md`

Per-agent rendered Markdown. Used as the primary human-readable artifact and inlined into both step-level and top-level `summary.md`.

```markdown
# Codex · Review

- Status: completed
- Runner ID: `6a0df23585d8ee407fd30199`
- Session ID: `6a0df375cb57f944ee2ca251`
- Usage: 661,381 tokens · 46 steps · 145.98 credits
- Netlify: https://app.netlify.com/projects/.../agent-runs/...

---

## 1. Repository State

...
```

For failed runs without `resultText`, the body section is replaced with an error block:

```markdown
---

**Failed**: <error message>
```

## Persistence Semantics

### When persistence runs

Persistence is triggered at three points, in order of importance:

1. **Per-run terminal landing.** Inside the local and GitHub completion loops, every time a single run transitions to a terminal state (`completed`, `failed`, `timeout`, `cancelled`), call `persistRunArtifact(runState, step, run)`. This writes an immutable `runs/<agent>.attempt-N.{md,json}` pair, refreshes the latest convenience copy at `runs/<agent>.{md,json}`, and rebuilds the parent step's `step.json`, `summary.md`, and `usage.json`, plus the top-level `summary.md` and `usage.json`.

2. **Step completion.** When `completeLocalStep()` or `completeGithubStep()` finishes (whether by full success, full failure, or partial failure with retries exhausted), call `persistStepArtifacts(runState, step)`. This is wrapped in `try/finally` so even an exception in the completion path persists what's on disk in `stepState.runs`.

3. **`saveRunState()` follow-up.** Each time `saveRunState()` is called, call `persistWorkflowArtifacts(runState, { summaryOnly: true })` for top-level and per-step summary projections only. This guarantees `summary.md`, `usage.json`, and the `latest` symlink reflect the latest run state without depending on completion-path code paths. It must not write `$GITHUB_STEP_SUMMARY`; CI summary output is emitted once at process end.

The current code does not yet expose normalized per-run terminal events in both transports. Implementing this spec requires adding that plumbing explicitly:

- Local transport: extend `waitForLocalAgentRuns()` or its progress callback so terminal events include the fully normalized run returned by `normalizeCompletedRun()` / `normalizeFailedRun()`, not just a status snapshot.
- GitHub transport: extend `waitForGithubStep()` to call an `onRunResult` callback whenever a scoped result reply is found and normalized, instead of waiting until all issue results are complete.
- Both callbacks should update `stepState.runs` before calling `persistRunArtifact()` so `run.json`, step summaries, and per-agent artifacts agree.

### Append-only attempts, rebuild for summaries

- Immutable attempt files, `runs/<agent>.attempt-N.{md,json}`, are **never overwritten or renamed**. `N` is the next available integer for that agent. `attempt-1` is the first terminal attempt, `attempt-2` is the second, and so on.
- The latest convenience copy at `runs/<agent>.{md,json}` may be overwritten after its matching immutable attempt file is safely written. This makes `runs/codex.md` easy to open while preserving the append-only attempt trail.
- `step.json`, `step summary.md`, top-level `summary.md`, and `usage.json` are **always rebuilt from `runState`** on each persist. They are pure projections; losing them is harmless because they regenerate.
- This guarantees no terminal-state agent output can be lost mid-run, even if persistence is interrupted between writes.

### Idempotent rebuild

Calling `persistWorkflowArtifacts(runState)` is safe at any time:

- If the on-disk files are stale, they are rewritten.
- Existing immutable `attempt-N` files are left untouched.
- Missing parent directories are created.
- Symlink to `latest` is refreshed.

### Atomic writes

Every file write goes through a temp-file + rename pattern in the same directory:

```js
const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
fs.writeFileSync(tmp, content)
fs.renameSync(tmp, target)
```

This avoids half-written files if the process is killed mid-write. `rename` is atomic on the same filesystem on macOS and Linux. Windows is not a supported target.

### Resume behavior

When a workflow resumes from `.nax/runs/<run-id>/run.json`:

1. The artifact writer reads only `runState`. It does not parse on-disk artifact files.
2. Existing per-agent terminal files stay in place; they were written when the prior process ran.
3. Summaries are rebuilt from current `runState`, which already reflects resumed-and-completed work.
4. New terminal runs land via the standard persistence path, picking up `attempt-N` numbers that don't collide with prior files (resolved by scanning the `runs/` directory once per write).

### Concurrent writes

A single `nax` process executes per-run persistence within the awaited polling loop, so writes within one run are serialized. Two `nax` processes touching the same run-id is out of scope; existing run-state code already assumes single-writer.

## Module API: `lib/workflow-artifacts.js`

```js
function artifactsRootForRunState(runState)
//   → path to <run-dir>/artifacts

function persistWorkflowArtifacts(runState, options = {})
//   Top-level entry point. Rebuilds top-level summary.md / usage.json,
//   per-step step.json / summary.md / usage.json, and refreshes the
//   latest symlink. Does NOT touch terminal per-agent files except to
//   create missing immutable attempt files for terminal runs already in
//   runState. Does NOT write $GITHUB_STEP_SUMMARY unless explicitly asked.

function persistStepArtifacts(runState, step, options = {})
//   Rebuilds artifacts for one step (step.json, summary.md, usage.json,
//   per-agent files for any terminal-state runs in stepState.runs[]).
//   Also rebuilds top-level summaries because step status feeds into them.

function persistRunArtifact(runState, step, run, options = {})
//   Writes one immutable per-agent attempt .md + .json pair and refreshes
//   the mutable latest convenience copy. Calls persistStepArtifacts() at
//   the end so step.json, summary.md, and top-level summaries stay current.

function buildAgentJson({ runState, step, run })
function buildAgentMarkdown({ runState, step, run })
function buildStepJson({ runState, step, ordinal })
function buildStepMarkdown({ runState, step, ordinal })
function buildTopSummaryMarkdown(runState)
function buildTopUsageJson(runState)

function safeArtifactName(value, fallback = 'run')
//   Lowercase, ASCII-safe, no path separators, no dot-prefix, max 64 chars.
//   Used for agent file names and step directory ids.

function stepDirectoryName(step, ordinal)
//   Returns "01-review" etc. Zero-padded 2-digit ordinal + safeArtifactName(step.id).

function existingAttemptCount(runsDir, agent)
//   Returns the highest N currently in use for <agent>.attempt-N.* in runsDir.

function nextAttemptNumber(runsDir, agent)
//   Returns existingAttemptCount(...) + 1.

function writeAtomic(target, content)
function updateLatestSymlink(runState)
function writeGithubStepSummary(runState, options = {})
```

Options for the three public persist functions:

```js
{
  // If true, skip ALL writes and just return the planned filesystem changes.
  // Used by tests.
  dryRun: false,

  // If true, log artifact persistence warnings to stderr.
  debug: false,

  // If true, rebuild summaries and usage files only. Do not create new
  // immutable attempt files.
  summaryOnly: false,

  // If true, write the final GitHub Actions step summary. This is used once
  // near process exit, never on every saveRunState call.
  writeGithubSummary: false
}
```

## Integration Points

### `completeLocalStep()` in `bin/nax.js`

Current signature accepts `{ stepState, step, options, projectRoot, netlify, initialDelayMs }`. Add `runState`.

Inside the polling loop, when a single run transitions to terminal state, call:

```js
persistRunArtifact(runState, step, run)
```

This requires the local polling code to emit a normalized terminal run event. A status-only progress event is not sufficient because artifact persistence needs `resultText`, `usage`, `sessionId`, and links.

At the end of the function, wrap step completion in `try/finally`:

```js
try {
  // existing await polling + normalization
} finally {
  persistStepArtifacts(runState, step)
  saveRunState(runState) // existing
}
```

`saveRunState()` itself fires `persistWorkflowArtifacts()` for top-level summaries (see below).

### `completeGithubStep()` in `bin/nax.js`

Same shape: accept `runState`, call `persistRunArtifact` per terminal run, wrap the function body in `try/finally` that calls `persistStepArtifacts`.

This requires adding an `onRunResult` callback to `waitForGithubStep()`. Today the GitHub path normalizes results only after all expected issue comments are present. The new callback should fire when a scoped reply with a valid result marker is found for an individual run, normalize that run immediately, update the matching `stepState.runs[]` entry, then call `persistRunArtifact()`.

### `saveRunState()` in `lib/run-state.js`

Add a final call:

```js
persistWorkflowArtifacts(state, { summaryOnly: true })
```

This guarantees that any code path that saves run state also refreshes top-level summaries and the `latest` symlink. To avoid a circular require, the persistence module is loaded lazily inside `saveRunState`:

```js
function saveRunState(state) {
  fs.mkdirSync(state.dir, { recursive: true })
  const next = { ...state, updatedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(state.dir, 'run.json'), JSON.stringify(next, null, 2) + '\n')
  try {
    require('./workflow-artifacts').persistWorkflowArtifacts(next, { summaryOnly: true })
  } catch (error) {
    // Persistence must never block state save.
    if (process.env.NAX_DEBUG_ARTIFACTS) {
      console.error(`nax artifact persistence failed: ${error.message}`)
    }
  }
  return next
}
```

## CI Integration

### Upload step in `.github/workflows/run-nax.yml`

```yaml
- name: Upload nax run artifacts
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: nax-${{ inputs.flow || 'review' }}-${{ github.run_id }}
    path: |
      .nax/runs/**/run.json
      .nax/runs/**/artifacts/**
    if-no-files-found: ignore
    include-hidden-files: true
    retention-days: 30
```

`if: always()` ensures upload on workflow failure. `if-no-files-found: ignore` keeps early-exit jobs from failing the workflow. `include-hidden-files: true` is required because `actions/upload-artifact@v4` ignores hidden files and hidden directories by default, and `.nax/` starts with a dot. This is safe only because the artifact privacy policy excludes secrets and raw environment data.

### `$GITHUB_STEP_SUMMARY`

When `process.env.GITHUB_STEP_SUMMARY` is set, write the final artifact summary to that file once near process exit, after normal completion or inside the top-level failure handler. Do not append on every `saveRunState()` or every top-level summary rebuild; `saveRunState()` is called frequently and would spam duplicate summaries until the GitHub limit is hit.

The GitHub Actions per-step summary limit is 1 MiB. Behavior on overflow:

1. Read full `summary.md` content.
2. If size <= 900 KiB, append the whole thing once.
3. If size > 900 KiB, append a compact generated summary with run metadata, usage totals, step links, and artifact download instructions. Do not include partial agent output by default because truncating Markdown in the middle of agent output can make the summary misleading.
4. If the compact summary still exceeds 900 KiB, truncate to 900 KiB and append:
   ```
   ---
   *Truncated. Full output: download the `nax-<flow>-<run-id>` artifact from this job.*
   ```

The disk file is never truncated. The function that writes `$GITHUB_STEP_SUMMARY` should be separate from `persistWorkflowArtifacts()` and called deliberately once.

## UX

### Success box

At the end of a successful run, the existing success box gains one line:

```
Artifacts: .nax/runs/<run-id>/artifacts
```

For runs where the absolute path is long (CI), the path is wrapped or truncated middle-style only if it exceeds terminal width by a lot. No file listing is printed.

### Failure output

On failure, print the artifact path with a short hint:

```
Partial artifacts: .nax/runs/<run-id>/artifacts
Resume:            nax run <flow> --resume <run-id>
```

This is only printed if `artifacts/` exists and contains at least one terminal run.

### `nax init`

`nax init` is extended to ensure `.nax/` appears in the project's `.gitignore`. If `.gitignore` does not exist, it is created with `.nax/` as its sole entry. If `.gitignore` exists and does not contain `.nax/` (or `.nax`), an entry is appended under a section header:

```
# Added by nax init
.nax/
```

The artifact writer never modifies `.gitignore`. That responsibility lives solely with `nax init` to keep the artifact module side-effect-light.

## Privacy And Size Policy

Artifacts contain:

- Agent result text.
- Normalized usage.
- Runner and session IDs.
- Public or authenticated Netlify UI links.
- GitHub issue, comment, and PR URLs when available.
- Flow, step, and agent metadata.
- Error messages from failed runs.

Artifacts do not contain:

- `NETLIFY_AUTH_TOKEN`.
- GitHub tokens.
- Raw environment objects.
- Full command payloads.
- `rawResult` from `agent-run-results.js`.

`run.json` may still contain raw payloads for local debugging; artifacts are the clean, shareable surface.

## Tests

### Unit tests: `test/workflow-artifacts.test.js`

- Writes `summary.md`, `usage.json`, per-step `step.json`/`summary.md`/`usage.json`, and per-agent `.md`/`.json` from a hand-built `runState`.
- Per-agent JSON contains `resultText` for completed runs.
- Per-agent JSON contains `error` and omits `resultText` body for failed runs without result text.
- `safeArtifactName` sanitizes step IDs and agent names (slashes, dots, control chars, length cap).
- `stepDirectoryName` produces `01-review`, `02-cross-review`, `10-foo`.
- Retried run writes immutable `<agent>.attempt-1.{md,json}`, then `<agent>.attempt-2.{md,json}` without renaming attempt-1. The mutable `<agent>.{md,json}` latest copy points to the newest attempt content.
- `step.json.runs[].attempts[]` lists historical attempts in attempt-number order.
- `persistWorkflowArtifacts` is idempotent: calling it twice with unchanged `runState` does not modify file mtimes spuriously (write only when content differs).
- `persistRunArtifact` followed by `persistWorkflowArtifacts` produces consistent top-level summaries.
- Atomic write uses temp + rename. Partial failure during write does not leave a half-written target file.
- `updateLatestSymlink` updates `.nax/runs/latest`. If symlinks fail, the error is swallowed and persistence completes.
- `GITHUB_STEP_SUMMARY` write: full content under 900 KiB is written once; oversize content falls back to compact summary with a notice.
- Persistence of a run with no `resultText`, no usage, and no links produces no per-agent file (nothing meaningful to persist).

### Integration tests in `bin/nax.js` paths

Touch lightly — most behavior is covered above.

- `completeLocalStep` calls `persistRunArtifact` for every terminal run.
- `completeGithubStep` calls `persistRunArtifact` for every terminal run.
- Local polling emits a normalized terminal-run event containing result text, usage, IDs, and links.
- GitHub polling emits an `onRunResult` callback before all expected issue replies have completed.
- `saveRunState` triggers `persistWorkflowArtifacts(..., { summaryOnly: true })`.
- Success box includes the artifact path.
- Failure path prints the partial artifact path when at least one terminal run was persisted.

### `nax init` test

- `nax init` adds `.nax/` to `.gitignore` if missing.
- `nax init` does not duplicate the entry if already present.
- `nax init` creates `.gitignore` if missing.

### Workflow test

If existing `.github/workflows/run-nax.yml` tests exist, extend them to assert the upload step. Otherwise, leave workflow correctness to manual verification.

## Implementation Phases

### Phase 1 — Artifact writer

`lib/workflow-artifacts.js` plus `test/workflow-artifacts.test.js`. No `bin/nax.js` integration yet.

Acceptance: tests pass against hand-built local-style and GitHub-style normalized run states.

### Phase 2 — `saveRunState` hook + `nax init` gitignore

Wire `persistWorkflowArtifacts` into `saveRunState`. Update `nax init` to manage `.gitignore`. No completion-path changes yet.

Acceptance: existing flows still work; `.nax/runs/<id>/artifacts/summary.md` exists at end of every run; `.nax/runs/latest` is a symlink.

### Phase 3 — Terminal event plumbing and completion-path hooks

Add `runState` param to `completeLocalStep` and `completeGithubStep`. Extend local and GitHub polling so each transport can emit a normalized terminal-run event before the full step is complete. Call `persistRunArtifact` from those terminal events. Wrap step completion in `try/finally` that calls `persistStepArtifacts`.

Acceptance: killing a `nax` process between steps still leaves per-agent terminal files on disk for completed runs.

### Phase 4 — CI upload + `$GITHUB_STEP_SUMMARY`

Update `.github/workflows/run-nax.yml` with the `upload-artifact` step, including `include-hidden-files: true`. Implement a one-shot `GITHUB_STEP_SUMMARY` writer in `workflow-artifacts.js` and call it at process end or from the top-level failure handler.

Acceptance: CI run shows results inline in the run UI; artifact bundle is downloadable; oversize summaries truncate with a notice and link.

### Phase 5 — User-facing polish

Success-box and failure-output artifact path lines.

Acceptance: TTY and non-TTY output remains clean.

## Risks And Tradeoffs

### Duplicated result text on disk

`resultText` is stored in `run.json` *and* in per-agent JSON *and* rendered into per-agent Markdown *and* inlined into step `summary.md` and top-level `summary.md`. This is intentional: each location serves a different consumer (machine state, programmatic per-run, human per-agent, human per-step, human top-level). Size is bounded by what agents produce, which is already on disk.

### `step.json` redundancy with `run.json`

`step.json` repeats fields from `run.json`. This is the price of having step artifacts be standalone-readable. The duplication is one-way (always derived from `run.json`) so there is no drift surface.

### Branching flows

Step ordinal is taken from `runState.steps[]` position. When flows gain branching, `runState.steps[]` must continue to be the authoritative execution log appended in execution order. If a flow engine introduces parallel branches, this spec needs revision; for now, sequential execution is the only supported mode.

### Attempt-N allocation race

If two terminal events for the same agent fire in rapid succession (shouldn't happen with current polling, but possible if persistence is called from multiple places), the attempt-N counter could collide. Mitigation: `persistRunArtifact` reads the directory, computes the next free `attempt-N`, writes the immutable attempt file first, and only then refreshes the latest convenience copy. Workers within `nax` are awaited serially, so this is a single-threaded sequence.

### `$GITHUB_STEP_SUMMARY` size

GitHub enforces 1 MiB per step. Long synthesize outputs from `review` regularly approach this. Truncation logic must be tested with realistic content sizes; the 900 KiB threshold leaves headroom for the truncation notice and any step-summary content written by other workflow commands.

### Hidden artifact upload

`actions/upload-artifact@v4` excludes hidden files and hidden directories by default. Because the artifact tree lives under `.nax/`, the workflow must either set `include-hidden-files: true` or copy artifacts to a non-hidden staging directory. This spec chooses `include-hidden-files: true` and relies on the artifact privacy policy to keep the uploaded content safe.

### Symlink portability

`.nax/runs/latest` uses a POSIX symlink. macOS and Linux only. If a Windows port is added later, switch to a `latest.txt` file or a `.cmd` shortcut. Symlink failure is swallowed today.

## Recommended First PR

One PR shipping Phases 1–4:

1. `lib/workflow-artifacts.js`
2. `test/workflow-artifacts.test.js`
3. `lib/run-state.js` — `persistWorkflowArtifacts` call inside `saveRunState`
4. `bin/nax.js` — `runState` parameter on `completeLocalStep` and `completeGithubStep`, per-run and per-step persist calls, `try/finally` wrappers
5. `lib/init.js` + `bin/nax.js init` — `.gitignore` management
6. `.github/workflows/run-nax.yml` — `upload-artifact` step
7. Terminal-run event plumbing in local and GitHub polling
8. One-shot `$GITHUB_STEP_SUMMARY` writer
9. Success-box artifact line

Defer to follow-ups:

- Artifact browsing/listing subcommand.
- Retry command sourced from artifacts.
- Optional artifact compression.
- Windows symlink alternative.
- `--no-artifacts` and `--artifacts-dir` flags (only if a real need surfaces).
