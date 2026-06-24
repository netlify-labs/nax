# Deconstruct `bin/nax.js`

## Goal

Turn `bin/nax.js` back into a thin executable entrypoint while preserving behavior, public CLI shape, and test coverage.

The target shape is:

```text
bin/nax.js
  - shebang
  - imports command registration and command handlers
  - buildProgram()
  - parseAsync(process.argv)
  - temporary compatibility exports while tests migrate

src/
  commands/
    nax.js                 # Commander command tree
    handlers.js            # CLI handler map
    options.js             # Commander option normalization
  cli/
    issue.js               # issue/comment command behavior
    flow-list.js           # list and flow display helpers
    handoff.js             # handoff command behavior and display helpers
    recent.js              # recent artifact picker
    run.js                 # top-level run orchestration
    retry.js               # retry command behavior
    sync.js                # sync command behavior
    ci.js                  # ci command behavior
  workflow/
    github-executor.js     # GitHub workflow execution
    local-executor.js      # Netlify API/local workflow execution
    resume.js              # unfinished-run detection and resume
    progress.js            # progress rows, heartbeat, flavor text
    prompt-delivery.js     # local prompt delivery and compaction
    success.js             # success boxes and handoff hints
  github/
    prompt-budget.js       # GitHub body/action/env budget helpers
    issue-plan.js          # issue/comment plan building and fallback
    polling.js             # GitHub result polling and failure classification
  netlify/
    project-selection.js   # filter/site/config selection
```

## Why `bin/nax.js` Is Still Huge

The previous extraction moved command registration only. That removed Commander wiring from the file, but it intentionally left command behavior and workflow internals in place.

`bin/nax.js` still owns at least these separate concerns:

- GitHub issue and comment planning.
- GitHub prompt budget enforcement and blob fallback.
- Interactive prompt selection.
- Flow listing and display formatting.
- Recent artifact selection.
- Handoff source selection, formatting, and fresh handoff runs.
- Workflow picker UI and transport selection.
- Resume display and unfinished-run selection.
- Success boxes and post-run handoff hints.
- Local prompt compaction and blob offload.
- Local Netlify API workflow execution.
- GitHub workflow execution and polling.
- Retry behavior.
- Progress rendering and heartbeat output.
- Netlify project/filter/site selection.
- Command handlers for `run`, `issue`, `comment`, `recent`, `handoff`, `retry`, `clean`, `skills`, `ci`, `sync`, and `init`.
- A large `_private` compatibility export used by tests.

That is why a registration-only extraction did not make the executable small. The real work is moving cohesive behavior clusters into `src` and migrating tests away from `require('../../bin/nax')._private`.

## Constraints

- Preserve the CLI contract exactly unless a change is explicitly approved.
- All JavaScript must have JSDoc types.
- No `any`, no broad `Object`, and no long one-line typedefs.
- Prefer colocated typedefs when they are local to a module.
- Keep behavior isomorphic: one extraction seam per pass, tests green after every pass.
- Do not delete compatibility exports until tests and downstream callers no longer need them.
- Avoid circular dependencies from `src` back into `bin`.
- `bin/nax.js` should only import from `src`; `src` must never import from `bin/nax.js`.

## Target Acceptance Criteria

The deconstruction is done when:

- `bin/nax.js` is under 300 lines.
- `bin/nax.js` contains no workflow execution, prompt construction, polling, display formatting, or artifact logic.
- `bin/nax.js` exports only `buildProgram` and intentionally public compatibility functions, or exports no compatibility functions if tests have migrated.
- No tests import `_private` from `bin/nax.js`.
- `npm run check` passes.
- `npm test` passes.
- `rg` finds no forbidden `any` / broad `Object` JSDoc in touched files.
- Command help output remains stable for root and all subcommands.

## Strategy

Extract from the outside inward:

1. Pure utilities and display helpers first.
2. Command handlers next.
3. GitHub/local execution modules after their helper dependencies are out.
4. Top-level run/resume orchestration last.
5. Remove `_private` only after tests point to real modules.

This order avoids the trap of extracting `handleRun` first. `handleRun` touches almost everything, so extracting it before its dependencies would create a huge module with the same problem under a different filename.

