# Event-Driven Dashboard Run Status Plan

## Summary

Move `nax dashboard` run updates from derived status polling to a structured
event stream emitted by the workflow runner itself.

The current dashboard already has a useful live path:

- The browser starts a run through `POST /api/workflows/:id/runs`.
- The dashboard server starts a child `node bin/nax.js run ...` process.
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

## Implementation Notes

Implemented on 2026-06-19.

The shipped local dashboard now uses a structured child-process event channel
for live workflow state:

- The dashboard server still starts a child `node bin/nax.js run ...` process
  for real runs.
- stdout and stderr remain human terminal output and continue to stream to the
  Output panel.
- The child process receives `NAX_EVENT_STREAM=jsonl` and `NAX_EVENT_FD=3`.
- The runner writes JSONL lifecycle events to file descriptor 3.
- The dashboard server parses fd 3 incrementally, stores valid events in memory,
  relays them to the browser as SSE, and records malformed chunks as diagnostic
  events instead of crashing the run.
- The browser reducer consumes structured events directly. It does not parse
  terminal output for workflow semantics.

Each event uses the common envelope:

```json
{
  "schemaVersion": 1,
  "seq": 12,
  "eventId": "2026-06-19T04-15-02-648Z-do-next:12",
  "type": "agent_status",
  "at": "2026-06-19T04:15:02.660Z",
  "runId": "2026-06-19T04-15-02-648Z-do-next",
  "flowId": "do-next"
}
```

The important event types are:

- `workflow_started`
- `workflow_status`
- `workflow_cancelled`
- `step_status`
- `agent_status`
- `artifact_written`
- `diagnostic`
- `stdout`
- `stderr`
- `exit`

The runner writes the same structured events to:

```text
.nax/workflows/<run-id>/events.jsonl
```

That append-only log is now the recovery, replay, and future polling substrate.
The local SSE endpoint supports cursor replay:

```text
GET /api/runs/<run-id>/events?since=<seq>
```

The diagnostic JSON endpoint exposes the same data without opening an SSE
stream:

```text
GET /api/runs/<run-id>/events.json?since=<seq>
```

`workflow.json` remains the durable milestone and artifact index for completed
and resumed runs. During an active run, live structured events win in the UI.
After process exit or page reload, durable state and `events.jsonl` replay
reconstruct the graph.

Remote model status is intentionally conservative. Netlify API and GitHub
Actions integrations emit every transition the runner can prove. When the remote
service cannot prove actual live execution, the UI should show states such as
`submitted` or `waiting` rather than inventing `running`. Dry-run simulation is
more granular because the simulator controls every model completion.

Cancellation means local orchestration cancellation in this implementation. The
runner marks known submitted remote work as `abandoned` so the UI does not imply
that local cancellation stopped an already-submitted remote Agent Runner job.
Remote cancellation/archive remains separate transport work.

Validation commands used for this implementation:

```bash
npm run check
npm test
node --import tsx --test tests/unit/live-run-reducer.test.ts
npm run dashboard:build
npm run dashboard:smoke
```

Developer debugging workflow:

1. Open the Output diagnostics button for the active run.
2. Inspect `.nax/workflows/<run-id>/events.jsonl`.
3. Use `/api/runs/<run-id>/events.json?since=<seq>` to verify replay behavior.
4. Treat stdout/stderr as human output only; semantic status bugs belong in the
   event emitter, server parser, or frontend reducer.

## Goals

- Make React Flow cards and model pills reflect real run state in near realtime.
- Keep terminal output streaming exactly as it does today.
- Avoid parsing stdout for semantics.
- Preserve durable `.nax` workflow state as the reload/reconnect source.
- Support reconnecting a browser after a run has started.
- Keep `nax run` useful without the dashboard.
- Make the event protocol testable with unit tests and integration tests.
- Keep the first implementation small enough to ship incrementally.

## Non-Goals

- Do not replace workflow artifacts.
- Do not make the dashboard depend on a browser being connected.
- Do not require a database or daemon.
- Do not remove the existing `.nax` polling fallback until event coverage is
  proven.
