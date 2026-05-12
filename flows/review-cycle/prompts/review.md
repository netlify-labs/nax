---
title: Review
description: Explore, review, and improve the current setup with three independent agents.
instruction: please review and access current setup and see if you find any improvements plz
---

# Review Contract

This run is **review-only**.

## Non-Negotiable Constraints

1. Do **not** edit files.
2. Do **not** commit.
3. Do **not** open or update PRs.
4. Do **not** claim any fix was applied.
5. Do **not** stage files, run code formatters that modify files, or leave any working-tree changes behind.
6. If you accidentally changed files while investigating, revert those changes before finishing.
7. Before concluding, verify the working tree is clean with `git status --short`.
8. If the working tree is not clean at the end of the review, stop and return a repository-state violation instead of a normal review.
9. The **Additional Context** includes a pinned commit SHA and repository snapshot.
10. Before doing substantial analysis, verify `git rev-parse HEAD`.
11. If the checked-out SHA does **not** exactly match the pinned SHA, stop and return a repository-state mismatch report instead of reviewing a different tree.

## Cross-Cutting Output Requirements

- Start the final answer with `## 1. Repository State`:
  - `pinned_sha`
  - `checked_out_sha`
  - `state_match`: `yes` or `no`
  - `git_status_clean`: `yes` or `no`
  - If `state_match` is `no`, stop there.
  - If `git_status_clean` is `no`, stop there.
- Then emit `## 2. Structured Findings` as a fenced JSON block.
- After the JSON block, keep the normal prose sections from Explore, Review, and Improve.
- Distinguish defects from polish instead of mixing them together.
- End with `## Items Considered And Rejected` listing up to 3 things you investigated but do not think belong in the backlog.
- Every non-rejected finding needs `file:line`.

## Structured Findings Schema

Use this exact schema:

```json
[
  {
    "id": "R1",
    "category": "defect",
    "severity": "critical",
    "status": "confirmed",
    "file": "path/to/file.js",
    "line": 123,
    "claim": "One-sentence description of the issue",
    "evidence": "Why this is true, tied to code behavior",
    "suggested_fix": "Concrete next step",
    "confidence": "high"
  }
]
```

Rules:

- `category` must be one of `defect`, `polish`, or `rejected`.
- `status` must be one of `confirmed`, `likely`, `already_fixed`, or `rejected`.
- Keep the JSON compact and factual.
- Preserve free-form explanation after the JSON block.

## Step 1: explore

# Explore

You are starting a fresh exploration of this codebase. Approach it with fresh eyes — assume nothing.

## Goals

1. Understand the project structure: key directories, entry points, config files
2. Read CLAUDE.md and any project documentation for conventions and rules
3. Trace the main execution flows end-to-end
4. Identify bugs, dead code, and inconsistencies
5. Note architectural patterns (good and bad)
6. Find areas with missing error handling or edge cases

## Process

1. Start with the project root: package.json, config files, README
2. Map out the directory structure and understand the organization
3. Read the core files — entry points, main modules, shared utilities
4. Trace at least 2-3 key execution paths from input to output
5. Look at tests — what's covered, what's missing
6. Check for common issues: race conditions, memory leaks, unhandled errors

## Output

Write a structured exploration report covering:

- **Project overview**: What it does, tech stack, key dependencies
- **Architecture**: How the code is organized, main modules and their roles
- **Execution flows**: The key paths you traced
- **Findings**: Bugs, issues, inconsistencies, dead code
- **Test coverage gaps**: What's not tested that should be
- **Conventions**: Coding patterns and style used in this project

Be specific. Reference files and line numbers. Quote code when relevant.

---

## Step 2: review

# Review

Review the codebase with particular attention to recent changes and agent-written code.

## Goals

1. Review recent git commits for quality issues
2. Identify code that looks auto-generated or hastily written
3. Find root causes of any bugs or issues (not just symptoms)
4. Cast a wide net — check all areas, not just changed files

## Process

1. Run `git log --oneline -20` to see recent history
2. Run `git diff HEAD~5` (or appropriate range) to review recent changes
3. For each changed file, review the full file context — not just the diff
4. Check that recent changes follow the project's conventions (see CLAUDE.md)
5. Look for: missing error handling, broken abstractions, naming issues, test gaps
6. Verify that recent changes don't break existing functionality

## Review Criteria

- **Correctness**: Does the code do what it claims? Edge cases handled?
- **Simplicity**: Is the solution the simplest it could be? Over-engineered?
- **Consistency**: Does it match surrounding code style and patterns?
- **Safety**: Input validation, error handling, security considerations
- **Tests**: Are changes covered by tests? Are the tests testing real behavior?

## Output

Write a review report with:

- **Recent changes summary**: What changed and why
- **Defects**: Categorized as critical / warning / suggestion
- **Root cause analysis**: For each issue, explain WHY it exists
- **Specific recommendations**: What to fix, with `file:line` references
- **Positive observations**: What's well-done (brief)

Be direct and specific. Every defect needs a `file:line` reference.

---

## Step 3: improve

# Improve

Scrutinize the project for quality improvements. Think Stripe-level polish.

## Goals

1. Find sub-optimal patterns that work but could be better
2. Identify UX/UI rough edges (CLI output, error messages, user-facing text)
3. Spot performance bottlenecks and unnecessary complexity
4. Find naming that doesn't communicate intent
5. Identify code that's correct but hard to understand or maintain

## Focus Areas

### User Experience
- Are error messages helpful and actionable?
- Is CLI output clear and scannable?
- Are edge cases handled gracefully?
- Would a user feel confident using this?

### Code Quality
- Functions doing too many things
- Abstractions at the wrong level
- Copy-paste code that should be shared
- Magic numbers or unexplained constants
- Complex conditionals that could be simplified

### Robustness
- What happens on bad input?
- What happens on network failure, disk full, permissions denied?
- Are timeouts appropriate?
- Are retries sensible?

### Performance
- Unnecessary file reads/writes
- O(n^2) when O(n) is possible
- Blocking operations that could be async
- Memory accumulation

## Output

Write an improvement report with:

- **Quick wins**: Small changes with high impact
- **Polish items**: UX/UI improvements
- **Refactoring opportunities**: Code structure improvements
- **Performance notes**: Bottlenecks or waste
- **Design concerns**: Architectural issues worth addressing

Rank by impact. Include `file:line` references. Keep polish separate from true defects.
