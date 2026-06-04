---
title: Implement E2E Tests
description: Add the agreed Playwright tests and supporting setup.
instruction: implement the synthesized Playwright E2E test plan
---

# Implement E2E Tests

You may edit files. Implement the synthesized first E2E test slice using the repository's existing conventions.

## Implementation Rules

- If Playwright already exists, fit into the existing config, fixtures, naming, and scripts.
- If no E2E framework exists, add the smallest practical Playwright setup and one P0 smoke test.
- Use role/test-id locators and web-first assertions.
- Do not use arbitrary sleeps.
- Do not automate Google/OAuth provider login. Use an env-gated test user, storage state, seeded session, or document the missing prerequisite.
- Avoid real payments, real email delivery, and uncontrolled third-party state.
- Add console error monitoring where practical; fail on unexpected runtime, hydration, network, React, and CSP errors.
- Store traces/screenshots/videos on failure when using Playwright config.
- Keep test data deterministic and clean up where needed.

## Verification

Run the new tests if the environment can support them. Also run related lint/typecheck/test commands if available. If browser binaries, env vars, test users, or a dev server are missing, state exactly what blocked execution.

## Output

Report files changed, tests added, how to run them, required env/setup, verification results, and remaining E2E backlog.
