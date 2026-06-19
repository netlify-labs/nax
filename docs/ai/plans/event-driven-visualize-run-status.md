# Event-Driven Visualize Run Status Plan

## Summary

Move `nax visualize` run updates from derived status polling to a structured
event stream emitted by the workflow runner itself.

The current visualizer already has a useful live path:

- The browser starts a run through `POST /api/workflows/:id/runs`.
- The visualize server starts a child `node bin/nax.js run ...` process.
- The browser opens `EventSource` against `/api/runs/:id/events`.
- stdout/stderr stream over Server-Sent Events.
- The server polls `.nax/workflows/<run-id>/workflow.json` every second and
  emits `step_status` when durable step status changes.

That is a good prototype, but it is not the right long-term source of truth for
realtime UI state. The UI should receive semantic lifecycle events at the exact
point where the runner knows what is happening:

- workflow started
- step started
- agent/model started
- agent/model submitted
- agent/model completed
- agent/model failed/cancelled
- step completed
- workflow completed
- artifact written

The durable `.nax` state should remain the recovery and history source. It
should not be the primary live transport.

## Goals

- Make React Flow cards and model pills reflect real run state in near realtime.
- Keep terminal output streaming exactly as it does today.
- Avoid parsing stdout for semantics.
- Preserve durable `.nax` workflow state as the reload/reconnect source.
- Support reconnecting a browser after a run has started.
- Keep `nax run` useful without the visualizer.
- Make the event protocol testable with unit tests and integration tests.
- Keep the first implementation small enough to ship incrementally.

## Non-Goals

- Do not replace workflow artifacts.
- Do not make the visualizer depend on a browser being connected.
- Do not require a database or daemon.
- Do not remove the existing `.nax` polling fallback until event coverage is
  proven.
- Do not infer agent state from human terminal text.

## Current Behavior

### Run Start

`web/src/App.tsx` starts a real run with:

```text
POST /api/workflows/:id/runs
```

The server creates an in-memory visualize run id and spawns:

```text
node bin/nax.js run <workflow> ...
```

### Live Output

`src/visualize-server.js` captures child stdout/stderr and records events:

```text
started
stdout
stderr
error
exited
```

The browser subscribes using:

```ts
new EventSource(runEventsUrl(response.run.id))
```

This part is event-driven today.

### Semantic Step Status

The server currently derives step status by periodically reading durable run
state:

```text
.nax/workflows/<durable-run-id>/workflow.json
```

Every second it snapshots steps and emits `step_status` if a step changed.

This gives a coarse step-level signal, but it is not enough for exact model pill
state.

## Problems With Current Status Polling

### Polling Lag

The UI can only react after the durable state is written and after the next
poll interval.

### Missing Short-Lived States

States such as `submitting`, `submitted`, or `waiting` can happen between poll
ticks. The UI may never see them.

### Agent-Level Status Is Incomplete

The dry-run simulation can animate each agent independently because it owns a
fake schedule. Real runs only get durable step snapshots. The UI cannot reliably
know that:

- Claude is submitting.
- Gemini submitted.
- Codex is still running.
- one agent failed while others completed.

### stdout Is Human UI, Not Machine API

Parsing terminal output would be brittle. Output formatting should remain free
to change without breaking the visualizer.

### Durable Writes Are Not Lifecycle Events

Artifacts and state files are for recovery and audit. They are not a precise
event bus.

## Target Architecture

Use a two-channel child process contract:

```text
stdout/stderr  -> human terminal stream
fd 3 JSONL     -> structured runner events
```

The visualize server will spawn `nax run` with an extra pipe:

```js
const child = spawn(process.execPath, args, {
  cwd: projectRoot,
  env: {
    ...process.env,
    NAX_EVENT_FD: '3',
    NAX_EVENT_STREAM: 'jsonl',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
})
```

`nax run` will write newline-delimited JSON events to fd 3 when that file
descriptor is available. If it is not available, nothing changes for normal CLI
users.

The visualize server will parse fd 3 JSONL and relay each event over SSE.

```text
nax run lifecycle
  -> emit structured JSONL event on fd 3
  -> visualize server parses event
  -> visualize server records/replays event
  -> browser EventSource receives event
  -> React reducer updates graph cards, model pills, output, and run metadata
```

Durable `.nax` state remains:

