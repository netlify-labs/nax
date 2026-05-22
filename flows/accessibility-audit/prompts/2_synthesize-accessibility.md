---
title: Synthesize Accessibility Fix Plan
description: Deduplicate findings and rank fixes by user impact and implementation risk.
instruction: synthesize accessibility audit results into a focused WCAG fix plan
---

# Synthesize Accessibility Fix Plan

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Read all prior accessibility audits. Deduplicate by user impact and component root cause. Reject findings that are not tied to source code or a verifiable user problem.

## Output

Produce `## Consensus Summary`, `## Structured Fix Plan` as fenced JSON, `## Manual Verification Matrix`, and `## Deferred Items`.

Each accepted fix needs severity, WCAG criterion when known, `file:line`, user impact, specific code change, verification method, implementation risk, and source agents.
