---
title: Audit Documentation
description: Independently compare docs against code and identify missing onboarding material.
instruction: audit README, contributing, architecture, and setup docs against the actual codebase
---

# Documentation Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

This prompt embeds the useful parts of `readme-writing`, `codebase-report`, and `docs-de-slopify`: docs must be grounded in code, scannable for newcomers, and free of generic AI filler.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checkout is unrelated or more than about 5 commits away, stop and report the mismatch.
3. Run `git status --short` before finishing.

## Build The Ground Truth

Read docs and source in this order:

- README, docs directory, AGENTS/CLAUDE instructions, contributing/release/deploy docs, examples, templates, and package metadata.
- Manifests and scripts: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, Makefile, CI workflows, Docker/Netlify/Vercel config.
- Entry points: CLI commands, app routes, API handlers, serverless functions, jobs, workers.
- Core types/state, config/env vars, external services, tests, and deployment assumptions.

## Audit Dimensions

- Value and audience: does the README quickly explain what problem the project solves and who it is for?
- Quick start: can a new user install, configure, run, test, and troubleshoot without guessing?
- Command/API reference: are commands, flags, env vars, examples, and outputs current?
- Architecture: entry points, core types, data flow, external dependencies, config precedence, persistent state, and test infrastructure.
- Accuracy: docs must not claim features, commands, package names, integrations, or support policies the code does not prove.
- Operational docs: deployment, secrets, rollback, CI, troubleshooting, limitations, and known caveats where relevant.
- Contribution docs: present only if appropriate; do not invent policies.
- Writing quality: remove vague hype, formulaic "here's why" phrasing, excessive em dashes, and generic AI-sounding copy. Do this manually, not with regex.

## README/Architecture Checklist

For READMEs, check whether the project needs:

- One-line value proposition.
- Quick example showing the main workflow.
- Installation and prerequisites.
- Quick start with copy-paste commands.
- Command/API/config reference.
- Architecture diagram or compact report for complex projects.
- Troubleshooting and limitations.
- Testing and development instructions.

For architecture docs, require:

- Executive summary.
- Entry points with `file:line`.
- 3-5 key types or domain objects.
- Main data flow.
- External dependencies.
- Configuration sources and precedence.
- Test infrastructure and coverage gaps.

## Output

Start with `## Repository State`, then `## Documentation Map`, then `## Structured Gaps` as fenced JSON:

```json
[
  {
    "id": "DOCS-1",
    "priority": "P0",
    "target_file": "README.md",
    "gap": "Quick start references missing command",
    "evidence": "package.json exposes `test:e2e`, README does not mention it",
    "source_reference": "package.json:12",
    "recommended_change": "Add testing section with exact command",
    "reader": "new contributor"
  }
]
```

Then include `## Accuracy Risks`, `## Recommended Doc Updates`, `## Style/Voice Issues`, and `## Deferred Backlog`.
