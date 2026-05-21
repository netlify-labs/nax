---
name: nax-workflows
description: >-
  Use when operating nax, the Netlify Agent Runner workflow CLI, or when choosing,
  resuming, redriving, troubleshooting, or extending its bundled review, ideas,
  and do-next flows.
---

# nax Workflows

`nax` runs multi-step Netlify Agent Runner workflows across Claude, Gemini, and Codex. Use this skill when a user asks to run one of the bundled flows, recover a stuck workflow, diagnose Agent Runner failures, or add a new flow.

## Core Commands

```bash
nax review
nax ideas
nax do-next
nax run <flow>
nax init
nax skills install
```

Useful flags:

```bash
--transport github-actions      # run through GitHub Actions
--transport netlify-api         # orchestrate through Netlify CLI/API from this machine
--branch <branch-or-pr>     # branch name or PR selector like '#123'
--step <id>                 # run only one step
--from-step <id>            # continue from a step through the end
--timeout-minutes <n>       # per-step wait timeout
--context <text>            # append manual context
--context-file <path>       # append context from a file
--no-auto-context           # skip pinned SHA / review contract context
--no-fetch-results          # skip prior result fetching
--dry --force               # preview non-interactively
```

## Built-In Flows

### `review`

Use for code review. Steps:

1. `review` - Claude, Gemini, and Codex independently review.
2. `cross-review` - each model critiques the other models' findings.
3. `synthesize` - Codex synthesizes the final consensus.

### `ideas`

Use for project improvement ideation. Steps:

1. `ideate` - Claude, Gemini, and Codex propose ideas.
2. `cross-score` - each model scores the other models' ideas.
3. `react` - each model reacts to criticism and defends or concedes.
4. `synthesize` - Codex produces a ranked plan.

### `do-next`

Use to pick the next best task. Steps:

1. `propose` - Claude, Gemini, and Codex recommend next tasks.
2. `synthesize` - Codex picks and justifies the best next task.

## Operating Rules

- Prefer `--transport netlify-api` when the user wants live local progress, resume state, or direct Netlify API control.
- Prefer `--transport github-actions` when the user wants remote reproducibility and GitHub Actions logs.
- Warn that local uncommitted/unpushed changes are invisible to remote Netlify agent runners.
- Use `--branch '#123'` for PR-specific runs when the user references a PR number.
- Use `--step` only for deliberate partial reruns; otherwise resume/redrive saved Netlify API state.
- Treat `.nax/runs/<run-id>/run.json` as the source of truth for Netlify API workflow recovery.

## Recovery

Netlify API runs persist state under:

```text
.nax/runs/<run-id>/run.json
```

If a Netlify API process was interrupted, starting `nax <flow>` can offer to resume unfinished in-flight runs.

For a terminal failed Netlify API run that needs a compact follow-up prompt, use:

```bash
nax redrive <run-id> --step <step-id> --agent <agent>
```

Example:

```bash
nax redrive 2026-05-15T01-24-10-177Z-ideas --step react --agent claude
```

The redrive command submits a new follow-up session to the existing runner, waits for that one agent, updates run state, and continues downstream steps if the failed step becomes complete.

## Known Failure Modes

### Capacity

Retryable once when the exact failure text is:

```text
The Claude Code/Gemini/Codex model is currently at capacity. Retrying automatically...
```

### Argument List Too Long

Retryable once with a compact prompt when the failure text matches:

```text
fork/exec /opt/build-bin/agent-runner: argument list too long
```

The compact prompt keeps the current step instructions intact and trims only embedded prior agent outputs / additional context. This is a workaround for a Netlify runner launch-path limitation, not a platform fix.

## Extending Flows

Flows live in:

```text
flows/<id>/flow.yml
flows/<id>/prompts/*.md
```

Each step declares:

- `id`
- `title`
- `prompt`
- `action`: `issue` or `comment`
- `submit`: `new-run` or `follow-up`
- `agents`
- optional `input` from earlier steps
- `waitFor: agent-results`

When adding a flow, keep prompts self-contained and make step outputs easy for later steps to parse. For follow-up steps, be careful with prompt size because prior outputs are embedded.

## References

- [Flow Reference](references/FLOWS.md)
- [Troubleshooting](references/TROUBLESHOOTING.md)
