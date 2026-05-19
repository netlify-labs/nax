# Netlify Agent Runner Fails Permanently On Long Follow-Up Prompt

## Linear Ticket Draft

Title: Agent Runner follow-up sessions can brick on long prompts with `argument list too long`

Priority: High

Area: Netlify Agent Runner / Orchestrator

## Problem

A Netlify Agent Runner follow-up session can fail permanently when the prompt payload is large enough to trip the runner process launch limit:

```text
fork/exec /opt/build-bin/agent-runner: argument list too long
```

This appears to happen before the selected model meaningfully executes. In the observed workflow, Gemini and Codex follow-up sessions accepted the same class of generated cross-reference prompt, while the Claude Code runner failed after about 6 seconds. Retrying from the Netlify UI repeats the same launcher failure, so the agent run becomes effectively bricked.

Observed failed run:

https://app.netlify.com/projects/agent-runner-github-action/agent-runs/6a0675c3bdf1203aab2a6573

## User Impact

- Multi-step workflows can become stuck even when prior agent results are available.
- UI retry is not useful because it resubmits the same oversized payload.
- The failure looks model-specific to users, but the error is from the runner/orchestrator launch path.
- Local orchestrators have to implement prompt compaction/redrive workarounds instead of relying on the platform to accept or safely stage payloads.

## Repro Context

Workflow: `Ideas`

Step sequence:

1. `Generate Ideas`
2. `Cross Score Ideas`
3. `React To Scores`
4. `Synthesize Ideas`

The failing step was a Claude follow-up session during `React To Scores`. The prompt included prior multi-agent outputs from earlier steps, including cross-scoring content. This makes the follow-up prompt substantially larger than the first-round prompt.

Relevant local flow shape:

```yaml
- id: react
  title: React To Scores
  prompt: prompts/3_react.md
  action: comment
  submit: follow-up
  agents:
    - claude
    - gemini
    - codex
  input:
    - step: cross-score
      results: all
  waitFor: agent-results
```

## Expected Behavior

The Agent Runner should not pass large prompt bodies through an OS argument vector or any equivalent launch path with a small size ceiling.

At minimum:

- Large prompts should be staged through stdin, a temp file, blob storage, or an internal payload reference.
- UI retry should not replay a known unrecoverable oversized launch request unchanged.
- The API/UI should expose a clear, typed failure reason for prompt-size launch failures.
- Ideally, the service should reject oversized prompt submissions before creating a run, with the measured prompt size and the accepted limit.

## Actual Behavior

The run fails quickly with:

```text
fork/exec /opt/build-bin/agent-runner: argument list too long
```

The Netlify UI shows:

- `Claude Agent failed after 6s`
- `1 action`
- `Retry run`

Clicking `Retry run` does not recover the run. It fails with the same error.

## Why This Is Probably An Orchestrator Bug

The error text is from `fork/exec`, not from Claude Code itself. That strongly suggests the runner process is launched with too much content in argv/env, rather than prompt content being delivered through a channel designed for large payloads.

The user-facing system is a multi-agent workflow runner. Follow-up steps naturally aggregate prior outputs, so large prompts are an expected workload, not an edge case.

## Suggested Fix

Change Agent Runner prompt delivery so large prompt bodies are not placed directly in process arguments or env.

Candidate implementation paths:

1. Store the prompt payload server-side and pass only a payload ID to `/opt/build-bin/agent-runner`.
2. Write the prompt to a temp file and pass a file path to the runner.
3. Stream the prompt to the runner over stdin.
4. Add request-time payload size validation with a precise error if there is a hard platform limit.

## Acceptance Criteria

- A follow-up prompt containing prior outputs from three agents across two workflow steps can launch successfully.
- Retrying the run from the UI does not reproduce `fork/exec /opt/build-bin/agent-runner: argument list too long`.
- The runner does not pass the full prompt through argv/env.
- If a hard limit remains, the API rejects the request before run creation and returns a typed, actionable error.
- UI displays that typed error instead of a raw `fork/exec` message.

## Workaround Implemented Locally

The local `nax` orchestrator now detects this exact error and can retry once with a compacted prompt. The compaction preserves the current step instructions and trims only embedded prior agent results / additional context.

This is a workaround, not a platform fix. It reduces blast radius for local workflows but does not fix the Netlify UI retry path or the underlying runner launch limit.

Manual local redrive command:

```bash
nax redrive 2026-05-15T01-24-10-177Z-ideas \
  --project-root /Users/david/projects/github-actions-agent-runner/agent-runner-action \
  --step react \
  --agent claude
```

## Evidence

Failed run URL:

https://app.netlify.com/projects/agent-runner-github-action/agent-runs/6a0675c3bdf1203aab2a6573

Observed error:

```text
fork/exec /opt/build-bin/agent-runner: argument list too long
```

Screenshot notes:

- Page shows `Claude Agent failed after 6s`.
- Page shows raw `fork/exec /opt/build-bin/agent-runner: argument list too long`.
- Page includes a `Retry run` button, but retrying remains bricked.

