# Spec - Dashboard `Run a followup`

> Status: IMPLEMENTED.
> Scope implemented: enable `Run a followup` in `RunDetailsModal` and add the supporting backend/API path.
> Product shape: one compose surface with two modes: **Follow up on existing agent results** and **Start fresh agent runner**.

---

## Summary

The run-details modal already has a `Send to next agent` action with copy affordances. The missing action is a real follow-up composer.

The feature should support both:

- **Follow up on existing agent results**: submit a new follow-up session to a previous runner thread when a compatible runner exists.
- **Start fresh agent runner**: start one or more new agent runner threads seeded with selected result artifacts.

The user must always provide new instructions. This feature must not submit a default "continue" prompt with no user intent.

The composer must also let the user choose which artifacts to include. Not every workflow has a clean final summary, and "send the latest results" is often not precise enough.

## Implementation Notes

The shipped implementation adds explicit follow-up targets and artifacts to run details, a token-protected `POST /api/runs/:id/followups` endpoint, and a `RunFollowupModal` opened from **Send to next agent** -> **Run a followup**.

The endpoint submits through the Netlify API transport and returns `202` after remote acceptance. It does not wait for completion. A compatible selected model continues the matching prior runner thread; additional selected models become fresh seeded runner threads. Fresh runner submissions are persisted as one-step pseudo-workflow runs so the dashboard can open them from Recent runs. If remote submission succeeds but local persistence fails, the response remains successful and includes `warnings[]`.

The browser composer requires a non-empty user prompt, defaults to the server-selected target and artifacts, uses the existing prompt delivery/blob policy for selected context, shows mixed follow-up/fresh submission plan lines, and refreshes/navigates after submission. GitHub transport support, wait-for-completion behavior, and a separate follow-up ledger remain non-goals for this MVP.

---

## Interview Decisions

### Required user prompt

Submitting requires non-empty user instructions. Prior artifacts are context only; they are not a prompt by themselves.

### Default target

When opened from the completed workflow card, default to the last meaningful result target:

1. Final step summary/result if present.
2. Workflow summary if present.
3. Latest completed agent session result.

The user can change this target before submitting.

### Context handling

Selected artifacts are included by default. The follow-up prompt should say, in effect:

- follow the user's new instructions
- use the existing thread context if available
- if the previous context is missing or incomplete, fetch/read the attached context payload

For small context packages, inline the selected artifact markdown. For large context packages, use the existing prompt blob/offload mechanism or a shared wrapper around it.

### Multi-model behavior

The model used by the selected previous result is selected by default.

If the user selects multiple models:

- the model with a compatible existing runner can submit a true follow-up session
- additional models start fresh runner threads seeded with the selected artifacts

Do not try to submit multiple model follow-ups into one existing runner thread.

If the user changes from the previous model to another single model and there is no matching previous runner for that model, treat it as a fresh seeded runner.

### Target SHA

Default to the original workflow target SHA for both modes, because the selected results were generated against that snapshot. Show a secondary option to use current `HEAD` later; the MVP can display the original target only.

### Graph behavior

Append a visual follow-up node only when that submitted run/session is persisted into the current workflow run state. Do not fake graph state.

Fresh one-off agent runs should become durable single-step pseudo-workflow runs so the dashboard can show a one-node graph and reuse existing run details surfaces.

### Post-submit UX

On accepted submission:

- close the composer
- show a Mantine notification with remote links and local artifact path when available
- refresh run details/graph in the background
- if a fresh pseudo-workflow was created, navigate/open that run

### Persistence failure after remote acceptance

If Netlify accepts the run/session but local artifact persistence fails, return success with `warnings[]` and include the remote link. Do not fail the whole request after the expensive remote operation already happened.

---

## Existing Code Facts

### Handoff sources

`src/handoff-sources.js` discovers completed artifact sources:

- workflow summaries from `.nax/workflows/<run-id>/artifacts/summary.md`
- agent runner summaries from `.nax/agent-runners/<runner-id>/summary.md`
- agent session summaries/results from `.nax/agent-sessions/<session-id>/summary.md` or `result.md`

It returns `summaryText`, `summaryPath`, status, title, and source metadata. `displayPath` is attached by `readHandoffSource`, not by the list helpers, so server/UI code should compute display paths explicitly where needed.

