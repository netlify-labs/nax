# nax Flow Reference

## `review`

Purpose: multi-model code review with adversarial cross-review and final synthesis.

Steps:

| Step | Agents | Submit | Input |
|------|--------|--------|-------|
| `review` | claude, gemini, codex | new-run | none |
| `cross-review` | claude, gemini, codex | follow-up | `review` |
| `synthesize` | codex | new-run | `review`, `cross-review` |

Run examples:

```bash
nax run review
nax run review --branch '#123' --transport netlify-api --force
nax run review --step cross-review
```

## `ideas`

Purpose: generate project improvement ideas, score them adversarially, react to criticism, and synthesize a ranked plan.

Steps:

| Step | Agents | Submit | Input |
|------|--------|--------|-------|
| `ideate` | claude, gemini, codex | new-run | none |
| `cross-score` | claude, gemini, codex | follow-up | `ideate` |
| `react` | claude, gemini, codex | follow-up | `ideate`, `cross-score` |
| `synthesize` | codex | new-run | `ideate`, `cross-score`, `react` |

Run examples:

```bash
nax run ideas
nax run ideas --transport netlify-api --timeout-minutes 45
nax run ideas --from-step react
```

## `do-next`

Purpose: ask multiple models for the next best task, then synthesize one ranked recommendation.

Steps:

| Step | Agents | Submit | Input |
|------|--------|--------|-------|
| `propose` | claude, gemini, codex | new-run | none |
| `synthesize` | codex | new-run | `propose` |

Run examples:

```bash
nax run do-next
nax run do-next --branch '#123' --transport netlify-api --force
```

## Additional Bundled Flows

Use `nax list --verbose` for the live bundled and project-local flow set. Current bundled audit, implementation, and polish flows include:

| Flow | Purpose |
|------|---------|
| `security-audit` | Auth, billing, webhook, tenant isolation, secrets, and attack-surface audits. |
| `performance-audit` | Bottleneck discovery and measurement-first optimization planning. |
| `analytics-audit` | Missing funnel, conversion, feature usage, and product telemetry plans. |
| `seo-audit` | Metadata, crawlability, structured data, links, alt text, content, page-speed checks. |
| `accessibility-audit` | WCAG 2.1 AA audit, synthesized fix plan, focused Codex implementation. |
| `mobile-responsiveness` | Small-viewport audit and focused responsive layout fixes. |
| `e2e-tests` | Critical-flow discovery, Playwright test planning, first test implementation. |
| `unit-tests` | High-value unit test gap discovery and focused test implementation. |
| `documentation` | README, setup, architecture, and operational documentation grounded in the codebase. |
| `error-handling` | Error boundaries, logging, retries, validation, and user-friendly failure states. |
| `ux-copy-polish` | Loading, empty, and error states plus visual polish, CTA hierarchy, and product copy. |

## Flow Authoring Notes

- A flow is `<flows-dir>/<id>/flow.*` plus `<flows-dir>/<id>/prompts/*.md`.
- Flow files can be YAML, JSON, JavaScript, TypeScript, or TOML.
- Use `action: issue` for a fresh top-level result.
- Use `action: comment` when continuing a runner thread.
- Use `submit: follow-up` only when there is a prior runner for the same agent.
- Use `input` to embed prior step results into the current prompt.
- Keep follow-up prompt size under control; prior outputs can get large quickly. `nax` can offload oversized context through Netlify Blobs, but concise step outputs still make downstream synthesis better.
