# NAX Dashboard Routing Plan

## Goal

Make dashboard navigation explicit, shareable, and mode-aware so workflow definitions and concrete runs never reuse ambiguous click behavior.

Today `App.tsx` owns workflow selection, run selection, selected step, and modal state as disconnected React state. That made a fresh workflow graph behave like a loaded run after details-modal behavior was added. The routing model should encode the user's intent directly:

- Workflow definition routes are for configuring a workflow before it runs.
- Run routes are for inspecting a concrete job and its persisted/live details.
- Prompt routes are for inspecting workflow prompt inputs without requiring local-only UI state.

TanStack Query is now installed and already owns most dashboard server state through `QueryClientProvider`, dashboard query keys, query hooks, mutation hooks, and cache update helpers. The routing plan should build on that instead of introducing Router and server-state migration as one combined change.

The dashboard should also be designed as a portable web UI. It must run in three environments:

- Local CLI dashboard served by `nax dashboard`.
- Desktop companion app that embeds or talks to the same dashboard UI.
- Hosted web app that calls a backend API to browse workflows and start/inspect agent runs.

Routing and API design should avoid local-machine assumptions unless those assumptions are explicitly exposed as backend capabilities.

## Current Problem

The dashboard has two different user workflows that look visually similar:

1. Prepare a workflow to run.
   - Click a workflow in the left sidebar.
   - Click a step card to inspect its prompt/config in the right sidebar.
   - Open the workflow prompt sequence to review the exact prompt inputs.
   - Click an agent pill to toggle that model on or off.
   - Click Dry run or Run.

2. Inspect a loaded job.
   - Click a recent run.
   - Click a step card to open step details.
   - Click an agent pill to open model-specific details.
   - Resume, follow up, or review output.

Before the route spine, the graph inferred which behavior to use from local state like `selectedRunId` and `activeRun`. That was workable as a short-term fix, but fragile because route-like state was spread across several hooks.

The codebase stabilized the worst interaction bug with an explicit graph mode:

- `WorkflowCanvas` receives `mode: 'configure' | 'inspect'`.
- `WorkflowNode` receives `agentInteraction: 'toggle' | 'view-result'` through node data.
- Fresh workflow cards select a step for `Inspector`.
- Fresh workflow agent pills toggle model selection.
- Loaded run cards and agent pills open `RunDetailsModal`.

The route spine addresses the architectural issue by moving workflow id, run id, selected step, prompt modal state, and run details modal state into URL-backed route state.

`WorkflowPromptModal` is also route-backed because prompt browsing answers "what exactly will this workflow send to the agents?" and should be linkable in local, desktop, and hosted web contexts.

## Routing Decision

Adopt `@tanstack/react-router` for the dashboard shell.

Use TanStack Router narrowly at first. It should own URL-addressable navigation state, not server cache, form state, or every modal. TanStack Query should continue to own server state and cache invalidation. The immediate value of Router is type-safe route params and a single source of truth for dashboard mode.

Route prompt inspection. Do not keep `WorkflowPromptModal` as permanently local-only UI state. It is read-only, identity-based, and useful to share/debug. The optional run context modal should stay local-only because it contains transient draft input.

## Deployment Model

The same React dashboard should run against a dashboard API regardless of where the UI is hosted.

### Local CLI

- UI origin is usually the local dashboard server.
- API base can remain same-origin (`/api/...`).
- Session token bootstrap via URL query can continue during migration.
- Local-only capabilities may be available, such as opening a prompt file in the user's editor.

### Desktop Companion

- UI may be embedded in a desktop shell or loaded from a local server.
- API base may be same-origin, loopback, or provided by the companion shell.
- Desktop shell may provide privileged local capabilities, but those capabilities should still be surfaced through explicit API/capability flags rather than assumed by React components.

### Hosted Web App

- UI is served from a real web origin.
- API may be same-origin or cross-origin behind authenticated endpoints.
- Agent runs are started by backend APIs, not by local shell access.
- Local filesystem operations must be unavailable or replaced by web-safe alternatives such as "copy path", "download artifact", or "open hosted artifact".
- Authentication must not depend on local URL tokens long-term; hosted mode needs durable app auth and CSRF/CORS decisions at the API boundary.

