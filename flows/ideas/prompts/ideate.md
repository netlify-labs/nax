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

Netlify Agent Runner cannot dynamically load local Codex skills, so perform these lightweight versions inline:

1. **Codebase archaeology lite:** Read `AGENTS.md`, `CLAUDE.md`, `README.md`, package/config files, and key source directories. Map the main modules, entry points, execution paths, data shapes, and hidden coupling.
2. **Reality check lite:** Compare documentation and stated goals against what the code actually implements. Separate real gaps from docs-only wishes.
3. **Multi-lens analysis lite:** Inspect the project from at least four angles: user experience, architecture, reliability/operations, and developer ergonomics. Note where those lenses disagree.
4. **Work graph check:** If `.beads/` exists and `bv` is available, run `bv --robot-triage` or `bv --robot-next`. Never run bare `bv`. If Beads is unavailable, state that it was unavailable.
5. **Architecture report lite:** Summarize the current architecture well enough that your ideas are grounded in the real system, not generic advice.

## Ideation Process

Generate 20-30 possible ideas privately, then winnow to your top 5. Favor ideas that are:

- Useful in real project workflows.
- Pragmatic to implement correctly.
- Accretive to the existing architecture rather than bolted on.
- Valuable to humans and AI coding agents using this repo.
- Specific enough that a developer could begin.

Avoid generic cleanup unless it unlocks a concrete capability or removes a real source of pain.

## Output

Start with `## Repository State`:

- `pinned_sha`
- `checked_out_sha`
- `state_match`: `yes`, `minor_drift`, or `no`
- `git_status_clean`: `yes` or `no`
- `beads_available`: `yes` or `no`

Then write `## Project Read` with a concise summary of what you learned.

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