- Do not infer agent state from human terminal text.
- Do not design hosted Netlify Functions orchestration in this plan. That is a
  related but separate architecture. This plan should, however, make event logs
  reusable by a future polling UI.

## Resolved Design Decisions

The following decisions are locked for this spec:

- The runner emits an immediate `workflow_started` handshake with the durable
  `.nax/workflows/<run-id>` id. The dashboard server may still keep an internal
  temporary id for the `POST /runs` response, but the durable run id becomes the
  canonical id for graph state, event logs, artifact lookup, and historical UI
  links as soon as the handshake arrives.
- Structured events are persisted as append-only JSONL at
  `.nax/workflows/<run-id>/events.jsonl`. The local UI receives events over SSE,
  but the event log is the recovery/debug/polling substrate.
- Remote agent status is best effort. Nax emits every transition it can prove,
  and may show `submitted`/`waiting` when a remote API cannot prove actual live
  execution. The UI must not pretend to know more than the runner knows.
- Runner instrumentation uses an explicit runtime/event context threaded through
  execution functions. Avoid module-level singletons so tests, future functions,
  and concurrent in-process runs can remain sane.
- Retries and compact-prompt retries appear as the same model pill in the live
  graph, with attempt metadata on the events and in artifacts. The graph stays
  readable; details preserve the attempt history.
- The runner emits fine-grained raw statuses. The UI maps them into a smaller
  visual vocabulary.
- Cancellation in this plan means local orchestration cancellation. Remote job
  cancellation/archive is a separate feature because it has API and product
  consequences.
- `events.jsonl` captures full fidelity. `workflow.json` stores durable
  milestone state for recovery and history, not every animation detail.
- During an active run, live events win over durable polling. Durable state wins
  on initial load, reconnect bootstrap, and after a run exits.
- Every structured event has monotonic sequencing so a future hosted UI can poll
  `events.jsonl` with `since=<seq>` instead of using SSE.

## Current Behavior

### Run Start

`src/dashboard/web/src/App.tsx` starts a real run with:

```text
POST /api/workflows/:id/runs
```

The server creates an in-memory dashboard run id and spawns:

```text
node bin/nax.js run <workflow> ...
```

### Live Output

`src/dashboard/server.js` captures child stdout/stderr and records events:

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
to change without breaking the dashboard.

### Durable Writes Are Not Lifecycle Events

Artifacts and state files are for recovery and audit. They are not a precise
event bus.

## Target Architecture

Use a two-channel child process contract:

```text
stdout/stderr  -> human terminal stream
fd 3 JSONL     -> structured runner events
```

The dashboard server will spawn `nax run` with an extra pipe:

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

The dashboard server will parse fd 3 JSONL and relay each event over SSE.

```text
nax run lifecycle
  -> emit structured JSONL event on fd 3
  -> dashboard server parses event
  -> dashboard server records/replays event
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
  seq: number
  eventId: string
  type: string
  at: string
  runId: string
  dashboardRunId?: string
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
- `seq` is required and strictly increases within one `runId`.
- `eventId` is required and stable enough for dedupe. A simple
  `<runId>:<seq>` value is fine for v1.
- `type` is required.
- `at` is ISO 8601.
- `runId` is the durable workflow run id when known.
- `dashboardRunId` is optional and only exists when a local dashboard server
  started the process with a temporary id.
- `flowId` is the workflow id.
- `stepId` is required for step and agent events.
- `agent` is required for agent events.
- Event names are stable API, not display copy.
- Display copy belongs in the UI.
- Payloads must not include prompt bodies, secrets, or large result markdown.
  Events point to artifacts; artifacts contain bulky content.

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

`workflow_started` is the durable id handshake. It must be emitted immediately
after `createRunState()` and the first `saveRunState()`, before the first step
is submitted. The dashboard server uses this event to bind any temporary
dashboard id to the durable run id without scraping stdout.

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
    | 'waiting'
    | 'abandoned'
  runnerId?: string
  sessionId?: string
  attempt?: number
  attemptId?: string
  previousRunnerId?: string
  url?: string
  durationMs?: number
  usage?: Record<string, unknown>
  error?: string
}
```

