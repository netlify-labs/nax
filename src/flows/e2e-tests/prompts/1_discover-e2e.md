---
title: Discover Critical E2E Flows
description: Independently identify the user journeys that most need E2E coverage.
instruction: identify the critical user flows that should have Playwright end-to-end tests
---

# Discover Critical E2E Flows

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This prompt embeds the core of the `test-e2e-webapps` skill: critical-flow selection, auth strategy, Page Object discipline, console monitoring, and flake control.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Discover The App

Map:

- User-facing routes and app shells.
- Auth flows: login, signup, OAuth callbacks, magic links, device codes, admin impersonation, logout.
- Core product jobs: create/import/configure/generate/export/share/invite/pay.
- Revenue flows: pricing, checkout, upgrade, downgrade, cancellation, paywall, seat changes.
- Risky failure flows: empty states, validation errors, permission denial, network/API error, loading states, mobile breakage.
- Admin and support flows if present.
- Existing test stack: Playwright/Cypress, Jest/Vitest, scripts, CI, fixtures, seed data, test users, page objects, data-testid conventions, and env variables.

## E2E Architecture Rules

- Prefer Playwright unless the repo already has a different E2E standard.
- Use role/test-id locators and web-first assertions. Avoid brittle CSS/xpath selectors.
- Avoid sleeps. Wait on UI states, requests, URLs, or assertions.
- Reuse auth state when safe: global setup, storage state, or API/session helpers.
- For Google/OAuth-only apps, propose a test-user bypass such as email/password test users, seeded sessions, device-code stubs, or documented env-gated setup. Do not suggest automating Google login.
- Capture unexpected console errors: hydration, runtime `TypeError`/`ReferenceError`, failed network requests, React warnings, and CSP/security errors.
- Use traces/screenshots/videos on failure.
- Keep tests deterministic with known seed data and cleanup.
- Separate smoke P0 tests from broader regression suites.

## Prioritization

Rank flows by:

- Customer or revenue impact.
- Regression likelihood.
- Security/permission risk.
- Coverage gap.
- Feasibility in CI.
- Flake risk.

Favor 2-4 P0 tests that prove the product can be used end-to-end over a large fragile suite.

## Output

Start with `## Repository State`, then `## Current E2E Infrastructure`, then `## Structured Flow Candidates` as fenced JSON:

```json
[
  {
    "id": "E2E-1",
    "priority": "P0",
    "flow": "Sign up and complete onboarding",
    "routes": ["/", "/auth/callback", "/dashboard"],
    "source_files": ["app/page.tsx", "app/dashboard/page.tsx"],
    "steps": ["Click primary CTA", "Authenticate as test user", "Complete first setup"],
    "assertions": ["Dashboard is visible", "No unexpected console errors"],
    "auth_strategy": "storage state from test user",
    "data_setup": "seed fresh user",
    "flake_risks": ["OAuth redirect if no test bypass"],
    "recommended_test_file": "e2e/onboarding.spec.ts"
  }
]
```

Then include:

- `## Selected First Slice`
- `## Required Setup`
- `## Console Monitoring Plan`
- `## Deferred Backlog`
