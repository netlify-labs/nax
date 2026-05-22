---
title: Audit Performance
description: Independently inspect the codebase for performance risks and optimization targets.
instruction: scan the codebase for performance bottlenecks and produce a measurement-first optimization plan
---

# Performance Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This prompt embeds the core of the `extreme-software-optimization` skill for remote runners: profile first, prove behavior unchanged, and rank opportunities by measured or measurable impact.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Method

Do not propose speculative optimization work as if it is proven. Split findings into:

- `measured`: you ran a benchmark/profile or found existing measurements.
- `strong-static-evidence`: code clearly implies cost, such as serial network calls, unbounded queries, or N+1 behavior.
- `needs-measurement`: plausible, but must be profiled before implementation.

Use the optimization loop:

1. Baseline: identify a benchmark, route, script, or user flow that can measure p50/p95/p99, throughput, memory, bundle size, render time, or build time.
2. Profile: identify the right tool for the stack, such as `hyperfine`, `clinic flame`, Chrome/Next bundle tools, `go test -bench`, `pprof`, `cargo flamegraph`, `py-spy`, database query plans, or existing APM.
3. Prove behavior: name the tests, golden outputs, snapshots, checksums, or invariants needed before changing behavior.
4. Rank: only recommend implementation when score is high enough.
5. Verify: specify before/after measurement and regression checks.

Opportunity score:

`score = impact(1-5) * confidence(1-5) / effort(1-5)`

Treat score >= 2.0 as implementable. Below that, prefer measuring or leaving it in backlog.

## Audit Surfaces

Inspect these areas as applicable:

- Backend: N+1 queries, missing joins/preloads, serial external calls, async work inside loops, unbounded queries, missing pagination, heavy JSON parse/stringify, blocking filesystem/process calls, excessive retries, large in-memory accumulations, and cacheable hot paths.
- Frontend: client bundle size, unnecessary client components, hydration cost, expensive effects, re-render storms, missing memoization on hot components, slow images, layout shift, over-fetching, route waterfalls, and interaction latency.
- Data: missing indexes, offset pagination on large tables, unbounded search, inefficient sort/filter, missing query limits, repeated serialization, and avoidable full scans.
- Build/CI: slow scripts, redundant installs, unnecessary generated artifacts, expensive test setup, and poor cache keys.
- Runtime operations: serverless cold starts, process-local caches that do not help in the cloud, memory leaks, connection churn, rate-limit or queue bottlenecks, and observability gaps.

## Safe Pattern Catalog

Use these as candidate shapes, not assumptions:

- N+1 to batch or join: same records, fewer round trips.
- Serial awaits to bounded concurrency: preserve ordering where output order matters.
- Linear lookup to map/set: preserve deterministic tie-breaking.
- Lazy evaluation: compute only values actually used.
- Memoization/cache: define key, TTL, invalidation, tenant/user scope, and stale behavior.
- Pagination/windowing/virtualization: preserve total results and cursor semantics.
- Streaming/chunking: preserve output format and error behavior.
- Image or bundle optimization: preserve visual fidelity and accessibility.

## Behavior-Preservation Proof

For each recommended fix, include:

- Ordering preserved: yes/no and why.
- Tie-breaking unchanged: yes/no and why.
- Floating point or time sensitivity: identical/N/A or bounded.
- Cache invalidation correctness.
- Tenant/user isolation preserved.
- Golden output or regression test to prove behavior.

## Output

Start with `## Repository State`, then `## Performance Map`, then `## Structured Opportunities` as fenced JSON:

```json
[
  {
    "id": "PERF-1",
    "status": "measured",
    "area": "backend",
    "file": "path/to/file.ts",
    "line": 123,
    "hypothesis": "What is slow and why",
    "evidence": "Measurement or static evidence",
    "measurement_plan": "Exact benchmark/profile to run",
    "optimization_shape": "Safe implementation shape",
    "behavior_proof": "Tests/goldens/invariants",
    "impact": 4,
    "confidence": 4,
    "effort": 2,
    "score": 8.0
  }
]
```

Then include:

- `## Ranked Opportunities`
- `## Measure First`
- `## Quick Wins`
- `## Risks And Rejected Ideas`

Every opportunity needs `file:line`, evidence, measurement plan, and behavior-preservation notes.
