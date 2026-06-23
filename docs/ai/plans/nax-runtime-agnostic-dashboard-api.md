# NAX Runtime-Agnostic Dashboard API Plan

> Status: Implemented closeout for `nax-boo3`.
> Source epic: `nax-boo3` - Design runtime-agnostic dashboard API and agent-runner transports.
> Scope: dashboard API route boundaries, Hono migration, runtime adapters, storage adapters, agent-runner transport abstraction, and related `src/` module-boundary cleanup.
> Non-scope: changing dashboard UX, changing workflow state format, or replacing existing local runner behavior.

## Executive Summary

The dashboard API currently lives in `src/dashboard/server.js` as a local Node HTTP server. That file owns routing, auth, static asset serving, local filesystem access, event streaming, workflow loading, durable run-state parsing, live child-process orchestration, cancellation, human-review resume, dashboard follow-ups, and Netlify CLI/API-adjacent calls.

That is acceptable for a local dashboard, but it is the wrong shape for the next product direction. We want the same dashboard API surface to run in more than one runtime:

- Local Node server: runs on the developer machine, reads local project files, writes `.nax/workflows`, can open local files, can spawn the local Nax runner, and can stream live process events.
- Netlify Function: runs in Netlify infrastructure, cannot assume a durable project filesystem or local process model, should use a Netlify token and direct Agent Runner API calls, and may need different storage/event capabilities.

The target architecture is a Hono API app with explicit dependencies. The Hono app owns HTTP behavior. Runtime adapters own the environment. Storage adapters own readable dashboard state. Runner transports own starting, stopping, polling, streaming, and follow-up operations.

This should also clean up the top-level `src/` sprawl. Today many domain modules sit directly under `src/`, even when they belong to clearer ownership areas such as dashboard storage, runner transports, Netlify integration, workflow execution, artifact persistence, follow-up orchestration, or shared primitives. The cleanup should happen as part of boundary extraction, not as a cosmetic mass rename.

The most important constraint is incremental migration. Local dashboard behavior must stay working while route logic moves behind adapter interfaces.

## Implementation Closeout

The `nax-boo3` implementation moved the dashboard API to a Hono app factory while preserving the existing local server behavior. `src/dashboard/server.js` still owns local HTTP lifecycle, static assets, fallback HTML, Host-header protection, and SSE response plumbing, but `/api/*` read and mutation routes now delegate through `createDashboardApi()`.

Implemented module boundaries:

- `src/dashboard/api/*`: Hono app, auth/session helpers, security headers, JSON request parsing, error payloads, capability helpers, and public serializers.
- `src/dashboard/storage/*`: local workflow, run, event, and artifact stores. The local runs store preserves the pagination invariant by slicing durable workflow state files before parsing `workflow.json`.
- `src/dashboard/runtime/*`: live run registry, local file-open utility, and Netlify Function wrapper.
- `src/dashboard/events/local-stream.js`: local SSE/event replay adapter.
- `src/dashboard/transports/*`: local child-process runner transport, local in-process dry-run/resume transport, and hosted Netlify API transport.
- `src/dashboard/services/mutations.js`: local cancellation, review cancellation, and follow-up mutation service.
- `src/netlify/api-client.js`: direct Netlify API client used by hosted dashboard transports.
- `src/netlify/blobs.js` and `src/netlify/runtime.js`: Netlify-owned modules moved out of the root, with root compatibility shims left in place.

Hosted Netlify Function support is capability-driven:

- `/api/health` works in hosted mode and does not expose `projectRoot`.
- Hosted direct Netlify API transport supports start, cancel, polling, `events.json`, run details, graph details, fresh-runner follow-ups, follow-up cancellation, and remote-safe artifact references.
- Hosted `/api/runs/:id/events` SSE remains unsupported and returns `event_stream_unavailable`; clients should use `/events.json` polling.
- Hosted local-only routes such as `/api/files/open`, dry-run, and review-gate mutation remain explicit `unsupported_capability` responses unless a future hosted implementation is added.
- Hosted artifact details use stable remote identifiers such as `id`, `url`, `blobKey`, and `store`; `absolutePath` is intentionally empty.

The initial `src/` cleanup was limited to stable ownership moves. Dashboard-owned helpers were extracted under `src/dashboard/*`; Netlify Blob/runtime modules moved under `src/netlify/*` with compatibility shims. Larger workflow, artifact, follow-up, runner, GitHub, and flow moves remain future cleanup work because they cross CLI and dashboard ownership boundaries.

## Core Product Goal

The user-facing dashboard should not care where the API runs. A user should see the same route surface and mostly the same response shapes whether the API is mounted locally or in a Netlify Function.

What changes is the backend capability set:

- A local runtime can operate directly on local files and local processes.
- A hosted runtime can operate through Netlify APIs, token-backed credentials, and hosted storage.
- Some routes may be unsupported in hosted mode until the matching storage or transport exists.

Unsupported hosted behavior should fail explicitly with typed errors such as `unsupported_capability`, not accidentally through filesystem or child-process failures.

## Design Principles

1. Preserve current local behavior first.
   The Hono migration is a refactor until a route is deliberately moved to hosted behavior.

2. Keep route paths stable.
   The dashboard client already depends on `/api/health`, `/api/workflows`, `/api/runs`, event routes, workflow mutations, follow-ups, and local file open. Any route rename needs a separate migration.