## Module Boundaries

### `src/commands/options.js`

Move from `bin/nax.js`:

- `collectOption`
- `commandOptions`
- `optionWasSet`
- `normalizeOptionAliases`
- `mergeCommandOptions`
- `actionOptions`

Reasoning:

These functions are command-framework glue, not workflow behavior. They belong beside `src/commands/nax.js`.

Tests:

- Add focused tests for alias normalization:
  - `--dry` -> `dryRun`
  - `--site-id` -> `netlifySiteId`
  - `--force` -> `yes`
  - `--where` -> `transport`
  - parent command option inheritance

### `src/cli/ci.js`

Move from `bin/nax.js`:

- `normalizeCiCommand`
- `handleCi`

Reasoning:

This command is already isolated and tested. It depends only on `classifyNetlifyRuntime`, `spawnSync`, and injected dependencies.

Tests:

- Move `tests/unit/netlify-runtime.test.js` command-handler assertions to import from `src/cli/ci.js`.
- Keep `bin/nax.js` compatibility export temporarily.

### `src/cli/sync.js`

Move from `bin/nax.js`:

- `handleSync`

Reasoning:

The sync behavior already delegates to `src/github-actions-sync.js` and `src/agent-runner-sync.js`. This is a thin command adapter.

Tests:

- Add direct handler tests for:
  - `last`
  - numeric GitHub Actions run id
  - GitHub Actions run URL
  - unsupported target

### `src/netlify/project-selection.js`

Move from `bin/nax.js`:

- `resolveProjectRoot`
- `maybeReportNetlifyFilter`
- `maybeReportNetlifySite`
- `netlifyOptionsFromTarget`
- `configDirForNetlifyOptions`
- `netlifyProjectChoiceLabel`
- `netlifyConfigChoiceHint`
- `netlifyConfigDistance`
- `sortNetlifyConfigChoices`
- `formatNetlifyConfigAmbiguity`
- `formatNetlifyWorkspaceFilterError`
- `chooseNetlifyFilterOption`

Reasoning:

This is a cohesive Netlify project-target selection module. It is used by local execution, retry, and command setup.

Tests:

- Move existing `chooseNetlifyFilterOption`, sorting, hint, label, and `resolveProjectRoot` tests to import from this module.

### `src/github/prompt-budget.js`

Move from `bin/nax.js`:

- GitHub issue/action size constants.
- `utf8ByteLength`
- `githubActionTriggerTextMetrics`
- `githubActionPromptBudgetLabel`
- `githubActionPromptBudgetViolations`
- `githubActionPromptBudgetWarnings`
- `formatGithubActionPromptBudgetError`
- `enforceGithubActionPromptBudget`
- `githubSafePromptBytes`

Reasoning:

This logic is pure, well-bounded, and already has tests. It should be extracted before GitHub plan/execution modules.

Tests:

- Move prompt-budget tests to import from `src/github/prompt-budget.js`.

### `src/cli/flow-list.js`

Move from `bin/nax.js`:

- `absolutePathOrEmpty`
- `flowListJsonItem`
- `formatFlowListJson`
- `flowListModels`
- `formatFlowDirectory`
- `formatFlowListBox`
- `formatFlowList`
- `workflowPickerHint`
- `workflowPickerLabel`
- `trimWorkflowHint`
- `compactWorkflowDescription`
- `BUNDLED_WORKFLOW_HINTS`
- `AD_HOC_RUN_CHOICE`

Reasoning:

These functions are presentation and picker-label helpers. They are not execution logic.

Tests:

- Move flow-list and picker-label tests to import from `src/cli/flow-list.js`.

### `src/cli/handoff.js`

Move from `bin/nax.js`:

- `normalizeHandoffSourceKind`
- `handoffSourceQuery`
- `formatHandoffSourceKind`
- `formatHandoffSourceLabel`
- `formatHandoffSourceHint`
- `formatLatestHandoffSourceHint`
- `formatCompactHandoffSourceHint`
- `handoffSourcePayload`
- `sourceDisplayTitle`
- `finalWorkflowRun`
- `previewTextForHandoffSource`
- `usageSummaryForHandoffSource`
- `handoffSourceUpdatedAt`
- `handoffSourceDetailTitle`
- `formatHandoffDetailField`
- `handoffSourceDetailLines`
- `formatHandoffSourceDetailBox`
- `handoffSourceMenuOptions`
- `handoffSummaryPath`
- `relativeHandoffPath`
- `findRunStateForHandoff`
- `readHandoffSummary`
- `readSelectedHandoffSource`
- `buildHandoffPrompt`
- `printPostSuccessHandoffHint`
- `copyToClipboard`
- `openHandoffSource`

Reasoning:

There is already `src/handoff-sources.js` and `src/handoff-runner.js`. This extraction should either extend those modules or create `src/cli/handoff.js` as the CLI-specific layer above them. The goal is to consolidate handoff behavior in `src`, not keep half in `bin`.

Tests:

- Move handoff helper tests to import from `src/cli/handoff.js` or existing handoff modules.

### `src/workflow/progress.js`

Move from `bin/nax.js`:

- `DEFAULT_ORCHESTRATOR`
- `STEP_SPINNER_FRAMES`
- `DID_YOU_KNOW_ROTATE_MS`
- `DID_YOU_KNOW_BORDER_COLORS`
- `AGENT_RUNNER_USE_CASES`
- `conciseErrorMessage`
- `submissionFailureSummary`
- `startSubmissionHeartbeat`
- `nextFlavorAt`
- `visibleLength`
- `physicalRowCount`
- `clearRenderedProgressFrame`
- `wrapLine`
- `agentRunUseCaseTitle`
- `formatDidYouKnowLines`
- `formatNonTtyRunStatusMessage`
- `formatUsageLogLine`
- `compactCurrentTask`
- `formatTtyProgressRow`
- `makeStepProgressReporter`

Reasoning:

Progress rendering is large, test-covered, and mostly independent. Moving it reduces the middle of `bin/nax.js` substantially and gives local/GitHub executors a clean import.

Tests:

- Move progress tests to `src/workflow/progress.js`.

### `src/workflow/prompt-delivery.js`

Move from `bin/nax.js`:

- `formatLocalRunResults`
- `compactTextForRetry`
- `localSafePromptBytes`
- `compactLocalTextByBytes`
- `formatCompactLocalRunResults`
- `buildLocalAgentPrompt`
- `renderStructuredForLocalEssentials`
- `blobOffloadDisabled`
- `localPromptByteMetrics`
- `ensureStepBlobOffload`
- `buildSafeCompactLocalPrompt`
- `buildOffloadedRoundResults`
- `buildFullPromptWrapper`
- `ensureFullPromptBlobOffload`
- `prepareLocalPromptDelivery`
- `applyContextFetchClassification`

Reasoning:

This block is a coherent prompt-delivery subsystem. It already leans on `src/prompt-offload.js`, `src/netlify-blobs.js`, and artifact modules. It should become a reusable workflow module before local execution moves.

Tests:

- Move prompt delivery and compaction tests to import from this module.

### `src/github/issue-plan.js`

Move from `bin/nax.js`:

- `ROUND_LABEL_BY_PROMPT`
- `parseCsv`
- `readManualContext`
- `readAutoContext`
- `joinContext`
- `fetchRoundResultsForOptions`
- `readContext`
- `shouldEmbedAllReplies`
- `shouldFetchResults`
- `createIssue`
- `createComment`
- `createPullRequestComment`
- `createDiscussionComment`
- `loadIssueMeta`
- `loadPullRequestMeta`
- `inferModelFromIssueTitle`
- `parseGitHubPullRequestUrl`
- `extractLinkedPullRequest`
- `resolveCommentTarget`
- `printPlan`
- `printCommentPlan`
- `buildPlan`
- `buildCommentPlan`
- `githubResultsToSourceRuns`
- `githubIssueDeliveryKey`
- `buildGithubFullPromptWrapper`
- `optionalNetlifyForBlobOffload`
- `blobOffloadContextError`
- `ensureGithubIssueFullPromptBlobOffload`
- `ensureGithubPlanBlobOffload`
- `buildAndMaybeFallbackPlan`

