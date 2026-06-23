---
title: Implement Accessibility Fixes
description: Apply the highest-confidence WCAG fixes and verify them.
instruction: implement the synthesized accessibility fixes that are safe and high confidence
---

# Implement Accessibility Fixes

You may edit files. Keep the patch focused on the synthesized high-confidence accessibility fixes.

## Implementation Rules

- Prefer semantic HTML and established component primitives over custom ARIA.
- Preserve visual design unless the fix requires visible contrast, focus, spacing, or state changes.
- Do not add ARIA that conflicts with native semantics.
- Maintain keyboard order and visible focus.
- Keep icon-only controls named with accessible labels.
- Ensure form errors and async status are programmatically associated or announced.
- Respect reduced motion where adding transitions.
- If a fix needs product/design judgment, leave it as a documented follow-up.

## Verification

Run relevant tests, lint, typecheck, axe, Playwright, or targeted keyboard checks. If unavailable, state the manual checks needed.

## Output

Report files changed, accessibility issues fixed, verification commands/results, and remaining manual checks.
