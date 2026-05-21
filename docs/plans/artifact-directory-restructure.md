# Nax Artifact Directory Restructure Plan

## Summary

Restructure `.nax/` persistence around the real execution hierarchy:

- **Workflows**: `nax` orchestration runs such as `review`, `ideas`, and `do-next`.
- **Agent runners**: Netlify agent runner threads, keyed by runner ID. A runner can contain multiple sessions.
- **Agent sessions**: individual Netlify agent session results, keyed by session ID. This is the atomic persisted result.

Target structure:

```text
.nax/
  workflows/
    latest -> <workflow-run-id>
    <workflow-run-id>/
      workflow.json
      artifacts/
        summary.md
        usage.json
        steps/
          01-<step-id>/
            step.json
            summary.md
            usage.json
            agent-runners/
              <agent>.md
              <agent>.json

  agent-runners/
    latest -> <runner-id>
    <runner-id>/
      agent-runner.json
      summary.md
      usage.json
      sessions/
        <session-id>.json

  agent-sessions/
    latest -> <session-id>
    <session-id>/
      agent-session.json
      summary.md
      usage.json
      result.md
```

There is no long-term backwards-compatibility requirement. New code should stop reading and writing `.nax/runs/` during normal operation.

One safety exception is required: Phase 1 must include a one-shot legacy cleanup for interrupted local work. If `.nax/runs/` exists when the new layout is first used, the CLI should either:

1. Rename `.nax/runs/` to `.nax/workflows/` when `.nax/workflows/` does not already exist, or
2. Warn clearly that unfinished legacy runs exist and list their paths before continuing.

The preferred implementation is the one-shot rename because it preserves resumability without maintaining dual-read compatibility. After Phase 1, there should be no steady-state `.nax/runs/` reads.

## Why This Model

Netlify Agent Runner is already modeled as a thread of sessions:

- The Netlify UI URL `/agent-runs/<runnerId>` identifies the runner/thread.
- The `?session=<sessionId>` query points at one session inside that thread.
- Follow-up prompts reuse a runner ID but create new session IDs.

The `.nax` structure should reflect that instead of flattening everything into “runs.” The terms become precise:

- `.nax/workflows/` means `nax` orchestration: steps, agents, dependencies, rollups.
- `.nax/agent-runners/` means Netlify runner/thread: one agent conversation lineage.
- `.nax/agent-sessions/` means one concrete result: prompt, output, usage, links, status.

This gives us the right granularity:

- Fetch or hand off one exact session.
- Fetch or hand off an entire runner thread.
- Fetch or hand off a whole workflow.
- Aggregate usage accurately from session → runner → workflow.

## Design Principles

1. **Sessions are atomic.** If an agent produces a result, the durable source is `.nax/agent-sessions/<session-id>/`.
2. **Runners are thread rollups.** `.nax/agent-runners/<runner-id>/` aggregates its sessions and points to the latest/relevant session.
3. **Workflows are orchestration rollups.** `.nax/workflows/<workflow-run-id>/` aggregates steps and references the runner/session records used by those steps.
4. **No generic `runs` noun.** Use `workflows`, `agent-runners`, and `agent-sessions`.
5. **No steady-state compatibility branching.** A one-shot `.nax/runs` rename is allowed only to avoid orphaning interrupted work.
6. **Shared rendering.** Session, runner, and workflow projections must use common formatting helpers for usage, links, status, and result blocks.
7. **Useful latest.** `nax handoff` should default to the newest useful source across sessions, runners, and workflows.

## Directory Contract

### Workflows

Path:

```text
.nax/workflows/<workflow-run-id>/
```

Files:

```text
workflow.json
artifacts/
  summary.md
  usage.json
  steps/
    01-review/
      step.json
      summary.md
      usage.json
      agent-runners/
        claude.md
        claude.json
        gemini.md
        gemini.json
        codex.md
        codex.json
```

Notes:

- Rename `run.json` to `workflow.json`.
- Rename step-local `runs/` to `agent-runners/`.
- Step-local files are workflow projections, not the canonical atomic output.
- Workflow summaries should link to canonical runner and session artifacts.
- The workflow summary remains the best human entry point for a grouped workflow.