Reasoning:

This is the issue/comment command core. It should be split before moving `handleIssue` and `handleComment`.

Tests:

- Move comment-target and issue plan tests to import from `src/github/issue-plan.js`.

### `src/cli/issue.js`

Move from `bin/nax.js` after `src/github/issue-plan.js` exists:

- `pickPromptInteractively`
- `selectIssueGroup`
- `chooseInteractively`
- `chooseCommentInteractively`
- `handleIssue`
- `handleComment`

Reasoning:

This is the CLI interaction layer for issue/comment creation. Keep it separate from pure plan building.

Tests:

- Add focused handler smoke tests with injected prompt/gh dependencies where possible.

### `src/workflow/resume.js`

Move from `bin/nax.js`:

- `DEFAULT_RESUME_WINDOW_MS`
- `SUCCESS_COLOR`
- `ERROR_COLOR`
- `MUTED_COLOR`
- `TEAL_COLOR`
- `rgbAnsi`
- `colorText`
- `resumeStatusColor`
- `isAutomaticResumeCandidate`
- `savedStepStatus`
- `resumeStepDecorations`
- `savedAgentStatus`
- `stepResultsSummaryPath`
- `workflowSummaryDisplayPath`
- `resumeLastStepTitle`
- `resumeRunDetailsTitle`
- `formatResumeRunDetails`
- `printResumeRunDetails`
- `findLatestResumableRun`
- `maybeResumeUnfinishedRun`
- `resumeRunById`

Reasoning:

Resume display and selection are their own subsystem. The actual `resumeLocalFlow` and `resumeGithubFlow` should move later with execution modules.

Tests:

- Move resume formatting and latest-resumable tests here.

### `src/github/polling.js`

Move from `bin/nax.js`:

- `commentsAfterGithubPrompt`
- `isGithubFailureResultBody`
- `githubResultRepliesForRun`
- `githubFailureCommentsForRun`
- `githubStatusCommentsForRun`
- `githubPromptCommentForRun`
- `githubRunStatusFromStatusComment`
- `applyGithubStatusCommentToRun`
- `resultsScopedToGithubRuns`
- `findGithubRunnerFailures`
- `GITHUB_POLL_MAX_CONSECUTIVE_FAILURES`
- `GITHUB_ACTION_FAILURE_GRACE_MS`
- `githubTerminalRunCount`
- `githubFailureDetail`
- `githubSavedRunFailures`
- `githubCombinedFailures`
- `normalizeGithubActionTitle`
- `githubActionRunMatchesResult`
- `actionRunCreatedNearPrompt`
- `listRecentGithubActionRuns`
- `loadGithubActionRunFailureLog`
- `githubActionFailureReason`
- `githubActionFailureSummary`
- `findGithubActionRunFailures`
- `waitForGithubStep`
- `githubStepStatus`

Reasoning:

This is the GitHub polling and failure classification engine. It is large but coherent and heavily tested.

Tests:

- Move GitHub polling/failure tests here.

### `src/workflow/local-executor.js`

Move from `bin/nax.js` after prompt delivery, progress, and Netlify project selection are out:

- `addLocalRunLinks`
- `reportTerminalLocalRun`
- `completeLocalStep`
- `executeLocalFlow`
- `resumeLocalFlow`
- `localStepStatus`
- `shouldPollLocalRun`
- `localRetryCandidates`
- `buildCompactLocalPromptForRetry`
- Local archive helpers if they are not moved to a dedicated artifact module.

Reasoning:

Local execution is high-coupling today. Extract only after its helper modules exist. This should make the new module import dependencies instead of carrying them.

Tests:

- Move local execution tests gradually.
- Keep compatibility exports until all callers are migrated.

### `src/workflow/github-executor.js`

Move from `bin/nax.js` after GitHub polling and issue planning are out:

- `completeGithubStep`
- `executeGithubFlow`
- `resumeGithubFlow`
- `shouldPollGithubRun`

Reasoning:

GitHub execution should import prompt-budget, issue-plan, polling, progress, artifact, and run-state modules. Extracting it too early would recreate the monolith.

