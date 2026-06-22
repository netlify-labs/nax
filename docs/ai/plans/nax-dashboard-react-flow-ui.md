# Nax Dashboard React Flow UI Plan

## Summary

Add a `nax dashboard` command that opens a local browser UI for discovering,
inspecting, previewing, and eventually running Nax workflows.

The first useful milestone is a running Vite 8 + React 19 + React Flow
application that reads the same workflow definitions as the CLI and renders the
workflow steps as interactive React Flow nodes. This should feel like the
existing terminal preview, but with a workflow list, selectable workflows, a
canvas view, and an inspector for step details.

The second milestone turns that dashboard into an operational cockpit: the UI
can submit workflow runs through a localhost API, stream run output/status, and
link to generated `.nax/` artifacts.

## Current Facts

- The CLI package is CommonJS and exposes `nax` from `bin/nax.js`.
- Workflow definitions already live in `src/flows/*/flow.yml`.
- Project workflows can shadow bundled workflows through `.github/nax-flows`,
  `nax.config.*`, `--flows-dir`, or `NAX_FLOWS_DIRS`.
- `src/flows.js` already provides the correct source of truth:
  `listFlows()`, `loadFlow()`, and `loadStepPrompt()`.
- `nax list --json` already serializes normalized workflow metadata, including
  steps, agents, action, submit mode, inputs, and source labels.
- The terminal preview is produced by `printFlowPlan()` in `bin/nax.js`.
- Actual run orchestration is currently centered around `handleRun()` in
  `bin/nax.js`; that function is not exported as a reusable module.
- The package currently declares Node `>=18`, but Vite 8 documentation lists
  Node `20.19+` or `22.12+` as the supported runtime for Vite tooling.

## External Reference Points

- React Flow quick start installs `@xyflow/react` and imports the package CSS
  from `@xyflow/react/dist/style.css`.
- React Flow v12 uses named imports from `@xyflow/react`, for example
  `import { ReactFlow } from '@xyflow/react'`.
- React Flow nodes and edges are the right model for Nax workflow steps and
  step dependencies.
- Handles are required as edge attachment points for custom nodes, even if the
  visual handle dots are hidden.
- Current npm versions checked during planning:
  - `vite`: `8.0.16`
  - `react`: `19.2.7`
  - `react-dom`: `19.2.7`
  - `@xyflow/react`: `12.11.0`

## Product Shape

`nax dashboard` should open a local workbench, not a marketing page.

Primary layout:

- Left sidebar: workflow list, search/filter, source label, step count, model
  summary.
- Main canvas: React Flow diagram of the selected workflow.
- Right inspector: selected workflow or selected step metadata.
- Top toolbar: project root, transport selector, branch input, model filter,
  refresh, open artifacts, run/dry-run actions.
- Bottom/status region: run stream, recent artifacts, errors, and links.

Initial demo scope:

- Start local dashboard server.
- Open browser.
- List all workflows from `listFlows()`.
- Select a workflow.
- Render its steps as React Flow custom nodes.
- Render edges from explicit `step.input` dependencies.
- Fall back to sequential edges when a workflow has no explicit input for a
  later step but is ordered linearly.
- Show agent chips, step action labels, submit mode, wait mode, source label,
  and descriptions.
- Support manual refresh without restarting the server.

Out of scope for the first demo:

- Editing workflows.
- Creating prompts.
- Full run orchestration from the browser.
- Live polling of existing `.nax/` run state.
- Authentication setup flows for GitHub CLI or Netlify CLI.

## Architecture

### Directory Layout

Recommended structure:

```text
src/dashboard/web/
  index.html
  package marker files only if needed
  src/
    App.tsx
    main.tsx
    api.ts
    graph.ts
    types.ts
    components/
      WorkflowCanvas.tsx
      WorkflowNode.tsx
      WorkflowList.tsx
      Inspector.tsx
      RunPanel.tsx
  vite.config.mjs
  tsconfig.json
  dist/

src/
  src/dashboard/server.js
  src/dashboard/shared/graph.js
  dashboard-api.js
```

Keep package installation simple by adding Vite/React/React Flow dependencies to
the root `package.json` instead of creating a separate unpublished workspace.
The package can still keep the UI source isolated under `src/dashboard/web/`.

