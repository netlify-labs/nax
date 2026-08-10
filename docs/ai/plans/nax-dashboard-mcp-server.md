# Nax Control Plane MCP Server

**Status:** Proposed design (2026-08-08)
**Primary client:** Claude Code
**Current scope:** Local `nax dashboard` adapter for remote Netlify Agent Runner workflows
**Portability constraint:** The same MCP contract must later fit Electron/Tauri and an authenticated hosted control plane on Netlify without redesigning the tools.

## Decision

Define a runtime-neutral nax MCP contract and control-plane interface. Implement only the local dashboard adapter now:

1. The MCP tools call a `NaxControlPlane` application contract, never dashboard internals, local files, child processes, or Netlify Functions directly.
2. In the first implementation, `nax dashboard` is the long-lived local control plane for project scope, Netlify auth context, workflow execution, run state, events, cancellation, review gates, retries, and follow-ups.
3. When the local dashboard starts, it publishes a private, per-project connection record. Claude launches `nax mcp` as a stdio adapter that discovers the dashboard and calls its authenticated local API.
4. A future desktop shell may own the same control plane in-process or as a sidecar. A future hosted deployment may expose it through authenticated Streamable HTTP backed by Netlify Functions and durable storage.
5. Tool names, inputs, result shapes, resource URIs, idempotency rules, and run semantics stay the same across those runtimes. Only connection, authentication, storage, and event-delivery adapters change.

This is the SoloTerm pattern adapted to nax: a stable stdio command for agent clients, backed by the already-running local application. It avoids creating a second workflow engine or asking users to put a random dashboard port into Claude configuration.

Desktop and hosted deployment are architectural constraints only. They are not implementation or rollout work in this proposal.

Do not make the official Netlify MCP a dependency of this feature. The two servers are complementary:

- Netlify MCP: general Netlify account, project, deploy, forms, environment, and extension management.
- Nax MCP: workflow planning, remote Agent Runner execution, observation, and control.

## Research findings

### SoloTerm patterns worth adopting

SoloTerm's MCP implementation has several useful properties:

- A bundled stdio helper connects MCP clients to the running application; users do not configure a public host or port.
- Project scope and caller identity are explicit and inspectable.
- Agent launch, process observation, output reading, and coordination are separate tool groups.
- Spawn responses contain bootstrap instructions and suggested next actions.
- The helper reconnects across application restarts, and queued work is bounded.
- Long-running work is observed through state and output tools rather than blind terminal scraping.
- Durable scratchpads/todos and narrow worker ownership are treated as coordination primitives, not incidental chat history.

Relevant references:

- <https://soloterm.com/docs/mcp-tools/overview>
- <https://soloterm.com/docs/mcp-tools/agent-terminal>
- <https://soloterm.com/docs/mcp-tools/project>
- <https://soloterm.com/docs/mcp-tools/process>
- <https://soloterm.com/docs/mcp-tools/output>
- <https://soloterm.com/docs/mcp-tools/coordination>
- <https://soloterm.com/docs/integrations/mcp-server>
- <https://soloterm.com/docs/workflows/agents-spawning-agents>
- <https://soloterm.com/docs/workflows/agent-orchestration>

Nax should copy the lifecycle and agent ergonomics, not SoloTerm's entire terminal/workspace surface. Nax already has a narrower and more valuable domain boundary: remote workflows and Agent Runner sessions.

### Current nax seams

The repository already has most of the application layer the MCP needs:

- `src/cli/main.js` resolves the project and Netlify context before starting the dashboard.
- `src/dashboard/server.js` owns a token-protected loopback HTTP server and the live-run registry.
- `src/dashboard/api/app.js` exposes runtime-neutral workflow, run, details, event, start, cancel, review, retry, and follow-up routes.
- `src/dashboard/runtime/netlify-function.js` already composes that API without the local Node HTTP listener, which is an early hosted-runtime seam.
- `src/dashboard/transports/netlify-api.js` already presents a hosted-shaped Agent Runner transport for dashboard operations.
- `src/dashboard/api/capabilities.js` describes which operations the runtime supports.
- `src/dashboard/services/mutations.js` centralizes Agent Runner mutations.
- `src/dashboard/storage/*` and `src/dashboard/events/*` provide durable reads and event replay.
- `nax-agent-runner-sdk` owns remote Agent Runner protocol, handles, reconciliation, retry, landing, and auth behavior.

The MCP adapter should call these application contracts. It must not shell out to `nax run`, scrape terminal output, or call provisional Netlify endpoints itself.

### Netlify MCP audit

The checked local repository is:

- Path: `_misc/netlify-mcp`
- Remote: `netlify/netlify-mcp`
- Commit: `bcc168a42ea34e43a20582f8b0f78947ffaa3e50` (2026-08-03)
- Package: `@netlify/mcp` 1.15.1

Its registered domains are user, team, project, deploy, and extension, plus `netlify-coding-rules`. Its concrete operations include project lookup/creation/settings, deploy lookup/submission, forms, environment variables, visitor access, extensions, teams, and user identity.

There are no Agent Runner, Agent Runner session, nax workflow, workflow run, retry, follow-up, or orchestration tools. Searches for `agent runner`, `agent-runner`, and `workflow` find no applicable tool implementation.

Useful implementation ideas from Netlify MCP:

- Use the official v2 TypeScript server package and `serveStdio(() => buildServer())` so one server can negotiate current and legacy MCP protocol eras.
- Register tools by a small domain taxonomy.
- Annotate read-only tools.
- Keep local stdio and remote HTTP hosting separable.

Patterns not to carry into nax:

- Do not group unrelated operations behind a selector union. Give common nax actions explicit tool names.
- Do not return JSON encoded inside a text string as the only result. Return `structuredContent` plus a concise text summary.
- Do not use `any`; repository JavaScript must use precise JSDoc shapes and TypeScript contracts must use explicit types.
- Do not duplicate Netlify token discovery. The dashboard and `nax-agent-runner-sdk` already own it.

## Goals

- Let Claude discover workflows available in the current project.
- Let Claude validate and start a remote nax workflow with explicit agent/model/effort instances.
- Let Claude start a single remote Agent Runner with a prompt.
- Let Claude inspect, wait for, cancel, retry, review, and follow up on runs.
- Keep the dashboard UI, CLI, and MCP on the same run state and mutation services.
- Keep the MCP contract independent of whether those services run in a CLI process, desktop application, or Netlify-hosted control plane.
- Make retries of MCP calls idempotent.
- Make project, Netlify site, branch, and cost-bearing execution explicit before a run starts.
- Return compact, structured results with useful next actions.

## Non-goals

- A general-purpose terminal or shell MCP.
- Local Claude/Codex/Gemini process spawning.
- Cross-project orchestration from one MCP connection.
- Netlify project/deploy/environment management already covered by Netlify MCP.
- A cloud-hosted public MCP endpoint in the first release.
- Implementing or selecting an Electron/Tauri desktop shell.
- Designing the hosted dashboard product, login UI, tenancy model, or billing model.
- An MCP-only workflow or run state model.
- Arbitrary reads of local filesystem paths.

## Architecture

The stable architecture is the control-plane boundary, not localhost:

```text
MCP client
    |
    | stdio locally, Streamable HTTP when hosted
    v
MCP protocol adapter
    |
    | NaxControlPlane contract
    v
application services
    |
    +-- workflow catalog
    +-- run planning and idempotency
    +-- workflow execution port
    +-- run/event/artifact stores
    +-- mutation services
    +-- nax-agent-runner-sdk
             |
             v
      Netlify Agent Runner API
```

The current local deployment is one composition of those layers:

```text
Claude Code
    |
    | stdio MCP
    v
`nax mcp` adapter
    |
    | discover by canonical project root
    | authenticated loopback HTTP (`x-nax-token`)
    v
`nax dashboard`
    |
    +-- dashboard API and capabilities
    +-- workflow/run stores and event log
    +-- live-run registry
    +-- mutation services
    +-- nax-agent-runner-sdk
             |
             v
      Netlify Agent Runner API
```

### Runtime-neutral control-plane contract

Define the MCP layer against an explicit interface whose operations match the application capabilities, for example:

```text
NaxControlPlane
  getContext(scope, actor)
  listWorkflows(scope, query)
  getWorkflow(scope, workflowId)
  createWorkflowPlan(scope, actor, input)
  createAgentRunPlan(scope, actor, input)
  startPlan(scope, actor, planId, requestId)
  listRuns(scope, query)
  getRun(scope, runId, view)
  waitForRun(scope, runId, cursor, timeout)
  cancelRun(scope, actor, target)
  retryAgentRun(scope, actor, target)
  submitFollowup(scope, actor, input)
  resolveReviewGate(scope, actor, input)
```

This is an application interface, not an HTTP or MCP interface. The local dashboard API, a desktop IPC/sidecar, and hosted Netlify Functions can implement or expose it without leaking their transport into tool handlers.

The interface must receive two explicit values on every call:

- `scope`: stable account/project/site/repository identity.
- `actor`: authenticated caller identity and authorization context.

