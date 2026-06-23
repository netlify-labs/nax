---
title: Synthesize Mobile Fix Plan
description: Produce a route-by-route responsive fix plan.
instruction: synthesize mobile responsiveness audit results into a route-by-route fix plan
---

# Synthesize Mobile Fix Plan

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Read all prior mobile audits. Deduplicate by route/component root cause and prioritize visible issues on common phone widths.

## Output

Produce `## Consensus Summary`, `## Structured Fix Plan` as fenced JSON, `## Viewport Verification Matrix`, and `## Deferred Screenshot Checks`.

Each accepted fix needs severity, viewport, `file:line`, visible issue, recommended code change, desktop-regression risk, verification method, and source agents.
