---
title: Audit Mobile Responsiveness
description: Independently inspect responsive UI behavior and small-screen risks.
instruction: audit the app across mobile viewports and identify responsive layout fixes
---

# Mobile Responsiveness Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This prompt adapts the `ux-audit` and `ui-polish` skills for mobile-specific inspection. Treat desktop and mobile as separate modalities, not one compromise layout.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Audit Scope

Map all user-facing routes, app shells, navigation, dashboards, data tables, forms, modals, drawers, toolbars, charts, pricing/marketing sections, onboarding, checkout, and admin views.

Inspect at common viewports:

- 320x568 for narrow legacy phones.
- 375x667 and 390x844 for common phones.
- 414x896 for larger phones.
- Small landscape around 667x375.
- Tablet breakpoint if the app has tablet-specific layouts.

If you cannot run the app, perform static analysis and mark runtime-only checks clearly.

## Checks

- Layout: horizontal overflow, clipped content, text overlap, fixed-width containers, unsafe `100vw`, viewport height bugs, sticky/fixed elements covering content, unstable grids, and awkward intermediate breakpoints.
- Navigation: menu discoverability, reachable primary actions, back/close behavior, scroll locking, drawer height, and active state clarity.
- Forms: input widths, label wrapping, keyboard type/autocomplete, validation visibility, error recovery, and submit affordance.
- Dense data: tables, dashboards, code blocks, charts, calendars, and sidebars need mobile patterns such as cards, horizontal scroll with affordance, column priority, or responsive summaries.
- Touch: target size around 44px, spacing between actions, no hover-only controls, no tiny icon-only taps without labels.
- Typography/content: long words, translated strings, dynamic data, button text, and headings fit containers without overlap.
- Media: images, video, canvas, maps, and charts have stable aspect ratios and do not push critical actions below unusable positions.
- Performance: mobile should not load unnecessary heavy desktop-only UI.
- Accessibility overlap: zoom/reflow, focus visibility, reduced motion, and screen reader order still make sense.

## Output

Start with `## Repository State`, then `## Route And Layout Map`, then `## Structured Findings` as fenced JSON:

```json
[
  {
    "id": "MOBILE-1",
    "severity": "high",
    "viewport": "375x667",
    "file": "app/dashboard/page.tsx",
    "line": 88,
    "issue": "Metrics table forces horizontal page overflow",
    "user_impact": "Primary dashboard cannot be scanned on phones",
    "evidence": "Grid uses fixed 900px min width without scroll container",
    "recommended_fix": "Wrap table in overflow container or add mobile card summary",
    "verification": "Screenshot at 375x667 and 390x844"
  }
]
```

Then include `## High-Impact Fixes`, `## Viewport Verification Matrix`, and `## Deferred Visual Review`.