`runnerSessionHandoffText` lives in `src/handoff-sources.js` and is currently private. Export it if the follow-up endpoint needs runner-level combined context directly.

### CLI handoff behavior

`bin/nax.js` contains the existing handoff behavior:

- `handoffSourceMenuOptions`
- `readSelectedHandoffSource`
- `buildHandoffPrompt`
- `runFreshHandoffAgent`
- `runSingleNetlifyAgent`

Only `handoffSourceMenuOptions` and `buildHandoffPrompt` are currently exported through the `_private` test surface. `readSelectedHandoffSource`, `runFreshHandoffAgent`, and `runSingleNetlifyAgent` are module-private. Implementation must extract or wrap behavior deliberately.

### Netlify follow-up session submission

`src/local-runner.js` already supports follow-up sessions:

- `createAgentSession`
- `createAgentSessionAsync`
- `submitLocalAgentRun` with `run.existingRunnerId`

`createAgentRunnerSession` is not a JS function; it is the Netlify CLI API command invoked by `createAgentSession*`.

The real reuse surface is:

```js
submitLocalAgentRun({
  run: {
    existingRunnerId,
    promptText,
    agent,
    // ...
  },
  // ...
})
```

### Run details

`src/dashboard/shared/run-details.js` returns every rendered section for a workflow run, including agent session sections with:

- `agent`
- `runnerId`
- `sessionId`
- `status`
- `links`
- `absolutePath`
- `markdown`

This is enough for display, but the API should add explicit follow-up target/artifact objects so the UI does not infer validity from rendered labels.

### Blob/offload support

The repo already has prompt blob/offload infrastructure:

- `src/netlify-blobs.js`
- `src/prompt-offload.js`
- `src/blob-ref-registry.js`
- local prompt delivery logic in `bin/nax.js`

This feature should reuse that policy where possible. The composer should not create a separate ad hoc large-context mechanism.

---

## User Experience

### Entry point

In `RunDetailsModal`, keep the existing `Actions` area under the timeline:

- `Copy file path of results output`
- `Copy results as markdown`
- `Run a followup`

`Run a followup` opens a composer modal. It never submits directly from the menu.

### Composer title

Use a title that reflects the default target:

```text
Send results to an agent
```

Subtitle examples:

```text
Follow up on Review / Codex
Start fresh agent runner with Review results
```

### Modes

Use a segmented control or equivalent:

- `Follow up on <Agent> Results`
- `Start fresh agent runner`

If multiple models are selected and some will start fresh runners, show a concise execution summary before submit:

```text
Codex: follow-up session
Claude: fresh runner
Gemini: fresh runner
```

### Required prompt field

The main textarea is required.

Label:

```text
What should the next agent do?
```

Placeholder:

```text
Implement the highest-confidence fixes from the selected review results.
```

Validation:

- trim whitespace
- disabled submit if empty
- server also rejects empty prompt

### Artifact picker

The modal needs an artifact picker because workflows do not always have a clean final summary.

Default visible artifact types:

- workflow summary
- step summaries
- agent result markdown
- agent runner summary
- agent session result/summary

Advanced artifact types behind a disclosure:

- metadata JSON
- usage JSON
- attempt markdown
- prompt delivery/blob debug files

The default selection should be the last meaningful result target:

1. final step summary/result
2. workflow summary
3. latest completed agent session result

The user can select multiple artifacts. Selected artifacts are packaged as labeled sections in one context package. If the package is too large, offload the package as one blob rather than creating one blob per artifact.

### Model selection

Show model chips for the supported agents:

- Claude
- Gemini
- Codex

Default:

- selected prior agent for `Follow up on <Agent> Results`
- previously selected workflow models or Codex fallback for `Start fresh agent runner`

When multiple models are selected:

- compatible existing runner for the prior model uses `continue-runner`
- other models use fresh seeded runner submissions

### Metadata preview

Show a compact read-only metadata block before submit:

- target SHA
- branch
- source workflow run ID
- selected runner ID when present
- selected session ID when present
- selected artifact count
- submission plan by model

Do not show full generated prompt by default. A later enhancement can add a preview disclosure.

