---
name: nax-workflows
description: >-
  Use when operating nax, the Netlify Agent Runner workflow CLI, or when choosing,
  resuming, redriving, troubleshooting, or extending its bundled review, ideas,
  and do-next flows.
---

# nax Workflows

`nax` runs multi-step Netlify Agent Runner workflows across Claude, Codex, Gemini, and OpenCode. Use this skill when a user asks to run one of the bundled flows, recover a stuck workflow, diagnose Agent Runner failures, or add a new flow.

## Core Commands

```bash
nax run review
nax run ideas
nax run do-next
nax run <flow>
nax run agent <claude|codex|gemini|opencode> "<prompt>"
nax run --retry <run-id>
nax init
nax handoff
nax admin sync last
nax admin clean blobs
nax dashboard
nax admin skills install
```

Useful flags:

```bash
--transport github              # run through GitHub Actions
--transport github-actions      # same GitHub Actions transport, older explicit name
--transport netlify-api         # orchestrate through Netlify CLI/API from this machine
--branch <branch-or-pr>     # branch name or PR selector like '#123'
--agents <provider[:model[:effort]]>  # select instances; comma-separated or repeatable
--models <agent=model>                # assign a real model; repeatable
--efforts <agent=effort>              # assign reasoning effort; repeatable
--step-agents <step=agents>           # select providers for one step
--step-models <step:agent=model>      # assign one step model; repeatable
--step-efforts <step:agent=effort>    # assign one step effort; repeatable
--step <id>                 # run only one step
--from-step <id>            # continue from a step through the end
--timeout-minutes <n>       # per-step wait timeout
--context <text>            # append manual context
--context-file <path>       # append context from a file
--session <id>              # handoff: select one agent session artifact
--runner <id>               # handoff: select one agent runner artifact
--workflow <id>             # handoff: select one workflow artifact
-c, --copy                  # handoff: copy selected/latest summary to clipboard
--no-auto-context           # skip pinned SHA / review contract context
--no-fetch-results          # skip prior result fetching
--dry --force               # preview non-interactively
```

## Built-In Flows

### `review`

Use for code review. Steps:

1. `review` - up to four configured agent instances independently review.
2. `cross-review` - each agent critiques the other agents' findings.
3. `synthesize` - Codex synthesizes the final consensus.

### `ideas`

Use for project improvement ideation. Steps:

1. `ideate` - Claude, Gemini, and Codex propose ideas.
2. `cross-score` - each agent scores the other agents' ideas.
3. `react` - each agent reacts to criticism and defends or concedes.
4. `synthesize` - Codex produces a ranked plan.

### `do-next`

Use to pick the next best task. Steps:

1. `propose` - Claude, Gemini, and Codex recommend next tasks.
2. `synthesize` - Codex picks and justifies the best next task.

## Operating Rules

- Prefer `--transport netlify-api` when the user wants live local progress, resume state, or direct Netlify API control.
- Prefer `--transport github` / `--transport github-actions` when the user wants remote reproducibility and GitHub Actions logs.
- Pinned model or effort settings require `netlify-api`; Auto omits both fields.
- Bare providers remain Auto on the wire; `latest`/`default` pin the catalog default at launch.
- Repeated providers are independent instances. Use exact tuples for model bake-offs and effort sweeps.
- Each step admits at most four agent instances, which may run concurrently.
- Warn that local uncommitted/unpushed changes are invisible to remote Netlify agent runners.
- For delegating one prompt to one remote agent (`nax run agent`), including the commit-and-push preflight and reading results back, use the `nax-remote-agents` skill.
- Use `--branch '#123'` for PR-specific runs when the user references a PR number.
- Use `--step` only for deliberate partial reruns; otherwise resume/retry saved Netlify API state.
- Use `nax dashboard` when the user wants to browse workflow state, inspect graph status, compare Results vs Prompt in run details, or send selected artifacts to a follow-up agent from the browser.
- Treat `.nax/workflows/<workflow-run-id>/workflow.json` as the source of truth for workflow recovery.
- Use `.nax/workflows/<workflow-run-id>/artifacts/summary.md` for full workflow handoff context.
- Use `.nax/agent-sessions/<session-id>/summary.md` for one concrete agent result.
- Use `.nax/agent-runners/<runner-id>/summary.md` for one threaded runner/conversation.

## Recovery

Netlify API runs persist state under:

```text
.nax/workflows/<workflow-run-id>/workflow.json
```

If a Netlify API run was interrupted or some agents failed, resume it in place. Finished agents are kept, running agents are polled, and only unfinished agents are resubmitted with their saved prompt:

```bash
nax run --resume <workflow-run-id> --dry    # preview keep/poll/resubmit/skip per agent
nax run --resume <workflow-run-id> --force  # non-TTY: resume without a prompt
```

Resume refuses before submitting anything on `flow_changed_since_run` (start a new run), `resume_ambiguous_submission` (check the Netlify agent runs page, then `--force`), `resume_plan_unavailable` (use `--from-step`), `resume_auth_failure` (fix `netlify status`), `branch_moved_since_run` (`--force` or a new run), and `run_locked` (another process owns the run; `--force-unlock` only if it is gone). Add `--include-cancelled` to resubmit cancelled agents. GitHub transport runs resume at step level only. Interactive `nax <flow>` still offers to resume unfinished runs with the same preview.