This is the key missing event. The React Flow model pill states should be driven
by this event, not by step-level status.

Status meaning:

- `pending`: the step has a selected agent, but no work has started.
- `submitting`: Nax is calling the remote submit path.
- `submitted`: the remote system accepted the run and returned an id.
- `waiting`: Nax is waiting for a remote result, but cannot prove active model
  execution.
- `running`: Nax has a positive signal that the remote/local agent is actively
  running.
- `completed`: terminal success.
- `failed`: terminal failure.
- `timeout`: terminal timeout, represented as `failed` visually but preserved in
  raw event data if needed.
- `cancelled`: Nax cancelled local orchestration before or during this agent.
- `abandoned`: Nax stopped watching local orchestration after cancellation, but
  the remote job may still continue.
- `skipped`: the agent was selected out or skipped by step logic.

For retries, the model pill remains the same visual entity. The event carries
`attempt`, `attemptId`, and `previousRunnerId` so details can show the attempt
history without exploding the React Flow graph into multiple nodes.

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

Event log persistence itself is not represented as `artifact_written`; it is the
transport ledger. `artifact_written` is for user-visible files such as workflow
summary, step summary, agent result markdown, agent metadata, usage, and final
result artifacts.

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

The event emitter should live near workflow execution, not in the dashboard.

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

## Dashboard Server Changes

### Spawn With Event FD

Change `runWorkflowChild()` in `src/dashboard/server.js`:

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
- Do not crash the dashboard server on malformed child events.
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

On refresh:

- UI loads `/api/runs`
- active run is listed from server memory when the local dashboard server still
  owns the child process
- UI opens `/api/runs/:id/events`
- server replays in-memory events first when available
- server also replays durable `.nax/workflows/<run-id>/events.jsonl` when a
  durable run id is known
- durable `.nax` graph fills in any missing historical state
- live events continue winning over durable snapshots while the run remains
  active

### Browser Opens After Process Completes

Use durable state:

- `/api/runs` lists durable runs
- `/api/runs/:runId/graph` builds graph from durable workflow state
- `/api/runs/:runId/details` loads artifacts
- `/api/runs/:runId/events?since=<seq>` can replay the persisted event log for
  debugging and future polling clients

### Dashboard Server Restarts

In-memory events are gone. Durable state and `events.jsonl` remain.

The UI should show final historical state by default. A debug view can replay
`events.jsonl` for event-level diagnostics.

### Future Netlify Functions UI

Running the actual orchestration inside Netlify Functions is a separate plan.
That environment will probably not hold a long-lived local SSE connection to the
child process. This plan still prepares for that future by making the event log:

- append-only
- monotonic by `seq`
- small enough to poll
- independent from terminal stdout
- reconstructable into the same live-state reducer the local UI uses

A future functions-backed UI should be able to poll:

```text
GET /api/runs/:runId/events?since=123
```

and feed the returned events into the same reducer used by local SSE.

## Durable State Relationship

The event stream should not replace durable writes.

For every semantic status event, the runner should append to `events.jsonl`.
For durable recovery, the runner should still write `workflow.json` at
reasonable checkpoints:

- after run creation
- after a step starts
- after selected runs are initialized
- after submission returns ids
- after terminal agent results arrive
- after a step completes/fails/cancels
- after workflow completion/failure/cancellation

Do not write `workflow.json` for every transient animation detail. The event log
is the high-fidelity ledger; `workflow.json` is the recovery snapshot.

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

