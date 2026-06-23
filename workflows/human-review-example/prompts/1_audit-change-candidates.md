---
title: Audit Change Candidates
description: Find safe, high-value changes that should be reviewed before implementation.
instruction: audit the repository and propose a small set of changes for human approval
---

# Audit Change Candidates

Review the repository and propose a short, prioritized implementation plan.

## Scope

- Look for changes that are valuable, well-scoped, and easy to verify.
- Prefer fixes that preserve existing architecture and user-facing behavior.
- Call out risky or ambiguous work separately instead of folding it into the implementation plan.
- Do not edit files in this step.

## Output

Return:

1. Recommended changes, ordered by impact.
2. Files or areas likely to change.
3. Risks, unknowns, and verification needed.
4. A clear recommendation for whether a human should approve continuation.
