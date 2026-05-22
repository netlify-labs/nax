# E2E Tests Flow

Identifies critical user journeys, synthesizes a Playwright plan, then adds the first practical E2E test slice.

Use this when a project lacks coverage for signup, onboarding, checkout, dashboard, settings, or other business-critical flows.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `discover` | claude, gemini, codex | Each agent finds critical journeys and test gaps. |
| 2 | `synthesize` | codex | Chooses a minimal, high-value Playwright plan. |
| 3 | `implement` | codex | Adds tests and supporting setup. |

## Run

```bash
nax e2e-tests
```
