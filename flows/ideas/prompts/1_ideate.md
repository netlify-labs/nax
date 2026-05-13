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

1. Determine what the project claims to do from README, plans, docs, and task tracker context if that context is visible in this runner.
2. Determine what is actually implemented and working from code, tests, config, and recent commits.
3. Identify gaps between the vision and reality:
   - working end-to-end capabilities
   - partial or stubbed capabilities
   - missing workflows
   - broken or risky assumptions
   - docs that overstate current behavior
4. If a task tracker is visible in this runner, determine whether open/in-progress tasks would close the gap. Explicitly call out goals not covered by any existing task. If no tracker is visible, continue without it.
5. Be brutally honest. Do not turn aspirational docs into evidence that the code works.

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

Generate 20-30 possible ideas privately, then winnow to your top 5. Favor ideas that are:

- Useful in real project workflows.
- Pragmatic to implement correctly.
- Accretive to the existing architecture rather than bolted on.
- Valuable to humans and AI coding agents using this repo.
- Specific enough that a developer could begin.

Avoid generic cleanup unless it unlocks a concrete capability or removes a real source of pain.

Use ultrathink.

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

- what is working now
- what is partial, stubbed, missing, or risky
- whether existing task tracker work appears to cover the gaps, if task tracker context was available
- most important mismatch between project vision and current code

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
