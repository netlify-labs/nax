---
title: Synthesize Unit Test Plan
description: Rank test gaps by behavioral risk and implementation cost.
instruction: synthesize unit test gap proposals into a focused first test plan
---

# Synthesize Unit Test Plan

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Read all prior unit-test discovery results. Deduplicate by behavior and choose a first slice that is deterministic, high-value, and consistent with existing test style.

## Rules

- Prefer behavior contracts over implementation details.
- Choose table, golden, round-trip, conformance, property, or error-path patterns deliberately.
- Reject volatile snapshots unless scrubbing/canonicalization is clear.
- Keep the first slice small enough to implement and run.

## Output

Produce `## Current Test Setup`, `## Selected First Test Slice`, `## Structured Test Plan` as fenced JSON, `## Additional Backlog`, and `## Risks`.

Each selected target needs `file:line`, behavior, pattern, edge cases, test file, determinism notes, and source agents.