3. Make runtime capability explicit.
   Route handlers should ask for capabilities through context instead of guessing from `process.env`, `projectRoot`, or Node globals.

4. Do not bury storage inside transport.
   Starting or cancelling runner work is transport behavior. Listing runs, reading graphs, and loading artifacts are storage behavior. A local adapter may implement both from `.nax`, but the interfaces should stay separate.

5. Do not regress durable run pagination.
   The shipped `/api/runs` behavior must continue using paged durable listing that slices before parsing `workflow.json`. Hono extraction must not reintroduce `listRunStates(projectRoot)` followed by slicing.

6. Treat hosted mode as a capability matrix, not a boolean.
   Hosted read-only APIs may arrive before hosted mutations. Polling may arrive before streaming. Remote artifacts may arrive before local file-open replacement.

7. Prefer typed, testable modules over one giant adapter.
   The current server can shrink route-by-route. Avoid moving the monolith into `dashboard/hono-server.js`.

8. Use the Hono/runtime work to rationalize `src/` ownership.
   Moving files is worthwhile when it clarifies dependency direction or makes a boundary enforceable. Avoid broad churn where every import changes but ownership stays muddy.

## Current Server Responsibilities

`src/dashboard/server.js` currently combines these layers:

- Node HTTP server lifecycle through `http.createServer`.
- Static file serving from `src/dashboard/web/dist`.
- Fallback HTML when the dashboard build does not exist.
- Host-header protection for local server access.
- Local session token generation, cookie bootstrap, and `x-nax-token` auth.
- JSON body parsing and structured error serialization.
- Capability reporting through `/api/health`.
- Workflow loading through `listFlows` and `loadFlow`.
- Workflow graph rendering through `flowToGraph`.
- Durable run-state listing, lookup, graph, details, and event replay.
- Live in-memory run tracking through a `runs` map.
- Active workflow de-duplication through `activeByWorkflow`.
- Local child-process orchestration through `spawn(process.execPath, bin/nax.js, ...)`.
- Runner event parsing from file descriptor 3.
- SSE event streaming for active runs plus durable replay.
- Workflow dry-run execution through `runWorkflow`.
- Workflow start execution through a child Nax process.
- Human-review approval through `resumeWorkflow`.
- Human-review cancellation through `cancelHumanReviewGate`.
- Dashboard follow-up planning, prompt construction, optional blob delivery, remote submission, and durable workflow updates.
- Follow-up cancellation through local durable mutation plus remote `stopAgentRun`.
- Run cancellation through local process cancellation plus remote runner stop attempts.
- Local file open through the `open` package.
- Netlify Blob writes through CLI-oriented `setBlob`.
- Linked site lookup through local `.netlify/state.json` and environment.

This is too much for one HTTP handler if the API needs to run outside the local Node process.

## Top-Level `src/` Sprawl Cleanup

There are currently dozens of files directly under `src/`. Some are genuinely shared primitives, but many are domain modules that should live under feature directories once their ownership is clear.

The live ownership inventory is maintained in `docs/ai/plans/nax-src-ownership-inventory.md`.

The cleanup should be part of this architecture effort for three reasons:

- Hono extraction needs explicit module boundaries anyway.
- Runtime-agnostic design is harder if dashboard routes import a broad grab bag of root-level modules.
- The eventual direct Netlify API transport needs a clean home that is not confused with the existing local CLI-oriented runner helpers.

### Cleanup Rules

1. Move modules only when a boundary is being extracted or stabilized.
   For example, move run-state paging into a dashboard local run store when that store exists. Do not move `run-state.js` first and then discover every CLI import later.

2. Keep shared primitives obvious.
   Files such as `status.js`, `types.js`, and constants can remain shared until there is a better domain-specific home.

3. Preserve public import compatibility where needed.
   If CLI code or tests import a root module heavily, use temporary shim exports only when they reduce risk. Remove shims in a later cleanup bead.

4. Keep dependency direction one-way.
   Dashboard API modules may depend on shared workflow/run/artifact modules. Shared workflow modules must not import dashboard API modules.

5. Group by domain, not by technical layer alone.
   A `storage/` directory is useful inside `dashboard/`, but repository-wide modules should be grouped around workflow, runner, Netlify, artifact, follow-up, GitHub, and CLI domains.

### Candidate Ownership Map

This is a planning map, not an instruction to move everything at once.

