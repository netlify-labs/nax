## 1. Repository State

- `pinned_sha`: `0a9a6b1ae0da161bbacabcdfa06d38069c20fdf0`
- `checked_out_sha`: `0a9a6b1ae0da161bbacabcdfa06d38069c20fdf0`
- `state_match`: `yes`
- `drift_commits`: `0`
- `drift_acceptable`: `yes`
- `git_status_clean`: `yes`

## 2. Structured Findings

```json
[
  {
    "id": "R1",
    "category": "defect",
    "severity": "warning",
    "status": "confirmed",
    "file": "src/workflows/engine/runner.js",
    "line": 196,
    "claim": "Concurrent in-process workflows can capture each other's console output and restore the global console in the wrong order.",
    "evidence": "Each run replaces process-wide console methods and later restores the methods it observed; the dashboard only rejects duplicate runs for the same flow, so different flows can overlap and corrupt output routing.",
    "suggested_fix": "Stop monkey-patching global console state; pass a run-scoped logger/output sink through the engine, or serialize all in-process executions as an interim safeguard.",
    "confidence": "high"
  },
  {
    "id": "R2",
    "category": "defect",
    "severity": "warning",
    "status": "confirmed",
    "file": "site/app/layout.tsx",
    "line": 67,
    "claim": "Documentation edit links target the nonexistent `main` branch instead of the repository's `master` branch.",
    "evidence": "The layout hard-codes `/blob/main/site/content`, while the pinned source and checked-out repository use `origin/master`, so generated edit links lead to the wrong branch.",
    "suggested_fix": "Change the documentation repository base to the canonical `master` path or derive the branch from deployment configuration.",
    "confidence": "high"
  },
  {
    "id": "R3",
    "category": "defect",
    "severity": "warning",
    "status": "confirmed",
    "file": "site/app/favicon.ico/route.ts",
    "line": 1,
    "claim": "The generated favicon payload is truncated and does not match its ICO directory metadata.",
    "evidence": "The embedded payload decodes to 187 bytes, but its ICO header declares a 296-byte image beginning at byte 22, requiring 318 total bytes; clients may reject the icon.",
    "suggested_fix": "Replace the embedded bytes with a valid static favicon asset and add a small header/length regression test.",
    "confidence": "high"
  },
  {
    "id": "R4",
    "category": "polish",
    "severity": "suggestion",
    "status": "confirmed",
    "file": "src/integrations/netlify/dashboard-context.js",
    "line": 126,
    "claim": "Dashboard startup repeats the same Netlify account lookup once for every discovered site.",
    "evidence": "The context resolver calls `checkNetlifyAccess` per site, and each call performs `/user` before the site request, creating 2N API calls and duplicated authentication work.",
    "suggested_fix": "Resolve the token/account once, then check site access with a shared client or cache the `/user` result across the batch.",
    "confidence": "high"
  },
  {
    "id": "R5",
    "category": "polish",
    "severity": "suggestion",
    "status": "confirmed",
    "file": "src/dashboard/web/src/run-format.ts",
    "line": 69,
    "claim": "Credit usage is rendered from raw floating-point values without consistent rounding or locale formatting.",
    "evidence": "The dashboard interpolates the numeric value directly, unlike the CLI formatter, so fractional aggregation can produce noisy values and inconsistent presentation between surfaces.",
    "suggested_fix": "Share a credits formatter that applies a stable precision policy across the CLI and dashboard.",
    "confidence": "high"
  }
]
```

## 3. Explore

### Project Overview

`nax` is a CommonJS Node CLI for orchestrating multi-step Netlify Agent Runner workflows, with GitHub Actions and direct Netlify API transports, durable `.nax` artifacts, follow-up sessions, and a local React/Vite dashboard. The documentation site is a separate Next.js 16/Nextra package under `site/`.

### Architecture

- CLI parsing and handlers live under `src/cli/`; orchestration is split across `src/workflows/engine/`, transport integrations, and local artifact storage.
- The dashboard separates API/runtime/storage/transport concerns under `src/dashboard/`, with a React client under `src/dashboard/web/`.
- Shared public payload contracts are typed in `src/contracts/`, while JavaScript modules use JSDoc shapes in accordance with `AGENTS.md`.
- Documentation routes are generated through Nextra from `site/content`, with custom home-page components and styling.

### Execution Flows Traced

