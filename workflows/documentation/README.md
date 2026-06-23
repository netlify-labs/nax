# Documentation Flow

Audits docs against the actual codebase, synthesizes the most useful updates, then improves README, setup, architecture, or contribution docs.

Use this for onboarding, handoff, or cleaning up outdated docs.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `audit` | claude, gemini, codex | Each agent compares docs to code and finds gaps. |
| 2 | `synthesize` | codex | Selects a scoped documentation update plan. |
| 3 | `implement` | codex | Updates the highest-value docs. |

## Run

```bash
nax documentation
```
