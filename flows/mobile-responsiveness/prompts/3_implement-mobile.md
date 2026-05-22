---
title: Implement Mobile Fixes
description: Apply focused responsive improvements and verify common mobile viewports.
instruction: implement the synthesized mobile responsiveness fixes that are safe and high confidence
---

# Implement Mobile Fixes

You may edit files. Keep the patch focused on synthesized responsive fixes.

## Implementation Rules

- Preserve desktop behavior.
- Use existing design tokens, breakpoints, and component patterns.
- Prefer responsive constraints over hiding content.
- Avoid fixed widths/heights for dynamic content unless bounded with overflow behavior.
- Ensure buttons, tabs, and icon controls have usable touch targets.
- Do not solve overflow by shrinking text below readable sizes.
- Check long labels, dynamic data, and empty/error/loading states.
- Maintain accessibility: focus order, labels, contrast, and reduced motion.

## Verification

Run relevant tests, lint, typecheck, and browser/screenshot checks if available. Reason explicitly about 320, 375, 390, and 414px widths for changed screens.

## Output

Report files changed, mobile issues fixed, viewports/checks used, desktop-regression considerations, and remaining runtime screenshot validation.