### Submit behavior

Button text:

- `Send follow-up`
- `Start agent runner`
- `Send to agents` when multiple models are selected

After accepted:

- close composer
- show Mantine notification
- include Netlify run/session link when available
- include local artifact link/path when available
- refresh details/graph

---

## API

### Endpoint

```http
POST /api/runs/:runId/followups
```

This is a mutation and must call `assertToken`, matching existing mutation routes.

### Request

```ts
type FollowupMode = 'follow-up-thread' | 'fresh-runner'

type FollowupArtifactKind =
  | 'workflow-summary'
  | 'step-summary'
  | 'agent-result'
  | 'runner-summary'
  | 'session-result'
  | 'metadata-json'
  | 'usage-json'
  | 'attempt-markdown'
  | 'blob-debug'

type FollowupModelSubmissionMode = 'continue-runner' | 'fresh-runner'

type RunFollowupRequest = {
  mode: FollowupMode
  prompt: string
  models: string[]
  source: {
    workflowRunId: string
    targetId?: string
    sectionId?: string
    stepId?: string
    runnerId?: string
    sessionId?: string
  }
  artifacts: Array<{
    id: string
    kind: FollowupArtifactKind
  }>
  target?: {
    sha?: string
    branch?: string
    source?: 'workflow-target' | 'current-head'
  }
}
```

Notes:

- `prompt` is required.
- `models` must contain at least one supported model.
- `artifacts` may be empty only if mode is `follow-up-thread` and the user intentionally chooses no context; the UI should still default to selected artifacts.
- `target.source` defaults to `workflow-target`.

### Response

```ts
type RunFollowupResponse = {
  followup: {
    id: string
    status: 'submitted'
    sourceWorkflowRunId: string
    target: {
      sha?: string
      branch?: string
      source: 'workflow-target' | 'current-head'
    }
    context: {
      artifactCount: number
      delivery: 'inline' | 'blob' | 'none'
      blobRef?: Record<string, unknown>
    }
    submissions: Array<{
      id: string
      mode: FollowupModelSubmissionMode
      agent: string
      runnerId: string
      sessionId: string
      status: 'submitted'
      links: {
        agentRunUrl?: string
        sessionUrl?: string
      }
      artifacts?: {
        workflowRunId?: string
        sessionDir?: string
        runnerDir?: string
        summaryPath?: string
      }
      warnings?: string[]
    }>
    warnings?: string[]
  }
}
```

The endpoint returns `202` after remote acceptance. It does not wait for terminal completion.

---

## Run Details Extensions

Extend `buildRunDetails(runState)` to include explicit follow-up data.

```ts
type RunFollowupTarget = {
  id: string
  kind: 'workflow-summary' | 'step-summary' | 'agent-result' | 'runner-summary' | 'session-result'
  label: string
  agent?: string
  stepId?: string
  stepTitle?: string
  runnerId?: string
  sessionId?: string
  status: string
  path: string
  absolutePath: string
  links: {
    agentRunUrl?: string
    sessionUrl?: string
  }
  defaultMode: 'follow-up-thread' | 'fresh-runner'
  isDefault: boolean
}

type RunFollowupArtifact = {
  id: string
  kind: FollowupArtifactKind
  label: string
  path: string
  absolutePath: string
  sizeBytes: number
  defaultSelected: boolean
  advanced: boolean
  source?: {
    stepId?: string
    runnerId?: string
    sessionId?: string
  }
}
```

Target ordering:

1. default target first
2. step summaries in workflow order
3. session results in workflow order
4. workflow summary
5. runner/session summary alternatives

Artifact ordering:

1. default selected human output
2. other human outputs
3. advanced artifacts

Do not require the frontend to parse markdown links to discover artifacts.

---

## Backend Design

### Shared runner module

Create a shared module, likely `src/handoff-runner.js` or `src/agent-handoff-run.js`.

It should expose non-interactive operations:

```js
buildHandoffPrompt({ instructions, summaryPath, summaryText })
buildFollowupPrompt({ instructions, contextPackage, delivery })
submitFreshAgentRunner({ ... })
submitFollowupSession({ existingRunnerId, ... })
submitFollowupPlan({ submissions, ... })
```