Root scripts:

```json
{
  "scripts": {
    "dashboard:dev": "vite --config src/dashboard/web/vite.config.mjs",
    "dashboard:build": "vite build --config src/dashboard/web/vite.config.mjs",
    "dashboard:preview": "vite preview --config src/dashboard/web/vite.config.mjs"
  }
}
```

Publishing:

- Include built static assets in the npm package, for example `src/dashboard/web/dist`.
- Update `files` so `nax dashboard` works after global install.
- Do not require end users to install dev dependencies just to open the UI.

### Local Server

Add `src/dashboard/server.js` as a CommonJS module that uses Node's built-in
`http` server.

Responsibilities:

- Bind to `127.0.0.1` by default.
- Choose an available port, defaulting to `0` or a preferred configurable port.
- Serve `src/dashboard/web/dist` static assets in production mode.
- In development mode, optionally proxy or print the Vite dev URL.
- Generate a per-process random token and include it in the opened URL.
- Require that token for mutating API requests.
- Return JSON errors with stable shapes.

Initial API:

```text
GET  /api/health
GET  /api/workflows
GET  /api/workflows/:id
GET  /api/workflows/:id/graph
```

Later run API:

```text
POST /api/workflows/:id/dry-run
POST /api/workflows/:id/runs
GET  /api/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events
POST /api/runs/:runId/cancel
```

### CLI Command

Add:

```text
nax dashboard [workflow]
```

Options:

```text
--project-root <path>
--flows-dir <path>        repeatable, same semantics as list/run
--host <host>             default 127.0.0.1
--port <port>             default auto
--no-open                 print URL without opening browser
--dev                     use Vite dev server integration when working locally
```

The command should:

1. Resolve `projectRoot` using the same helper as `run` and `list`.
2. Start the dashboard server.
3. Open the browser with the selected workflow id encoded in the URL when
   provided.
4. Keep the process alive until interrupted.
5. Print the local URL and project root.

### Graph Mapping

Add a pure transform in `src/dashboard/shared/graph.js`.

Input:

```js
{
  flow,
  selectedAgents,
  runState
}
```

Output:

```js
{
  nodes: [],
  edges: [],
  metadata: {}
}
```

Node data:

```js
{
  kind: 'workflow-step',
  stepId,
  index,
  title,
  description,
  action,
  submit,
  waitFor,
  agents,
  input,
  status,
  sourceLabel
}
```

Edge rules:

1. For every `step.input[].step`, create an edge from that source step to the
   current step.
2. If a non-first step has no explicit input and the workflow is ordered
   linearly, create an edge from the previous runnable step.
3. Use stable ids: `edge:<sourceStepId>:<targetStepId>`.
4. Mark `submit: follow-up` edges with a visual distinction in the UI.

Initial layout:

- Use deterministic vertical layout to match the terminal preview:
  - `x = 0`
  - `y = index * 220`
- Use React Flow `fitView` after selection/load.
- Defer a layout engine until workflows become branching enough to justify it.

Future layout:

- Add Dagre or ELK only after the data model needs real branching layouts.
- Keep the transform output independent from any specific layout library.

### React Flow UI

Use `@xyflow/react`.

Core implementation:

```tsx
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
```

Custom node:

- Header: step number/title and action label.
- Body: step description.
- Footer: agent chips.
- Hidden top target handle and bottom source handle for linear workflows.
- Optional per-input handles later if branching becomes visually ambiguous.

Canvas defaults:

- `nodesDraggable={false}` for the first demo.
- `nodesConnectable={false}`.
- `elementsSelectable={true}`.
- `fitView`.
- `defaultEdgeOptions` with `type: 'smoothstep'`.
- Hide handle dots with CSS while preserving handles for edge attachment.

Visual tone:

- Dense, operational workbench.
- Avoid nested cards.
- Use icons for refresh/run/open controls.
- Keep cards only for repeated workflow list items and node bodies.
- Keep the palette restrained but not one-note.

### Run Execution Strategy

The browser should never call Netlify or GitHub directly. It should call the
local `nax dashboard` server, and that server should run Nax on behalf of the
operator.

There are two acceptable implementation stages.

