# Error Handling Flow

Audits failure paths, synthesizes safe improvements, then applies focused error handling, logging, and user-facing state fixes.

Use this when an app has brittle failure behavior, vague errors, missing boundaries, or poor operator visibility.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `audit` | claude, gemini, codex | Each agent inspects failure paths, retries, logs, and user errors. |
| 2 | `synthesize` | codex | Selects safe, high-value fixes. |
| 3 | `implement` | codex | Applies focused improvements and tests them where practical. |

## Run

```bash
nax error-handling
```
