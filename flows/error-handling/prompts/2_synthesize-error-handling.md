---
title: Synthesize Error-Handling Plan
description: Deduplicate findings and identify safe improvements.
instruction: synthesize error handling audit results into a safe remediation plan
---

# Synthesize Error-Handling Plan

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Read all prior error-handling audits. Deduplicate by failure scenario. Reject speculative findings without a concrete code path.

## Output

Produce `## Failure Surface Summary`, `## Structured Fix Plan` as fenced JSON, `## User-Facing Fixes`, `## Operator/Logging Fixes`, `## Tests And Verification`, and `## Deferred Or Risky Work`.

Each selected fix needs `file:line`, failure scenario, current behavior, proposed change, user/operator impact, verification method, risk, and source agents.
