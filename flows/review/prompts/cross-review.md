---
title: Cross Review
description: Cross-check the first-round Claude/Gemini/Codex review findings against each other.
instruction: please cross-reference the first-round review outputs and evaluate the other models' findings carefully
---

# Cross Reference Review

You are in round 2 of a multi-model review process.

The **Additional Context** section contains:

- the first-round review outputs from Claude, Gemini, and Codex
- a pinned commit SHA and repository snapshot
- a merge-state ledger for open PRs at prompt generation time

Your job is to:

1. Identify which first-round report came from **your own model family**.
2. Treat that report as your prior position.
3. Critically evaluate the **other two** reports.
4. Say where they are right, where they are overstating things, where they missed important context, and where an item is already fixed or partly fixed.
5. Update your own position based on the strongest evidence.

Do not just restate the other reports. Adjudicate them.

## Non-Negotiable Constraints

1. This is **review-only**. Do **not** edit files, commit, or open/update PRs.
2. Do **not** stage files, run code formatters that modify files, or leave any working-tree changes behind.
3. If you accidentally changed files while investigating, revert those changes before finishing.
4. Before concluding, verify the working tree is clean with `git status --short`.
5. If the working tree is not clean at the end of the review, stop and return a repository-state violation instead of a normal cross-review.
6. Before reviewing anything substantial, verify the checked-out `git rev-parse HEAD`.
7. If the checked-out SHA does **not** exactly match the pinned SHA from the Additional Context, evaluate repository drift before deciding whether to stop:
   - Run `git merge-base --is-ancestor <pinned_sha> HEAD`.
   - If the pinned SHA is not an ancestor of `HEAD`, stop and return a repository-state mismatch report.
   - If it is an ancestor, run `git rev-list --count <pinned_sha>..HEAD`.
   - Continue only when the runner is 1-5 commits ahead and `git diff --shortstat <pinned_sha>..HEAD` is not obviously huge.
   - Stop when drift is more than 5 commits or the diff is large enough that cross-review against the pinned context would be unreliable.
8. Treat open PRs as merge-dependent context. Do not assume a PR is merged unless the pinned SHA actually contains it.

## Review Rules

- Be skeptical and evidence-driven.
- Prefer concrete code references over general opinions.
- Distinguish clearly between:
  - **confirmed issue**
  - **likely issue**
  - **already fixed**
  - **weak / unsupported claim**
- If another model found a real problem you missed, say so directly.
- If your original report was wrong or incomplete, correct yourself explicitly.
- If a model implemented fixes in a PR, do not treat those exact items as still-open unless the fix is partial.

## Structured Findings Schema

Start your output with `## 2. Structured Findings` as a fenced JSON block using this schema:

```json
[
  {
    "id": "CR1",
    "category": "defect",
    "severity": "critical",
    "status": "confirmed",
    "file": "path/to/file.js",
    "line": 123,
    "claim": "One-sentence finding",
    "evidence": "Why this survives cross-review",
    "suggested_fix": "Concrete next action",
    "confidence": "high"
  }
]
```

Rules:

- `category` must be `defect`, `polish`, or `rejected`.
- `status` must be `confirmed`, `likely`, `already_fixed`, or `rejected`.
- Every non-rejected finding must include `file` and `line`.
- Keep the JSON compact; use the prose sections for nuance.

## Output

Write a structured report with these sections:

## 1. Repository State
- `pinned_sha`
- `checked_out_sha`
- `state_match`: `yes` or `no`
- `drift_commits`: number of commits from pinned SHA to checked-out SHA, or `0`
- `drift_acceptable`: `yes` or `no`
- `git_status_clean`: `yes` or `no`
- If `state_match` is `no` and `drift_acceptable` is `no`, stop here.
- If `git_status_clean` is `no`, stop here.

## 2. Structured Findings
- A fenced JSON block using the schema above

## 3. My Original Position
- Brief summary of your first-round report

## 4. Evaluation Of The Other Two Reports
For each other model:
- **Strong agreements**
- **Disagreements**
- **Claims that need more evidence**
- **Important things they found that I missed**
- **Important things they missed**

## 5. Updated Consensus View
- List the highest-confidence issues that still matter after cross-checking
- Rank them by impact
- Include `file:line` references wherever possible
- Separate defects from polish where helpful

## 6. Already-Fixed Or Partially-Fixed Items
- Call out anything that should be removed from the live backlog because it was already fixed in the meantime

## 7. Revised Recommendations
- Give the top 3-5 next actions after seeing the other models' work

## 8. Items Considered And Rejected
- List up to 3 claims that you investigated but do **not** think belong in the backlog
- Give a one-line reason for each rejection

## 9. Self-Corrections
- Explicitly list any places where your original report changed after this cross-reference pass

Be direct. The goal is not diplomacy; it is convergence on the strongest true findings.