Stage A: command delegation

- `POST /api/workflows/:id/runs` spawns the current CLI command:

```text
node bin/nax.js run <flowId> --project-root <root> --transport <transport> --branch <branch> --force
```

- Stream stdout/stderr to the UI through server-sent events.
- Record child process id, command args, startedAt, exitedAt, and exit code.
- This is fastest and matches the user's model of "API calls run Nax commands."

Stage B: reusable orchestration module

- Extract `handleRun()` and related orchestration code out of `bin/nax.js` into
  a reusable module.
- Keep `bin/nax.js` as command wiring.
- Let the dashboard API call orchestration directly with a structured logger.
- This removes argv coupling and makes cancellation/status cleaner.

Recommendation:

- Use Stage A only for the first runnable trigger.
- Move to Stage B before making browser-triggered runs feel like a supported
  product surface.

### Security And Safety

This UI can create GitHub issues, trigger GitHub Actions, and spend Netlify
agent credits. Treat localhost as a privileged control plane.

Required safeguards before run buttons are enabled:

- Bind to `127.0.0.1` by default.
- Generate a random session token for each server process.
- Require the token for every mutating endpoint.
- Use `SameSite=Strict` if a cookie is used; a URL token plus header is simpler
  for the first implementation.
- Validate workflow ids against `listFlows()` output.
- Validate transport against known values.
- Validate branch, model names, and step ids.
- Never accept arbitrary shell command strings from the browser.
- Build child process argv arrays directly.
- Display a confirmation modal before real runs.
- Make dry-run the default action in early versions.
- Show the exact project root and transport before run submission.

### State And Artifacts

Initial demo:

- Stateless except selected workflow id in the URL.

Run-control version:

- Use existing `.nax/workflows/<run-id>/workflow.json` as the durable source of
  truth.
- Add API endpoints that read `listRunStates(projectRoot)`.
- Poll run state after command submission.
- Link to `.nax/.../artifacts/summary.md`.
- Show each agent runner/session link when available.

Do not create a parallel UI-only database unless run orchestration needs
cross-process history that `.nax/` cannot provide.

## Implementation Phases

### Phase 1: Demo Dashboard

Goal: `nax dashboard` opens a UI that lists and renders workflows.

Tasks:

1. Add Vite 8, React 19, React DOM 19, `@xyflow/react`, and likely
   `@vitejs/plugin-react` to the root package.
2. Add `src/dashboard/web/` Vite application.
3. Add `src/dashboard/shared/graph.js` pure transform.
4. Add `src/dashboard/server.js` with read-only API routes.
5. Add `dashboard [workflow]` command to `bin/nax.js`.
6. Build custom React Flow workflow step node.
7. Add workflow list and workflow inspector.
8. Add unit tests for graph transform.
9. Add an integration test for `GET /api/workflows`.
10. Update README with a short experimental usage section.

Acceptance criteria:

- `npm run check` passes.
- `npm test` passes.
- `npm run dashboard:build` passes.
- `nax dashboard review` opens a browser.
- The Review workflow shows three nodes and two edges.
- Project-local workflows appear before bundled workflows.
- Workflow source labels match `nax list --verbose`.

### Phase 2: Dry Run And Command Preview

Goal: the UI can preview what would run without creating remote work.

Tasks:

1. Add `POST /api/workflows/:id/dry-run`.
2. Invoke existing dry-run command path or extracted dry-run renderer.
3. Stream terminal output into a run panel.
4. Render validation errors in the UI.
5. Add branch, transport, model filter, context, `--step`, and `--from-step`
   controls.

Acceptance criteria:

- Dry-run from UI produces output equivalent to `nax run <flow> --dry --force`.
- No `.nax/` artifacts are written by a dry-run.
- Invalid workflow ids and invalid options return structured API errors.

### Phase 3: Real Run Submission

Goal: the UI can start a real workflow safely.

Tasks:

1. Add authenticated `POST /api/workflows/:id/runs`.
2. Spawn Nax command with argv array, not a shell string.
3. Add server-sent events for stdout/stderr/process lifecycle.
4. Disable duplicate run submissions for the same active workflow unless
   explicitly confirmed.
