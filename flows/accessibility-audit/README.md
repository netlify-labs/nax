# Accessibility Audit Flow

Audits WCAG 2.1 AA issues, synthesizes a fix plan, then lets Codex apply the safest high-confidence fixes.

Use this for pre-launch accessibility hardening or to make a UI more keyboard, screen-reader, and contrast friendly.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `audit` | claude, gemini, codex | Each agent finds accessibility issues with user impact and file references. |
| 2 | `synthesize` | codex | Deduplicates findings and ranks fixes. |
| 3 | `implement` | codex | Applies focused fixes and verifies them when tooling exists. |

## Run

```bash
nax accessibility-audit
```
