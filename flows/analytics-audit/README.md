# Analytics Audit Flow

Maps existing telemetry and proposes missing product, funnel, conversion, and feature events.

Use this when a team asks what they are not tracking but probably should.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `audit` | claude, gemini, codex | Each agent maps existing tracking and missing events. |
| 2 | `synthesize` | codex | Produces one event plan with names, properties, triggers, and validation. |

## Run

```bash
nax analytics-audit
```
