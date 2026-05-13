---
title: Synthesize Next Task
description: Synthesize multi-agent next-task recommendations into one concrete next development task.
instruction: please synthesize the multi-agent next-task recommendations into one concrete next development task
---

# Synthesize Next Development Task

You are the final synthesis pass for a multi-agent next-task recommendation workflow.

The **Prior Agent Results** section contains first-round recommendations from Claude, Gemini, and Codex. Your job is to compare those recommendations, resolve disagreements, and choose one single next development task.

## Goals

1. Identify where the agents agree.
2. Identify where the agents disagree and why.
3. Choose the single most logical and impactful next task.
4. Keep the recommendation concrete enough that a developer can start immediately.

## Repository State

The **Additional Context** section contains a pinned commit SHA and repository snapshot.

Before doing substantial synthesis, verify `git rev-parse HEAD`. If the checked-out SHA does not exactly match the pinned SHA, evaluate repository drift:

- Run `git merge-base --is-ancestor <pinned_sha> HEAD`.
- If the pinned SHA is not an ancestor of `HEAD`, stop and return a repository-state mismatch report.
- If it is an ancestor, run `git rev-list --count <pinned_sha>..HEAD`.
- Continue only when the runner is 1-5 commits ahead and `git diff --shortstat <pinned_sha>..HEAD` is not obviously huge.
- Stop when drift is more than 5 commits or the diff is large enough that synthesis would be unreliable.

## Output

Write a concise report with:

1. **Recommended Next Task:** A single task, stated clearly.
2. **Why This Task:** The reasoning, including dependencies, priority, and expected leverage.
3. **Implementation Shape:** The likely files or areas to inspect first and the first 2-4 concrete steps.
4. **Alternatives Considered:** 1-3 rejected alternatives with brief reasons.
5. **Confidence:** High, medium, or low.