| Current top-level files | Likely target ownership | Notes |
| --- | --- | --- |
| `run-state.js`, `runner-event-log.js`, `graceful-run-state.js` | `src/workflow/state/` or `src/dashboard/storage/local-*` wrappers | Core workflow state is shared; dashboard-specific access should wrap it rather than own it outright. |
| `workflow-runner.js`, `workflow-events.js`, existing `src/workflow/*` | `src/workflow/` | Continue moving workflow execution/orchestration under the existing workflow directory. |
| `local-runner.js`, `agent-runner-sync.js`, `agent-run-results.js` | `src/runners/local/` or `src/agent-runner/` | Distinguish local CLI/API-adjacent runner behavior from future dashboard transport interfaces. |
| `agent-runner-artifacts.js`, `agent-session-artifacts.js`, `workflow-artifacts.js` | `src/artifacts/` | Artifact persistence is shared by CLI and dashboard. |
| `followup-context.js`, `followup-delivery.js`, `followup-persistence.js`, `followup-plan.js`, `handoff-runner.js`, `handoff-sources.js` | `src/followup/` or split `src/handoff/` and `src/followup/` | Dashboard follow-ups and CLI handoff overlap but should not remain a loose root-level cluster. |
| `netlify-blobs.js`, `netlify-runtime.js`, existing `src/netlify/*` | `src/netlify/` | Implemented as `src/netlify/blobs.js`, `src/netlify/runtime.js`, and `src/netlify/api-client.js`; root shims remain for compatibility. |
| `gh-cli.js`, `github-actions-sync.js`, existing `src/github/*` | `src/github/` | Keep GitHub-specific integration away from dashboard runtime code. |
| `flows.js`, existing `src/flows/*`, `prompts.js`, `issue-groups.js` | `src/flows/` or `src/prompts/` | Move only after checking CLI import blast radius. |
| `notifications.js`, `runner-events.js`, `target.js`, `transports.js` | shared domain directories after audit | These need dependency review before moving because they likely cross CLI/workflow/dashboard boundaries. |

### Refactor Strategy

The `src/` cleanup should follow the API migration phases:

- During shared API primitive extraction, create `src/dashboard/api/*` and move only dashboard-owned helpers out of `server.js`.
- During local storage adapter work, wrap root-level state/artifact modules from `src/dashboard/storage/*` before moving shared state modules.
- During runner transport extraction, create `src/dashboard/transports/*` for dashboard transport contracts and decide separately whether shared runner modules move to `src/runners/*`.
- During Netlify API transport design, move or create Netlify-specific client modules under `src/netlify/*` unless they are truly dashboard-only.
- After Hono owns all `/api/*`, run a separate import graph review to identify root files with clear single-domain ownership and move them in small batches.

The desired end state is not "no files at `src/` root." The desired end state is that anything left at `src/` root is intentionally shared and boring.

## Current Route Inventory

This inventory is the required starting point for `nax-boo3.1`.

| Route | Method | Current behavior | Current local assumptions | Target owner | Hosted posture |
| --- | --- | --- | --- | --- | --- |
| `/api/health` | GET | Reports auth and dashboard capabilities | Reads env, may reveal `projectRoot` after auth | Hono route plus runtime context | Portable |
| `/api/workflows` | GET | Lists workflow definitions | Reads local flow files from project/root dirs | Workflow storage adapter | Hosted needs bundled or remote workflow source |
| `/api/workflows/:id` | GET | Returns one public workflow | Reads local flow files | Workflow storage adapter | Hosted needs bundled or remote workflow source |
| `/api/workflows/:id/graph` | GET | Returns workflow graph | Reads local flow files, uses shared graph builder | Workflow storage adapter plus graph service | Hosted portable if workflow source exists |
| `/api/workflows/:id/dry-run` | POST | Runs Nax dry-run and returns stdout/stderr-style result | Calls `runWorkflow` in local process, uses local project | Runner transport | Unsupported in hosted until simulated or remote dry-run exists |
| `/api/workflows/:id/runs` | POST | Starts workflow run and streams local child events | Spawns `bin/nax.js`, reads/writes local `.nax`, local process lifecycle | Runner transport plus live run registry | Hosted should call Netlify API transport |
| `/api/runs` | GET | Lists active runs and paged durable runs | Active in-memory map plus local `.nax/workflows` | Run storage plus live run registry | Portable only after hosted run source exists |
| `/api/runs/:id` | GET | Returns active or durable run | Active in-memory map plus full durable lookup | Run storage plus live run registry | Portable with hosted run source |
| `/api/runs/:id/graph` | GET | Returns durable run graph and workflow | Reads durable state, syncs follow-ups, loads flow | Run storage plus workflow storage plus graph service | Hosted needs run state and workflow source |
| `/api/runs/:id/details` | GET | Returns durable artifact/details model | Reads local artifact files under run dir | Artifact storage adapter | Hosted needs artifact API/blob source |
| `/api/runs/:id/events` | GET | SSE stream/replay | Uses Node response streaming and in-memory clients; reads local event log | Event stream adapter | Hosted may need polling, SSE, or function streaming |
| `/api/runs/:id/events.json` | GET | JSON event replay | Reads active memory or local event log | Event storage adapter | Portable with hosted event source |
| `/api/runs/:id/cancel` | POST | Stops remote runners and local child process; mutates durable state | Local run map, local child process, local durable files, Netlify CLI/API stop helper | Runner transport plus run storage | Hosted should call Netlify API transport |
| `/api/runs/:id/review/approve` | POST | Resumes paused workflow from review gate | Calls `resumeWorkflow` locally | Runner transport | Hosted needs remote resume/review operation |
| `/api/runs/:id/review/cancel` | POST | Cancels human review gate in durable state | Mutates local `workflow.json` | Run storage/review service | Hosted needs state mutation source |
| `/api/runs/:id/followups` | POST | Builds context package, maybe writes blob, submits follow-up runner/session, persists pseudo-workflow/source workflow updates | Reads local artifacts, writes blobs through CLI helper, submits via local modules, mutates local durable state | Follow-up service plus runner transport plus artifact storage | Hosted requires direct API and remote artifact/context storage |
| `/api/runs/:id/followups/cancel` | POST | Cancels a submitted follow-up locally and remotely | Mutates local durable state, calls `stopAgentRun` | Runner transport plus run storage | Hosted requires direct API and hosted state update |
| `/api/files/open` | POST | Opens a local file or directory | Requires local filesystem and desktop opener | Runtime local utility | Hosted should return `unsupported_capability` |
| Static dashboard assets | GET | Serves built Vite app | Local filesystem dist dir | Local server adapter or Netlify static hosting | Not part of core Hono API |
| Fallback index HTML | GET | Shows simple API page if build missing | Local server convenience | Local server adapter | Hosted static deployment decides separately |