Completed results also persist as artifacts:

```text
.nax/workflows/<workflow-run-id>/artifacts/summary.md
.nax/agent-runners/<runner-id>/summary.md
.nax/agent-sessions/<session-id>/summary.md
```

Use `nax handoff` to continue from prior results interactively, or `nax handoff -c` to copy the latest useful summary.

Use `nax admin sync last` when a Netlify UI follow-up happened outside the local process and the latest local runner is missing remote sessions.

Use `nax dashboard` to inspect saved runs in a browser. Run details can switch between rendered Results and the original Prompt when the prompt file is still resolvable from the flow definition.

For a terminal failed Netlify API run that needs a compact follow-up prompt, use:

```bash
nax run --retry <run-id> --step <step-id> --instance <agent:model:effort>
```

Example:

```bash
nax run --retry 2026-05-15T01-24-10-177Z-ideas --step react \
  --instance claude:claude-opus-5:high
```

The retry command submits a new follow-up session to the existing runner, waits for that one agent, updates run state, and continues downstream steps if the failed step becomes complete.

## Stopping Runs

Remote agents keep running (and billing) on Netlify after the process that started them stops. Killing a local `nax` process, pressing Ctrl-C, or cancelling a GitHub Actions job does **not** reliably stop the Netlify agent runners it already created. Always stop both sides, then confirm nothing is still running.

1. **Stop whatever launched the runs.** Locally, stop the `nax` process. In GitHub Actions (for example `run-nax.yml` / `run-local-nax.yml`, or a PR-triggered review workflow in a consuming repo):
   ```bash
   gh run list --workflow run-nax.yml --status in_progress
   gh run list --workflow run-local-nax.yml --status in_progress
   gh run cancel <run-id>
   gh run view <run-id> --json status,conclusion   # wait for "completed" / "cancelled"
   ```
2. **List agent runners still running on the Netlify site.** Run from the linked project directory (or pass `--project <site-id-or-name>`):
   ```bash
   netlify agents:list --status running --json
   ```
3. **Cancel each remaining runner** by id (the `id` field above, also shown as `Runner ID:` in nax output). This is the same `DELETE /agent_runners/<id>` call nax and the SDK use:
   ```bash
   netlify api deleteAgentRunner --data '{"agent_runner_id":"<runner-id>"}'
   ```
   The Netlify CLI prints `TextHTTPError: Accepted` for this call. That is the 202 success response, not a failure.
4. **Confirm** each runner is `cancelled` and nothing is left running:
   ```bash
   netlify api getAgentRunner --data '{"agent_runner_id":"<runner-id>"}'   # "state": "cancelled"
   netlify agents:list --status running --json                             # []
   ```

Cancel only runners you (or the user) started for the task at hand; other agent runs on the same site may belong to someone else. Cancelling a runner is irreversible, so confirm the ids with the user when they were not started in this session. A cancelled runner shows as `cancelled` in nax run state; `nax run --resume <run-id> --include-cancelled` resubmits it later if needed.

## Known Failure Modes

### Prompt Blob Cleanup

Large fan-in prompts can be offloaded to temporary Netlify Blobs. `nax` records refs in `.nax/blob-refs.jsonl`, mirrors payloads under `.nax/workflows/<run-id>/blobs/`, and retries cleanup at flow completion. If cleanup is interrupted:

```bash
nax admin clean blobs          # dry run
nax admin clean blobs --force  # delete eligible stale/pending refs
```

Do not delete the local `.nax/workflows/<run-id>/blobs/` mirrors unless the user explicitly wants to prune workflow artifacts; they are useful for debugging prompt delivery.

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

The current prompt delivery path uses Netlify Blob offload when a full prompt is larger than the safe submission budget. If blob offload is disabled or unavailable, compact fallback keeps the current step instructions intact and trims only embedded prior agent outputs / additional context when the compact prompt is still under budget. This is a workaround for a Netlify runner launch-path limitation, not a platform fix.

## Extending Flows

Flows live in:

```text
<flows-dir>/<id>/flow.*
<flows-dir>/<id>/prompts/*.md
```

Flow files can be YAML, JSON, TOML, or a JavaScript/TypeScript module containing
a single JSON5-compatible static object export. Dynamic module code is blocked
by workflow discovery safe mode.

Each step declares:

- `id`
- `title`
- `prompt`
- `action`: `issue` or `comment`
- `submit`: `new-run` or `follow-up`
- `agents`: bare providers or instance objects with `model`/`models` and `effort`/`efforts`
- optional `input` from earlier steps
- `waitFor: agent-results`

When adding a flow, keep prompts self-contained and make step outputs easy for later steps to parse. A `follow-up` step inherits surviving instances from its first input on the netlify-api transport, so do not declare `agents` there unless the flow also runs on the GitHub transport (which uses them). Use `results: peers` to give each inherited instance only the other instances' outputs. Mixed success becomes `completed_with_failures`; an all-failed step halts the workflow.

After authoring or editing a flow, validate it and fix every diagnostic before running it:

```bash
nax lint <flow-id> --json
```

Each diagnostic has a `code`, a `message`, and a `hint` with the fix. `--strict` also fails on warnings.

## References

- [Flow Reference](references/FLOWS.md)
- [Troubleshooting](references/TROUBLESHOOTING.md)
