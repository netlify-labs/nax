# Changelog

All notable changes to `nax-agent-runner-sdk` are recorded here.

## Unreleased

## 0.2.0 - 2026-08-03

- Promoted the tested `0.2.0-next.2` API as the first stable release of the
  resumable Agent Runner SDK.
- Hardened public failure-text redaction for `Authorization` headers using
  Bearer, Basic, token, or direct credential forms.
- Bounded GitHub failure comment and check-run text to stay within API limits.
- Includes exact-session result attribution, bounded create/session
  reconciliation, persisted deadlines and retry budgets, explicit landing
  outcomes, prompt/blob delivery, redacted recovery guidance, and typed ESM
  and CommonJS entry points.
- Validated the packed package in nax and the Agent Runner GitHub Action, and
  validated the published prerelease through Revenue Engine's durable
  EventBridge finisher with unchanged-result landing and single-write usage
  accounting.

## 0.2.0-next.2 - 2026-08-03

- Added attributable-session Netlify Git publishing with restart-safe
  checkpoints and explicit `published`, `unsupported`, and typed failure
  outcomes.
- Added pure recovery recommendations and optional idempotent GitHub
  comment, check-run, and label presenters with value-free redaction.
- Kept the optional Netlify CLI transport fail-closed after source-level
  verification found no released CLI with the complete SDK lifecycle
  contract.
- Skip GitHub PR creation when the exact current session explicitly has no
  result diff and no pull request exists.

## 0.2.0-next.1 - 2026-08-03

- Fetch the terminal runner diff when the service reports a changed successful
  session, so `RunResult.diff` reflects the public result contract.

## 0.2.0-next.0 - 2026-08-03

- Added stable core and separate GitHub failure profiles with safe,
  deterministic guidance metadata.
- Added bounded in-process capacity/rate-limit/platform retry, serialized retry
  reason/timing metadata, pre-I/O retry checkpoints, original-deadline
  enforcement, and replacement-create reconciliation that preserves budget.
- Kept transport replay operation-specific and prohibited automatic
  replacement for unsafe or ambiguous failure categories.
- Added the default Netlify `BlobStore` with tenant-scoped collision-resistant
  refs, SDK-enforced logical expiry and size ceilings, sentinel-bearing runner
  fetch instructions, and value-free typed storage failures.
- Added restart-safe, best-effort prompt-ref cleanup on success, cancellation,
  and timeout while retaining failed-run refs for bounded retry.
- Added final-decorated-byte prompt planning with inline, deterministic
  compaction, and blob fallback modes; `NAX_SAFE_PROMPT_BYTES` defaults to
  16 KiB and effective handles retain semantic input plus safe delivery
  metadata.
- Added sentinel evidence normalization for confirmed, failed, probable, and
  suspect runner fetch outcomes.
- Added value-free transport retry telemetry, restored exponential adapter
  backoff, and fixed multiline blob-fetch failure classification.
- Added repository CI and strict dashboard typechecking to the release gate.

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