## Capability Matrix

The API should expose capabilities in `/api/health` and enforce them in route handlers.

| Capability | Local Node | Netlify Function read-only | Netlify Function full |
| --- | --- | --- | --- |
| `canListWorkflows` | yes | maybe | yes if workflow source configured |
| `canReadRuns` | yes | maybe | yes if hosted state source configured |
| `canReadRunDetails` | yes | maybe | yes if artifacts are remotely accessible |
| `canReadEventsJson` | yes | maybe | yes through hosted event source |
| `canStreamRunEvents` | yes | maybe | maybe through function streaming or SSE-compatible runtime |
| `canStartRuns` | yes | no | yes through Netlify API transport |
| `canDryRun` | yes | no | only if a remote dry-run simulation is designed |
| `canCancelRuns` | yes | no | yes through Netlify API transport |
| `canSubmitFollowups` | yes | no | yes after context delivery and artifact access are remote-safe |
| `canReviewGates` | yes | no | yes after hosted resume/review semantics exist |
| `canOpenLocalFiles` | yes | no | no |
| `canServeStaticAssets` | yes | no or external | usually external |

Capability names should be stable and more granular than the current coarse flags. The frontend can keep its existing behavior initially, but route handlers should enforce the matrix.

## Target Module Layout

The exact file names can change during implementation, but the boundaries should look like this:

```text
src/dashboard/api/
  app.js                  # createDashboardApi(dependencies)
  errors.js               # DashboardRequestError, error payloads, Hono helpers
  auth.js                 # token/session middleware and auth abstractions
  routes/
    health.js
    workflows.js
    runs.js
    run-events.js
    workflow-mutations.js
    run-mutations.js
    files.js
  serializers.js          # publicFlow, publicRunState, publicRun, response DTOs
  request.js              # query/body parsing helpers

src/dashboard/runtime/
  local-node.js           # mount Hono app in existing local HTTP server
  netlify-function.js     # export function handler for hosted runtime
  capabilities.js         # capability construction and enforcement

src/dashboard/storage/
  local-workflows.js      # list/load flow definitions
  local-runs.js           # paged run state, run lookup, graph/detail reads
  local-events.js         # durable event replay
  local-artifacts.js      # artifact/details file reads
  hosted-placeholder.js   # explicit unsupported storage for early hosted app

src/dashboard/transports/
  local-process.js        # wraps current local child-process workflow behavior
  local-in-process.js     # optional dry-run/resume wrapper around current functions
  netlify-api.js          # direct Agent Runner API design target
  types.js                # JSDoc typedefs for transport contracts

src/artifacts/             # eventual home for shared artifact persistence modules
src/followup/              # eventual home for follow-up/handoff planning and persistence
src/netlify/               # existing and future Netlify API/blob/runtime integration
src/runners/               # eventual home for shared runner clients and local runner adapters
src/workflow/              # existing and future workflow execution/state modules
```

The local HTTP server can keep static asset serving and fallback HTML outside Hono. The Hono app should own `/api/*`.

## Hono App Boundary

The API factory should be dependency-injected:

```js
createDashboardApi({
  runtime,
  auth,
  workflowStore,
  runStore,
  eventStore,
  artifactStore,
  liveRuns,
  runnerTransport,
  followupService,
  reviewService,
  logger,
  clock,
})
```

The Hono app owns:

- HTTP route definitions.
- Method handling.
- Query and body parsing.
- Auth middleware.
- Capability checks.
- Response serialization.
- Error mapping.
- Security headers for API responses.

The Hono app must not:

- Import `fs`, `http`, `child_process`, `open`, or Node path APIs except through small shared utilities that are runtime-safe.
- Spawn `bin/nax.js`.
- Read `.nax/workflows` directly.
- Call `listRunStates` or `listWorkflowStatePage` directly.
- Call Netlify CLI helpers directly.
- Know whether the API is local or hosted beyond `runtime.capabilities`.

## Runtime Context Contract

The runtime object describes the environment and provides request-independent facts:

```js
/**
 * @typedef {{
 *   mode: 'local-node' | 'netlify-function',
 *   deploymentMode: 'local' | 'desktop' | 'web',
 *   projectRoot?: string,
 *   capabilities: DashboardCapabilities,
 *   env: Record<string, string | undefined>,
 *   now: () => Date,
 *   logger: DashboardLogger,
 * }} DashboardRuntime
 */
```

The local runtime supplies:

- `projectRoot`.
- flow directories.
- local env.
- local token/session config.
- local static-serving config outside Hono.
- local process lifecycle cleanup hooks.

The Netlify Function runtime supplies:

- Netlify token source.
- site/project identifiers.
- function env.
- hosted capability set.
- storage/transport instances that do not depend on local project files.

## Storage Contracts

Storage is split by read domain. A single local implementation can compose these, but the interfaces should remain separate.

### Workflow Storage

```js
/**
 * @typedef {{
 *   listWorkflows: () => Promise<{ count: number, items: Array<object> }>,
 *   getWorkflow: (id: string) => Promise<object | null>,
 *   getWorkflowGraph: (id: string) => Promise<object | null>,
 * }} DashboardWorkflowStore
 */
```

Local implementation wraps `listFlows`, `loadFlow`, `publicFlow`, and `flowToGraph`.

Hosted implementation options:

- bundle selected workflow definitions into the deployed function;
- read workflow definitions from Netlify Blobs;
- fetch from a repository API;
- use direct API-provided runner templates if Netlify exposes them.

The plan does not choose the hosted workflow source yet. `nax-boo3.1` should record the available product constraints.

### Run Storage

```js
/**
 * @typedef {{
 *   listRunsPage: (input: RunsPageInput) => Promise<RunsPage>,
 *   getRun: (id: string) => Promise<object | null>,
 *   getRunGraph: (id: string) => Promise<object | null>,
 *   getRunDetails: (id: string) => Promise<object | null>,
 *   updateRunState?: (id: string, mutation: RunMutation) => Promise<object>,
 * }} DashboardRunStore
 */
```

Local implementation rules:

- `listRunsPage` must preserve paged durable listing and parse only selected workflow JSON files.
- `getRun` may use full lookup until a separate detail-pagination optimization exists.
- `getRunGraph` may sync submitted follow-ups as today, but that side effect should be documented and eventually separated.
- `getRunDetails` may use `buildRunDetails` and local artifact files.

Hosted implementation options:

- direct Agent Runner session APIs for remote run/session status;
- Netlify Blobs for dashboard-owned workflow snapshots;
- event callback ingestion into hosted storage;
- hybrid read model where Netlify API is authoritative for active/remote sessions and blobs are authoritative for Nax workflow structure.

### Event Storage

```js
/**
 * @typedef {{
 *   listEvents: (input: { runId: string, since?: number }) => Promise<{ events: Array<object>, errors: Array<object> }>,
 *   streamEvents?: (input: { runId: string, since?: number }) => AsyncIterable<object> | null,
 * }} DashboardEventStore
 */
```

Local implementation wraps active in-memory events and durable `events.jsonl`.

Hosted implementation should start with JSON polling if streaming constraints are unclear. SSE can be added when function streaming semantics are proven.

### Artifact Storage

```js
/**
 * @typedef {{
 *   buildRunDetails: (runId: string) => Promise<object | null>,
 *   readArtifactText?: (input: ArtifactReadInput) => Promise<string | null>,
 *   createFollowupContextPackage?: (input: FollowupContextInput) => Promise<FollowupContextPackage>,
 * }} DashboardArtifactStore
 */
```

Local implementation wraps `buildRunDetails` and `buildFollowupContextPackage`.

Hosted implementation must define where artifact bodies live. Do not assume local absolute paths are meaningful in hosted mode. Hosted responses should prefer stable artifact IDs and URLs over local paths.

## Live Run Registry

The current `runs` map in `createRequestHandler` mixes:

- active run identity;
- current stdout/stderr window;
- current event window;
- SSE clients;
- child-process cancel function;
- active-by-workflow de-duplication;
- finished-run eviction.

This should become a local runtime service:

```js
/**
 * @typedef {{
 *   listActiveRuns: () => Array<object>,
 *   getActiveRun: (id: string) => object | null,
 *   startLocalRun?: (input: StartRunInput) => Promise<object>,
 *   registerClient?: (runId: string, client: EventClient) => void,
 *   cancelLocalRun?: (id: string) => Promise<CancelLocalRunResult>,
 *   shutdown?: () => void,
 * }} LiveRunRegistry
 */
```

Hosted mode may provide an empty registry or a registry backed by remote polling. The API should not assume active runs are in memory.

## Runner Transport Contract

The transport layer starts, resumes, cancels, follows up, and inspects runner work. It does not own HTTP or dashboard storage.

```js
/**
 * @typedef {{
 *   kind: 'local-process' | 'local-in-process' | 'netlify-api',
 *   capabilities: RunnerTransportCapabilities,
 *   startWorkflowRun: (input: StartWorkflowRunInput) => Promise<StartWorkflowRunResult>,
 *   dryRunWorkflow?: (input: DryRunWorkflowInput) => Promise<DryRunWorkflowResult>,
 *   resumeWorkflowRun?: (input: ResumeWorkflowRunInput) => Promise<ResumeWorkflowRunResult>,
 *   cancelRun: (input: CancelRunInput) => Promise<CancelRunResult>,
 *   submitFollowup?: (input: SubmitFollowupInput) => Promise<SubmitFollowupResult>,
 *   cancelFollowup?: (input: CancelFollowupInput) => Promise<CancelFollowupResult>,
 *   approveReviewGate?: (input: ReviewGateInput) => Promise<ReviewGateResult>,
 *   cancelReviewGate?: (input: ReviewGateInput) => Promise<ReviewGateResult>,
 * }} AgentRunnerTransport
 */
```

### Local Process Transport

