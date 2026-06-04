# Mobile Responsiveness Flow

Audits small-viewport behavior, synthesizes route-level fixes, then applies focused responsive improvements.

Use this when pages work on desktop but need systematic mobile hardening.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `audit` | claude, gemini, codex | Each agent inspects mobile layout, navigation, touch, and overflow risks. |
| 2 | `synthesize` | codex | Produces a route-by-route mobile fix plan. |
| 3 | `implement` | codex | Applies safe responsive fixes. |

## Run

```bash
nax mobile-responsiveness
```
