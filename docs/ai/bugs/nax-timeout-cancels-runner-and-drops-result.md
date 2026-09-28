# nax Timeout Cancels the Remote Runner and Drops Its Result

## Status

Fixed on branch `fix/nax-timeout-detach` (fixes 1-5 below). A local timeout no longer cancels the
runner unless `--cancel-on-timeout` is passed. Every timeout path syncs the session. `nax run --resume`
polls runners that were left running, and `nax salvage --runner <id>` commits a run's diff onto a branch.

## Ticket Draft

Title: `nax run agent` silently cancels a still-working Netlify runner at its hidden 25-minute timeout, reports an empty result, and discards a recoverable diff

Priority: High. It lost a run that cost 4,558 credits and made the work look lost when it wasn't.

Area: `src/integrations/netlify/local-runner.js` (the local wait loop), `src/cli/commands/nax.js` (options), the `nax-remote-agents` skill, and result syncing

## Problem

`nax run agent` waits for the remote runner until a local deadline. When the deadline passes it:

1. **Cancels the remote runner.** It calls `client.stop(handle)`, even though the runner is healthy and still working.
2. Records the run as `status: 'timeout'` with `resultText: ''`.
3. **Never reads the session back.** The session's result text, its steps, and the fact that it has a diff are never synced to `.nax/`.
4. Prints `Netlify Agent Run: Claude timeout` / `did not complete successfully`, which reads as a platform failure.

The deadline is `--timeout-minutes`, **default 25**, which is a *hidden* option. It doesn't appear in `nax run agent --help` or in the `nax-remote-agents` skill. So a caller following the skill can't know that any run over 25 minutes will be killed.

## Observed Run (2026-09-27)

| Field | Value |
|---|---|
| Site | `gtm-services` (`b3b7360c-4621-4601-8c94-5751d87833b1`, team gtm-engineering) |
| Runner | `6ab9a873b5c516b3ea324bde` |
| Session | `6ab9a873b5c516b3ea324be0` |
| Agent | claude · `claude-fable-5` · effort Auto |
| Command | `nax run agent claude --model claude-fable-5 --prompt "$(cat prompt.md)" --branch master --transport netlify-api --force` |
| Created | `2026-09-27T23:36:19.783Z` |
| Cancelled (`done_at`) | `2026-09-28T00:01:35.732Z`, **25m16s later**, which is the default `--timeout-minutes 25` |
| nax output | `claude 6ab9a873…: timeout (check #97)`, then `Netlify Agent Run failed` |
| `.nax/agent-sessions/<id>/agent-session.json` | `status: "timeout"`, `result: ""`, `fileChanges: null`, `usage: {}` |
| Runner (`getAgentRunner`) | `state: "cancelled"`, `has_result_diff: false` |
| **Session (`getAgentRunnerSession`)** | `state: "cancelled"`, **`result`: 2,862 chars**, **`steps_count`: 265**, **`has_result_diff`: true**, `has_cumulative_diff`: true, `base_sha` `9049b18`, `usage.total_credits_cost`: **4558.4** |

The agent had finished its main task: six refactor changes, test counts matching before and after, and a written summary. It was busy with a follow-up (fixing its own deploy preview) when nax cancelled it. Everything was recoverable. nax just never looked.

## Root Cause (code)

- **The timeout cancels the runner:**
  - `src/integrations/netlify/local-runner.js:1406-1418`, inside the poll loop:
    `if (Date.now() >= handle.policy.deadlineAt) { await client.stop(handle).catch(() => {}); … status: 'timeout', resultText: '' }`
  - `src/integrations/netlify/local-runner.js:1482-1491`, after the loop: runners still pending get
    `client.stop(handle)` and `status: 'timeout', resultText: ''`.
  - When the SDK reports `timedOut`, `terminalRun()` at `local-runner.js:1363-1369` also returns
    `resultText: ''`.
- **The deadline is hidden:**
  - `src/cli/commands/nax.js:221` is `hiddenOption('--timeout-minutes <count>', …, '25')`, part of
    `addAdvancedRunOptions`, which `run agent` uses.
  - The default `25` is repeated in `local-runner.js:833,840,1116`, `local-executor.js:448,862`,
    `github-executor.js:241` and `cli/main.js:1019,1140,2652`.
  - Only `nax handoff` exposes it (`nax.js:548`).
- **The session isn't read after a timeout.** The timeout paths never call `listSessions` or
  `getSession`, so `result`, `has_result_diff` and `usage` from the session never reach
  `agent-session.json`, `result.md` or `usage.json`.
- **Diff state disagrees between runner and session.** After the cancel, the runner reports
  `has_result_diff: false` while the session reports `true`.
  `src/workflows/results/agent-run-results.js:109-130` (`fileChangesFromSessionOrRunner`) handles both, but it
  never gets the session on this path.