This wraps the current child-process behavior:

- uses `workflowCommand`;
- spawns `process.execPath bin/nax.js ...`;
- injects `NAX_EVENT_FD` and `NAX_EVENT_STREAM=jsonl`;
- parses runner event JSONL from fd 3;
- maintains bounded stdout/stderr;
- exposes local cancellation through SIGTERM and SIGKILL;
- preserves existing dashboard event semantics.

This transport can initially stay in the local server module, but the migration target is a dedicated module with tests.

### Local In-Process Transport

This wraps current in-process calls:

- `runWorkflow({ dryRun: true })` for dry-run;
- `resumeWorkflow` for review approval/resume.

It exists because dry-run and resume currently do not use the same child-process path as normal start. A future cleanup can merge them if that reduces complexity.

### Netlify API Transport

This is the new target transport. It must use direct Netlify API calls, not `netlify` CLI subprocesses.

Required design details before implementation:

- token source and precedence;
- token scope requirements;
- site/project identifier resolution;
- request base URL and API version;
- Agent Runner create/start endpoint mapping;
- Agent Runner session/follow-up endpoint mapping;
- cancel/archive endpoint mapping;
- polling strategy for session/run status;
- streaming strategy if available;
- rate-limit and retry model;
- idempotency keys for duplicate-submission protection;
- error mapping to dashboard error codes;
- how remote runner IDs map to dashboard `runId`, `runnerId`, `sessionId`, and `links`;
- how file changes, usage, statuses, and artifacts map into existing dashboard models.

The first Netlify API transport bead should be a design and spike bead, not a production mutation rollout.

## Error Model

Errors should become shared API primitives before broad Hono migration.

Current shape:

```json
{
  "error": {
    "statusCode": 400,
    "code": "invalid_cursor",
    "message": "Invalid runs cursor."
  }
}
```

Keep that shape for compatibility.

Add these standard codes:

- `unauthorized`
- `forbidden_host`
- `method_not_allowed`
- `not_found`
- `invalid_json`
- `payload_too_large`
- `invalid_cursor`
- `unsupported_capability`
- `invalid_transport`
- `duplicate_run`
- `runner_transport_error`
- `runner_rate_limited`
- `runner_auth_failed`
- `hosted_storage_unavailable`
- `event_stream_unavailable`

Hono middleware should map thrown `DashboardRequestError` objects to this JSON shape.

## Auth And Session Design

Local auth currently uses:

- random token generated at server start;
- token in launch URL query string;
- `x-nax-token` header;
- `nax_dashboard_token` cookie bootstrap;
- token required for sensitive reads and mutations;
- host-header allowlist for local server.

Keep that for local mode.

Hosted auth is unresolved and must not be guessed during implementation. The design bead should compare:

- Netlify Identity or team/session auth;
- signed dashboard URLs;
- CLI-issued short-lived token;
- Netlify token passed as user secret;
- function protected behind Netlify access controls.

The Hono app should consume an `auth` dependency:

```js
/**
 * @typedef {{
 *   authenticate: (request: Request) => Promise<AuthResult>,
 *   sessionHeaders?: (request: Request, auth: AuthResult) => HeadersInit,
 *   describe: () => { requiresAuth: boolean, mode: string },
 * }} DashboardAuth
 */
```

Local token auth is one implementation. Hosted auth is another.

## Static Assets

Static assets should not block Hono extraction.

Local mode can continue using Node filesystem static serving outside the Hono app:

- Vite build assets;
- SPA fallback for non-API paths;
- fallback `defaultIndexHtml`.

Hosted mode should normally serve assets through Netlify static hosting and route `/api/*` to a function. If a single-function deployment is desired later, that is a separate adapter.

## Migration Plan

### Phase 0 - Audit And Contracts

Goal: produce the concrete route/runtime inventory and define interfaces without moving behavior.

Tasks:

- Expand `nax-boo3.1` into the route inventory from this plan.
- Add a top-level `src/` ownership inventory for files that the dashboard server currently imports directly or indirectly.
- Add a route test inventory mapping existing tests to routes.
- Decide whether to add Hono as a dependency now or after response/error extraction.
- Define JSDoc typedefs for runtime, capabilities, stores, and transports.
- Identify which current tests are contract tests and which are implementation tests.
- Identify files that can move as part of boundary extraction versus files that need temporary shim exports.

Exit criteria:

- The team can point at each current route and name its target owner.
- The team can point at each dashboard-adjacent root `src/` file and name its target domain or justify leaving it shared.
- No implementation has started beyond docs/types if desired.

### Phase 1 - Shared API Primitives

Goal: make current Node server and future Hono app share response/error/auth semantics.

Tasks:

- Extract `DashboardRequestError`, `errorPayload`, and standard error mapping.
- Extract token/session helper functions.
- Extract capability construction.
- Extract serializers: `publicFlow`, `publicRunState`, `publicRunOptions`, and related DTO helpers.
- Keep `createRequestHandler` behavior unchanged.
- Place new dashboard-specific primitives under `src/dashboard/api/` rather than adding more root-level `src/` files.

Exit criteria:

- Existing dashboard server tests pass unchanged or with minimal import updates.
- No route behavior changes.

### Phase 2 - Local Storage Adapters

Goal: move read-only storage logic behind local adapters.

Tasks:

- Create local workflow store around `listFlows`, `loadFlow`, and `flowToGraph`.
- Create local run store around paged durable runs, durable lookup, run graph, and run details.
- Create local event store around active/durable event replay.
- Preserve `/api/runs` pagination invariant.
- Add unit tests for adapters independent of HTTP.
- Use this phase to decide whether shared state modules stay at root temporarily or move under `src/workflow/state/` with compatibility shims.

Exit criteria:

- `createRequestHandler` can call stores for read-only routes.
- No route paths or response shapes change.

### Phase 3 - Hono Read-Only App Mounted Locally

Goal: introduce Hono for read-only `/api/*` routes while the local server still serves static assets and owns live runtime.

Routes:

- `/api/health`
- `/api/workflows`
- `/api/workflows/:id`
- `/api/workflows/:id/graph`
- `/api/runs`
- `/api/runs/:id`
- `/api/runs/:id/graph`
- `/api/runs/:id/details`
- `/api/runs/:id/events.json`

Implementation direction:

- Add `createDashboardApi`.
- Mount it from the existing Node server for matching read-only routes.
- Keep SSE and mutation routes in the current handler until their adapters exist.
- Keep static asset handling unchanged.

Exit criteria:

- Existing API tests pass.
- New Hono route tests cover the read-only contract.
- Local dashboard still works.

### Phase 4 - Event Stream Adapter

Goal: extract event stream handling without coupling Hono to Node `ServerResponse`.

Tasks:

- Keep `/api/runs/:id/events.json` as the portable baseline.
- Define streaming capability separately from event storage.
- Implement local SSE through a local adapter or Hono streaming helper if clean.
- Make hosted mode return `event_stream_unavailable` or client-fallback instructions until proven.

Exit criteria:

- Active local run events still stream.
- Durable replay still works.
- The frontend can tolerate JSON polling fallback in a later hosted mode.

### Phase 5 - Runner Transport Extraction

Goal: move workflow start, dry-run, resume, cancel, and follow-up submission behind transport/service interfaces.

Tasks:

- Extract local process transport for normal workflow start.
- Extract local in-process transport for dry-run and review resume.
- Extract run cancellation service that composes local cancellation, remote stop attempts, durable state mutation, and event emission.
- Extract follow-up service boundary around context package, delivery, submission, and persistence.
- Keep local behavior unchanged.
- Create dashboard transport modules under `src/dashboard/transports/` and avoid adding new transport files at `src/` root.
- Decide whether `local-runner.js` and Agent Runner result/sync helpers should move to `src/runners/` in this phase or a follow-up cleanup bead.

Exit criteria:

- Mutation routes call transport/service interfaces.
- Current duplicate-run, cancel, review, and follow-up tests still pass.

### Phase 6 - Hono Mutation Routes

Goal: move mutation routes into Hono after transports exist.

Routes:

- `/api/workflows/:id/dry-run`
- `/api/workflows/:id/runs`
- `/api/runs/:id/cancel`
- `/api/runs/:id/review/approve`
- `/api/runs/:id/review/cancel`
- `/api/runs/:id/followups`
- `/api/runs/:id/followups/cancel`
- `/api/files/open`

Implementation direction:

- Each route checks capabilities first.
- Local adapter supplies full capability set.
- Hosted placeholder adapter returns typed unsupported errors.

Exit criteria:

- All `/api/*` routes are owned by Hono.
- Local Node server primarily mounts Hono and serves assets.

### Phase 7 - Netlify Function Read-Only Adapter

Goal: prove the same Hono app can run in a Netlify Function for a small read-only subset.

Tasks:

- Add Netlify Function handler wrapper.
- Add hosted runtime with explicit limited capabilities.
- Add hosted unsupported storage where no source is configured.
- Add deployment docs for function route wiring.
- Add tests that instantiate the app with hosted placeholder adapters.

Exit criteria:

- A Netlify Function can answer `/api/health`.
- Unsupported routes return typed capability/storage errors, not crashes.

### Phase 8 - Netlify API Transport Design Spike

Goal: turn the transport concept into an implementable direct Netlify API plan.

Tasks:

- Identify required Netlify API endpoints and payloads.
- Document token scopes.
- Build a thin Netlify API client module with typed request/response normalization.
- Add mocked contract tests for status mapping and error mapping.
- Decide polling versus streaming for hosted updates.
- Put reusable Netlify API client code under `src/netlify/`; keep dashboard-only glue under `src/dashboard/transports/`.

Exit criteria:

- A follow-up implementation bead can build the first direct API operation without rediscovering endpoint semantics.

### Phase 9 - Hosted Mutations

Goal: enable hosted start/cancel/follow-up behavior incrementally.

Recommended order:

1. Start simple one-step Agent Runner work through direct API.
2. Poll/read remote status.
3. Cancel/archive remote runner.
4. Submit follow-up session.
5. Persist enough dashboard state for graph/details.
6. Add review-gate operations if the remote API supports them.

Exit criteria:

- Hosted dashboard can start and observe real Agent Runner work without shelling out.

## Expanded Bead Recommendations

The current epic has three design tasks:

- `nax-boo3.1` - Audit current dashboard server runtime assumptions.
- `nax-boo3.2` - Specify Hono API app and runtime adapter boundaries.
- `nax-boo3.3` - Specify agent-runner transport interface and Netlify API transport.

