---
title: Propose Next Task
description: Identify and recommend the most logical next development task based on current project state.
instruction: please identify and recommend the most logical next development task based on the current project state and goals
---

# Propose Next Development Task

After completing the task above, **Your next task: Identify and recommend the most logical next development task based on the current project state and goals.**

## File Existence Check

Check for key documentation files first:

```bash
ls . docs
```

Use these results to inform your analysis.

To achieve this, follow these thought processes:

1. **Understand Context:**
   - Review relevant project documentation (e.g. files in `docs/`, `README.md`).
   - Analyze current project requirements. If a `.cursor/rules/req-task.mdc` (or similar) file exists and is relevant, consult it for specific task requirements or context.
   - Consider the most recent actions, discussions, or completed work in the project.

2. **Identify Potential Tasks:**
   - Based on your understanding, brainstorm a list of 3-5 potential next tasks that would advance the project.

3. **Evaluate and Recommend:**
   - From your list, select the single most logical and impactful task to undertake next.
   - Clearly state your recommendation.
   - Provide concise reasoning for your choice, explaining why it's the most appropriate next step (e.g. dependency for other tasks, highest priority, unblocks other work).

## Output Expectation

Your response should clearly state:

1. **Recommended Next Task:** [Describe the task]
2. **Reasoning:** [Explain why this task is recommended]
3. **Alternative Tasks:** [Briefly list 1-2 other potential tasks considered]

## Repository State

The **Additional Context** section contains a pinned commit SHA and repository snapshot.

Before doing substantial analysis, verify `git rev-parse HEAD`. If the checked-out SHA does not exactly match the pinned SHA, evaluate repository drift:

- Run `git merge-base --is-ancestor <pinned_sha> HEAD`.
- If the pinned SHA is not an ancestor of `HEAD`, stop and return a repository-state mismatch report.
- If it is an ancestor, run `git rev-list --count <pinned_sha>..HEAD`.
- Continue only when the runner is 1-5 commits ahead and `git diff --shortstat <pinned_sha>..HEAD` is not obviously huge.
- Stop when drift is more than 5 commits or the diff is large enough that the recommendation would be unreliable.

**REMEMBER: Your goal is to provide a well-reasoned recommendation for the single most impactful next development task.**