- **The skill says the opposite.** `src/templates/skills/nax-remote-agents/SKILL.md`, under
  "Stopping a Run", says stopping nax locally "does not reliably stop the remote runner". That's
  true for Ctrl-C. But nax's *own* timeout **does** stop it, and the skill never says so.

## User Impact

- **Work is lost silently:** a long, expensive run is cancelled mid-flight. The credits are spent
  (4,558 here) and the output looks gone.
- **Misdiagnosis:** it looks like a Netlify platform limit ("the site caps runs at about 30
  min"). I (Claude) told the user exactly that, and I was wrong.
- **No next step:** there's no hint about `--timeout-minutes`, and no hint that the diff can be
  recovered.

## Workaround Used: Salvage a Cancelled Run

This works on any cancelled runner whose session still has `has_result_diff: true`:

```bash
# 1. Inspect the session. The runner-level fields are not enough; they said "no diff".
netlify api getAgentRunnerSession \
  --data '{"agent_runner_id":"<runner>","agent_runner_session_id":"<session>"}' > session.json
jq '{state, has_result_diff, has_cumulative_diff, base_sha, steps_count, credits: .usage.total_credits_cost}' session.json
jq -r .result session.json          # the agent's own summary, if it wrote one

# 2. Create the target branch AT the session's base_sha FIRST.
#    If the branch doesn't exist, step 3 fails with merge_commit_error "Failed to apply commit".
git push origin <base_sha>:refs/heads/nax/<slug>

# 3. Ask Netlify to commit the session diff onto that branch.
#    target_branch is REQUIRED, so it can't fall back to the runner's branch (master here).
netlify api agentRunnerCommitToBranch \
  --data '{"agent_runner_id":"<runner>","target_branch":"nax/<slug>"}'

# 4. Poll until the commit exists.
netlify api getAgentRunner --data '{"agent_runner_id":"<runner>"}' \
  | jq '{merge_commit_is_being_created, merge_commit_sha, merge_commit_error}'
# → false, "<sha>", null   → git fetch origin nax/<slug>
```

The result is **one squashed commit** with the whole session diff. If the prompt asked for one
commit per change, that structure is gone. Always review the whole diff: here the agent had also
changed things outside its scope (a root `netlify.toml` and `public/index.html` to fix its own
deploy preview). They were split into a separate PR.

## Proposed Fixes (priority order)

1. **Don't cancel healthy runners on the local timeout by default.**
   - When the deadline passes and the runner is still `running`, stop *waiting*, not the
     *runner*.
   - Print the runner id, the View run link, and
     `nax wait --runner <id>` (or `nax handoff --runner <id>`) to resume.
   - Put cancel-on-timeout behind an explicit `--cancel-on-timeout`, for cost-capped CI.
   - If cancelling stays the default, print it loudly:
     `Cancelling remote runner <id> after 25m (--timeout-minutes). Pass --timeout-minutes N to wait longer.`
2. **Make `--timeout-minutes` visible** on `run agent` (and `run <flow>`) in `--help`, and document it
   in the skill's "Run It" section. Consider a longer default for single `run agent` calls
   (e.g. 60–90 min), because implementation tasks routinely take more than 25 minutes.
3. **Always sync the session after any terminal or timeout outcome.**
   - After `stop()` (or on `timedOut`), call `getSession`/`listSessions` and persist `result`
     (→ `result.md`), `usage`, `has_result_diff`/`has_cumulative_diff` and `base_sha` into
     `agent-session.json`.
   - Report session-level diff state in preference to the runner's.
   - Status could be `cancelled (timeout)`, with `resultText` set whenever the session has one.
4. **Add `nax salvage --runner <id> [--branch nax/<slug>]`.** It wraps the four steps above:
   - create the branch at `base_sha` if it's missing;
   - call `agentRunnerCommitToBranch`;
   - poll `merge_commit_*`;
   - print the sha and a compare link;
   - refuse `target_branch` = the default branch unless `--allow-default-branch` is passed.
5. **Update the skill.** Covered by this change, in `src/templates/skills/nax-remote-agents/SKILL.md`:
   the timeout flag, what a `timeout` status really means, and the salvage steps.

## Acceptance Checks

- A run that is still `running` at the local deadline is **not** cancelled by default, and nax
  prints how to resume waiting.
- With `--cancel-on-timeout`, the runner is cancelled *and* `result.md`, `usage.json` and the
  session diff flags are still synced from the session.
- `nax run agent --help` lists `--timeout-minutes`.
- `nax salvage` against a cancelled runner with `has_result_diff: true` produces a commit on a
  new branch and never touches the default branch.
- Unit tests for the three timeout paths (`local-runner.js` around lines 1363, 1406 and 1482)
  assert that the session is fetched after the stop.