Do not import `bin/nax.js` from the server.

Extraction requirement:

- use injected `logger`
- use injected `reporter`
- use injected or optional progress hooks
- CLI passes current terminal logger/reporter
- server passes no-op/collector hooks

Before moving behavior, add characterization coverage around the new seam. `runSingleNetlifyAgent` currently has terminal I/O and progress behavior mixed into submission logic.

### Context package assembly

Server builds context from local files. Do not trust frontend-provided markdown.

For each selected artifact:

1. Resolve artifact ID against `details.followupArtifacts`.
2. Ensure `absolutePath` stays under project `.nax`.
3. Read the file.
4. Add a labeled section:

```md
## Artifact: <label>

Source: <relative path>

<contents>
```

The combined context package is then delivered according to the prompt size policy:

- `none` if no artifacts selected
- `inline` if safely under prompt budget
- `blob` if too large and Netlify blob context is available
- fail before submit if too large and no safe delivery path exists

For follow-up thread mode, the prompt can say:

```md
Use the existing conversation context when available. If needed, use the attached prior-results context to recover details from the source workflow.
```

### Submission plan

The server resolves the requested models into concrete submissions.

For selected target with existing runner:

- if model matches target agent, submission mode is `continue-runner`
- if model does not match target agent, submission mode is `fresh-runner`

For selected target without existing runner:

- all models are `fresh-runner`

For multiple models:

- at most one true follow-up submission per compatible existing runner/model pair
- remaining models become fresh seeded runners

### Fresh runner pseudo-workflow

Fresh one-off agent runs should create a durable single-step pseudo-workflow run.

Purpose:

- one-node React Flow graph
- regular Recent Runs entry
- regular run-details modal
- no separate dashboard view model

Suggested run ID:

```text
<timestamp>-agent-run
```

Suggested flow title:

```text
Agent Run
```

Suggested step title:

```text
Fresh Agent Runner
```

When a fresh runner is launched from workflow results, store source metadata on the run/session artifact:

```json
{
  "type": "dashboard-followup",
  "mode": "fresh-runner",
  "sourceWorkflowRunId": "...",
  "sourceTargetId": "...",
  "sourceArtifactIds": ["..."]
}
```

### Follow-up graph append

Only append a follow-up node to the current workflow graph if the submitted follow-up is persisted into that workflow run state.

For accepted submissions that are not represented by a new local workflow node:

- return submitted links
- show notification
- refresh current details
- do not fake a graph node

### Artifact persistence

For accepted submissions:

- persist normal agent session/runner artifacts when enough data is available
- status may be `submitted`
- later sync/refresh can update to terminal status

If persistence fails after Netlify accepts:

- return `202`
- include `warnings[]`
- show warning notification
- include remote link

---

## Frontend Design

### API client

Add to `src/dashboard/web/src/api.ts`:

```ts
export async function startRunFollowup(
  runId: string,
  request: RunFollowupRequest,
): Promise<RunFollowupResponse>
```

### Types

Add to `src/dashboard/web/src/types.ts`:

- `RunFollowupTarget`
- `RunFollowupArtifact`
- `RunFollowupRequest`
- `RunFollowupResponse`

Extend `RunDetailsResponse.details` with:

- `followupTargets`
- `followupArtifacts`

### Component split

Add:

```text
src/dashboard/web/src/components/RunFollowupModal.tsx
```

Props:

```ts
type RunFollowupModalProps = {
  opened: boolean
  onClose: () => void
  run: DashboardRun
  details: RunDetails
  activeEntry?: TimelineEntry | null
  onSubmitted?: (response: RunFollowupResponse) => void
}
```

`RunDetailsModal` responsibilities:

- own modal open/close state
- pass details/current entry to composer
- refresh details after submit
- keep existing copy menu actions unchanged

`RunFollowupModal` responsibilities:

- initialize target/artifact/model defaults
- validate prompt/model/artifact choices
- submit request
- display inline validation errors

### Notifications

Use Mantine notifications if already installed. If not, add the small Mantine notifications dependency/config in the app shell.

Success notification:

```text
Follow-up submitted
```

Include action links when possible:

- Open Netlify run/session
- Open local result artifact
- Open new run view for fresh pseudo-workflow

