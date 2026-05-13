---
title: Summarize Consensus
description: Summarize the first-round reviews and second-round cross-review outputs into one ranked consensus plan.
instruction: please summarize the multi-model review and cross-review outputs into one ranked consensus plan
---

# Cross Reference Synthesis

You are the synthesis pass in a multi-model review workflow.

The **Additional Context** section contains:

- the original first-round review outputs
- the second-round cross-review outputs where each model evaluated the others
- a pinned commit SHA and repository snapshot
- a merge-state ledger for open PRs at prompt generation time

Your task is to produce the clearest possible synthesis of what the models collectively found.

## Non-Negotiable Constraints

1. This is **review-only synthesis**. Do **not** edit files, commit, or open/update PRs.
2. Do **not** stage files, run code formatters that modify files, or leave any working-tree changes behind.
3. If you accidentally changed files while investigating, revert those changes before finishing.
4. Before concluding, verify the working tree is clean with `git status --short`.
5. If the working tree is not clean at the end of synthesis, stop and return a repository-state violation instead of a normal synthesis report.
6. If you inspect repository code directly, verify the checked-out `git rev-parse HEAD` first.
7. If the checked-out SHA does **not** exactly match the pinned SHA from the Additional Context, evaluate repository drift before deciding whether to stop:
   - Run `git merge-base --is-ancestor <pinned_sha> HEAD`.
   - If the pinned SHA is not an ancestor of `HEAD`, stop and return a repository-state mismatch report.
   - If it is an ancestor, run `git rev-list --count <pinned_sha>..HEAD`.
   - Continue only when the runner is 1-5 commits ahead and `git diff --shortstat <pinned_sha>..HEAD` is not obviously huge.
   - Stop when drift is more than 5 commits or the diff is large enough that synthesis against the pinned review context would be unreliable.
8. Use the merge-state ledger to separate merged reality from PR-only or branch-only claims.

## Goals

1. Separate true consensus from one-model-only opinions.
2. Separate still-open issues from items that were already fixed during the process.
3. Distinguish high-confidence bugs/security issues from polish/refactor suggestions.
4. Produce a ranked action plan that a maintainer can execute.
5. Summarize where the models systematically differed.

## Structured Consensus Schema

Start your output with `## 2. Structured Consensus` as a fenced JSON block using this schema:

```json
{
  "consensus_findings": [
    {
      "id": "S1",
      "category": "defect",
      "severity": "critical",
      "status": "open",
      "file": "path/to/file.js",
      "line": 123,
      "claim": "One-sentence consensus finding",
      "evidence": "Why multiple reviewers converged on this",
      "suggested_fix": "Concrete next action",
      "confidence": "high"
    }
  ],
  "contested_findings": [],
  "merge_dependent_findings": []
}
```

Rules:

- `category` should usually be `defect` or `polish`.
- `status` should distinguish `open`, `already_fixed`, `merge_dependent`, or `dropped`.
- Keep the JSON concise; use prose sections for reasoning.

## Output

Write a report with these sections:

## 1. Repository State
- `pinned_sha`
- `checked_out_sha`
- `state_match`: `yes` or `no`
- `drift_commits`: number of commits from pinned SHA to checked-out SHA, or `0`
- `drift_acceptable`: `yes` or `no`
- `git_status_clean`: `yes` or `no`
- If `state_match` is `no` and `drift_acceptable` is `no`, stop here.
- If `git_status_clean` is `no`, stop here.

## 2. Structured Consensus
- A fenced JSON block using the schema above

## 3. Executive Summary
- One short paragraph explaining the overall result of the multi-model process

## 4. Consensus Findings
- Issues that multiple models converged on
- Rank by impact
- Include `file:line` references when available
- Separate defects from polish where helpful

## 5. Contested Findings
- Issues where models materially disagreed
- Summarize the strongest argument on each side
- Say whether you think the item should stay in the backlog, be downgraded, or be dropped

## 6. Already Addressed Or Merge-Dependent
- Items that appeared in the first round but were fixed or partially fixed during the process
- Include claims whose truth depends on whether a PR is merged into the pinned SHA

## 7. Recommended Action Plan
- Top 5 next actions
- Order them realistically by risk, leverage, and implementation dependency

## 8. Model-Difference Notes
- Briefly describe what each model seemed strongest or weakest at in this review set

## 9. Prompt/Workflow Improvements
- Suggest concrete improvements to the review workflow itself so the next round produces cleaner outputs

## 10. Dropped Or Rejected Items
- Call out items that should be removed from the backlog entirely

Be concise, opinionated, and explicit about confidence.