Those are good first tasks, but implementation should not stop there. After those close, create follow-up implementation beads roughly like this:

1. Extract shared dashboard API errors, serializers, and auth helpers.
2. Inventory root-level `src/` files and assign target ownership domains.
3. Add local workflow/run/event/artifact storage adapters.
4. Add Hono dependency and read-only Hono app.
5. Mount read-only Hono app in local server.
6. Extract local live run registry.
7. Extract local process runner transport.
8. Extract local dry-run/resume transport.
9. Move SSE/event handling behind adapter.
10. Move mutation routes into Hono.
11. Move obvious dashboard-owned helpers into `src/dashboard/api`, `src/dashboard/runtime`, `src/dashboard/storage`, and `src/dashboard/transports`.
12. Move obvious shared domain modules from `src/` root into `src/netlify`, `src/workflow`, `src/artifacts`, `src/followup`, or `src/runners` in small compatibility-preserving batches.
13. Add hosted placeholder runtime and Netlify Function wrapper.
14. Design and test Netlify API client.
15. Implement first direct Netlify API start/cancel path.
16. Implement hosted run polling/status mapping.
17. Implement hosted follow-up context delivery and submission.
18. Add hosted artifact/details source.

Each implementation bead should state whether it is behavior-preserving local refactor, hosted read-only enablement, or hosted mutation enablement.

## Testing Strategy

Keep test layers separate:

- Pure unit tests for serializers, errors, capability checks, cursor parsing, and response DTOs.
- Local adapter tests for workflow, run, event, and artifact stores.
- Transport tests with fake process/API dependencies.
- Hono app tests using `app.request()` or equivalent fetch-style tests.
- Existing Node server tests for local mounting and static asset behavior.
- Dashboard E2E smoke tests for user-visible workflows.
- Import-boundary tests or lightweight scans that prevent new dashboard API code from importing root-level local-only modules directly once adapters exist.

Important regression tests:

- `/api/runs` still slices durable state before parsing workflow JSON.
- Auth failures keep the same error shape.
- Capability-disabled hosted routes return typed 501 or 403 responses.
- Query-token bootstrap still sets the local session cookie.
- Active local runs remain visible alongside durable paged runs.
- SSE replay and JSON event replay return compatible event shapes.
- Start run duplicate protection still works.
- Cancel run still reports local and remote cancellation results honestly.
- Follow-up submission still persists source workflow and fresh pseudo-workflow results.
- File moves preserve CLI imports or provide temporary shims with removal beads.
- No new top-level `src/` files are added for dashboard API, runtime, storage, or transport work.

## Documentation Updates Completed

Closeout docs now cover:

- Local versus hosted capability differences.
- Hono app factory and runtime adapter boundaries.
- Local storage/event/transport adapters.
- Netlify Function wrapper behavior.
- Direct Netlify API client notes and hosted token expectations.
- Unsupported hosted behavior and typed error posture.
- `src/` ownership rules and compatibility shims.

## Open Questions

These remain future product/design questions after the first hosted transport implementation:

1. What is the hosted source of truth for workflow definitions?
2. What is the hosted source of truth for Nax workflow state and graph structure?
3. What final Netlify API endpoint names and token scopes are required for Agent Runner start, session follow-up, cancel/archive, status, usage, and artifacts?
4. Should hosted event updates stay polling-first, or is function/SSE streaming reliable enough for a later runtime?
5. How should hosted dashboard auth work for local users, team users, and CI-generated dashboards?
6. How should local absolute artifact paths be represented in hosted mode?
7. Does hosted dry-run mean "validate request payload" or "simulate full Nax workflow planning"?
8. What idempotency key should prevent duplicate hosted runner submissions?
9. How should hosted mode handle local uncommitted changes that a remote runner cannot see?
10. Which non-fresh-runner follow-up modes are supported by Netlify APIs directly?

## Acceptance Criteria For `nax-boo3`

The epic is complete when:

- The route inventory has been verified against `src/dashboard/server.js`.
- Hono owns the `/api/*` route behavior through `createDashboardApi()`.
- Local behavior is preserved through local runtime, storage, event, transport, and mutation adapters.
- Hosted Netlify Function behavior is capability-driven and does not assume local files or child processes.
- Direct Netlify API transport supports hosted start, cancel, polling, `events.json`, details, graph, fresh-runner follow-ups, and follow-up cancel.
- Hosted limitations are explicit and typed.
- `/api/runs` pagination still slices durable state before parsing workflow JSON.
- Top-level `src/` sprawl has an ownership inventory; dashboard-owned code has moved under `src/dashboard/*`; Netlify-owned modules have `src/netlify/*` homes with root compatibility shims.
- Validation covers Hono routes, local server mounting, local storage, local transports, hosted function behavior, direct Netlify API client behavior, import-boundary guardrails, and source cleanup shims.

## Plan Review Prompt

Use this prompt for the next planning-workflow refinement round:

```text
Carefully review this entire plan for me and come up with your best revisions in terms of better architecture, new features, changed features, etc. to make it better, more robust/reliable, more performant, more compelling/useful, etc. For each proposed change, give me your detailed analysis and rationale/justification for why it would make the project better along with the git-diff style change versus the original plan shown below:

<paste this complete plan>
```