The dashboard server should emit:

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
agent_status: abandoned
step_status: cancelled
workflow_completed: cancelled
```

Use local orchestration cancellation in this plan. If remote agents cannot be
cancelled, mark unobserved/in-flight remote pills as `abandoned`, not
`cancelled`, so the UI does not imply that Netlify or GitHub actually stopped
them. A future remote cancellation/archive feature can upgrade those semantics.

## Security Considerations

- fd 3 events are local child-process IPC, not exposed directly.
- SSE endpoint already uses unguessable local run ids and is localhost-only.
- Mutating endpoints still require the dashboard token.
- Do not include secrets in event payloads.
- Avoid embedding full prompt body in events.
- Artifact paths may be local absolute paths; only expose them through the
  existing local dashboard context.

## Testing Plan

### Unit Tests

Add tests for `src/runner-events.js`:

- no-op when `NAX_EVENT_FD` is absent
- writes valid JSONL when fd stream is supplied
- includes schema version and timestamp
- does not throw on write errors in normal mode

Add tests for dashboard server JSONL parser:

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

Add a fake child runner mode for dashboard tests.

Options:

- `NAX_TEST_RUNNER_EVENTS_FIXTURE=<path>`
- or a test-only command hook injected into `startDashboardServer()`

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

Extend `tests/e2e/dashboard.spec.js`:

- start dashboard server with fake eventing runner
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
- append-only `events.jsonl` writer
- fd 3 JSONL parser in dashboard server
- server relays parsed runner events over SSE
- `/api/runs/:runId/events?since=<seq>` can replay persisted events for durable
  runs
- unit tests for parser/emitter

Acceptance:

- Existing stdout/stderr SSE still works.
- Invalid JSONL cannot crash the server.
- Valid synthetic runner events appear as SSE events.
- Persisted synthetic events can be replayed with `since`.

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
- `workflow_started` appears before the first step submission and contains the
  durable run id.

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
- active-run merge policy: live events win while active, durable wins after exit

Acceptance:

- Refresh during active run reconstructs current state from replay plus durable
  graph.
- Dashboard server restart still shows completed durable run state.
- Persisted event replay never regresses a newer in-memory event.

### Phase 5: Polish and Observability

Deliverables:

- status legend or tooltip copy if needed
- debug toggle for raw runner events
- clear error display for malformed event stream
- documentation in dashboard plan / README

Acceptance:

- UI state transitions match dry-run quality for real runs.
- Developers can diagnose event protocol problems quickly.

## Files Likely To Change

```text
src/runner-events.js                new
src/runner-event-log.js             new append-only events.jsonl helpers
src/dashboard/server.js             fd 3 parsing and SSE relay
src/workflow-runner.js              optional event plumbing for dry-run/run helpers
bin/nax.js                          create/pass runner event emitter into run execution
src/workflow-artifacts.js           artifact_written events
src/dashboard/web/src/App.tsx                     EventSource handlers and reducer integration
src/dashboard/web/src/types.ts                    event and live state types
src/dashboard/web/src/components/WorkflowNode.tsx pill status rendering
tests/unit/runner-events.test.js    new
tests/unit/runner-event-log.test.js new
tests/unit/dashboard-server.test.js parser/SSE coverage
tests/e2e/dashboard.spec.js         realtime status coverage
```

## Implementation Decisions

- Use fd 3 JSONL for structured child-to-server events.
- Keep stdout/stderr as human output only.
- Add `agent_status` as the key event for model pills.
- Keep durable polling as fallback during the transition.
- Persist final per-agent status into existing workflow state so completed run
  graphs match live run graphs.
- Persist live event history to `.nax/workflows/<run-id>/events.jsonl` from the
  first implementation.
- Use `submitted` or `waiting` rather than fake `running` when a remote API
  cannot prove live execution.
- Give GitHub Actions the same event shape as Netlify API, but allow fewer
  statuses when GitHub cannot expose equivalent lifecycle detail.
- Failed agent handling follows existing runner semantics first. Do not invent
  `completed_with_warnings` in this plan unless runtime failure policy work adds
  that state later.
- Artifact events should include both a run-relative path for portability and an
  absolute path for the local dashboard open/copy actions.

## Definition of Done

- A real `nax dashboard` run updates React Flow step cards from structured
  events.
- Model pills update independently from structured `agent_status` events.
- Terminal output still streams live.
- Completed runs still load from `.nax` artifacts after refresh.
- `events.jsonl` exists for real runs and can be replayed with `since`.
- No UI state depends on parsing stdout.
- Tests cover event emitter, server parsing, frontend reducer, and at least one
  realtime UI flow.
