# Performance Audit Flow

Finds likely bottlenecks and turns them into a measurement-first optimization plan.

Use this when a project feels slow, before performance work, or when you need a ranked list of profiling targets instead of generic optimization advice.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `audit` | claude, gemini, codex | Each agent inspects code for performance risks and measurement targets. |
| 2 | `synthesize` | codex | Ranks opportunities by impact, confidence, effort, and evidence. |

## Run

```bash
nax performance-audit
```