### API Boundary Requirements

- Keep `src/dashboard/web/src/api.ts` as a typed transport layer, but allow a configurable API base URL for hosted/desktop deployments.
- Keep route components and UI components calling Query hooks/mutations, not raw `fetch`.
- Extend `/api/health` or add `/api/capabilities` so the UI can branch on capabilities:
  - `canStartRuns`
  - `canDryRun`
  - `canOpenLocalFiles`
  - `canStreamRunEvents`
  - `requiresAuth`
  - `deploymentMode: 'local' | 'desktop' | 'web'`
- Any button that depends on local filesystem behavior, such as `ArtifactActions` opening a local file, must be capability-gated.
- Prompt and run artifacts should be represented by stable artifact identifiers or URLs when possible, not only absolute local paths.

## TanStack Query Baseline

Already present:

- `src/dashboard/web/src/query-client.ts` creates `dashboardQueryClient`.
- `src/dashboard/web/src/main.tsx` wraps the app in `QueryClientProvider`.
- `src/dashboard/web/src/query-keys.ts` defines stable dashboard query keys.
- `src/dashboard/web/src/queries/dashboard-queries.ts` wraps health, workflows, workflow graph, runs, run graph, and run details reads.
- `src/dashboard/web/src/queries/dashboard-mutations.ts` wraps dry-run, run start, cancellation, follow-up, and human-review mutations.
- `src/dashboard/web/src/queries/dashboard-cache.ts` centralizes run upserts and invalidations.
- `src/dashboard/web/src/queries/query-event-bridge.ts` patches or invalidates query cache from live runner events.

Router should not replace this. Router should select which query is enabled and which cached entity the shell renders.

## Route Model

```txt
/
/workflows
/workflows/$workflowId
/workflows/$workflowId/steps/$stepId
/workflows/$workflowId/prompts
/workflows/$workflowId/prompts/$stepId

/runs
/runs/$runId
/runs/$runId/details
/runs/$runId/steps/$stepId
/runs/$runId/steps/$stepId/agents/$agent
```

## Route Semantics

`/workflows/$workflowId`

- Renders a workflow definition graph from `useWorkflowGraphQuery(workflowId)` / `dashboardQueryKeys.workflowGraph(workflowId)`.
- Graph mode is `configure`.
- Card click selects the step for `Inspector`.
- Agent pill click toggles that model on or off.
- Details modal must not open.

`/workflows/$workflowId/steps/$stepId`

- Same as workflow definition mode.
- The right inspector shows the selected step.
- This replaces local-only `selectedNode` for workflow definition browsing.

`/workflows/$workflowId/prompts`

- Opens `WorkflowPromptModal` for the workflow prompt sequence.
- Uses the first prompt entry as the active prompt.
- Modal close navigates back to `/workflows/$workflowId`.
- Prompt content comes from the workflow graph/query response, not direct browser filesystem reads.

`/workflows/$workflowId/prompts/$stepId`

- Opens `WorkflowPromptModal` directly to the selected step prompt.
- Replaces local-only `promptModalStepId`.
- Modal timeline selection should navigate within the prompt route so back/forward works for prompt step changes.
- Modal close navigates back to `/workflows/$workflowId/steps/$stepId` if the user came from a step route, otherwise `/workflows/$workflowId`.

`/runs/$runId`

- Renders a run graph from `useRunGraphQuery(runId)` / `dashboardQueryKeys.runGraph(runId)`.
- Graph mode is `inspect`.
- Card click opens step details.
- Agent pill click opens model details.
- Recent run selection navigates here.

`/runs/$runId/details`

- Opens `RunDetailsModal` at the workflow summary.
- Preserves the existing Recent Runs behavior where clicking the run title opens saved results, while keeping the modal owned by Router rather than `RecentRuns` local state.
- Modal close navigates back to `/runs/$runId`.

`/runs/$runId/steps/$stepId`

- Opens `RunDetailsModal` for the selected step.
- The underlying graph and recent runs remain visible.
- Modal close navigates back to `/runs/$runId`.

`/runs/$runId/steps/$stepId/agents/$agent`

