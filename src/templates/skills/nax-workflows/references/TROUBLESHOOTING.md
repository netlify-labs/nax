# nax Troubleshooting

## Setup

`nax init` links a Netlify site, writes `.github/workflows/netlify-agents.yml`, and can set GitHub secrets.

Common setup failures:

- `gh: command not found`: install and authenticate GitHub CLI.
- `netlify: command not found`: install and authenticate Netlify CLI.
- `Could not resolve NETLIFY_SITE_ID`: run `netlify link`, pass `--site-id`, or run `nax init`.

## Local Workflow State

Local runs write state to:

```text
.nax/workflows/<workflow-run-id>/workflow.json
```

Use this file to inspect:

- flow id
- current step statuses
- runner ids
- saved prompt text
- result text
- retry metadata

Completed output is also projected into artifact summaries:

```text
.nax/workflows/<workflow-run-id>/artifacts/summary.md
.nax/agent-runners/<runner-id>/summary.md
.nax/agent-sessions/<session-id>/summary.md
```

Use `.nax/workflows/latest/artifacts/summary.md` for the latest workflow rollup when the filesystem supports symlinks. Use `nax handoff -c` to copy the latest useful summary to the clipboard.

## Visualizer

Use the browser workbench when terminal summaries are not enough:

```bash
nax visualize
nax visualize review --no-open
```

Run details can render saved workflow, step, runner, session, and result artifacts. When the selected entry maps back to a flow prompt, the center pane can switch between **Results** and **Prompt**; copy/open actions follow the active view.

If a Prompt tab is missing, verify the flow definition and prompt path still exist locally. Synced remote artifacts can show results even when the original project-local prompt file is no longer present.

From a completed run, **Send to next agent** opens the follow-up composer. Browser follow-ups currently use the Netlify API transport. If a follow-up was submitted from the Netlify UI or another process, use `nax sync last` to pull the latest remote sessions into local `.nax` artifacts.

## Resume

Start the same flow again and accept the resume prompt when a run is still in flight.

Resume is for unfinished Netlify API work. Terminal failed runs need a rerun or retry.

## Retry

Use retry when exactly one Netlify API agent failed and the rest of the step is usable:

```bash
nax retry <run-id> --step <step-id> --agent <agent>
```

This is useful for oversized follow-up prompts or transient terminal failures after a step has partially completed.

## Prompt Blob Offload

Large fan-in prompts are offloaded to temporary Netlify Blobs when they exceed the safe runner submission budget. `nax` records refs in:

```text
.nax/blob-refs.jsonl
```

It mirrors each payload locally under:

```text
.nax/workflows/<workflow-run-id>/blobs/
```

Remote cleanup runs at flow completion. If the process was interrupted, preview or force stale cleanup with:

```bash
nax clean blobs
nax clean blobs --force
```

## Argument List Too Long

Symptom:

```text
fork/exec /opt/build-bin/agent-runner: argument list too long
```

This is likely a Netlify Agent Runner launch-path issue where prompt content is too large for argv/env. Current `nax` versions prefer Blob-backed prompt delivery before falling back to compact prompts. If the Netlify UI retry is bricked, use local retry where possible.

## Capacity

Symptom:

```text
The Claude Code model is currently at capacity. Retrying automatically...
```

Also applies to Gemini and Codex variants. `nax` retries this once per runner.
