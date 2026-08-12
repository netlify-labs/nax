# Changelog

## 3.0.0

### Breaking changes

- Node.js 20 or newer is now required. The MCP SDK used by `nax mcp` does not
  support Node.js 18.

### Added

- A project-scoped MCP control plane served by `nax mcp` and advertised by
  `nax dashboard` without a fixed port or shared secret in client config.
- One path-free MCP definition can route concurrent calls across advertised
  projects using `context_get.project_ref` and explicit opaque `scope_id`
  propagation; omission still defaults to Claude's current project.
- Thirteen entity-first tools for context and workflow discovery, immutable
  planning, idempotent start, run observation, targeted cancellation, retry,
  follow-up, and human review gates.
- Six scoped resources for context, workflows, run views, events, and exact
  artifacts, plus guided prompts for remote workflows and follow-ups.
- `nax mcp setup claude` for project, local, and user scopes, with exact dry-run
  previews, portable path-free configuration, backups, and atomic
  writes.
- `nax mcp doctor` for read-only Claude, package, project, registry, dashboard,
  Netlify target, capability, and `context_get` diagnostics.
- `nax mcp` auto-starts a dashboard on demand when none is advertised for the
  default project, so it works without separately running `nax dashboard`. Opt
  out with `NAX_MCP_AUTOSTART=0`.
- Runtime-neutral control-plane contracts and conformance fixtures for future
  desktop and hosted implementations. The shipped runtime remains local.

### Safety and reliability

- Explicit immutable project scopes, per-call routing without mutable cwd,
  strict schemas, exact entity targeting, bounded outputs, secret redaction,
  private audit records, and no site overrides or broadcast mutation tools.
- Durable idempotency for starts, retries, follow-ups, and review decisions,
  including safe replay after ambiguous responses or dashboard restarts.
- Real-process stdio coverage across current and older MCP protocol versions,
  dashboard port changes, concurrent projects, auth/version/scope failures, and
  independent process shutdown.
- A separately gated, one-run real Agent Runner canary that is excluded from
  default tests and fails closed without explicit repository, site, account,
  branch, request, run, credit, and time bounds.
- Local dashboard context now preserves the selected Netlify account slug from
  the authenticated health response so target validation and the real canary
  agree on the exact account and site.
- Non-breaking dependency refreshes for Hono, OpenTelemetry, Mermaid, PostCSS,
  js-yaml, DOMPurify, nanoid, brace expansion, and build tooling advisories.

## 2.0.0

### Breaking changes

- `agents` now exclusively selects Agent Runner providers: Claude, Codex,
  Gemini, and OpenCode.
- `models` now contains real provider-specific model IDs. Provider lists passed
  through the old `models` or `stepModels` shapes are rejected.
- CLI and dashboard requests use provider-keyed `models` and `efforts` maps,
  with matching step-level overrides.

### Added

- A server-owned 19-model catalog with model-sensitive reasoning effort,
  Auto omission, and Max-to-`xhigh` wire translation.
- Direct `nax run agent --model --effort` configuration and interactive model
  and effort selection.
- Model and effort configuration for workflow launches, standalone agent runs,
  and follow-ups in the dashboard.
- Exact provider/model/effort persistence across state, events, artifacts,
  retries, reconciliation, and resume.
- Static data-only JavaScript and TypeScript workflow/config object exports.
- `nax-agent-runner-sdk@0.3.0`, including exact effort forwarding and durable
  create/follow-up reconciliation.

### Transport behavior

- Auto transport selects the Netlify API when a model or effort is pinned.
- The pinned GitHub Actions transport fails before dispatch when provider-
  specific model or effort configuration is requested.
