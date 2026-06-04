# Security Audit Flow

Runs Claude, Gemini, and Codex independently against the same repository, then asks Codex to synthesize one ranked security report.

Use this for pre-launch hardening, auth/billing reviews, webhook reviews, multi-tenant data isolation checks, and broad attack-surface mapping.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `audit` | claude, gemini, codex | Each agent independently finds exploitable issues with evidence. |
| 2 | `synthesize` | codex | Deduplicates, rejects weak claims, and ranks confirmed findings. |

## Run

```bash
nax security-audit
```
