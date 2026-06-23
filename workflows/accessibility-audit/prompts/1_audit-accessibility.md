---
title: Audit Accessibility
description: Independently identify accessibility defects with WCAG impact and file references.
instruction: audit the app for WCAG 2.1 AA accessibility defects and prioritize fixes
---

# Accessibility Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This prompt embeds the accessibility portion of the `ux-audit` skill with enough WCAG-oriented detail for cloud runners.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Audit Scope

Find routes, layouts, components, forms, dialogs, menus, navigation, tables, charts, uploads, media, icons, interactive widgets, error states, loading states, and empty states.

Check these areas:

- Keyboard: all interactive elements reachable, logical focus order, visible focus, skip links, no keyboard traps, escape/close behavior, menu/dialog focus management, and no hover-only functionality.
- Semantics: native elements where possible, correct buttons/links, landmarks, headings, lists, tables, labels, fieldsets, descriptions, and accessible names.
- Forms: labels, required indicators, validation messages, aria-describedby, autocomplete, grouped controls, error summary, and programmatic announcements.
- Screen reader behavior: icon-only controls, live regions, route changes, async loading, toasts, modals, tabs, accordions, and custom selects.
- Visual access: contrast, text sizing, zoom/reflow, color-only communication, reduced motion, disabled states, and focus/hover states.
- Media/assets: meaningful alt text, decorative images ignored, captions/transcripts where relevant.
- Mobile accessibility: touch target size, spacing, zoom, orientation, and responsive reflow.

## Severity

- Blocker: prevents a keyboard or assistive-tech user from completing a critical flow.
- Serious: major task degradation, missing labels, broken dialog/menu, poor contrast on important content.
- Moderate: confusing or inefficient but workaround exists.
- Minor: polish or best practice with limited task impact.

## Output

Start with `## Repository State`, then `## Accessibility Surface Map`, then `## Structured Findings` as fenced JSON:

```json
[
  {
    "id": "A11Y-1",
    "severity": "serious",
    "wcag": "2.1.1 Keyboard",
    "file": "components/Dialog.tsx",
    "line": 42,
    "issue": "Dialog does not trap focus",
    "user_impact": "Keyboard users can tab behind modal content",
    "evidence": "No focus trap or aria-modal behavior in component",
    "recommended_fix": "Use existing dialog primitive or add focus management",
    "verification": "Keyboard tab cycle plus axe/Playwright check"
  }
]
```

Then include `## Critical User Flows`, `## Fix Plan`, `## Manual Checks Needed`, and `## Positive Findings`.