Each MCP operation has one explicit effective scope. The connection keeps a default project hint for backward compatibility, while `context_get(project_ref)` resolves another project and returns the opaque `scope_id` required by later calls. Local mode uses canonical roots and the private dashboard registry; the path itself is not the public project ID. Desktop mode may resolve scope from an application workspace, and hosted mode must resolve it from verified user authentication plus an authorized account/project binding. Tool arguments never contain bearer tokens or silently choose an account.

If a local project does not yet have a stable nax project ID, generate and persist one in project metadata before advertising MCP resources. Moving the directory must not change public run/resource identity. The canonical path hash remains acceptable only as an internal lookup key for the local dashboard registry.

### Portability invariants

These rules keep the first local implementation portable:

- **Stable IDs over paths:** workflow, plan, run, artifact, account, project, and site IDs are the durable contract. An absolute project root is optional local metadata, never an entity ID.
- **No process ownership in domain services:** application services do not assume they can spawn a child CLI, listen on localhost, open a browser, or receive Unix signals. Those are local runtime adapter behaviors.
- **Pluggable execution:** the control plane calls a `WorkflowExecutionBackend`. Local mode may adapt the current child/in-process runner, while hosted mode invokes the workflow engine and Agent Runner SDK without requiring a resident CLI process.
- **Async execution:** starting work persists intent/handle state and returns an accepted run. Completion is observed later through snapshots and cursor-based events. No tool requires one request to stay alive for the duration of an Agent Runner.
- **Durable idempotency:** plans, request IDs, SDK handles, and start state live behind storage interfaces. Correctness cannot depend on one Node process retaining an in-memory map.
- **Durable event cursors:** events have stable sequence/cursor semantics that survive process restarts and function invocations.
- **Capability negotiation:** `context_get` reports runtime and capabilities. Unsupported actions disappear when dynamic tool filtering is available or fail with `unsupported_capability` and a useful alternative.
- **Transport-neutral errors:** domain error codes do not mention localhost. Runtime adapters may add local recovery details such as `dashboard_not_running`.
- **Opaque artifact access:** MCP resources use nax artifact IDs and authorized resource reads, not arbitrary `file://` paths. Local storage, desktop storage, Netlify Blobs, or another hosted store can back the same resource.
- **Request-bounded work:** planning, starting, state reads, and control operations fit within one bounded request. Background reconciliation and cleanup are separate jobs.
- **Authorization at the service boundary:** every read and mutation checks the actor against the scope; a trusted local transport is not treated as the universal auth model.

### Runtime compositions

| Runtime | MCP transport | Control-plane connection | Auth | Durable state |
|---|---|---|---|---|
| Local CLI/dashboard (now) | stdio from Claude | Authenticated loopback HTTP discovered from a private registry | Dashboard capability token plus stable local project metadata | Existing `.nax` stores plus new storage interfaces |
| Electron/Tauri desktop (future) | Bundled stdio helper or local Streamable HTTP | In-process service, IPC, or managed sidecar | Desktop user/session plus selected project | App data store and artifact storage |
| Hosted Netlify site (future) | Streamable HTTP | Authenticated control-plane routes/functions | User login/OAuth and account/project authorization | Durable database/Blobs plus Agent Runner SDK handles |

The table is a compatibility target, not a commitment to build the future rows now.

### Local v1: why stdio in front of the dashboard API

Claude Code treats stdio as the normal transport for local tools. The router derives the current project as its default hint, so checked-in and user-level configurations are both path-free:

```json
{
  "mcpServers": {
    "nax": {
      "type": "stdio",
      "command": "nax",
      "args": ["mcp"]
    }
  }
}
```

A direct Streamable HTTP configuration would need a fixed port or a config rewrite every time the dashboard chooses an available port. It also becomes awkward when more than one project dashboard is running. The stdio adapter gives clients one stable command and keeps dashboard discovery private.

Do not proxy terminal bytes. `nax mcp` is an MCP server whose handlers call the dashboard's typed JSON API.

### Local v1 process ownership

- The dashboard may outlive any one Claude session.
- Claude owns the `nax mcp` stdio child.
- Closing Claude stops only the adapter, never the dashboard or remote runs.
- Closing the dashboard removes its instance record and stops its local live-run processes according to existing dashboard shutdown behavior. Remote Agent Runner state remains governed by current cancellation semantics.
- The adapter resolves the selected scope's dashboard instance before each tool call, so restarting `nax dashboard` does not require editing `.mcp.json` or restarting Claude.

## Local dashboard instance discovery

### Registry

On successful listen, `nax dashboard` writes an atomic JSON record under a user-private runtime directory, not inside the repository:

```text
${XDG_RUNTIME_DIR:-platform-temp}/nax/<uid>/dashboards/<sha256(realProjectRoot)>.json
```

