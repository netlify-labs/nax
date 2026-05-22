---
title: Synthesize E2E Test Plan
description: Merge proposals into one practical Playwright implementation plan.
instruction: synthesize critical-flow proposals into one Playwright E2E test plan
---

# Synthesize E2E Test Plan

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Read all prior E2E discovery results. Deduplicate by user journey and pick the smallest first slice that catches important regressions without creating flaky CI.

## Synthesis Rules

- Prefer existing test framework and repo conventions.
- Choose P0 smoke coverage before broad regression coverage.
- Require a credible auth/data strategy.
- Avoid real payments, real email delivery, uncontrolled third-party auth, and arbitrary sleeps.
- Include console monitoring and failure artifacts when practical.

## Output

Produce:

1. `## Current Test Setup`
2. `## Selected First Test Slice`
3. `## Structured Implementation Plan` as fenced JSON with test file, flows, setup files, env vars, selectors, assertions, auth/data strategy, flake controls, and source agents
4. `## Additional Backlog`
5. `## Risks`

Be explicit about what cannot be implemented without credentials or seeded test users.
