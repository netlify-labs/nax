# Changelog

All notable changes to `nax-agent-runner-sdk` are recorded here.

## Unreleased

- Added stable core and separate GitHub failure profiles with safe,
  deterministic guidance metadata.
- Added bounded in-process capacity/rate-limit/platform retry, serialized retry
  reason/timing metadata, pre-I/O retry checkpoints, original-deadline
  enforcement, and replacement-create reconciliation that preserves budget.
- Kept transport replay operation-specific and prohibited automatic
  replacement for unsafe or ambiguous failure categories.

## 0.1.0 - 2026-08-02

Initial `next` candidate.

- Added the stateless `start`, `run`, `waitFor`, `getSnapshot`, `getResult`,
  `land`, `stop`, `followUp`, `shouldRetry`, and kind-aware `retry` engine.
- Added versioned, serializable run/session handles that preserve effective
  inputs, absolute deadlines, retry budgets, exact session attribution, and
  landing checkpoints across process boundaries.
- Added bounded, request-marker-based runner and session reconciliation for
  ambiguous create responses and active-session conflicts.
- Added discriminated `RunResult`, `RunOutcome`, `LandingOutcome`, snapshot,
  and reconciliation unions with mandatory nullable usage and tri-state
  change reporting.
- Added the normalized HTTP transport for the verified v1 API and legacy
  bb-api response style, with operation-specific retries and typed member
  actions.
- Added the shared Netlify authentication, preflight, redaction, request
  metadata, and value-free telemetry core. `NETLIFY_AUTH_TOKEN` is the sole
  supported environment token.
- Added resumable GitHub PR landing, exact-current-session follow-up commits,
  and optional expected-head compare-and-swap merge.
- Added the public `BlobStore`/`BlobRef` contracts and the Phase 1
  `promptRefDelivery` compatibility adapter.
- Added strict TypeScript declarations, ESM/CommonJS builds, deterministic
  conformance tests, typechecked public examples, and packed-consumer smoke
  coverage for Node.js 18 and newer.
- Migrated nax runner lifecycle, workflow engine, dashboard, follow-ups,
  preflight, retry/cancel, and persisted artifacts to the SDK.