Example record:

```json
{
  "v": 1,
  "instanceId": "01K...",
  "pid": 12345,
  "projectRoot": "/absolute/real/path",
  "origin": "http://127.0.0.1:53734",
  "token": "random-dashboard-token",
  "startedAt": "2026-08-08T18:00:00.000Z",
  "version": "2.0.0"
}
```

Requirements:

- Directory mode `0700`; file mode `0600` where supported.
- Atomic temporary-file-plus-rename writes.
- Canonical `realpath` project identity, with normalized case on Windows.
- Loopback origins only. The MCP adapter must reject registry records pointing to a non-loopback host.
- Validate PID liveness and authenticated `/api/health` before using a record.
- Delete the record only if its `instanceId` still belongs to the closing process.
- Remove stale records during dashboard start and MCP discovery.
- Permit one advertised dashboard per canonical project root. A second dashboard may run for development, but it must use an explicit unadvertised instance flag rather than racing for the default registry entry.

The token is already a dashboard capability secret. Never print the registry contents, include it in tool responses, or write it to the repository.

### Local project resolution

`nax mcp` resolves its default project hint with this precedence:

1. `--project-root`
2. `CLAUDE_PROJECT_DIR`
3. First MCP root, when supported by the connected client
4. Current working directory

The chosen root is only a default. `context_get` accepts either an exact `project_ref` or a previously returned `scope_id`. Absolute paths resolve directly; exact short project/site/repository aliases resolve against running private dashboard advertisements. Ambiguous and unknown aliases fail closed. There is deliberately no mutable `select_project` operation: each later tool receives `scope_id`, so concurrent calls cannot change one another's project.

`context_get` always reports the runtime, stable account/project/site scope, current branch, authenticated actor summary, and capabilities so the agent can verify scope. Local mode may additionally report the effective project root and dashboard instance as diagnostic metadata. Every returned tool follow-up carries the same `scope_id` automatically.

## Tool surface

Keep tools explicit and grouped by workflow. The server name already supplies the `nax` namespace, so tool names should not repeat it.

Tool names use the singular entity-first `noun_action` convention. MCP clients expose a flat tool list, so stable entity prefixes keep related operations adjacent and make the exact mutation target visible in the name.

### Context and discovery

| Tool | Purpose | Important inputs |
|---|---|---|
| `context_get` | Resolve a project and confirm runtime/control-plane health, effective scope, selected Netlify target, branches, capabilities, and agent catalog. | `project_ref?` or `scope_id?` |
| `workflow_list` | List concise workflow summaries. | Optional source filter and limit |
| `workflow_get` | Read one workflow, its steps, defaults, accepted instances, and optionally its graph. | `workflow_id`, `include_graph?` |

`context_get` is the preferred first call. Every discovery response includes exact IDs accepted by later tools. All other tools accept optional `scope_id`; omission intentionally uses the default project hint.

### Planning and execution

| Tool | Purpose | Important inputs |
|---|---|---|
| `workflow_plan` | Normalize instances, resolve the remote site/branch, use nax's shared planning/validation core, and return an expiring plan. | `workflow_id`, `branch?`, `instances?`, `step_instances?`, `context?`, `only_step?`, `from_step?` |
| `agent_run_plan` | Validate a single remote Agent Runner request and return an expiring plan. | `prompt`, `instance`, `branch?` |
| `run_start` | Start exactly the previously validated workflow or agent-run plan. Repeated calls return the same run. | `plan_id`, optional caller `request_id` |

Both plan tools force the Netlify API transport in v1. `github`, `local`, and `auto` are not accepted through MCP because the product promise is remote Agent Runner execution. A later release may add an explicit execution mode after its semantics are equally observable.

An agent instance is always an object:

```json
{
  "agent": "claude",
  "model": "claude-opus-5",
  "effort": "high",
  "label": "deep-review"
}
```

Provider-only arrays and separate `models`/`efforts` maps are rejected with the same `invalid_instance_contract` guidance as the dashboard.

The plan response includes:

- `plan_id` and expiry.
- Stable control-plane scope; local mode may include the canonical project root as diagnostic metadata.
- Netlify account and site name/ID.
- Target branch and known remote-state caveats.
- Workflow steps that will run.
- Resolved instances per step.
- Number of Agent Runner submissions expected.
- Dry-run warnings.
- A concise human-readable summary suitable for Claude's tool approval UI.

Plans are held by the active control plane, expire after ten minutes, and are bound to the stable account/project/site scope, actor authorization, branch, and normalized request hash. They are not bound to a process ID or localhost port. Starting a plan does not accept overrides; changed inputs require a new plan.

