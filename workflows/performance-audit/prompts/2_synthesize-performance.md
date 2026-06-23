---
title: Synthesize Performance Plan
description: Rank performance opportunities by evidence, impact, confidence, and effort.
instruction: synthesize performance audit results into a measurement-first optimization plan
---

# Synthesize Performance Plan

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Read all prior performance audits. Deduplicate by root bottleneck, not by surface symptom. Reject optimization ideas that lack evidence and no clear measurement path.

## Rules

- Prefer measured findings over plausible static guesses.
- Keep `measured`, `strong-static-evidence`, and `needs-measurement` separate.
- Recalculate `score = impact * confidence / effort`.
- Do not recommend implementation for score < 2.0 unless it fixes a correctness or reliability risk.
- Each implementation candidate must include a behavior-preservation proof.

## Output

Produce:

1. `## Consensus Summary`
2. `## First Measurements To Run`
3. `## Structured Consensus` as fenced JSON with id, status, area, `file:line`, evidence, measurement plan, optimization shape, behavior proof, score, and source agents
4. `## Ranked Implementation Candidates`
5. `## Measure-First Backlog`
6. `## Rejected Or Risky Optimizations`

Call out the single safest first optimization only if it has enough evidence and a clear verification loop.
