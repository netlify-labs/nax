---
title: Implement Approved Changes
description: Apply only the changes approved at the human review gate.
instruction: implement the human-approved changes from the prior audit
---

# Implement Approved Changes

You may edit files. Implement only the changes approved at the human review gate.

## Implementation Rules

- Keep the change scoped to the approved work.
- Preserve existing public behavior unless the approval explicitly allowed a behavior change.
- Follow the repository's local style and helper APIs.
- Add or update tests when the approved change affects behavior.
- Do not implement items that were deferred, rejected, or marked risky.

## Verification

Run the most relevant checks for the changed files and report the results.

## Output

Summarize files changed, behavior changed, verification commands, and anything that still needs manual review.