`run_start` is idempotent. The control plane stores `plan_id`/`request_id` with the durable run and returns the original run when it receives the same key again. It must never create a second remote run because Claude or the MCP transport retried an ambiguous call.

Use a persisted plan state machine rather than a check-then-start boolean:

```text
prepared -> starting -> started
                    \-> failed
```

- Atomically claim `prepared -> starting` before launching the workflow or Agent Runner.
- Concurrent callers that see `starting` wait briefly for the durable run binding, then return a recoverable `run_start_in_progress` response with the same plan ID.
- Persist the durable workflow run ID or SDK handle before returning success.
- A retry against `started` returns the original run.
- A control-plane runtime restart that finds a stale `starting` plan reconciles it against durable nax run state and the Agent Runner SDK request marker. It never blindly replays a remote create.
- `failed` is retryable only when the recorded failure proves that no remote mutation was transmitted; ambiguous creates require SDK reconciliation first.

### Observation

| Tool | Purpose | Important inputs |
|---|---|---|
| `run_list` | List compact recent/active run summaries with pagination. | `status?`, `workflow_id?`, `limit?`, `cursor?` |
| `run_get` | Read one run at a requested detail level. | `run_id`, `view: summary | details | graph | events`, `section_id?`, `since?` |
| `run_wait` | Wait a bounded interval for new events or a meaningful state transition. | `run_id`, `since?`, `timeout_ms?` |

`run_wait` is the macro that replaces blind polling. It returns immediately when the run becomes terminal, reaches a human review gate, produces new events, stalls, or reaches the bounded timeout. Cap a single call at 30 seconds and return the next event cursor.

Large result bodies must stay out of conversation context by default:

- `run_list` returns summaries only.
- `run_get(view: details)` returns the final summary and a compact section index by default, with an opt-in section ID for one full result.
- `run_get(view: events)` is cursor-based and bounded.
- Never return raw terminal buffers or every artifact in one response.
- Return resource links for larger read-only content.

### Control

| Tool | Purpose | Important inputs |
|---|---|---|
| `run_cancel` | Cancel one workflow run or one specifically identified active agent run. | `run_id`, optional exact `agent_run_id`, `reason?` |
| `agent_run_retry` | Retry one terminal failed agent run in an active workflow. | `run_id`, `agent_run_id` |
| `agent_run_followup` | Continue one agent-run result thread or start a fresh runner with selected artifacts. | `run_id`, `agent_run_id`, `prompt`, `mode?`, `artifacts?`, `instances?` |
| `review_gate_resolve` | Approve or cancel one awaiting human-review step. | `run_id`, `review_gate_id`, `decision`, `reason?` |

There is no broadcast, cancel-all, approve-all, or multi-scope operation. Each call targets one explicit project scope, and exact entity IDs are required for mutations. When a target is ambiguous, the error returns candidates and a suggested `run_get` call.

## Resources and prompts

Expose read-only resources for durable entities. Include the stable scope ID so URIs remain globally meaningful across local, desktop, and hosted runtimes:

```text
nax://scopes/{scope_id}/context
nax://scopes/{scope_id}/workflows/{workflow_id}
nax://scopes/{scope_id}/runs/{run_id}
nax://scopes/{scope_id}/runs/{run_id}/details
nax://scopes/{scope_id}/runs/{run_id}/events?since={cursor}
nax://scopes/{scope_id}/runs/{run_id}/artifacts/{artifact_id}
```

Resource reads resolve IDs through control-plane stores. They never accept arbitrary absolute paths. Artifact reads must validate that the artifact belongs to the scoped project and run, reject traversal/symlink escape, enforce a size limit, and return a resource link when content is too large.

Ship two MCP prompts:

- `run_remote_workflow`: context check -> workflow discovery -> plan -> start -> bounded wait -> result inspection.
- `follow_up_on_run`: inspect targets/artifacts -> choose thread or fresh runner -> submit -> monitor.

The workflow prompt should instruct the lead agent to keep independent lanes bounded and to inspect actual results rather than treating summaries as proof.

## Result contract

Every successful tool returns both a short text summary and structured content:

```json
{
  "ok": true,
  "data": {},
  "context": {
    "runtime": "local-dashboard",
    "scope": {
      "scopeId": "scope_01K...",
      "projectId": "proj_01K...",
      "siteId": "site-id"
    },
    "local": {
      "projectRoot": "/repo",
      "dashboardInstanceId": "01K..."
    }
  },
  "next_actions": [
    {
      "tool": "run_wait",
      "arguments": { "run_id": "2026-...", "since": 12 }
    }
  ]
}
```

The text block should summarize the decision-relevant fields in a few lines. It must not duplicate a large JSON object.

