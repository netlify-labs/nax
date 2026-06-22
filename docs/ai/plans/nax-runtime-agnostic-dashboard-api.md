# NAX Runtime-Agnostic Dashboard API Plan

> Status: Draft architecture plan.
> Scope: dashboard API runtime boundaries, Hono migration, and agent-runner transport abstraction.
> Primary goal: make the dashboard API portable across local Node and Netlify Function runtimes without changing the user-facing API surface.

## Summary

The dashboard currently starts a local Node HTTP server. That server serves the web app, reads local `.nax` state, and starts/stops runner work through local process/CLI-oriented paths. That is a useful local cockpit, but the API is not yet shaped as a runtime-agnostic service.

The next architecture direction should separate three concerns:

- HTTP API: request parsing, route matching, auth, response shapes, and structured errors.
- Runtime adapter: local Node server versus Netlify Function, including filesystem, storage, auth/session, streaming, and capabilities.
- Runner transport: how runner lifecycle operations are performed, such as local CLI/process behavior versus direct Netlify API calls with a Netlify token.

The target is a single API surface implemented as a Hono app. Local development mounts that app inside the existing local server. Hosted/dashboard deployments export the same app as a Netlify Function. The route handlers call interfaces, not local-only globals.

## Why This Matters

The current local server is allowed to assume:

- a project root exists on disk
- `.nax/workflows` is readable
- local files can be opened
- local child processes can be spawned
- local event logs can be tailed
- Netlify CLI or CLI-adjacent modules are available

A Netlify Function runtime has different constraints:

- no durable project filesystem in the same sense
- no local GUI file opener
- no long-running child process model
- request timeouts and streaming constraints
- secrets must come from function environment/context
- runner operations should use direct Netlify API calls

If these assumptions remain mixed into route handlers, every hosted-dashboard step becomes risky. If they are explicit adapter capabilities, the API can stay stable while implementations vary by runtime.

## Current Responsibilities To Audit

`src/dashboard/server.js` currently owns several responsibilities that should be classified before extraction:

- Static dashboard asset serving.
- Local session token bootstrap and cookie handling.
- Host-header and token auth checks.
- `/api/health` capability reporting.
- Workflow discovery and workflow graph rendering.
- `/api/runs` list/detail/graph/events endpoints.
- Dry-run, real-run, cancellation, follow-up, and review-gate mutations.
- SSE/live event streaming for active local runs.
- Durable event replay from `.nax/workflows`.
- Local file-open endpoint.
- Netlify Blob offload and follow-up context delivery.

The first design bead should produce a route inventory table with columns:

- route
- method
- current dependencies
- local-only, portable, or hosted-needs-new-storage
- runtime capability required
- runner transport operation required
- migration risk

## Target Architecture

### Hono App

Create a module shaped like:

```ts
createDashboardApi({
  runtime,
  storage,
  runnerTransport,
  auth,
  clock,
  logger,
})
```

The Hono app should own:

- route definitions
- method checks
- body parsing
- query parsing
- structured errors
- auth middleware
- response serialization
- capability-aware 403/501 responses

It should not directly:

- read arbitrary local files
- spawn child processes
- assume Node `http.ServerResponse`
- assume a local project root
- call Netlify CLI commands
- know how runner start/stop is implemented

### Runtime Adapter

Define a runtime context with explicit capabilities:

```ts
type DashboardRuntime = {
  deploymentMode: 'local' | 'desktop' | 'web'
  capabilities: DashboardCapabilities
  projectRoot?: string
  canServeStaticAssets: boolean
  canOpenLocalFiles: boolean
  canStreamEvents: boolean
}
```

Local adapter:

- supplies `projectRoot`
- reads `.nax/workflows`
- serves static assets outside the Hono API app or through a local wrapper
- supports local file open
- supports SSE for active local process events
- can use local runner transport

Netlify Function adapter:

- supplies token/env-backed Netlify API credentials
- reports hosted capabilities accurately
- cannot open local files
- should not rely on local `.nax/workflows`
- may use Netlify-hosted storage or direct API reads for durable state
- uses direct Netlify API runner transport

