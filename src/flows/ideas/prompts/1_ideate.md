---
title: Generate Ideas
description: Study the project and propose the strongest pragmatic improvement ideas.
instruction: please study the project and propose your best pragmatic improvement ideas
---

# Generate Project Improvement Ideas

This is the first pass of a multi-agent idea duel. Your task is to independently study the repository, generate many possible improvements, and return only your strongest ideas.

This is **analysis-only**. Do not edit files, do not stage files, do not commit, and do not open or update PRs.

## Repository State

Before doing substantial analysis:

1. Run `git rev-parse HEAD`.
2. Compare it with the pinned SHA in the Additional Context.
3. If the checked-out SHA differs by a small fast-forward from the same branch, continue and mention the drift.
4. If the checked-out SHA appears to be on a different branch, unrelated history, or more than about 5 commits away from the pinned SHA, stop and report the mismatch.
5. Run `git status --short` before finishing. If it is not clean because of your own work, revert your changes before answering.

## Inline Skill Preparation

Remote Netlify Agent Runner cannot dynamically load local Codex skills, so execute the following skill protocols inline before generating ideas.

### 1. Codebase Archaeology Protocol

Do not read randomly. Build a mental model from documentation, entry points, and data flow:

1. **Documentation first:** Read `AGENTS.md`, `CLAUDE.md`, `README.md`, and important markdown files in `docs/`, `plans/`, `.cursor/rules/`, or equivalent directories if they exist.
2. **Orientation:** Inspect top-level files and package/config manifests such as `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `serverless.yml`, `netlify.toml`, workflow files, and test config.
3. **Entry points:** Find main process entry points, CLI commands, HTTP routes, framework routers, serverless handlers, workers, jobs, and frontend bootstraps.
4. **Layer map:** Trace entry point -> handler/controller -> domain logic -> storage/integration for at least 2-3 important workflows.
5. **Core types:** Identify the 3-5 domain objects, records, schemas, or state files everything revolves around.
6. **Configuration:** Identify env vars, config files, CLI flags, defaults, and precedence.
7. **Integrations:** Identify databases, external APIs, filesystem state, queues, auth, deploy/build systems, and network boundaries.
8. **Tests:** Inspect test structure, what behavior is covered, and what important paths lack coverage.
9. **Critical searches:** Use targeted searches for entry points, config, core types, external I/O, and error handling. Prefer `rg`.

### 2. Reality Check Protocol

Use code as the ground truth and docs as the measuring stick:

1. **Extract the vision.** From README, plans, docs, and (if visible) task tracker, extract every concrete, testable promise the project makes. Convert vague claims ("high performance") into testable ones ("parses 10K lines/sec"). The result is a numbered Vision Checklist.
2. **Map each goal to code.** For each numbered goal, find the implementing code. Read it — is it real or a stub/placeholder/mock? Check for tests proving it works. Where possible, try to actually run the relevant code path end-to-end, not just rely on tests passing.
3. **Categorize each goal** using this status taxonomy:
   - `WORKING` — code exists, tests pass, end-to-end verified
   - `PARTIAL` — some features work, others missing
   - `STUB` — placeholder, mock, or `todo!()` only
   - `UNPROVEN` — code exists but no tests or tests don't cover the real path
   - `NOT_STARTED` — no code at all for this goal
   - `REGRESSED` — was working, now broken
   - `NO_TASK` — vision goal not covered by any open task tracker item (critical when a tracker exists)
   - `WRONG_APPROACH` — implemented but architecturally cannot reach the goal
4. If a task tracker is visible, determine whether open/in-progress items would close every gap. Explicitly call out goals with zero task coverage.
5. **Be brutally honest.** Common failure modes to resist:
   - **Optimism bias:** reporting `PARTIAL` when reality is `STUB`. Ask: does it produce correct output for any real input?
   - **Test theater:** trusting passing tests as proof of working software. Ask: are tests trivial? Do they use real data?
   - **Task-completion illusion:** "72% of tasks done" can coexist with "0% of vision delivered" if the remaining 28% covers the core. Cross-check vision goals against task coverage, not just task percentage.
   - **Aspirational docs as evidence.** Docs describe intent, not behavior. Treat README claims as hypotheses until code confirms them.

### 3. Optional Work Graph And Priority Protocol

Most Agent Runner environments will not have the user's local task tracker. Treat task graph context as optional:

1. If `.beads/` exists and `bv` is available, run `bv --robot-triage` or `bv --robot-next` to understand the current graph.
2. Never run bare `bv`; it launches an interactive TUI.
3. If `.beads/` exists and `br` is available, use `br ready`, `br list`, or `br list --status=open` if useful.
4. Look for PageRank/betweenness bottlenecks, blockers, cycles, stale work, priority mismatches, and existing commitments that your ideas should respect.
5. If the task tracker is absent, inaccessible, or the commands fail, do not stop and do not treat that as a project problem. Record `task_tracker_available: no` and continue from code/docs.
6. Do **not** create or modify task tracker items in this ideation run. Only use the graph as context when it is actually available.

If task tracker context is unavailable, state that briefly and continue.

### 4. Multi-Lens Analysis Protocol

Inspect the project through multiple perspectives and preserve disagreements:

1. **User experience:** CLI/app flows, messages, defaults, setup, failure recovery, and confidence-building feedback.
2. **Architecture:** module boundaries, coupling, data ownership, state model, extensibility, and naming.
3. **Reliability/operations:** retries, timeouts, idempotency, resume behavior, observability, secrets, and deploy/runtime failure modes.
4. **Developer experience:** tests, local setup, docs accuracy, command ergonomics, task tracking, CI, and contribution loops.
5. **Product leverage:** which improvements unlock visibly better outcomes rather than only internal neatness.

Record where lenses disagree. A technically elegant idea that hurts UX, or a UX win that creates ugly operational risk, should be treated as contested.

### 5. Architecture Report Protocol

Before ideating, produce a compact architecture report for yourself:

1. Executive summary: what the project is and what it currently does.
2. Entry points: main files/commands/routes/handlers with file references.
3. Key types/state: core domain objects or persistent records.
4. Data flow: concise input -> processing -> output diagram.
5. External dependencies: services, APIs, databases, CLIs, files.
6. Configuration: env/config/flag sources.
7. Test infrastructure and coverage gaps.

Use this report to ground ideas. Do not propose generic improvements that ignore the actual architecture.

## Ideation Process

Generate 20-30 possible ideas privately. For each candidate, really think through how it would work, how users are likely to perceive it, how you would implement it, what could go wrong, and how it interacts with existing systems. Only after that work should you winnow to your top 5.

Evaluate every candidate against all ten criteria:

- **robust:** handles edge cases and failure modes
- **reliable:** works consistently, not intermittently
- **performant:** fast enough for the use case
- **intuitive:** users predict behavior correctly
- **user-friendly:** pleasant experience, helpful errors
- **ergonomic:** reduces friction for humans and AI agents
- **useful:** solves a real, frequent problem
- **compelling:** users would actually want it
- **accretive:** builds on existing strengths rather than bolted on
- **pragmatic:** realistic to build and maintain correctly

Weight `useful`, `pragmatic`, and `accretive` highest. An idea that scores high on `compelling` but low on `pragmatic` is a trap.

Red flag phrases that should trigger instant skepticism in your own reasoning:

- "Users will figure it out"
- "We'll document it later"
- "It's technically correct"
- "Nobody does it differently"

Avoid generic cleanup unless it unlocks a concrete capability or removes a real source of pain.

Use ultrathink: decompose each idea into constituent claims, evaluate each claim against specific files and functions in this codebase, consider second-order effects and interactions with existing systems, identify the specific implementation risks, only then commit to a final ranking.

## Output

Start with `## Repository State`:

- `pinned_sha`
- `checked_out_sha`
- `state_match`: `yes`, `minor_drift`, or `no`
- `git_status_clean`: `yes` or `no`
- `task_tracker_available`: `yes` or `no`

Then write `## Architecture Report` with:

- executive summary
- entry points
- key types/state
- main data flows
- external dependencies
- configuration
- test infrastructure

Then write `## Reality Check` with:

- a numbered Vision Checklist table: `# | Goal | Source | Status | Evidence | Task Coverage`
- the most important mismatch between project vision and current code
- explicit `NO_TASK` items if a task tracker is visible
- any places where passing tests do not actually prove the goal is delivered

Then write `## Idea Selection Rationale` explaining what signals drove your winnowing.

Then write `## Structured Ideas` as a fenced JSON block:

```json
[
  {
    "id": "CLAUDE-1",
    "title": "Short name",
    "category": "ux|reliability|architecture|testing|performance|developer-experience|product",
    "problem": "Specific problem or missed opportunity",
    "proposal": "Specific improvement",
    "implementation_shape": ["First concrete step", "Second concrete step"],
    "expected_impact": "Why this matters",
    "cost_risk": "Implementation cost and main risk",
    "confidence": "high|medium|low"
  }
]
```

Use your own agent name in IDs when obvious: `CLAUDE-1`, `GEMINI-1`, or `CODEX-1`. If uncertain, use `IDEA-1`.

Finish with short prose rationale for your top 5 ordering.