Recoverable domain failures are tool results with `isError: true` and the same stable shape:

```json
{
  "ok": false,
  "error": {
    "code": "dashboard_not_running",
    "message": "No running nax dashboard was found for /repo.",
    "recoverable": true,
    "details": {
      "projectRoot": "/repo"
    }
  },
  "next_actions": [
    {
      "kind": "command",
      "command": "nax dashboard --no-open"
    }
  ]
}
```

Throw protocol-level exceptions only for invalid MCP framing or an unexpected server bug.

### Error mapping

| Condition | Code | Recovery |
|---|---|---|
| Control plane cannot be reached | `control_plane_unavailable` | Return runtime-specific connection or login guidance. |
| No live registry entry | `dashboard_not_running` | Start `nax dashboard --no-open` in the scoped project. |
| Stale or unreachable entry | `dashboard_unreachable` | Remove stale entry automatically; restart dashboard. |
| Registry project differs | `project_scope_mismatch` | Report both canonical roots; do not switch silently. |
| No token/account/site | Existing `no_token`, `bad_token`, `no_site`, or `no_access` | Return current context plus the exact nax/Netlify setup action. |
| Unknown workflow/step/run | Existing not-found code plus fuzzy suggestions | Call the relevant list/get tool. |
| Invalid instance | Existing agent configuration code | Return supported agents/models/efforts for that transport. |
| Active duplicate workflow | `duplicate_run` | Return the existing run ID and suggest `run_get`/`run_wait`. |
| Expired plan | `run_plan_expired` | Re-run the corresponding plan tool. |
| Reused request with different payload | `idempotency_conflict` | Generate a new request ID after reviewing the differing plan. |
| Ambiguous retry/follow-up target | Existing ambiguity code | Return exact candidate target IDs. |
| Review is not awaiting input | `no_review_gate` | Refresh the run before another mutation. |
| MCP/dashboard version mismatch | `dashboard_version_mismatch` | Restart both from the same installed nax version. |
| Runtime lacks an operation | `unsupported_capability` | Return the runtime capability map and supported alternative. |
| Actor cannot access scope | `scope_forbidden` | Re-authenticate or choose an authorized account/project outside the tool call. |

Preserve control-plane application error codes instead of inventing aliases in the MCP adapter. The local adapter maps existing dashboard codes into that taxonomy. Add `recoverable`, `details`, and `next_actions` at the MCP boundary.

## Tool annotations and safety

Use MCP annotations consistently:

- Discovery/observation/resources: `readOnlyHint: true`, `idempotentHint: true`.
- Plan tools: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` because validation checks remote Netlify context.
- Start/follow-up/retry: `readOnlyHint: false`, `idempotentHint: true` only when an idempotency key is enforced, `openWorldHint: true`.
- Cancel/review decisions: `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true`.

Additional rails:

- Remote execution is two-stage: plan first, then start the immutable plan.
- Never infer a different site when a saved plan is started.
- Never accept a Netlify token, GitHub token, or dashboard token as a tool argument.
- Never expose secrets in tool output, MCP logs, audit events, or errors.
- Reject placeholder IDs such as `YOUR_RUN_ID`, `$RUN_ID`, and `<workflow>` with discovery guidance.
- Bound prompts, context, event pages, and artifact reads before forwarding them.
- Use exact target IDs for cancellation, retry, review, and follow-up.
- Do not add shell-command execution or arbitrary URL fetching.

## MCP server implementation

Use the stable v2 packages available at implementation time:

- `@modelcontextprotocol/server` 2.x
- `zod` 4.x for tool input schemas

The stable v2 server package requires Node 20 or newer, so NAX 2.0 raises its
runtime floor to Node 20 rather than claiming unsupported Node 18 compatibility.

Serve stdio with `serveStdio(() => buildServer())`, which supports both the 2025-era clients and the 2026-07-28 protocol negotiation path. All stdout belongs to MCP framing; diagnostics go to stderr or the existing nax debug logger.

Suggested modules:

```text
src/control-plane/
  service.js                # NaxControlPlane application service
  ports.js                  # storage, execution, artifacts, events, auth contracts
  run-plans.js              # portable planning/idempotency state machine
src/contracts/
  control-plane.ts          # shared scope, actor, plan, run, event, result DTOs
src/mcp/
  server.js                 # buildServer + stdio entry
  client.js                 # tool-facing control-plane client interface
  adapters/
    local-dashboard.js      # authenticated, bounded dashboard API adapter
  local-instance-registry.js # project identity, atomic registry, stale cleanup
  results.js                # text + structuredContent helpers
  errors.js                 # domain/runtime error mapping and recovery hints
  schemas.js                # Zod schemas, no `any`
  tools/
    context.js
    workflows.js
    runs.js
    control.js
  resources.js
  prompts.js