### Storage Boundary

Do not let route handlers reach into `fs` directly. Introduce a storage interface for dashboard-readable state:

```ts
type DashboardStorage = {
  listRunsPage(input: RunsPageInput): Promise<RunsPage>
  getRun(id: string): Promise<DashboardRunState | null>
  getRunGraph(id: string): Promise<RunGraphResponse | null>
  getRunDetails(id: string): Promise<RunDetailsResponse | null>
  listWorkflows(): Promise<WorkflowListResponse>
  getWorkflowGraph(id: string): Promise<WorkflowGraphResponse>
}
```

Local storage can wrap existing `run-state.js`, flow loading, and artifact readers.

Hosted storage must be designed separately. Candidate sources:

- Netlify Agent Runner/session APIs
- Netlify Blobs for dashboard-owned metadata
- workflow state persisted by future runner callbacks
- read-only project configuration bundled into deployment

Do not pretend hosted storage is solved by the local filesystem interface. The adapter should make missing hosted capabilities explicit.

## Runner Transport

Runner lifecycle should move behind a transport interface:

```ts
type AgentRunnerTransport = {
  startWorkflowRun(input: StartWorkflowRunInput): Promise<StartWorkflowRunResult>
  cancelRun(input: CancelRunInput): Promise<CancelRunResult>
  submitFollowup(input: SubmitFollowupInput): Promise<SubmitFollowupResult>
  approveReview(input: ReviewGateInput): Promise<ReviewGateResult>
  cancelReview(input: ReviewGateInput): Promise<ReviewGateResult>
  events(input: RunEventsInput): AsyncIterable<RunnerEvent> | null
}
```

Local transport:

- preserves current local behavior
- may wrap `runWorkflow`, `resumeWorkflow`, `workflowCommand`, and local cancellation helpers
- writes `.nax/workflows`
- streams local process events
- can keep CLI/process-oriented internals while the HTTP layer stops depending on them

Netlify API transport:

- uses raw Netlify API calls, not shelling out
- requires an explicit Netlify token source
- requires site/project identifiers
- maps Netlify runner/session responses into dashboard run models
- maps API failures/rate limits into structured dashboard errors
- should define polling versus streaming behavior honestly

The transport interface should be smaller than the current server. Avoid baking dashboard storage concerns into runner lifecycle calls.

## Hono Migration Sequence

1. Audit current route dependencies and write the route inventory.
2. Introduce shared response/error helpers that can work in Hono and current Node server.
3. Extract read-only routes into a Hono app behind local adapters:
   - `/api/health`
   - `/api/workflows`
   - `/api/workflows/:id/graph`
   - `/api/runs`
   - `/api/runs/:id`
   - `/api/runs/:id/graph`
   - `/api/runs/:id/details`
4. Mount the Hono app in the local server while leaving static serving and SSE wrappers intact.
5. Extract mutation routes after runner transport interfaces exist:
   - dry-run
   - start run
   - cancel run
   - follow-ups
   - review gates
6. Add a Netlify Function adapter for a read-only subset first.
7. Add direct Netlify API runner transport for hosted mutations once auth/storage semantics are explicit.
8. Remove direct route dependencies on local server internals when equivalent adapters exist.

## Open Questions

- What is the hosted durable run source of truth: Netlify API, Netlify Blobs, workflow callbacks, or a hybrid?
- Which Netlify token scopes are required for runner create/stop/session/artifact APIs?
- Does hosted mode support SSE, polling, or both?
- How should hosted auth work for dashboard users: CLI-issued token, Netlify identity/session, signed URL, or team auth?
- Which local endpoints should be intentionally unavailable in hosted mode, such as `/api/files/open`?
- Should dry-run exist in hosted mode, and if so does it simulate only API payloads or full workflow execution?

## Acceptance For The Design Track

- Route inventory exists and classifies runtime assumptions.
- Hono app boundary is specified with adapter interfaces.
- Runner transport interface is specified with local and Netlify API implementations planned separately.
- Hosted limitations are explicit rather than hidden behind local-only behavior.
- Local dashboard behavior can be preserved through an incremental migration.
