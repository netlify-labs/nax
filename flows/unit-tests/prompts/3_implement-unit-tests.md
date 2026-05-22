---
title: Implement Unit Tests
description: Add focused unit tests for the highest-value uncovered behavior.
instruction: implement the synthesized unit test plan
---

# Implement Unit Tests

You may edit files. Add the synthesized first slice of unit tests using the repository's existing test framework and style.

## Implementation Rules

- Test behavior, not private implementation details, unless local conventions clearly do otherwise.
- Keep tests deterministic: isolate env vars, temp dirs, time, randomness, network, and filesystem state.
- Use table tests for edge-case matrices.
- Use golden/snapshot tests only when output is complex and stable; scrub timestamps, UUIDs, paths, durations, ports, and random IDs.
- Use round-trip tests for parsers, serializers, import/export, and schema transforms.
- Add regression tests for error paths, invalid input, and missing configuration where relevant.
- Avoid broad refactors. If code is too coupled to test safely, make the smallest extraction needed and explain it.
- Do not weaken existing tests or remove assertions.

## Verification

Run the targeted test file and the relevant broader test command if practical.

## Output

Report files changed, behaviors covered, commands run and results, any deterministic setup added, and remaining high-value test gaps.