```

The dashboard-owned additions should be small and reusable:

```text
src/dashboard/runtime/mcp-instance-registry.js
src/dashboard/storage/local-run-plans.js
src/dashboard/runtime/local-workflow-execution.js
```

Create `src/contracts/control-plane.ts` for portable plan/request/result contracts and have dashboard contracts compose or re-export them where useful. JavaScript modules import those shapes through JSDoc. Do not create MCP-only or dashboard-only duplicates of workflow/run DTOs.

The MCP tool handlers import only `src/mcp/client.js` and shared contracts. They must not import `src/dashboard/server.js`, local filesystem stores, Electron APIs, Tauri commands, or Netlify Function handlers.

## Control-plane API additions

The stdio adapter can reuse all current read/control routes. Add a small planning surface to the dashboard API:

```text
POST /api/run-plans/workflows/:workflowId
POST /api/run-plans/agents
POST /api/run-plans/:planId/start
GET  /api/run-plans/:planId
```

These are application APIs, not MCP-shaped JSON-RPC endpoints. This keeps planning usable by a future local UI, desktop shell, or hosted control plane and keeps protocol code out of the workflow engine.

Do not implement `workflow_plan` by launching the CLI and parsing dry-run output. Extract a pure plan builder/validator from the workflow engine. The CLI dry run, dashboard, MCP, desktop shell, and hosted control plane should all consume the same structured plan.

Plan records should contain normalized inputs and hashes, not raw secrets. Prompt text may be stored only under the same local protections and retention rules as current run prompts. A started plan records its durable run ID and becomes an idempotent lookup.

Current routes then map directly:

| MCP operation | Dashboard API |
|---|---|
| Context | `GET /api/health` |
| List/get workflow | `GET /api/workflows`, `GET /api/workflows/:id`, graph route |
| Plan/start | New run-plan routes |
| List/get/wait | Existing run, details, graph, and event routes |
| Cancel | Existing run/agent cancel routes |
| Retry | Existing retry route |
| Review | Existing approve/cancel routes |
| Follow-up | Existing follow-up route |

## Local setup UX

Add a hidden-at-first `nax mcp` command used by MCP clients and a visible setup helper once the server is stable:

```text
nax mcp setup claude [--scope local|project|user] [--dry-run]
nax mcp doctor
nax mcp [--project-root <default-path>]
```

`setup claude` should:

- Detect the Claude CLI.
- Show the exact config change before writing.
- Prefer project scope for teams, local scope when the user does not want `.mcp.json` committed, and user scope for one personal entry across projects.
- Generate `nax mcp` without baking a project path into the server definition.
- Preserve unrelated MCP servers and project configuration.
- Write atomically with a backup.
- Never start a dashboard as a hidden side effect.

`doctor` should verify the nax binary, MCP SDK load, Claude configuration, canonical project root, registry permissions, dashboard health, version compatibility, Netlify target access, and one read-only MCP call. It must not start a remote run. Future desktop/hosted diagnostics should implement their own connection/auth checks behind the same health contract rather than inheriting local registry checks.

When no dashboard is running, the tool error should say exactly:

```text
Start the nax control plane for this project:
  nax dashboard --no-open
