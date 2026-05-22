---
title: Implement Documentation
description: Update the most valuable documentation files.
instruction: implement the synthesized documentation updates
---

# Implement Documentation

You may edit files. Update the selected documentation files from the synthesized plan.

## Implementation Rules

- Treat code as ground truth.
- Keep commands copy-pasteable and verify script names, paths, env vars, ports, and flags.
- Prefer concrete examples over abstract claims.
- Add architecture sections only when they help readers understand entry points, core types, data flow, dependencies, config, and tests.
- Keep README and docs scannable with tables and short sections where useful.
- Remove generic AI filler, excessive em dashes, "here's why" constructions, "it's not X, it's Y" formulas, and vague hype.
- Do not invent features, commands, badges, screenshots, roadmap claims, package manager support, or contribution policies.
- If a fact cannot be verified from the repo, omit it or mark it as an assumption.

## Verification

Check links, commands, package scripts, paths, env vars, and examples against the repository. Run docs-related tests or link checks if they exist.

## Output

Report files changed, documentation gaps closed, facts verified against code, commands checked, and remaining docs backlog.