Example `step.json` run entry:

```json
{
  "agent": "claude",
  "status": "completed",
  "runnerId": "6a0e3ed5de30883a88f4f624",
  "sessionId": "6a0e3ed5de30883a88f4f626",
  "runnerPath": "../../../agent-runners/6a0e3ed5de30883a88f4f624/summary.md",
  "sessionPath": "../../../agent-sessions/6a0e3ed5de30883a88f4f626/summary.md",
  "resultPath": "agent-runners/claude.md",
  "metadataPath": "agent-runners/claude.json",
  "usage": {}
}
```

### Agent Runners

Path:

```text
.nax/agent-runners/<runner-id>/
```

Files:

```text
agent-runner.json
summary.md
usage.json
sessions/
  <session-id>.json
```

`agent-runner.json` describes a Netlify runner/thread:

```json
{
  "schemaVersion": 1,
  "runnerId": "6a0e3ed5de30883a88f4f624",
  "agent": "claude",
  "status": "completed",
  "createdAt": "2026-05-20T23:10:00.000Z",
  "updatedAt": "2026-05-20T23:15:00.000Z",
  "latestSessionId": "6a0e3ed5de30883a88f4f626",
  "sessionIds": [
    "6a0e3ed5de30883a88f4f626"
  ],
  "source": {
    "type": "handoff",
    "priorSourceKind": "workflow",
    "priorSourceId": "2026-05-20T22-23-24-159Z-do-next",
    "priorSummaryPath": ".nax/workflows/2026-05-20T22-23-24-159Z-do-next/artifacts/summary.md"
  },
  "usage": {},
  "links": {}
}
```

`sessions/<session-id>.json` is a lightweight pointer/projection:

```json
{
  "sessionId": "6a0e3ed5de30883a88f4f626",
  "path": "../../agent-sessions/6a0e3ed5de30883a88f4f626/summary.md",
  "status": "completed",
  "usage": {}
}
```

`summary.md` is a thread summary:

```markdown
# Claude Agent Runner · 6a0e3ed5de30883a88f4f624

- Status: completed
- Agent: Claude
- Runner ID: `6a0e3ed5de30883a88f4f624`
- Latest session: [6a0e3ed5de30883a88f4f626](sessions/6a0e3ed5de30883a88f4f626.json)
- Usage: 18.07 credits, 10 steps, 85,131 tokens
- Netlify: https://app.netlify.com/projects/.../agent-runs/6a0e3ed5de30883a88f4f624

## Sessions

1. [6a0e3ed5de30883a88f4f626](../../agent-sessions/6a0e3ed5de30883a88f4f626/summary.md) · completed · 18.07 credits, 10 steps, 85,131 tokens
```

### Agent Sessions

Path:

```text
.nax/agent-sessions/<session-id>/
```

Session ID choice:

- Prefer `sessionId` when present.
- If a session ID is unavailable, fall back to:
  ```text
  <timestamp>-<agent>
  ```
  Provenance belongs in `agent-session.json.source`, not the directory name.

Files:

```text
agent-session.json
summary.md
usage.json
result.md
```

Only write `result.md` when there is non-empty agent-authored result text. Do not create an empty `result.md` for failed, timeout, cancelled, or metadata-only sessions.

`agent-session.json`:

```json
{
  "schemaVersion": 1,
  "sessionId": "6a0e3ed5de30883a88f4f626",
  "runnerId": "6a0e3ed5de30883a88f4f624",
  "agent": "claude",
  "status": "completed",
  "createdAt": "2026-05-20T23:10:00.000Z",
  "updatedAt": "2026-05-20T23:15:00.000Z",
  "source": {
    "type": "handoff",
    "priorSourceKind": "workflow",
    "priorSourceId": "2026-05-20T22-23-24-159Z-do-next",
    "priorSummaryPath": ".nax/workflows/2026-05-20T22-23-24-159Z-do-next/artifacts/summary.md"
  },
  "usage": {},
  "links": {},
  "resultText": ""
}
```

`summary.md`:

```markdown
# Claude Session · 6a0e3ed5de30883a88f4f626

- Status: completed
- Agent: Claude
- Runner ID: `6a0e3ed5de30883a88f4f624`
- Session ID: `6a0e3ed5de30883a88f4f626`
- Usage: 18.07 credits, 10 steps, 85,131 tokens
- Netlify: https://app.netlify.com/projects/.../agent-runs/6a0e3ed5de30883a88f4f624?session=6a0e3ed5de30883a88f4f626
- Result: [result.md](result.md)
- Metadata: [agent-session.json](agent-session.json)

---

<result text>
```

## Source Metadata

Every runner and session must identify where it came from. Initial variants:

```js
{
  type: 'handoff',
  priorSourceKind: 'workflow' | 'agent-runner' | 'agent-session',
  priorSourceId: '<source id>',
  priorSummaryPath: '.nax/workflows/.../summary.md'
}
```

```js
{
  type: 'workflow-step',
  workflowRunId: '<workflow-run-id>',
  stepId: '<step-id>',
  stepTitle: '<human title>'
}
```

```js
{
  type: 'manual',
  reason: '<short reason>'
}
```

Do not infer source from directory names. Directory names are identifiers; provenance is structured metadata.

## Handoff Semantics

`nax handoff` should search handoff sources in this order:

1. Newest completed agent session under `.nax/agent-sessions/`.
2. Newest completed agent runner thread under `.nax/agent-runners/`.
3. Newest completed workflow summary under `.nax/workflows/`.

The selected source should return a uniform shape:

```js
{
  kind: 'agent-session' | 'agent-runner' | 'workflow',
  id,
  title,
  summaryPath,
  summaryText,
  updatedAt
}
```

TTY and non-TTY output must disclose the selected source kind:

```text
Source: agent-session
Summary: .nax/agent-sessions/6a0e3ed5de30883a88f4f626/summary.md
```

or:

```text
Source: workflow
Summary: .nax/workflows/2026-05-20T22-23-24-159Z-do-next/artifacts/summary.md
```

Fresh handoff session:

- Reads prior `summary.md`.
- Builds the submitted prompt from user instructions plus full summary contents.
- Persists the completed session under `.nax/agent-sessions/<session-id>/`.
- Updates/creates the runner thread under `.nax/agent-runners/<runner-id>/`.
- Prints a success box with Netlify URL, usage, and both runner/session artifact paths.

Workflow chaining:

- Reads prior `summary.md`.
- Embeds full summary contents into workflow context.
- Creates a normal workflow run under `.nax/workflows/<workflow-run-id>/`.

Future handoff UX can expose source granularity:

```text
Use previous:
> Latest result
  Entire workflow
  Agent runner thread
  Individual session
```

The first implementation can keep the existing menu while using latest-source discovery internally.

## Module Plan

### `lib/run-state.js`

Rename workflow state paths:

- `getRunsDir(projectRoot)` → `getWorkflowsDir(projectRoot)`
- `listRunStates(projectRoot)` → `listWorkflowStates(projectRoot)`
- `createRunState(...)` can remain exported temporarily if call sites are easier, but internally it writes to `.nax/workflows`.
- `readRunState(...)` → `readWorkflowState(...)`

State file path:

```text
.nax/workflows/<workflow-run-id>/workflow.json
```

The in-memory state may keep `runId`; the disk filename and directory are the important cleanup.

### `lib/workflow-artifacts.js`

Update workflow artifact paths:

- `artifactsRootForRunState(runState)` remains `<workflow-dir>/artifacts`.
- Step-local directory changes from:
  ```text
  steps/<step>/runs/
  ```
  to:
  ```text
  steps/<step>/agent-runners/
  ```

Workflow step projections should include links to canonical runner/session artifacts.

### Shared Agent Artifact Renderers

Add shared render helpers in `lib/agent-run-results.js` or a sibling module such as `lib/agent-artifact-renderers.js`:

```js
function buildAgentSessionJson(input)
function buildAgentSessionMarkdown(input)
function buildAgentSessionUsageJson(input)
function buildAgentSessionResultMarkdown(input)
function buildAgentRunnerJson(input)
function buildAgentRunnerMarkdown(input)
function buildAgentRunnerUsageJson(input)
```

