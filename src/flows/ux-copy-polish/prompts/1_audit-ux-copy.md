---
title: Audit UX And Copy
description: Independently inspect UI polish, copy clarity, and conversion friction.
instruction: audit UX polish, loading states, empty states, transitions, and conversion copy
---

# UX And Copy Polish Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This prompt combines `ux-audit`, `ui-polish`, and `docs-de-slopify`: evaluate usability first, then visual polish and copy quality. The app should already work; do not recommend a full redesign unless the current UI cannot support the task.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## UX Heuristics

Evaluate:

- Visibility: users know what is happening, especially during loading, saving, errors, async jobs, and background work.
- Real-world language: labels and copy match user goals, not implementation terms.
- Control: users can undo, cancel, dismiss, go back, recover, and avoid destructive mistakes.
- Consistency: same action, state, and terminology mean the same thing everywhere.
- Error prevention and recovery: validation, confirmations, helpful errors, empty states, and retry paths.
- Recognition: options are discoverable; users do not need hidden knowledge.
- Efficiency: common workflows are fast for repeat users.
- Minimalism: the UI is dense enough for the product without clutter.

## Polish And Copy Checks

Consider desktop and mobile separately:

- Layout, spacing, alignment, visual hierarchy, density, typography, color balance, border radius consistency, hover/focus/active states.
- Loading states, skeletons, disabled states, optimistic updates, empty states, error states, success states, transitions, and animation restraint.
- CTA hierarchy, onboarding clarity, pricing/upgrade moments, form friction, trust cues, and conversion copy.
- Copy specificity: remove vague claims, generic marketing filler, "here's why" formulas, "it's not X, it's Y" constructions, excessive em dashes, and AI-sounding phrasing.
- Accessibility and performance implications of any polish idea.

## Output

Start with `## Repository State`, then `## UX Surface Map`, then `## Structured Findings` as fenced JSON:

```json
[
  {
    "id": "UXCOPY-1",
    "priority": "P1",
    "type": "empty-state|loading|copy|visual|flow",
    "file": "app/dashboard/page.tsx",
    "line": 52,
    "desktop_mobile": "both",
    "issue": "Empty dashboard gives no next action",
    "user_impact": "New users stall after signup",
    "specific_improvement": "Add concise empty state with primary setup action",
    "risk": "Low",
    "verification": "Manual route check at desktop and mobile widths"
  }
]
```

Then include `## Highest Leverage Polish`, `## Copy Rewrites`, `## Desktop vs Mobile Notes`, and `## Deferred Ideas`.