- recovery source after refresh
- history source for completed runs
- fallback source if event stream is unavailable
- artifact source for result modals

## Event Transport Choice

### Recommended: fd 3 JSONL

Use a dedicated inherited file descriptor for structured events.

Pros:

- Keeps stdout/stderr human-readable.
- No regex parsing.
- Works with existing child process model.
- Easy to test.
- Backward compatible.
- Does not require sockets or a persistent daemon.
- Can be ignored by normal runs.

Cons:

- Requires small plumbing inside `bin/nax.js` / runner modules.
- Requires care to ensure each event is valid one-line JSON.
- Parent must handle partial chunks and malformed lines.

### Rejected: stdout JSON Sentinels

Example:

```text
::nax-event::{"type":"agent_status",...}
```

Pros:

- Easy to add quickly.
- No extra fd.

Cons:

- Pollutes terminal output.
- Requires escaping and parsing mixed human/machine output.
- Easy to break when output changes.

### Rejected: Filesystem Watcher

Pros:

- Keeps event source durable.
- Avoids child IPC.

Cons:

- Still depends on write timing.
- Harder to make portable and deterministic.
- Does not solve short-lived state.

### Rejected: Local WebSocket From Runner

Pros:

- Bidirectional if needed later.

Cons:

- More moving pieces.
- Requires runner to know about server details.
- Adds reconnection and port management complexity.

## Event Schema

Every event should share a common envelope.

```ts
type NaxRunnerEvent = {
  schemaVersion: 1
  type: string
  at: string
  runId: string
  flowId: string
  stepId?: string
  stepTitle?: string
  agent?: 'claude' | 'gemini' | 'codex' | string
  status?: string
  message?: string
  data?: Record<string, unknown>
}
```

Rules:

- `schemaVersion` is required.
- `type` is required.
- `at` is ISO 8601.
- `runId` is the durable workflow run id when known.
- `flowId` is the workflow id.
- `stepId` is required for step and agent events.
- `agent` is required for agent events.
- Event names are stable API, not display copy.
- Display copy belongs in the UI.

## Event Types

### Workflow Events

```ts
type WorkflowStartedEvent = {
  type: 'workflow_started'
  runId: string
  flowId: string
  status: 'running'
  command?: string[]
  projectRoot?: string
  branch?: string
  transport?: string
}
```

```ts
type WorkflowCompletedEvent = {
  type: 'workflow_completed'
  runId: string
  flowId: string
  status: 'completed' | 'failed' | 'cancelled'
  exitCode?: number | null
  durationMs?: number
}
```

### Step Events

```ts
type StepStatusEvent = {
  type: 'step_status'
  runId: string
  flowId: string
  stepId: string
  stepTitle: string
  status:
    | 'pending'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
}
```

Use `step_status` as the canonical event for step-level state. Specific aliases
such as `step_started` are optional sugar, but the reducer should only need
`step_status`.

### Agent Events

```ts
type AgentStatusEvent = {
  type: 'agent_status'
  runId: string
  flowId: string
  stepId: string
  stepTitle: string
  agent: string
  status:
    | 'pending'
    | 'starting'
    | 'submitting'
    | 'submitted'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'skipped'
  runnerId?: string
  sessionId?: string
  url?: string
  durationMs?: number
  usage?: Record<string, unknown>
  error?: string
}
```

This is the key missing event. The React Flow model pill states should be driven
by this event, not by step-level status.

### Artifact Events

```ts
type ArtifactEvent = {
  type: 'artifact_written'
  runId: string
  flowId: string
  stepId?: string
  agent?: string
  artifactType:
    | 'workflow-summary'
    | 'step-summary'
    | 'agent-result'
    | 'agent-metadata'
    | 'usage'
  path: string
}
```

Artifact events let the UI know when result modals can be loaded or refreshed.

### Log Events

stdout/stderr should remain separate as they are today:

```text
stdout
stderr
```

These are server-side SSE events produced from child stdout/stderr, not runner
JSONL events.

## Status Model

### Step Status

Recommended step lifecycle:

```text
pending -> running -> completed
pending -> running -> failed
pending -> running -> cancelled
pending -> skipped
```

For follow-up or wait states:

```text
running -> waiting -> running -> completed
```

UI mapping:

- `pending`: neutral border
- `running` / `waiting`: yellow border
- `completed`: green border
- `failed`: red border
- `cancelled`: gray/red hybrid or muted red
- `skipped`: muted gray