Tests:

- Move GitHub execution and wait tests gradually.

### `src/cli/run.js`

Move last:

- `handleRun`
- `handleRunEngine`
- `handleAdHocAgentRun`
- `prepareInteractiveFlowRun`
- `pickFlowInteractively`
- `chooseAdHocAgentInteractively`
- `promptForAdHocAgentPrompt`
- `chooseTransportInteractively`
- `chooseSingleRunTransportInteractively`
- `collectFlowOptions`
- `printInteractiveIntroBox`
- `printFlowPlan`
- `printSuccessBox`
- `resolveDryRunTransport`
- `remotePinnedOptions`
- `buildFlowRunContext`
- `contextForRunState`
- `confirmRemoteRunnerCanMissLocalChanges`
- `readRemoteInvisibleGitState`

Reasoning:

This is the top-level orchestration shell. It should become straightforward only after all submodules exist.

Tests:

- Keep CLI dry-run integration tests.
- Add direct handler tests with injected dependencies after the first move.

### `src/commands/handlers.js`

Create after command handlers are in `src/cli/*`:

- Exports the handler map consumed by `src/commands/nax.js`.
- Imports from `src/cli/ci.js`, `src/cli/sync.js`, `src/cli/run.js`, etc.
- Keeps `bin/nax.js` from manually wiring every handler.

Final `bin/nax.js` should look like:

```js
#!/usr/bin/env node

const { buildProgram } = require('../src/commands/program')

if (require.main === module) {
  buildProgram().parseAsync(process.argv).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

module.exports = { buildProgram }
```

## Test Migration Plan

Current tests heavily import `../../bin/nax` and `_private`. That is useful as a compatibility net but bad as a long-term architecture.

For every extraction pass:

1. Move the code into a `src` module.
2. Export it from the `src` module.
3. Update the focused tests to import the `src` module directly.
4. Keep `bin/nax.js._private.<name>` as a compatibility re-export only if other tests still need it.
5. Remove the compatibility re-export when no test or package export uses it.

This turns tests into an extraction guide. When `_private` is empty, `bin/nax.js` can be tiny.

## Type Plan

Use `src/types.js` for cross-module durable shapes only:

- Workflow state.
- Workflow flow and steps.
- Agent run/session/runner artifacts.
- Blob refs.
- Command result/run command abstractions.

Use colocated typedefs for module-local inputs:

- CLI option bags.
- Handler dependency injection.
- Formatting contexts.
- Polling intermediate rows.
- Selection menu options.

Do not add `JsonMap` as a lazy replacement for real shapes when a module owns the fields. Use `JsonMap` only at external/raw boundaries.

## Extraction Order

### Phase 0: Stabilize Current Refactor

Purpose:

Commit or otherwise checkpoint the current command registration extraction before broad deconstruction.

Tasks:

- Confirm `src/commands/nax.js` is the intended location.
- Decide whether to keep the current registration extraction despite total LOC increase from typing.
- Run `npm run check` and `npm test`.
- Commit with the prior `src/workflow-runner.js` simplification and `.gitignore` change if desired.

Exit criteria:

- Working tree has a clean checkpoint or an explicitly accepted dirty baseline.

### Phase 1: Extract Command Framework Glue

Purpose:

Move command option normalization beside command registration.

Files:

- Add `src/commands/options.js`.
- Update `src/commands/nax.js`.
- Shrink `bin/nax.js`.

Expected impact:

- `bin/nax.js`: about `-60` lines.
- Tests begin moving away from `_private`.

### Phase 2: Extract Isolated Command Adapters

Purpose:

Move small handlers with low coupling.

Files:

- Add `src/cli/ci.js`.
- Add `src/cli/sync.js`.
- Potentially add `src/cli/init.js` for `handleInit` and `printInitResult`.

Expected impact:

- `bin/nax.js`: about `-150` to `-250` lines.
- Low risk.

### Phase 3: Extract Pure Display and Selection Modules

Purpose:

Remove large formatting/helper clusters without touching execution.

Files:

- Add `src/netlify/project-selection.js`.
- Add `src/cli/flow-list.js`.
- Add `src/workflow/progress.js`.
- Add `src/workflow/resume.js`.

Expected impact:

- `bin/nax.js`: about `-1200` to `-1700` lines.
- Moderate test migration work.

### Phase 4: Extract GitHub Planning and Prompt Budgeting

Purpose:

Separate issue/comment planning from command handlers and workflow execution.

Files:

- Add `src/github/prompt-budget.js`.
- Add `src/github/issue-plan.js`.
- Add `src/cli/issue.js`.

Expected impact:

- `bin/nax.js`: about `-900` to `-1200` lines.
- Tests for `buildPlan`, `buildCommentPlan`, comment target resolution, and prompt budget move to `src`.

### Phase 5: Extract Handoff CLI Layer

Purpose:

Consolidate handoff behavior with existing handoff modules.

Files:

- Add `src/cli/handoff.js` or extend `src/handoff-sources.js` and `src/handoff-runner.js`.

Expected impact:

- `bin/nax.js`: about `-700` to `-1000` lines.

### Phase 6: Extract Prompt Delivery and Blob Cleanup

Purpose:

Move local prompt delivery and cleanup behavior before extracting executors.

Files:

- Add `src/workflow/prompt-delivery.js`.
- Add `src/workflow/blob-cleanup.js` if cleanup is too large for prompt delivery.

Expected impact:

- `bin/nax.js`: about `-800` to `-1100` lines.

### Phase 7: Extract GitHub Polling and Executors

Purpose:

Move high-coupling runtime execution after its dependencies have real modules.

Files:

- Add `src/github/polling.js`.
- Add `src/workflow/github-executor.js`.
- Add `src/workflow/local-executor.js`.

Expected impact:

- `bin/nax.js`: about `-1500` to `-2200` lines.
- Highest risk phase; use smaller commits inside the phase.

### Phase 8: Extract Run Orchestration and Handler Map

Purpose:

Make `bin/nax.js` a real entrypoint.

Files:

- Add `src/cli/run.js`.
- Add `src/cli/retry.js`.
- Add `src/commands/handlers.js`.
- Optionally add `src/commands/program.js` as the final `buildProgram` owner.

Expected impact:

- `bin/nax.js`: below `300` lines.

### Phase 9: Remove `_private` Bridge

Purpose:

Stop using the executable as a library module.

Tasks:

- Migrate remaining tests from `require('../../bin/nax')._private` to `src`.
- Keep only intentional public exports.
- Confirm package `bin` still works.

Expected impact:

- Cleaner dependency graph.
- `bin/nax.js` becomes stable and small.

## Per-Pass Checklist

Before editing:

- Record `wc -l bin/nax.js`.
- Identify functions being moved.
- Identify tests that currently use those functions through `_private`.
- Write the expected import graph.

During editing:

- Move one cohesive cluster only.
- Add JSDoc typedefs in the destination module.
- Preserve old `bin/nax.js` export names temporarily.
- Update focused tests to import from the destination module.

After editing:

- `node --check bin/nax.js`
- `node --check <new module>`
- `npm run check`
- Focused tests for the moved cluster.
- `npm test` for larger phases.
- Forbidden JSDoc scan on touched files.
- `git diff --check`
- Record line-count delta.

## Forbidden Moves

- Do not create a `src/monolith.js`.
- Do not move `handleRun` before its helper clusters are extracted.
- Do not make `src` import from `bin/nax.js`.
- Do not preserve `_private` forever.
- Do not replace precise typedefs with `JsonMap` just to make TypeScript quiet.
- Do not combine unrelated extractions in one pass.

## Suggested First Implementation Pass

Start with Phase 1 and Phase 2:

1. Move command option normalization into `src/commands/options.js`.
2. Move `handleCi` into `src/cli/ci.js`.
3. Move `handleSync` into `src/cli/sync.js`.
4. Update tests for `handleCi` to import `src/cli/ci.js`.
5. Keep compatibility exports from `bin/nax.js` for now.

This gives immediate shrinkage with low risk, exercises the pattern, and avoids starting with high-coupling workflow execution.