5. Add cancellation endpoint for still-running child processes.
6. Poll/read `.nax/workflows` state and show per-step status.

Acceptance criteria:

- A real Netlify API workflow can be started from the UI.
- The UI shows command lifecycle and links to created artifacts.
- Failed commands surface exit code and stderr.
- Refreshing the browser can recover visible status from `.nax/`.

### Phase 4: Refactor CLI Orchestration Into Reusable Modules

Goal: replace subprocess run control with direct application calls.

Tasks:

1. Move run orchestration from `bin/nax.js` into `src/workflow-runner.js`.
2. Keep Commander-specific prompt/option wiring in `bin/nax.js`.
3. Provide a structured logger/event sink interface.
4. Reuse the module from both CLI and dashboard API.
5. Expand tests around non-TTY execution.

Acceptance criteria:

- CLI behavior remains unchanged.
- Dashboard API can run workflows without spawning `node bin/nax.js`.
- Existing flow execution tests remain meaningful and pass.

### Phase 5: Artifact Browser

Goal: dashboard completed and unfinished workflow runs.

Tasks:

1. Add run list API from `.nax/workflows`.
2. Add a recent runs panel.
3. Add per-step result summaries and usage data.
4. Link to runner/session artifacts.
5. Add resume affordance for unfinished workflows.

Acceptance criteria:

- UI can show latest workflow summary.
- UI can distinguish pending, running, completed, failed, and dry-run steps.
- Resume actions map to existing Nax resume semantics.

## Test Plan

Unit tests:

- `flowToGraph()` creates expected nodes/edges for Review.
- Explicit `input` dependencies override simple sequential assumptions.
- Agent filtering updates node agents.
- Project workflow metadata survives API serialization.
- API rejects unknown workflow ids.

Integration tests:

- Start dashboard server on an ephemeral port.
- Fetch `/api/health`.
- Fetch `/api/workflows`.
- Fetch `/api/workflows/review/graph`.
- Verify token requirement for mutating endpoints once they exist.

Frontend checks:

- `npm run dashboard:build`.
- Playwright or lightweight browser smoke test once UI stabilizes.
- Desktop and narrow viewport screenshots before marking the UI polished.

Manual smoke:

```bash
npm install
npm run check
npm test
npm run dashboard:build
node bin/nax.js dashboard review --no-open
```

## Key Tradeoffs

### Root Package Dependencies vs Nested UI Package

Root dependencies keep install/build simpler and avoid package-manager workspace
churn. A nested UI package is cleaner conceptually, but it adds release and
install complexity before the UI has earned it.

Decision: use root dependencies for the first implementation.

### Subprocess Runs vs Direct Module Calls

Subprocess runs are fast to implement and match the current CLI boundary. Direct
module calls are more robust and testable.

Decision: start with subprocess for a narrow run trigger, then extract
orchestration before the UI becomes the main supported run path.

### Manual Layout vs Layout Library

Nax workflows are currently mostly linear. Manual vertical layout mirrors the
terminal preview and keeps the demo deterministic.

Decision: use manual layout first. Add Dagre/ELK only when branching workflows
make it necessary.

### Node 18 Package Support vs Vite 8 Tooling

Existing package metadata says Node `>=18`, but Vite 8 tooling requires newer
Node versions. Users running the published CLI should not need Vite at runtime
if static assets are shipped.

Decision: keep CLI runtime as broad as possible, but document that developing
or building the UI requires Node 20.19+ or 22.12+.

## Open Questions

1. Should `nax dashboard` be marked experimental in help text for the first
   release?
2. Should the first run button perform dry-run only, with real runs hidden
   behind an explicit flag?
3. Should the dashboard open the latest unfinished workflow automatically when
   one exists?
4. Do we want workflow editing eventually, or should this stay inspect/run only?
5. Should branch selection default to the same `resolveWorkflowBranch()` logic
   before the user touches it?

## Recommended First Commit

Build Phase 1 only:

- Vite React app under `src/dashboard/web/`.
- `@xyflow/react` custom node rendering.
- Read-only localhost API.
- `nax dashboard [workflow]`.
- Tests for graph conversion and workflow API.

This creates visible product value without risking accidental remote workflow
execution from the browser.
