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

## Resume

Start the same flow again and accept the resume prompt when a run is still in flight.

Resume is for unfinished Netlify API work. Terminal failed runs need a rerun or retry.

## Retry

Use retry when exactly one Netlify API agent failed and the rest of the step is usable:

```bash
nax retry <run-id> --step <step-id> --agent <agent>
```

This is useful for oversized follow-up prompts or transient terminal failures after a step has partially completed.

## Argument List Too Long

Symptom:

```text
fork/exec /opt/build-bin/agent-runner: argument list too long
```

This is likely a Netlify Agent Runner launch-path issue where prompt content is too large for argv/env. `nax` detects this and retries once with a compact prompt. If the Netlify UI retry is bricked, use local retry where possible.

## Capacity

Symptom:

```text
The Claude Code model is currently at capacity. Retrying automatically...
```

Also applies to Gemini and Codex variants. `nax` retries this once per runner.
