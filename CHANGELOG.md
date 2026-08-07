# Changelog

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