```

## Observability

Record value-free MCP activity through the control plane (the local dashboard is the first sink):

- Timestamp, tool name, duration, success/error code.
- Client name/version when available.
- Runtime, stable scope ID, plan ID, request ID, workflow ID, and run ID.
- Number of expected/created runners and usage totals when known.
- Never raw prompts, results, tokens, environment values, or artifact content in the MCP audit log.

Tag workflow/run state with `source: "mcp"` and the request/plan IDs. This makes UI origin badges possible later without requiring a UI change in the first implementation.

## Tests

### Unit

- Project-root precedence and canonicalization.
- Stable scope identity does not depend on localhost port, PID, or an absolute path in public IDs.
- Registry permissions, atomic replace, stale PID cleanup, and instance-safe deletion.
- Loopback-origin enforcement and token redaction.
- Every Zod schema, including placeholder and provider-only input rejection.
- Dashboard error mapping and fuzzy suggestions.
- Text summaries stay within output budgets.
- Plan hashing, expiry, immutable binding, single consumption, and idempotent replay.

### Integration

- Start dashboard on an ephemeral port, start stdio MCP, call `context_get`.
- List and inspect fixture workflows.
- Plan a workflow without remote mutation.
- Repeated `run_start` returns one durable run and one set of submissions.
- Dashboard restart is rediscovered by the same adapter process.
- Wrong-project and stale-registry failures are helpful and do not leak tokens.
- Run event cursors and `run_wait` terminal/review/timeout behavior.
- Cancel, retry, follow-up, and review tools hit the existing mutation services.
- Large details/events/artifacts remain bounded.
- Run the MCP tool suite against an in-memory `NaxControlPlane` test double so tool handlers prove they do not depend on dashboard modules.

### Contract/conformance

- MCP initialize/discover, tools, prompts, resources, pagination, cancellation, and malformed requests.
- Claude Code stdio smoke test using a project-scoped config.
- A second MCP client smoke test to catch Claude-specific assumptions.
- Canary prompts with a smaller model: discover -> plan -> start -> wait -> inspect without being told tool names.
- Tool descriptions include discovery, when-to-use, do/don't, idempotency, examples, and common mistakes.
- The same tool schemas and result contracts pass against local, desktop-shaped, and hosted-shaped control-plane conformance fixtures.
- Hosted-shaped fixtures have no filesystem, child-process, long-lived memory, or loopback assumptions.

No real remote submission belongs in the default test suite. Keep a separately gated Netlify Agent Runner canary with an explicit site and credit budget.

## Rollout

### Phase 1: read-only bridge

- Add MCP dependencies and stdio entry.
- Add dashboard instance registry.
- Implement `context_get`, workflow discovery, run discovery, resources, and one prompt.
- Add setup/doctor dry-run behavior.
- Prove dashboard restart discovery and Claude Code compatibility.

### Phase 2: planned remote execution

- Add durable expiring run plans and idempotency.
- Implement workflow and single-agent planning.
- Implement `run_start` against existing dashboard services.
- Tag run origin and add value-free audit events.
- Run a gated remote canary.

### Phase 3: observation and control

- Implement bounded wait, details sections, and event cursors.
- Add cancel, retry, follow-up, and review tools.
- Add resources for safe artifact reads.
- Validate restart/replay behavior during active remote runs.

### Phase 4: user-facing setup and docs

- Make setup command visible.
- Add canonical user docs under `site/content`.
- Add Claude config examples and troubleshooting.
- Add an optional dashboard UI indicator for MCP readiness/origin; run `npm run dashboard:build` for that UI change.

### Future runtime adapters (explicitly outside this plan)

Desktop and hosted work is not part of the current rollout. The first implementation must merely preserve the seams they need.

For Electron/Tauri, the desktop shell may embed the control-plane services or manage a nax sidecar. It owns lifecycle, selected project, app-data storage, and user session. The MCP tools still call `NaxControlPlane`; they do not call Electron IPC or Tauri commands directly.

For a Netlify-hosted control plane, expose the MCP over authenticated Streamable HTTP and map the application API onto Netlify Functions or framework server routes. Prefer a stateless/JSON-response MCP handler whose durable session and application state lives outside function memory. The hosted composition must assume:

- Function invocations are stateless and request-bounded.
- Plans, handles, idempotency records, events, and artifacts are stored durably outside function memory.
- Starting an Agent Runner returns promptly; reconciliation, cleanup, and scheduled work use background/scheduled execution where appropriate.
- `run_wait` may degrade from local long-polling to a cursor snapshot with a recommended retry interval when holding a function invocation is inefficient.
- Every request derives tenant/account/project scope from authenticated server context and authorizes it before reads or mutations.
- Artifact resources are served through authorized IDs and hosted storage rather than local absolute paths.
- Local dashboard tokens and registry records are never reused as hosted authentication.

Do not expose the local dashboard's token-authenticated API over a public interface.

## Acceptance criteria

- One checked-in Claude config works across developer machines without a fixed dashboard port.
- MCP tool handlers depend only on the runtime-neutral control-plane interface.
- Public entity IDs and resource URIs do not depend on a localhost port, process ID, or absolute filesystem path.
- The same tool schemas work with local, desktop-shaped, and hosted-shaped conformance adapters.
- `nax dashboard` advertises exactly one healthy instance for its canonical project.
- Claude can discover, plan, and start a remote workflow without shelling out or knowing Netlify API details.
- One plan/request ID cannot create duplicate Agent Runners.
- Claude can wait for and inspect results without unbounded polling or output.
- All mutations stay within the actor-authorized account/project/site scope selected when the plan was created.
- Missing dashboard/auth/site/model/run IDs produce structured, recoverable guidance.
- The official Netlify MCP remains optional and no Agent Runner behavior is duplicated there.
- No secrets appear in MCP responses, logs, registry diagnostics, or committed files.
- All JavaScript has precise JSDoc typing and passes repository type checks.
- User-facing documentation is added only under `site/content`.