1. CLI run: Commander registration → `src/cli/main.js` handler → Netlify target selection/preflight → workflow engine → transport executor → durable state and artifacts.
2. Dashboard run: authenticated dashboard API → `startRun` live registry → in-process workflow execution → event/output capture → durable run reconciliation and SSE updates.
3. Documentation request: catch-all Next route → Nextra `importPage` → MDX wrapper/layout → navigation, search, and repository edit links.

### Test Coverage Gaps

- There is no site-specific test command or route/component test suite in `site/package.json:7`; the broken edit-link branch and malformed favicon are therefore unguarded.
- Workflow runner tests cover sequential in-process execution but not two overlapping flows, leaving the global console race at `src/workflows/engine/runner.js:196` untested.
- Targeted recent-change tests produced 115 passes. One test failed because this review environment disables `git init`/`git check-ignore`; the failure does not establish a repository defect.

### Conventions

The code generally uses precise JSDoc typedefs, dependency injection for testability, structured API errors, bounded live output, explicit public serializers, and focused Node test coverage. Recent changes follow those patterns.

## 4. Review

### Recent Changes Summary

The last five commits added dashboard Netlify target visibility, per-run credit usage, a `nax costs` report, and supporting contracts/tests. The changes are cohesive and mostly well-covered. The strongest recent addition is the explicit target propagation from dashboard context into launched workflows.

### Defects

- **Warning — concurrent output corruption:** `src/workflows/engine/runner.js:196` patches process-global console functions, while `src/dashboard/server.js:1213` only blocks a second run of the same workflow. Different workflows can overlap, cross-route output, and restore stale console functions.
- **Warning — broken edit links:** `site/app/layout.tsx:67` points Nextra's repository base at `main`, but the repository source is `master`.
- **Warning — invalid favicon:** `site/app/favicon.ico/route.ts:1` serves an ICO whose declared image length exceeds the actual payload.

### Root Causes

- The in-process runner preserves a child-process-style output contract by adapting global process facilities rather than injecting run-scoped dependencies.
- Site shell details are hard-coded without lightweight route/asset validation.

### Positive Observations

- Dashboard health data remains token-protected before exposing project and Netlify context.
- Recent target selection changes pass the resolved site ID and filter through dry runs and real runs consistently.
- Usage aggregation is centralized and covered at the artifact, API, CLI, and UI layers.

## 5. Improve

### Quick Wins

1. Correct the docs branch at `site/app/layout.tsx:67`.
2. Replace the favicon payload at `site/app/favicon.ico/route.ts:1` with a valid asset.
3. Standardize credit formatting at `src/dashboard/web/src/run-format.ts:69`.
4. Add a minimal site smoke suite through `site/package.json:7` for metadata, edit URLs, favicon validity, and core routes.

### Polish Items

- The site README still reads like generated scaffold documentation and recommends Vercel despite this repository's Netlify deployment configuration at `site/README.md:3`; rewrite it around the actual Netlify/Nextra setup.
- The council visualization uses tab roles without a complete roving-tab/tabpanel relationship at `site/components/council-viz.tsx:222`; either implement the tab pattern fully or use simpler button semantics.

### Refactoring Opportunities

- Replace global console capture at `src/workflows/engine/runner.js:109` with an injected logger/event sink. This removes the concurrency defect and simplifies testing.
- Consolidate credit formatting shared by `src/cli/display/costs-report.js:60` and `src/dashboard/web/src/run-format.ts:69` so rounding and labels remain consistent.

### Performance Notes

- Batch Netlify account verification in `src/integrations/netlify/dashboard-context.js:126`; account identity is invariant across site checks, so repeated `/user` calls are unnecessary.
- Recursive Netlify config/state discovery is synchronous at `src/integrations/netlify/local-runner.js:360`. It is bounded and skips common heavy directories, so this is acceptable today, but instrumentation would help before increasing scan depth.

### Design Concerns

The local dashboard runs workflows inside its own process. That reduces process-management overhead but couples workflow execution to process-global state and server stability. Moving execution behind a worker/process boundary, or making the engine fully context-injected, would provide stronger isolation.

## Items Considered And Rejected

- `tests/unit/local-runner.test.js:376`: the gitignore test failure was caused by the review harness disabling `git init` and `git check-ignore`; it is not backlog evidence against production behavior.
- `src/cli/display/costs-report.js:32`: limiting before aggregation is consistent with the command's “recent runs” behavior and clearly reports the shown count.
- `site/app/[[...mdxPath]]/page.tsx:14`: rejecting dotted terminal path segments is a reasonable guard against non-document requests given the current slug set.