- Opens `RunDetailsModal` directly to the selected step/agent.
- Modal close navigates back to `/runs/$runId`.

## State Ownership

Router-owned state:

- Selected workflow id.
- Selected run id.
- Selected workflow step id.
- Selected workflow prompt step id.
- Selected run details step id.
- Selected run details agent id.

React-owned state:

- Dry-run options.
- Live run reducer state.
- Context modal draft.
- Event diagnostics modal state.
- Splitter sizing and UI-only controls.

Query-owned state:

- Health response.
- Workflow list.
- Workflow graph by workflow id.
- Run list.
- Run graph by run id.
- Run details by run id.
- Mutating run operations and cache invalidation.

Legacy local mirrors removed:

- `graph` now derives from `useWorkflowGraphQuery` or `useRunGraphQuery`.
- `selectedWorkflowId` derives from route params or the loaded run graph workflow.
- `selectedRunId` derives from route params.
- `selectedNode` derives from `/workflows/$workflowId/steps/$stepId`.
- Run details modal context derives from `/runs/$runId/steps/$stepId(/agents/$agent)`.
- Workflow prompt modal context derives from `/workflows/$workflowId/prompts(/$stepId)`.

## Component Contract Changes

`WorkflowCanvas` should accept a semantic mode:

```ts
type WorkflowCanvasMode = 'configure' | 'inspect'
```

In configure mode:

- `onNodeClick(node)` selects the node for the inspector.
- `onAgentClick(node, agent)` toggles the model.

In inspect mode:

- `onNodeClick(node)` navigates to `/runs/$runId/steps/$stepId`.
- `onAgentClick(node, agent)` navigates to `/runs/$runId/steps/$stepId/agents/$agent`.

`WorkflowNode` should not decide global behavior. It should render based on the mode passed through node data:

- Toggle mode tooltip: `Enable Claude for Review` / `Disable Claude for Review`.
- Inspect mode tooltip: `View Claude result for Review`.

Status: the explicit mode and node-data interaction contract are already implemented. Router should preserve this contract and swap local handlers for navigation handlers where appropriate.

## Implemented State

The dashboard now has a route spine while keeping TanStack Query as the server-state boundary.

- `@tanstack/react-router` is installed.
- `src/dashboard/web/src/router.tsx` defines route shells for workflow, prompt, run, step-detail, and agent-detail destinations.
- `src/dashboard/web/src/main.tsx` renders `RouterProvider` inside the existing `QueryClientProvider`.
- `src/dashboard/web/src/dashboard-routes.ts` owns match-based route-state helpers and default deployment capabilities.
- `App.tsx` derives selected workflow id, selected run id, selected workflow step, prompt modal state, run details modal state, and graph data from route params plus Query results.
- `App.tsx` no longer mirrors `selectedWorkflowId`, `selectedRunId`, `selectedNode`, `promptModalStepId`, `detailsModalContext`, or `graph` in local state.
- Existing `?workflow=<id>` startup URLs are still accepted and replaced with `/workflows/$workflowId`.

Query remains the source of server state:

- `useWorkflowsQuery` owns the sidebar workflow list.
- `useWorkflowGraphQuery(routedWorkflowId)` owns workflow-definition graphs.
- `useRunsQuery` owns recent runs.
- `useRunGraphQuery(selectedRunId, { refetchActiveGraphs: true })` owns saved/live run graphs.
- `useRunDetailsQuery(runId)` remains inside `RunDetailsModal`.
- Mutations still upsert and invalidate `dashboardQueryKeys` through the existing cache helpers.
- Live runner events continue to patch Query cache through `query-event-bridge`; event-stream output and the live reducer stay local component state.

## Route Behavior

Workflow definition routes:

- `/workflows/$workflowId` renders a configurable workflow graph.
- `/workflows/$workflowId/steps/$stepId` selects that step in `Inspector`.
- Card clicks in configure mode navigate to the workflow step route.
- Agent pills in configure mode toggle the selected model for that step.
- Details modal does not open in workflow-definition mode.

Prompt routes:

- `/workflows/$workflowId/prompts` opens `WorkflowPromptModal`.
- `/workflows/$workflowId/prompts/$stepId` opens the prompt modal to that step.
- The prompt button opens the selected step's prompt route when a step is selected.
- Prompt timeline selection replaces the prompt-step route so the URL follows the active prompt without noisy browser history.
- Prompt file-open controls are capability-gated; copy path remains available.

Run inspection routes:

- `/runs/$runId` renders a concrete run graph.
- `/runs/$runId/details` opens saved workflow results at the summary entry.
- `/runs/$runId/steps/$stepId` opens `RunDetailsModal` for that step.
- `/runs/$runId/steps/$stepId/agents/$agent` opens model-specific details.
- Card clicks in inspect mode navigate to step details.
- Agent pills in inspect mode navigate to agent details.
- Closing `RunDetailsModal` navigates back to `/runs/$runId`.

## Deployment Capabilities

The dashboard health response now includes:

```ts
type DashboardCapabilities = {
  deploymentMode: 'local' | 'desktop' | 'web'
  canStartRuns: boolean
  canDryRun: boolean
  canOpenLocalFiles: boolean
  canStreamRunEvents: boolean
  requiresAuth: boolean
}
```

Local CLI defaults:

- `deploymentMode: 'local'`
- run and dry-run actions enabled
- local file opening enabled
- event streaming enabled
- auth required

Vite read-only dev API:

- run and dry-run actions disabled
- event streaming disabled
- local file opening enabled for local prompt/artifact paths
- auth not required

Hosted web mode:

- set `NAX_DASHBOARD_DEPLOYMENT_MODE=web`
- `canOpenLocalFiles` is false
- run and dry-run actions are false unless `NAX_DASHBOARD_WEB_CAN_START_RUNS=1` or `NAX_DASHBOARD_WEB_CAN_DRY_RUN=1`

UI capability gates:

- `WorkflowControls` disables dry-run/run when capabilities deny them.
- `runDryRun` and `runWorkflow` also guard in handler code.
- `ArtifactActions`, `WorkflowPromptModal`, `RunDetailsModal`, and `RunFollowupContent` hide local file/folder open actions when `canOpenLocalFiles` is false.
- Copy-path actions remain available.

## API Transport

`src/dashboard/web/src/api.ts` still exposes typed dashboard API functions, but requests now resolve through a configurable API base:

- same-origin by default
- `window.NAX_DASHBOARD_API_BASE` for desktop shells or injected runtime config
- `<meta name="nax-dashboard-api-base" content="...">` for hosted/static deployments

This keeps local CLI behavior unchanged while allowing desktop and hosted UI shells to call a backend dashboard API.

## Verification

Implemented tests:

- `tests/unit/dashboard-query-cache.test.ts` covers route parsing for workflow, prompt, run, step, and agent routes.
- `tests/unit/dashboard-server.test.js` covers local health capabilities.
- `tests/unit/dashboard-server.test.js` covers hosted web capability limits.

Validated commands:

- `npm run dashboard:build`
- `npm run check`
- `npm test`

## Remaining Future Work

Route loaders are still optional. Add them only if route-level prefetching becomes valuable:

- Workflow route loader may `ensureQueryData(dashboardQueryKeys.workflowGraph(workflowId))`.
- Run route loader may `ensureQueryData(dashboardQueryKeys.runGraph(runId))`.
- Details route loader may `ensureQueryData(dashboardQueryKeys.runDetails(runId))`.
- Prompt route loader should share the workflow graph query unless prompt payloads become large.
- Event streams should stay component lifecycle work, not route loader work.

Hosted web hardening still needs product/API decisions before public deployment:

- durable app auth instead of local URL session tokens
- CORS and CSRF policy at the API boundary
- hosted artifact identifiers or URLs instead of absolute local paths
- download/open-hosted-artifact actions to replace local file opening
- redaction of machine-specific paths in hosted payloads

## Non-Goals

- Do not route the optional context modal yet; it contains transient draft input.
- Do not route event diagnostics yet.
- Do not rewrite `RunDetailsModal`; it now receives route-derived selectors.
- Do not create a separate prompt API until workflow graph payload size or permissions require it.
- Do not introduce TanStack Query Devtools in production UI unless gated to development.