Both workflow projections and canonical runner/session artifacts must consume these helpers. Storage modules decide where files are written; renderers decide what metadata and Markdown look like.

This is a hard requirement. Without shared renderers, workflow-local projections and canonical artifacts will drift.

### New `lib/agent-session-artifacts.js`

Writes canonical session artifacts:

```js
function agentSessionsRoot(projectRoot)
function agentSessionDir(projectRoot, sessionId)
function persistAgentSessionArtifact(input, options)
function listAgentSessionArtifacts(projectRoot)
function updateLatestAgentSessionSymlink(projectRoot, sessionId)
```

### New `lib/agent-runner-artifacts.js`

Writes runner/thread rollups:

```js
function agentRunnersRoot(projectRoot)
function agentRunnerDir(projectRoot, runnerId)
function persistAgentRunnerArtifact(input, options)
function listAgentRunnerArtifacts(projectRoot)
function updateLatestAgentRunnerSymlink(projectRoot, runnerId)
```

The runner artifact should be rebuilt whenever a new session for that runner is persisted.

### New `lib/handoff-sources.js`

Discovers handoff sources:

```js
function listHandoffSources(projectRoot)
function findLatestHandoffSource(projectRoot, { id, kind } = {})
function readHandoffSource(projectRoot, { id, kind } = {})
```

Source discovery reads:

- `.nax/agent-sessions/*/summary.md`
- `.nax/agent-runners/*/summary.md`
- `.nax/workflows/*/artifacts/summary.md`

No `.nax/runs` fallback after Phase 1 cleanup.

### `bin/nax.js`

Update call sites:

- `handleRun`
  - workflow state path becomes `.nax/workflows/<id>/workflow.json`.
  - terminal workflow runs persist canonical session and runner artifacts.
  - success/failure boxes display workflow artifact paths under `.nax/workflows`.
- `handleRecent`
  - list workflows, agent runners, and agent sessions.
  - add `--type workflow|agent-runner|agent-session|all`; default `all`.
  - label entries with kind.
- `handleRedrive`
  - workflow runs only in the first pass.
- `handleHandoff`
  - use `handoff-sources`.
  - fresh one-off handoff persists session and runner artifacts.
  - after completion, latest handoff source becomes the new session.
- `printPostSuccessHandoffHint`
  - accept workflow, runner, or session artifact paths.

## CLI UX

### Workflow Success

```text
Artifacts:
/Users/david/.../.nax/workflows/2026-05-20T22-23-24-159Z-do-next/artifacts

The results from your workflow are in .nax/workflows/2026-05-20T22-23-24-159Z-do-next/artifacts/summary.md

Hand them off to another agent with:

nax handoff
```

### Fresh Handoff Success

```text
╭────────────────────────────────────────────────────────────────────────╮
│  Success                                                               │
├────────────────────────────────────────────────────────────────────────┤
│  Agent session "Claude Handoff" complete.                              │
│  Netlify: https://app.netlify.com/projects/.../agent-runs/...?session= │
│  Usage: 18.07 credits, 10 steps, 85,131 tokens                         │
│  Session artifacts:                                                    │
│  /Users/david/.../.nax/agent-sessions/6a0e3ed5de30883a88f4f626         │
│  Runner artifacts:                                                     │
│  /Users/david/.../.nax/agent-runners/6a0e3ed5de30883a88f4f624          │
╰────────────────────────────────────────────────────────────────────────╯

The result from this agent session is in .nax/agent-sessions/6a0e3ed5de30883a88f4f626/summary.md

Hand it off again with:

nax handoff
```

### Handoff Menu

Keep generic labels because the latest source may be a workflow, runner, or session:

```text
Hand off previous results
> Copy previous results to clipboard
  Start a new agent session with previous results
  Cancel
```

Add a source hint:

```text
Latest: Claude Session · .nax/agent-sessions/6a0e3ed5de30883a88f4f626/summary.md
```

## CI Upload

Update `.github/workflows/run-nax.yml` artifact paths from:

```yaml
.nax/runs/**/run.json
.nax/runs/**/artifacts/**
```

to:

```yaml
.nax/workflows/**/workflow.json
.nax/workflows/**/artifacts/**
.nax/agent-runners/**
.nax/agent-sessions/**
```

Keep `include-hidden-files: true` because `.nax/` is hidden.

## Cleanup Scope

- Remove steady-state `.nax/runs` reads.
- Keep only the Phase 1 one-shot `.nax/runs` rename/orphan warning.
- Remove `.nax/runs/latest` writes.
- Remove current-behavior docs and tests that assert `.nax/runs`.
- Update messages that say “No runs found in .nax/runs.”
- Update help text to say `.nax/workflows`, `.nax/agent-runners`, `.nax/agent-sessions`, or `.nax artifacts`.

## Test Plan

### `test/run-state.test.js`

- `createRunState()` creates `.nax/workflows/<id>/workflow.json`.
- `listWorkflowStates()` reads `.nax/workflows`.
- `saveRunState()` refreshes `.nax/workflows/<id>/artifacts`.
- `latest` symlink points under `.nax/workflows`.
- One-shot legacy `.nax/runs` rename or orphan warning works.

### `test/workflow-artifacts.test.js`

- Step-local files are under `agent-runners/`, not `runs/`.
- Top summary relative links point to `steps/01-review/agent-runners/claude.md`.
- `step.json` includes canonical runner/session artifact paths.

### New `test/agent-session-artifacts.test.js`

- `persistAgentSessionArtifact()` writes `agent-session.json`, `summary.md`, `usage.json`, and `result.md` when result text exists.
- `persistAgentSessionArtifact()` omits `result.md` for failed, timeout, cancelled, dry-run, or empty-result sessions.
- Session ID becomes the default directory name.
- Generated fallback ID is generic (`<timestamp>-<agent>`).
- Source metadata supports `handoff`, `workflow-step`, and `manual`.
- Latest symlink updates.

### New `test/agent-runner-artifacts.test.js`

- `persistAgentRunnerArtifact()` writes `agent-runner.json`, `summary.md`, `usage.json`, and `sessions/<session-id>.json`.
- Runner usage aggregates session usage.
- Latest session points to the newest session.
- Summary links to canonical session summaries.
- Latest symlink updates.

### New `test/handoff-sources.test.js`

- Newest session beats older runner and workflow.
- Newest runner beats older workflow when no newer session exists.
- Newest workflow is selected when it is newest overall.
- Explicit source ID and kind select the right source.
- Empty `.nax` returns a helpful error.
- No `.nax/runs` fallback after cleanup.

### `test/flow-execution.test.js`

- Latest source path can be workflow, runner, or session.
- Fresh handoff completion persists `.nax/agent-sessions/<session-id>/summary.md`.
- Fresh handoff completion updates `.nax/agent-runners/<runner-id>/summary.md`.
- Post-success hint uses the session summary for standalone handoff runs.
- Non-TTY handoff output prints source kind and summary path.

### Recent Command Tests

- Default recent list includes workflows, agent runners, and agent sessions.
- `--type workflow` lists only workflows.
- `--type agent-runner` lists only agent runners.
- `--type agent-session` lists only sessions.
- Entries display kind labels.

## Implementation Phases

### Phase 1: Workflow Path Rename

Change workflow state from `.nax/runs/<id>/run.json` to `.nax/workflows/<id>/workflow.json`.

Add one-shot legacy cleanup:

- If `.nax/runs/` exists and `.nax/workflows/` does not, rename `.nax/runs/` to `.nax/workflows/`.
- If both exist and `.nax/runs/` contains unfinished runs, print a warning with orphaned paths.
- Do not keep dual-read behavior.

Acceptance:

- `npm test` passes.
- New workflow run creates `.nax/workflows/<id>/workflow.json`.
- No steady-state source code references `.nax/runs`.

### Phase 2: Workflow Step Projection Rename

Update workflow step artifacts from:

```text
steps/<step>/runs/
```

to:

```text
steps/<step>/agent-runners/
```

Acceptance:

- Workflow `summary.md` links point to `agent-runners/<agent>.md`.
- `step.json` paths use `agent-runners`.
- Artifact tests pass.

### Phase 3: Canonical Session And Runner Artifacts

Add shared renderers, `lib/agent-session-artifacts.js`, and `lib/agent-runner-artifacts.js`.

Wire fresh `nax handoff` one-off runs to persist:

- `.nax/agent-sessions/<session-id>/`
- `.nax/agent-runners/<runner-id>/`

Acceptance:

- `nax handoff --agent claude` creates session and runner artifacts.
- Success output prints session and runner artifact directories.
- `result.md` is omitted when there is no result text.
- Runner rollup links to the session.

### Phase 4: Handoff Source Discovery

Add `lib/handoff-sources.js` and update `nax handoff` in the same change that makes session/runner artifacts visible.

Acceptance:

- Plain `nax handoff` defaults to the newest source across sessions, runners, and workflows.
- Copy mode works for any source kind.
- Chained workflow mode embeds full summary text from any source kind.
- Running `nax handoff --agent claude` twice in a row uses the first handoff session as the second run's prior source.

### Phase 5: Workflow Runs Also Write Canonical Session/Runner Artifacts

For every terminal workflow agent result, write:

- workflow-local projection under `steps/<step>/agent-runners/<agent>.*`
- canonical session artifact under `.nax/agent-sessions/<session-id>/`
- canonical runner rollup under `.nax/agent-runners/<runner-id>/`

Acceptance:

- Completing a workflow step writes all three layers.
- Workflow summaries link to canonical runner/session artifacts.
- Shared render helper tests prove consistent formatting across layers.

### Phase 6: Recent Command, CI, And Docs Cleanup

Update:

- `nax recent` to include workflows, agent runners, and agent sessions with `--type`.
- `.github/workflows/run-nax.yml` upload paths.
- Help text.
- Current-behavior docs.

Acceptance:

- `nax recent` shows all source kinds with labels.
- `nax recent --type workflow`, `--type agent-runner`, and `--type agent-session` filter correctly.
- CI uploads `.nax/workflows`, `.nax/agent-runners`, and `.nax/agent-sessions`.
- User-facing current docs do not describe `.nax/runs` as the active structure.

## Open Decisions

### Should workflow step projections duplicate canonical session text?

Recommendation: yes for now, but keep canonical session artifacts authoritative.

Workflow artifacts should remain self-contained for CI downloads and human review. Canonical session artifacts give exact atomic access. Duplication is acceptable because artifacts are derived and shared renderers prevent drift.

### Should every workflow terminal result write canonical session/runner artifacts?

Recommendation: yes, Phase 5.

The clean model is that every terminal agent result exists as an atomic session, whether it came from a workflow or a one-off handoff.

### Should `nax recent` include all three layers?

Recommendation: yes, Phase 6.

Once sessions and runners are first-class, hiding them from the browsing command makes them feel accidental. Filters keep the default list usable.

## Risks

- **Path churn:** Many tests and messages mention `.nax/runs`. Mitigation: Phase 1 focused rename plus broad grep validation.
- **Interrupted legacy runs:** A pure cutover can orphan unfinished `.nax/runs` state. Mitigation: one-shot rename or explicit orphan warning.
- **Too many files:** Three layers produce more artifacts. Mitigation: sessions are small, and the navigability is worth the file count.
- **Duplicate artifact drift:** Workflow projections and canonical session artifacts can drift. Mitigation: mandatory shared renderers.
- **Handoff source ambiguity:** Users may not know whether latest is a workflow, runner, or session. Mitigation: always display source kind and path.
- **CI hidden-file upload:** `.nax` remains hidden, so `include-hidden-files: true` must stay.

## Final Target

After this work, a user can run:

```bash
nax run do-next
nax handoff
```

and each layer remains durable:

```text
.nax/workflows/<do-next-id>/artifacts/summary.md
.nax/agent-runners/<runner-id>/summary.md
.nax/agent-sessions/<session-id>/summary.md
```

The chain no longer breaks when moving from workflow output to one-off handoff sessions, and future commands can fetch exactly the level of context they need.
