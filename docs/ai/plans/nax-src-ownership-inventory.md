# NAX `src/` Ownership Inventory

> Status: Closeout ownership map for `nax-boo3`.
> Purpose: guide runtime-agnostic dashboard API extraction without doing a broad cosmetic file shuffle.

## Rules

- Do not add new dashboard API, runtime, storage, or transport modules at the top level of `src/`.
- Move files only when an implementation bead establishes the boundary that will own them.
- Use temporary compatibility shims when a move would otherwise create large unrelated churn.
- Shared workflow/runner/artifact modules must not import `src/dashboard/api/*`.
- Dashboard route code should move toward adapters instead of importing local-only modules directly.

## Current Top-Level Files

| File | Current role | Target ownership | Move timing |
| --- | --- | --- | --- |
| `agent-run-results.js` | Normalize Agent Runner/session payloads into local artifact/result shapes. | `src/runners/` or `src/agent-runner/` | Move with runner-domain cleanup after dashboard transports exist. |
| `agent-runner-artifacts.js` | Persist/read Agent Runner artifacts. | `src/artifacts/` | Move with artifact-domain cleanup. |
| `agent-runner-sync.js` | Sync remote runner/session state into local artifacts. | `src/runners/` or `src/agent-runner/` | Move after Netlify API client boundaries are clearer. |
| `agent-selection.js` | Shared agent/model selection normalization and validation. | shared root or `src/agents/` | Leave shared until a broader agent registry cleanup. |
| `agent-session-artifacts.js` | Persist/read Agent Runner session artifacts. | `src/artifacts/` | Move with artifact-domain cleanup. |
| `blob-debug-cache.js` | Blob/debug support utility. | `src/netlify/` or shared debug utility | Audit before moving. |
| `blob-ref-registry.js` | Blob reference tracking. | `src/netlify/` | Move with Netlify/blob cleanup. |
| `comment-markers.js` | GitHub/comment marker helpers. | `src/github/` | Move with GitHub-domain cleanup. |
| `constants.js` | Shared constants. | shared root | Leave unless ownership narrows. |
| `flows.js` | Workflow/flow loading entrypoint. | `src/flows/` | Move only after CLI import blast radius is reviewed. |
| `followup-context.js` | Build follow-up context packages from details/artifacts. | `src/followup/` | Move with follow-up service extraction. |
| `followup-delivery.js` | Inline/blob delivery of follow-up context. | `src/followup/` | Move with follow-up service extraction. |
| `followup-persistence.js` | Persist follow-up runs into workflow state. | `src/followup/` | Move with follow-up service extraction. |
| `followup-plan.js` | Plan follow-up submissions. | `src/followup/` | Move with follow-up service extraction. |
| `gh-cli.js` | GitHub CLI wrapper. | `src/github/` | Move with GitHub-domain cleanup. |
| `github-actions-sync.js` | Sync GitHub Actions artifacts. | `src/github/` | Move with GitHub-domain cleanup. |
| `graceful-run-state.js` | Persist active workflow state on shutdown. | `src/workflow/state/` | Move with workflow state cleanup. |
| `handoff-runner.js` | Submit handoff/follow-up runner work. | `src/followup/` or `src/handoff/` | Move with follow-up/handoff extraction. |
| `handoff-sources.js` | Discover/read handoff sources. | `src/followup/` or `src/handoff/` | Move with follow-up/handoff extraction. |
| `human-review.js` | Review gate helpers. | `src/workflow/review/` | Move after review service boundary exists. |
| `init.js` | Project initialization/linking setup. | `src/init/` or shared root | Leave until init command cleanup. |
| `issue-groups.js` | Issue grouping support. | `src/flows/` or `src/prompts/` | Audit before moving. |
| `local-runner.js` | Local Netlify CLI/API-adjacent Agent Runner operations. | `src/runners/local/` | Move after local process/API transport extraction. |
| `multiline.js` | CLI prompt utility. | `src/utils/` | Move with CLI utility cleanup. |
| `netlify-blobs.js` | Compatibility shim for Netlify Blob CLI wrapper. | `src/netlify/` | Implemented as `src/netlify/blobs.js`; remove the shim in a later compatibility cleanup. |
| `netlify-runtime.js` | Compatibility shim for Netlify runtime classification. | `src/netlify/` | Implemented as `src/netlify/runtime.js`; remove the shim in a later compatibility cleanup. |
| `notifications.js` | Workflow notification dispatcher. | shared root or `src/workflow/notifications/` | Audit after workflow events cleanup. |
| `prompt-offload.js` | Prompt offload support. | `src/workflow/` or `src/prompts/` | Audit before moving. |
| `prompts.js` | Prompt loading. | `src/prompts/` | Move after flow/prompt ownership is clarified. |
| `review-context.js` | Review target/context gathering. | `src/workflow/review/` | Audit before moving. |
| `round-results.js` | Round result helpers. | `src/workflow/` | Move with workflow cleanup. |
| `run-state.js` | Shared durable workflow state. | `src/workflow/state/` | Wrap from dashboard storage first; move later with shims. |
| `runner-event-log.js` | Durable event log read/write. | `src/workflow/state/` or `src/workflow/events/` | Wrap from dashboard event store first; move later. |
| `runner-events.js` | Runtime runner event emitter. | `src/workflow/events/` | Move with event system cleanup. |
| `skills.js` | Skill installation/check helpers. | shared root or `src/skills/` | Leave until skills command cleanup. |
| `status.js` | Shared status predicates. | shared root | Leave shared. |
| `target.js` | Target branch/SHA helpers. | shared root or `src/workflow/target/` | Audit before moving. |
| `transports.js` | Existing CLI transport detection/helpers. | `src/runners/` or `src/transports/` | Coordinate with broader CLI transport epic. |
| `types.js` | Shared JSDoc typedefs. | shared root | Leave shared. |
| `workflow-artifacts.js` | Persist workflow artifacts. | `src/artifacts/` | Move with artifact-domain cleanup. |
| `workflow-events.js` | Workflow event context helpers. | `src/workflow/events/` | Move with workflow event cleanup. |
| `workflow-runner.js` | In-process workflow run/resume adapter. | `src/workflow/` | Move after dashboard local in-process transport exists. |

## Guardrail Strategy

Immediate guardrail:

- New dashboard-owned modules go under `src/dashboard/api`, `src/dashboard/runtime`, `src/dashboard/storage`, or `src/dashboard/transports`.
- Review diffs for new top-level `src/*.js` files during this epic.
- New Netlify-owned modules go under `src/netlify/*`. Root `src/netlify-blobs.js` and `src/netlify-runtime.js` are shims only.

Deferred automated guardrail:

- After local storage adapters exist, add an import-boundary check that prevents `src/dashboard/api/routes/*` from importing `fs`, `http`, `child_process`, `open`, `../../run-state`, `../../local-runner`, `../../netlify-blobs`, or other local-only modules directly.
- Keep adapter modules exempt from that rule because local adapters are allowed to import local storage/runner modules.

Compatibility strategy:

- If moving a shared root module breaks many CLI imports, add a root-level shim that re-exports the new module.
- Add a follow-up cleanup note or bead for shim removal once downstream imports are migrated.

## Current Intentional Exceptions

- `src/dashboard/api/serializers.js` currently imports shared `run-state`, `agent-selection`, and `status` helpers. This is acceptable during the first primitive extraction because storage adapters do not exist yet. After local storage adapters are introduced, route serializers should be reviewed and split if needed so API route modules depend on stores rather than durable state internals.
