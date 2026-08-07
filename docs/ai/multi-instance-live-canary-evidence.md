# Multi-instance Agent Configuration Live Canary Evidence

Date: 2026-08-07 (America/Los_Angeles)

Status: passed

## Scope and safety

The canaries ran through the real `nax run` Netlify API executor, not through a
direct SDK-only probe. The target was the documented disposable canary project:

- GitHub repository: `netlify-labs/agent-sdk-canary`
- Branch: `main`
- Verified remote commit: `988e54714361f04537c755fc3457bfb2645edc1b`
- Netlify site: recorded here as `dedicated-disposable-site`; the site UUID is
  intentionally omitted from this evidence file
- Prompts: ask-only, explicitly instructed every agent not to edit files
- Source fixtures: `tests/fixtures/live-canary-flows/`
- Reproduction harness: `scripts/run-multi-instance-canary.mjs`

The harness requires both an explicit `--site-id` and the
`ALLOW_MULTI_INSTANCE_CANARY=1` mutation gate. It uses an authenticated temporary
clone, creates temporary local Netlify site context, verifies durable workflow
state and `events.jsonl`, archives all runner IDs from both state and events, and
then removes the clone.

Reproduction command:

```sh
ALLOW_MULTI_INSTANCE_CANARY=1 npm run canary:multi-instance -- --site-id <disposable-site-uuid>
```

A single failed case can be retried without repeating successful cases:

```sh
ALLOW_MULTI_INSTANCE_CANARY=1 npm run canary:multi-instance -- \
  --site-id <disposable-site-uuid> \
  --scenario arena-all-failed-canary
```

All raw workflow, runner, and session IDs below are replaced with stable aliases.
Timestamps and instance tuple IDs are retained because they contain no secrets.

## Results

### Six-instance combination, wave boundary, artifacts, and inheritance

Workflow `W1` (`arena-combo-canary`) started at
`2026-08-07T20:51:02.240Z` and completed before
`2026-08-07T20:52:21.106Z`.

The first step resolved and completed these six instances in declared order:

1. `claude:claude-opus-5:auto`
2. `claude:claude-opus-4-8:auto`
3. `claude:claude-fable-5:auto`
4. `codex:gpt-5.6-sol:low`
5. `codex:gpt-5.6-sol:medium`
6. `codex:gpt-5.6-sol:high`

This proves both a three-model same-provider bake-off and a three-effort sweep in
one bounded lineup. The event sequence showed five lifecycle slots occupied;
instance 6 was submitted 23 seconds after the step began, only after an earlier
instance emitted its terminal event. The maximum observed simultaneous
non-terminal count was 5.

Six distinct Markdown results and six distinct JSON metadata artifacts were
written. Their basenames were instance-scoped, including:

- `claude__claude-opus-5__auto`
- `claude__claude-opus-4-8__auto`
- `claude__claude-fable-5__auto`
- `codex__gpt-5.6-sol__low`
- `codex__gpt-5.6-sol__medium`
- `codex__gpt-5.6-sol__high`

The inheritance-only `continue` step completed six follow-ups. For every tuple
`I1` through `I6`, source `(runner Rn, session Sn)` became follow-up
`(runner Rn, session Sn+6)`: runner identity was unchanged, session identity was
new, and each serialized follow-up handle retained that instance's exact
provider/model/effort request.

### Bare-provider Auto council

Workflow `W2` (`arena-auto-canary`) started at
`2026-08-07T20:52:21.106Z` and completed before
`2026-08-07T20:52:45.540Z`.

The three completed tuple IDs were:

- `claude:auto:auto`
- `gemini:auto:auto`
- `codex:auto:auto`

For all three runs, both durable run state and serialized SDK wire input omitted
the `model` and `effort` properties. Bare-provider behavior therefore remained
Auto rather than silently pinning catalog defaults.

### Partial failure and survivor continuation

Workflow `W3` (`arena-partial-canary`) started at
`2026-08-07T20:52:45.540Z` and completed before
`2026-08-07T20:53:47.213Z`.

- `codex:gpt-5.4-mini:low` completed.
- `claude:nax-canary-unsupported-model-partial:auto` failed backend validation,
  including the bounded SDK retry.
- Step `mixed` persisted `completed_with_failures`.
- Step `survivor-continues` contained exactly one run: the completed Codex tuple.
- That follow-up reused the survivor's runner ID and received a new session ID.
- The workflow completed with exit code 0 because the final survivor step
  completed.

This proves that a failed instance does not cascade into continuation planning
and that a surviving instance still proceeds.

### All failed, halt, and non-zero exit

The corrected workflow `W4` (`arena-all-failed-canary`) started at
`2026-08-07T20:56:03.712Z`; sanitized harness evidence was emitted at
`2026-08-07T20:56:44.521Z`.

- `claude:nax-canary-unsupported-model-all-failed-a:auto` failed.
- `codex:nax-canary-unsupported-model-all-failed-b:auto` failed.
- Step `rejected` persisted `failed`.
- Workflow state persisted `failed`.
- The CLI exited non-zero.
- The later `must-not-run` sentinel step was absent from durable state and had no
  submission events.

The first all-failed attempt exposed and led to a fix for graceful process-exit
handling overwriting durable `failed` with `interrupted`. The corrected canary
above proves the regression is fixed.

## Cleanup

The final evidence set created 16 unique remote runner IDs when retry
replacements are included. All 16 were archived. Across the entire verification
session, including exploratory/pre-fix attempts, 26 of 26 unique runner IDs were
archived. No runner was created by the two preflight-only failures.

The cleanup inventory now unions runner IDs from final workflow state with every
`agent_status` event. This matters because a capacity retry can replace a runner
ID, leaving the superseded failed runner visible only in the event history.

## Local verification

The complete repository release verification is recorded in the implementing
commit and includes SDK CI/pack smoke, JavaScript syntax and import checks, JSDoc
checks, TypeScript checks, all unit/integration tests, CLI help smoke, dashboard
build, Playwright dashboard smoke, and `npm pack --dry-run`.
