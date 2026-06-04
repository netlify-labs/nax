---
title: Discover Unit Test Gaps
description: Independently identify high-value untested functions and edge cases.
instruction: identify untested utility and domain logic that should receive focused unit tests
---

# Discover Unit Test Gaps

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Use the testing skills' shared principle: test the contract. Prefer behavior, fixtures, golden artifacts, round trips, and edge cases over superficial line coverage.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Discover Test Infrastructure

Identify:

- Test runner, scripts, config, coverage tools, fixtures, snapshots/goldens, mocks, factories, and CI behavior.
- Current test style: unit vs integration, table-driven tests, snapshots, fixtures, public APIs, helper patterns.
- Untested code with business rules, parsing, validation, serialization, config precedence, state machines, permission checks, date/time, sorting, retries, and error formatting.

## Candidate Test Patterns

Use the pattern that fits the behavior:

- Example/table tests: deterministic utility logic and edge cases.
- Golden artifacts: complex text/JSON/HTML/CLI output that should remain stable; scrub timestamps, IDs, paths, durations, and random values.
- Round-trip tests: parse/serialize, encode/decode, import/export, markdown/render, schema transformations.
- Conformance tests: behavior is defined by a spec, API contract, reference implementation, or documented compatibility promise.
- Property/metamorphic tests: transformations where exact expected values are hard but invariants are clear.
- Error-path tests: invalid input, missing env vars, failed I/O, network failures, denied permissions.

## Prioritization

Rank by:

- Blast radius and business risk.
- Bug-prone branching.
- Public API or user-facing behavior.
- Ease of deterministic testing.
- Existing regression history or TODOs.

Avoid tests that only assert implementation details, snapshot huge volatile output, or require broad refactors.

## Output

Start with `## Repository State`, then `## Current Test Infrastructure`, then `## Structured Test Gaps` as fenced JSON:

```json
[
  {
    "id": "UNIT-1",
    "priority": "P0",
    "target": "src/config.ts",
    "line": 42,
    "behavior": "Config precedence between env, file, and flags",
    "test_pattern": "table",
    "edge_cases": ["missing env", "invalid value", "flag overrides file"],
    "suggested_test_file": "test/config.test.ts",
    "determinism_notes": "Use temp dirs and restore env",
    "why": "Broken config blocks all runtime modes"
  }
]
```

Then include `## Selected First Slice` and `## Backlog`.
