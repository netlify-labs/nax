# SEO Audit Flow

Audits site metadata, crawlability, structured data, links, content, image alt text, and page-speed risks.

Use this for marketing sites, docs sites, content-heavy products, or any public web app where organic discovery matters.

## Steps

| # | Step | Agents | Purpose |
|---|------|--------|---------|
| 1 | `audit` | claude, gemini, codex | Each agent inspects SEO issues from routes, metadata, links, and assets. |
| 2 | `synthesize` | codex | Produces a ranked remediation plan with file references. |

## Run

```bash
nax seo-audit
```
