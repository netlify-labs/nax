---
title: Audit Error Handling
description: Independently inspect failure paths, logging, retries, and user-visible errors.
instruction: audit error handling, logging, retries, and user-friendly failure states throughout the app
---

# Error Handling Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This prompt adapts `codebase-audit` plus UX/reliability checks. Focus on real failure behavior, not generic "add try/catch" advice.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Failure Surface Map

Trace important workflows from input to output and inspect failures at each boundary:

- UI routes, layouts, loading states, error boundaries, not-found pages, empty states, forms, toasts, and modals.
- API handlers, server actions, serverless functions, background jobs, cron, queues, CLIs, scripts, and webhooks.
- External services: databases, auth providers, payment providers, storage, email, analytics, AI APIs, queues, caches, and search.
- Filesystem, network, env/config, permissions, timeouts, rate limits, validation, parsing, and serialization.

## Checks

- User-facing errors are clear, actionable, and do not leak stack traces, secrets, SQL/schema details, provider tokens, or PII.
- Operators get enough context: request ID, actor/tenant/resource, provider error class, retry count, and safe metadata.
- Errors are categorized: validation, auth, permission, not found, conflict, rate limit, provider failure, timeout, partial failure, unknown.
- HTTP/API status codes and response shapes are consistent.
- Retry behavior is bounded, idempotent, and uses backoff where appropriate.
- Timeouts/cancellation exist for external calls.
- Multi-step writes either commit atomically, compensate safely, or expose recoverable state.
- Error boundaries cover route/component failures and preserve navigation/recovery.
- Loading/empty/error states exist for critical async UI.
- Logs and analytics do not duplicate noisy errors or hide critical failures.
- Tests cover important failure paths.

## Output

Start with `## Repository State`, then `## Failure Surface Map`, then `## Structured Findings` as fenced JSON:

```json
[
  {
    "id": "ERR-1",
    "priority": "P0",
    "file": "app/api/export/route.ts",
    "line": 64,
    "failure_scenario": "Storage upload fails after database row is created",
    "current_behavior": "Returns 500 and leaves export stuck in pending",
    "user_operator_impact": "User sees generic failure; operators cannot identify stuck exports",
    "recommended_fix": "Mark export failed with safe error code and log request id",
    "verification": "Unit test storage failure path"
  }
]
```

Then include `## Highest-Risk Failure Paths`, `## User-Facing Improvements`, `## Observability Improvements`, and `## Tests To Add`.
