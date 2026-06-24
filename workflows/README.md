# Bundled Workflows

These workflows ship with the `nax` package and are loaded from this directory by default. Project-local workflows can still override or extend this catalog through `.github/nax-flows`, `nax.config.*`, `--flows-dir`, or `NAX_FLOWS_DIRS`.

<!-- docs WORKFLOW_TABLE -->
| Workflow | Description | Steps | Agents | Definition |
| --- | --- | ---: | --- | --- |
| `review` | Review, cross-review, and synthesize findings with multiple Netlify agents. | 3 steps | claude, codex, gemini | [workflows/review/flow.yml](./review/flow.yml) |
| `human-review-example` | Demonstrate a workflow that pauses for a human approval before continuing. | 3 steps | codex | [workflows/human-review-example/flow.yml](./human-review-example/flow.yml) |
| `ideas` | Generate, cross-score, react to, and synthesize competing project improvement ideas. | 4 steps | claude, codex, gemini | [workflows/ideas/flow.yml](./ideas/flow.yml) |
| `do-next` | Ask multiple agents to recommend the next development task, then synthesize one ranked recommendation. | 2 steps | claude, codex, gemini | [workflows/do-next/flow.yml](./do-next/flow.yml) |
| `security-audit` | Run a multi-agent security audit and synthesize a ranked vulnerability report. | 2 steps | claude, codex, gemini | [workflows/security-audit/flow.yml](./security-audit/flow.yml) |
| `performance-audit` | Find likely bottlenecks, measurement gaps, and safe optimization opportunities. | 2 steps | claude, codex, gemini | [workflows/performance-audit/flow.yml](./performance-audit/flow.yml) |
| `analytics-audit` | Identify missing product, funnel, conversion, and feature telemetry. | 2 steps | claude, codex, gemini | [workflows/analytics-audit/flow.yml](./analytics-audit/flow.yml) |
| `seo-audit` | Audit site metadata, crawlability, structured data, content quality, and page speed risks. | 2 steps | claude, codex, gemini | [workflows/seo-audit/flow.yml](./seo-audit/flow.yml) |
| `accessibility-audit` | Audit and fix WCAG 2.1 AA accessibility issues across the app. | 3 steps | claude, codex, gemini | [workflows/accessibility-audit/flow.yml](./accessibility-audit/flow.yml) |
| `mobile-responsiveness` | Audit and improve small-viewport layout, navigation, touch targets, and responsive states. | 3 steps | claude, codex, gemini | [workflows/mobile-responsiveness/flow.yml](./mobile-responsiveness/flow.yml) |
| `e2e-tests` | Design and add Playwright end-to-end tests for critical user flows. | 3 steps | claude, codex, gemini | [workflows/e2e-tests/flow.yml](./e2e-tests/flow.yml) |
| `unit-tests` | Find untested utility and domain code, then add focused unit tests. | 3 steps | claude, codex, gemini | [workflows/unit-tests/flow.yml](./unit-tests/flow.yml) |
| `documentation` | Generate or improve README, contributing, and architecture documentation from the codebase. | 3 steps | claude, codex, gemini | [workflows/documentation/flow.yml](./documentation/flow.yml) |
| `error-handling` | Audit and improve error boundaries, logging, retries, and user-friendly failure states. | 3 steps | claude, codex, gemini | [workflows/error-handling/flow.yml](./error-handling/flow.yml) |
| `ux-copy-polish` | Improve UX polish, loading states, empty states, transitions, and conversion copy. | 3 steps | claude, codex, gemini | [workflows/ux-copy-polish/flow.yml](./ux-copy-polish/flow.yml) |
<!-- /docs -->
