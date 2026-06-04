# Unit Tests Flow

Finds high-value untested utility and domain logic, synthesizes a first test slice, then adds focused tests.

Use this when you want practical unit coverage rather than blanket test generation.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `discover` | claude, gemini, codex | Each agent identifies important untested behavior. |
| 2 | `synthesize` | codex | Chooses a focused first test plan. |
| 3 | `implement` | codex | Adds tests using existing project conventions. |

## Run

```bash
nax unit-tests
```