Warning notification:

```text
Follow-up submitted, but local artifact persistence needs attention.
```

---

## Validation

Server-side:

- `prompt.trim()` required
- known mode required
- at least one model required
- model names normalized against supported agents
- selected workflow run must exist
- artifact IDs must resolve against server-discovered artifacts
- artifact paths must stay under `.nax`
- `continue-runner` requires a compatible `runnerId`
- fresh runners require Netlify site/env context
- target SHA defaults to workflow target

Client-side:

- disable submit while prompt is empty
- disable submit with no models
- show clear validation when no artifact/context is selected
- show submission plan before submit

---

## Testing

Use the repo's existing `node:test` + `tsx` pattern. Relevant current guards:

- `tests/unit/handoff-sources.test.js`
- `tests/unit/local-runner.test.js`
- `tests/unit/dashboard-server.test.js`
- `tests/unit/flow-execution.test.js`
- `tests/unit/workflow-artifacts.test.js`

### Unit tests

- run details returns stable follow-up targets/artifacts
- default target prefers final step summary, then workflow summary, then latest session result
- artifact resolver rejects paths outside `.nax`
- context package preserves selected artifacts as labeled sections
- large context package uses blob/offload path
- empty prompt is rejected
- model plan maps matching model to `continue-runner`
- additional selected models become fresh runners
- persistence failure after remote acceptance returns warnings

### Server tests

- `POST /api/runs/:id/followups` rejects missing token
- rejects unknown run
- rejects empty prompt
- rejects invalid artifact ID
- rejects unsafe artifact path
- submits follow-up with `existingRunnerId`
- submits fresh runner for non-matching additional model
- returns `202` with submissions array

### Frontend tests

- menu opens composer
- prompt is required
- artifact defaults are selected
- model default matches selected previous result
- multiple model selection shows mixed submission plan
- success closes modal and emits notification callback

### Integration tests

- fake Netlify CLI `api createAgentRunnerSession` response
- fake fresh runner response
- verify persisted submitted artifacts where implemented
- verify pseudo-workflow appears in run list for fresh one-off run

---

## Implementation Stages

### Stage 1 - run details contracts

- Add `followupTargets`.
- Add `followupArtifacts`.
- Add target/artifact unit tests.
- No UI behavior change.

### Stage 2 - shared handoff runner module

- Extract prompt/context helpers behind DI.
- Keep CLI behavior unchanged.
- Add characterization tests before moving terminal-wired behavior.
- Export only source modules needed by server.

### Stage 3 - follow-up API

- Add `POST /api/runs/:id/followups`.
- Implement validation.
- Implement artifact context package.
- Implement prompt delivery policy.
- Implement submission plan.
- Implement true follow-up and fresh runner submissions.
- Return `202` on acceptance with warnings if persistence fails.

### Stage 4 - composer UI

- Add `RunFollowupModal`.
- Wire `Run a followup` menu item.
- Add artifact picker.
- Add model chips.
- Add submission plan preview.
- Add notifications.

### Stage 5 - graph/run polish

- Create pseudo-workflow view for fresh single agent runs.
- Append real follow-up graph nodes only when persisted in run state.
- Add navigation/open behavior after fresh pseudo-workflow creation.

---

## Non-Goals For MVP

- Waiting for terminal completion in the HTTP request.
- GitHub transport support for the dashboard follow-up action.
- Full generated prompt preview.
- A workflow-level `followups.jsonl` ledger with no reader.
- Cross-model follow-up in the same existing runner thread unless Netlify behavior is proven safe.

---

## Acceptance Criteria

- `Run a followup` is enabled for completed runs with usable artifacts.
- The user must provide instructions before submitting.
- The composer defaults to the last meaningful result target.
- The user can choose artifacts to include.
- The default model matches the selected previous result.
- Selecting multiple models produces one compatible follow-up session plus fresh seeded runners for additional models.
- The endpoint submits and returns `202` after remote acceptance.
- The endpoint does not wait for completion.
- Fresh one-off runs are represented as one-step pseudo-workflow runs.
- Existing CLI handoff behavior remains unchanged.
- Remote acceptance plus local persistence failure returns success with warnings, not a false failure.
