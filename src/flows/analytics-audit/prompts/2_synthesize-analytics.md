---
title: Synthesize Analytics Plan
description: Produce one tracking plan with event names, properties, and implementation locations.
instruction: synthesize analytics audit results into a practical tracking plan
---

# Synthesize Analytics Plan

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Read all prior analytics audits. Merge event proposals by funnel decision, normalize names to the repository's existing convention, and reject events that are noisy, duplicative, privacy-risky, or not tied to a decision.

## Output

Produce:

1. `## Current Telemetry Summary`
2. `## Structured Tracking Plan` as fenced JSON with event, priority, trigger, `file:line`, client/server, parameters, conversion flag, decision enabled, privacy notes, validation, and source agents
3. `## Funnel Coverage Matrix` covering acquisition, conversion, activation, engagement, monetization, retention, and failures
4. `## Implementation Notes`
5. `## Validation Plan`
6. `## Rejected Events`

Call out the first minimal implementation slice, but do not invent analytics provider credentials or external GTM setup that cannot be done from source code.