### Agent Status

Recommended agent lifecycle:

```text
pending -> starting -> submitting -> submitted -> running -> completed
pending -> starting -> submitting -> failed
submitted -> running -> cancelled
```

Netlify API reality:

- `submitting`: local request in flight to create the agent run.
- `submitted`: Netlify accepted the agent run and returned runner/session ids.
- `running`: if the runner can observe remote progress.
- `completed`: final remote result synced.

If the transport cannot observe remote progress after submission, use
`submitted` until completion is known, and display it as an in-progress state.

UI mapping:

- `pending`: visible but muted pill
- `starting` / `submitting` / `submitted` / `running`: yellow pill with subtle
  progress background
- `completed`: green pill
- `failed`: red pill
- `cancelled`: muted red/gray pill
- `skipped`: dimmed pill

## Runner Instrumentation Points

The event emitter should live near workflow execution, not in the visualizer.

### Add a Runner Event Emitter Module

Create `src/runner-events.js`.

Responsibilities:

- Detect `NAX_EVENT_FD`.
- Open a write stream for that fd when available.
- Validate required envelope fields.
- Write one JSON object per line.
- Never throw in normal operation unless explicitly configured for tests.
- Expose a no-op emitter when no fd is configured.

Proposed API:

```js
function createRunnerEventEmitter(options = {}) {
  return {
    enabled: boolean,
    emit(type, payload),
    close(),
  }
}
```

Usage:

```js
const events = createRunnerEventEmitter({
  flowId,
  runId,
})

events.emit('agent_status', {
  stepId: step.id,
  stepTitle: step.title,
  agent: 'claude',
  status: 'submitting',
})
```

### Instrument Workflow Start

When the durable run id is created, emit:

```text
workflow_started
```

This should happen after the durable state path is known, so `runId` is stable.

### Instrument Step Start/End

At the start of each step:

```text
step_status: running
```

After all selected agents for that step finish:

```text
step_status: completed
```

On failure:

```text
step_status: failed
```

### Instrument Agent Submission

Before remote/local agent creation:

```text
agent_status: submitting
```

After Netlify API returns runner/session identifiers:

```text
agent_status: submitted
```

Payload should include:

- `agent`
- `runnerId`
- `sessionId`
- `url`

### Instrument Agent Completion

When result sync confirms completion:

```text
agent_status: completed
```

Payload should include:

- `usage`
- `durationMs`
- `artifactPath`

### Instrument Artifact Writes

When workflow artifacts are written:

```text
artifact_written
```

This should be emitted from artifact writer helpers where paths are known.

## Visualize Server Changes

### Spawn With Event FD

Change `runWorkflowChild()` in `src/visualize-server.js`:

```js
const child = spawn(process.execPath, args, {
  cwd: projectRoot,
  env: {
    ...childEnv,
    NAX_EVENT_FD: '3',
    NAX_EVENT_STREAM: 'jsonl',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
})
```

### Parse JSONL From fd 3

Add a small parser that buffers chunks and emits complete lines.

Rules:

- Ignore blank lines.
- Parse JSON.
- Reject malformed event lines by recording a `runner_event_error`.
- Do not crash the visualize server on malformed child events.
- Include the raw line in debug output only if safe.

### Record and Replay Structured Events

Use the existing in-memory `run.events` list.

For each parsed runner event:

- normalize it
- assign server-side monotonic SSE id
- record it
- write it to all SSE clients

Important: SSE event name should match event type:

```text
event: agent_status
data: {...}
```

### Keep Existing stdout/stderr

No change to terminal output streaming.

### Keep Polling Fallback Temporarily

Keep the current `recordStepStatusEvents()` polling for now, but treat it as a
fallback.

Rules:

- If structured runner events are flowing, they win.
- Polling should not overwrite newer event-driven state with older durable
  state.
- Polling can still fill gaps if a browser attaches late or a child does not
  emit structured events.

Implementation detail:

- Maintain `run.eventProtocolActive = true` after the first valid fd 3 event.
- Continue polling, but dedupe based on current status.
- Prefer event statuses for active run state.

## Frontend Changes

### Add a Live Run State Reducer

Replace scattered state updates with a reducer for live run state.

Shape:

```ts
type LiveRunState = {
  workflowStatus: string
  stepStatuses: Record<string, string>
  agentStatuses: Record<string, Record<string, string>>
  agentRuns: Record<string, Record<string, {
    runnerId?: string
    sessionId?: string
    url?: string
    artifactPath?: string
    error?: string
  }>>
  artifacts: Array<{
    stepId?: string
    agent?: string
    artifactType: string
    path: string
  }>
}
```

Reducer inputs:

- `workflow_started`
- `workflow_completed`
- `step_status`
- `agent_status`
- `artifact_written`
- `exited`

### React Flow Node Mapping

Update graph rendering to merge:

- static workflow graph
- durable run graph, when viewing a past run
- live event state, when an active run exists

Live event state should override static/durable display for the active run.

### Model Pill Behavior

Pills should render all configured agents for a step, but with live status:

- selected agents from the run are active
- unselected agents are visible but dimmed when viewing a filtered run
- active in-progress agents show yellow progress style
- completed agents show green style
- failed agents show red style

### Output Panel

No major changes. stdout/stderr SSE events continue to append to the output
panel.

### Recent Runs

On `workflow_completed` or `exited`, refresh recent runs once so durable history
appears.

Avoid continuous polling of `/api/runs` during the run if SSE is healthy.

## Reconnect and Reload Behavior

### Browser Connects Before Run Starts

Normal path:

- run starts
- EventSource opens
- replay existing events
- receive live events

### Browser Refreshes During Run

Current in-memory events are only available while the visualize server process
is alive.

On refresh:

- UI loads `/api/runs`
- active run is listed from server memory
- UI opens `/api/runs/:id/events`
- server replays `run.events`
- durable `.nax` graph fills in any missing historical state

### Browser Opens After Process Completes

Use durable state:

- `/api/runs` lists durable runs
- `/api/runs/:runId/graph` builds graph from durable workflow state
- `/api/runs/:runId/details` loads artifacts

### Visualize Server Restarts

In-memory events are gone. Durable state remains.

The UI should show final historical state, not live event history.

## Durable State Relationship

The event stream should not replace durable writes.

For every semantic status event, the runner should still write durable state at
reasonable checkpoints.

Durable state should eventually include enough per-agent state for completed
runs:

```json
{
  "steps": [
    {
      "id": "review",
      "status": "completed",
      "runs": [
        {
          "agent": "claude",
          "status": "completed",
          "runnerId": "...",
          "sessionId": "...",
          "links": {
            "sessionUrl": "..."
          }
        }
      ]
    }
  ]
}
```

That lets historical graphs match the live event-driven graph after refresh.

## Error Handling

### Malformed Event JSON

The visualize server should emit:

```text
runner_event_error
```

The UI can show this in the output panel or status bar.

### Unknown Event Type

Record it and ignore for graph state.

This allows forward-compatible runner changes.

### Agent Failure

Emit:

```text
agent_status: failed
```

Then decide step/workflow behavior based on runner semantics:

- if fail-fast, emit `step_status: failed`
- if partial success allowed, keep step running until all required agents settle

### Cancellation

Cancellation should emit:

```text
workflow_status: cancelling
agent_status: cancelled
step_status: cancelled
workflow_completed: cancelled
```

Use best-effort cancellation. If remote agents cannot be cancelled, the UI
should distinguish local workflow cancellation from remote agent continuation.

## Security Considerations

- fd 3 events are local child-process IPC, not exposed directly.
- SSE endpoint already uses unguessable local run ids and is localhost-only.
- Mutating endpoints still require the visualize token.
- Do not include secrets in event payloads.
- Avoid embedding full prompt body in events.
- Artifact paths may be local absolute paths; only expose them through the
  existing local visualizer context.

## Testing Plan

### Unit Tests

Add tests for `src/runner-events.js`:

- no-op when `NAX_EVENT_FD` is absent
- writes valid JSONL when fd stream is supplied
- includes schema version and timestamp
- does not throw on write errors in normal mode

Add tests for visualize server JSONL parser:

- parses complete lines
- buffers partial chunks
- ignores blank lines
- emits `runner_event_error` for invalid JSON

Add tests for frontend reducer:

- step status updates one step
- agent status updates one pill
- completed agent preserves runner/session metadata
- stale polling state does not override newer live state

### Integration Tests

Add a fake child runner mode for visualize tests.

Options:

- `NAX_TEST_RUNNER_EVENTS_FIXTURE=<path>`
- or a test-only command hook injected into `startVisualizeServer()`

The fake runner should emit:

```text
workflow_started
step_status running
agent_status claude submitting
agent_status claude submitted
agent_status claude completed
step_status completed
workflow_completed completed
```

Then assert:

- SSE receives events in order
- UI reducer produces expected statuses
- stdout still streams
- run exits cleanly

### E2E Test

Extend `tests/e2e/visualize.spec.js`:

- start visualize server with fake eventing runner
- open UI
- start workflow
- verify React Flow node turns yellow
- verify model pill turns yellow
- verify model pill turns green
- verify step card turns green
- verify output panel contains streamed stdout

## Implementation Phases

### Phase 1: Event Protocol and Server Plumbing

Deliverables:

- `src/runner-events.js`
- fd 3 JSONL parser in visualize server
- server relays parsed runner events over SSE
- unit tests for parser/emitter

Acceptance:

- Existing stdout/stderr SSE still works.
- Invalid JSONL cannot crash the server.
- Valid synthetic runner events appear as SSE events.

### Phase 2: Runner Lifecycle Instrumentation

Deliverables:

- emit `workflow_started`
- emit `step_status`
- emit `agent_status`
- emit `artifact_written`
- emit `workflow_completed`

Acceptance:

- Real Netlify API run emits per-agent status events.
- Runner works normally without `NAX_EVENT_FD`.
- Durable artifacts remain unchanged or strictly improved.

### Phase 3: Frontend Live State Reducer

Deliverables:

- typed event union
- live run reducer
- EventSource handlers for structured events
- React Flow card status from live reducer
- model pill status from live reducer

Acceptance:

- During a real run, step cards and model pills update without waiting for
  durable polling.
- stdout/stderr still stream.
- final status refreshes recent runs.

### Phase 4: Fallback and Reconnect Hardening

Deliverables:

- dedupe and precedence rules between event state and durable polling
- reconnect replay tests
- browser refresh behavior verified

Acceptance:

- Refresh during active run reconstructs current state from replay plus durable
  graph.
- Visualize server restart still shows completed durable run state.

### Phase 5: Polish and Observability

Deliverables:

- status legend or tooltip copy if needed
- debug toggle for raw runner events
- clear error display for malformed event stream
- documentation in visualize plan / README

Acceptance:

- UI state transitions match dry-run quality for real runs.
- Developers can diagnose event protocol problems quickly.

## Files Likely To Change

```text
src/runner-events.js                new
src/visualize-server.js             fd 3 parsing and SSE relay
src/workflow-runner.js              optional event plumbing for dry-run/run helpers
bin/nax.js                          create/pass runner event emitter into run execution
src/workflow-artifacts.js           artifact_written events
web/src/App.tsx                     EventSource handlers and reducer integration
web/src/types.ts                    event and live state types
web/src/components/WorkflowNode.tsx pill status rendering
tests/unit/runner-events.test.js    new
tests/unit/visualize-server.test.js parser/SSE coverage
tests/e2e/visualize.spec.js         realtime status coverage
```

## Open Questions

- Should `nax run` emit `agent_status: running` after `submitted`, or is
  `submitted` the best representation until completion for Netlify API runs?
- Should GitHub Actions transport emit the same agent lifecycle, or a reduced
  step-only lifecycle until better remote observation exists?
- Should failed optional agents fail the whole step, or can a step be
  `completed_with_warnings`?
- Should artifact paths in events be absolute, relative to run dir, or both?
- Should live event history be persisted to `.nax/workflows/<run-id>/events.jsonl`
  for post-server-restart replay?

## Recommended Decisions

- Use fd 3 JSONL for structured child-to-server events.
- Keep stdout/stderr as human output only.
- Add `agent_status` as the key event for model pills.
- Keep durable polling as fallback during the transition.
- Persist final per-agent status into existing workflow state so completed run
  graphs match live run graphs.
- Do not block initial implementation on persisted event logs.

## Definition of Done

- A real `nax visualize` run updates React Flow step cards from structured
  events.
- Model pills update independently from structured `agent_status` events.
- Terminal output still streams live.
- Completed runs still load from `.nax` artifacts after refresh.
- No UI state depends on parsing stdout.
- Tests cover event emitter, server parsing, frontend reducer, and at least one
  realtime UI flow.
