# nax Roadmap Ideas

Sixteen improvement ideas for `nax`, generated from a deep read of the codebase, README, and known pain points. Each idea exists as a bead (`br show <id>` for the full self-documenting spec with design details, acceptance criteria, and test plans). Ordered roughly best-first.

---

## 1. Harden prompt delivery: file-based prompts + tiered context compaction (`nax-vhv`)

The single worst documented bug is follow-up sessions failing at runner launch because large prompts — round-2 prompts with embedded round-1 results — travel via argv/env and blow past OS `ARG_MAX`. Separately, the github-actions transport enforces an ~80KB env budget at plan time and simply errors, forcing users to hand-trim context. Both are symptoms of the same root cause: prompt size handling is ad-hoc and transport-specific. The fix is one shared `prompt-budget` module with progressive degradation tiers — full prompt, then drop prior-round prose but keep structured findings, then a links-only ledger telling the agent to fetch the linked issues itself, and only then a hard error with exact byte counts. On the netlify-api transport, oversized prompts switch to file-based delivery (write the full prompt where the runner can read it, submit a short pointer) so big follow-ups never hit argv limits at all. The applied tier is recorded in `workflow.json` and printed in run output, so results stay interpretable. The philosophy extends "resume over re-run" to "degrade over die."

## 2. Reliability: per-agent auto-retry, mid-step resume, and a run lock (`nax-33l`)

Resume today works only at step granularity: if two of three agents in a fan-out finished and the third hit a transient capacity error, re-running redoes *all* agents in the step — wasted credits, wasted wall-clock, divergent context. Yet `workflow.json` already records per-run status, and the retryable error classes are already identified in `local-runner.js`. This epic makes recovery automatic for transient failures (bounded exponential backoff, 3 attempts, attempts recorded in artifacts) and surgical for everything else: resume polls still-in-flight runs, keeps completed agents' results untouched, and resubmits only the missing or failed agents using the originally-submitted prompt (persisted at submit time so resume never rebuilds context against a moved branch). A `.nax/run.lock` rounds it out so two concurrent nax processes can never interleave writes and corrupt `latest` symlinks or workflow state.

## 3. Agent and script ergonomics: `nax doctor` + `--json` robot mode (`nax-pja`)

nax has many moving prerequisites — gh auth, netlify auth, linked site, workflow file, repo secrets, node version — and today failures surface one at a time, mid-run. Every row of the README troubleshooting table is really a diagnostic check waiting to be executable. `nax doctor` runs them all in order, prints pass/warn/fail with a one-line actionable fix per check, and exits nonzero only on hard failures so CI can gate on it. The second half recognizes that nax's emerging primary audience is *other AI agents* driving it (handoff exists for exactly this): `--json` on the read commands (`list`, `recent`, `handoff`, end-of-run summary) with a strict contract — JSON on stdout only, decoration to stderr, stable documented keys — plus non-TTY sanity so piped invocations never emit spinner garbage and prompts fail fast naming the missing flag.

## 4. Flow authoring toolkit: `nax lint`, fail-fast validation, `nax flow new` (`nax-pup`)

Custom flows are the extensibility story ("the flow file is the program"), but authoring one today is copy-a-bundled-flow-and-pray. Errors — a typo'd step id in `input.step`, a missing prompt file, an unknown agent, an invalid action/submit combo — surface mid-run, possibly after credits were spent on earlier steps. This epic creates a single source of truth for the flow shape (`flow-schema.js`), a `nax lint` command that reports every defect with the exact path and a fix hint, automatic pre-run validation so a broken flow can never start executing (zero credits spent on invalid flows), and a `nax flow new` scaffolder that interviews you with clack prompts and generates a flow whose inline comments double as schema documentation. Generated flows are guaranteed to lint clean and emit findings-compatible structured output by default. This epic deliberately lands first among the flow work — control-flow keys and the agent registry both extend the schema it formalizes.

## 5. Structured findings contract + actionable handoff targets (`nax-i9j`)

nax already extracts structured-findings JSON blocks from agent comments, but only to feed follow-up prompts. The terminal artifact of a workflow — the ranked consensus — is markdown a human must copy somewhere. The whole point of consensus output is to become *work*: GitHub issues, beads, PR comments. This epic makes findings a first-class machine-readable artifact (`findings.json` per workflow: title, severity, files, originating agents, cross-review confirmations, consensus rank, source issue URLs) and grows `nax handoff` from "copy markdown" into "route results into the tool where work happens." `nax handoff --to github-issues` creates one labeled issue per consensus finding, idempotent via body markers so reruns never duplicate. `nax handoff --to beads` drops findings straight into a local br issue graph with severity-mapped priorities. Parsing is tolerant by design — a malformed agent block degrades to a diagnostics entry, never a crash.

## 6. Cost visibility and guardrails: `nax usage` + `--max-credits` (`nax-7xp`)

Every run already persists `usage.json` (tokens, credit cost, limit-exceeded flags) per runner and session — but nothing aggregates it, so users discover spend after the fact, per artifact, by hand. Multi-agent fan-out multiplies cost: a three-step review is ~9 agent executions. `nax usage` aggregates existing artifacts into tables — recent runs, or grouped `--by agent/flow/step`, with `--since` windows and `--json` output — a pure read-side win requiring no new data collection. `--max-credits N` adds a budget checkpoint between steps: when cumulative spend crosses the budget, the workflow halts before submitting the next step, persists resumable interrupted state, and prints resume instructions (never killing an in-flight step — the step boundary is the natural commit point). A pre-run estimate line ("~N credits, median of last K runs of this flow") appears at confirmation time once local history exists. Cost transparency is the difference between a tool people run weekly and one they run once.

## 7. Flow control-flow: `onFailure`, `when:`, parameterized `inputs:` (`nax-33r`)

Flows are strictly linear, all-steps-always. Real workflows need three escapes. First, failure policy: `onFailure: continue | abort | retry` (+ `maxRetries`) lets authors choose whether one failed agent poisons the pipeline — synthesize steps should abort (a missing consensus invalidates the run), fan-out steps should retry once. Second, conditional steps: a small whitelisted `when:` vocabulary (`stepHasResults`, `findingsAtLeast`, input gates) so an audit→fix flow skips the fix step when the audit found nothing — skipped steps are recorded as `skipped` with the evaluated condition, auditable rather than invisible. Third, parameterized flows: an `inputs:` declaration block plus `--var key=value` and `{{inputs.*}}` interpolation, with required inputs prompting interactively in a TTY (flows become questionnaires for free) and erroring helpfully in pipes. The design principle is declarative and boring: no expression language — the moment flows need real logic, `flow.js` already exists. This turns the bundled flows from demos into a library of reusable parameterized programs.

## 8. Diff-scoped review context: changed-files ledger, `--base`, PR metadata (`nax-j7q`)

Auto-injected context today is a pinned SHA plus an open-PR ledger. The single highest-leverage context a reviewer-agent needs is missing: *what changed*. Agents burn their first minutes rediscovering the diff scope, and on large repos sometimes review the wrong thing entirely. This adds a "changed files vs base" section (`git diff --stat`, rename-aware, capped at 50 files) with sane base resolution (`--base` flag → PR base → repo default branch), and — when `--branch '#123'` is used — a PR metadata section with title, author, and body, giving agents the change's stated *intent*, which is the one thing they cannot derive from the diff. Intent-vs-implementation mismatch is exactly the class of finding multi-model review is best at. Everything flows through the same auto-context section `--no-auto-context` already disables, and registers as droppable content in the prompt-budget tiers so big diffs compact instead of exploding prompts.

## 9. Recorded-transcript test harness (`nax-mgi`)

`flow-execution.test.js` is the crown jewel of the suite, but every new transport-touching feature hand-builds seam stubs, and stubs drift from reality — the classic way orchestration bugs survive testing. The answer (consistent with the no-mocks rule) is recorded real traffic: a `NAX_RECORD` env var tees every gh CLI exchange and Netlify API request/response into a redacted, committable JSONL transcript; a replay driver feeds recorded responses back through the same seams in order, with pointed mismatch diagnostics when behavior drifts. First scenarios: review happy path, one-agent terminal failure, interrupt + resume, and the GitHub Actions dispatch/poll cycle. Every other epic in this roadmap gains a realistic scenario harness from this, and recording doubles as a debugging tool — `NAX_RECORD` on a failing user run is an attachable repro.

## 10. PR review output target (`nax-u76`)

For PR-centric teams, consensus findings should land exactly where humans already review. `nax handoff --to pr-review` posts a single GitHub PR review: a summary comment with the consensus overview, plus one inline comment per finding that maps to a file in the PR diff (best-effort line mapping; unmappable findings collect under "Outside this diff" in the summary). Always review type `COMMENT`, never `REQUEST_CHANGES` — nax stays advisory, not gatekeeping, which is a deliberate posture decision. Idempotent via a body marker; rerunning refuses politely with a link to the existing review.

## 11. Webhook notifications: `--notify-url` + failure notices (`nax-sgn`)

Notifications are macOS-only (`osascript`) and only celebrate completion. Long fan-out runs (25–45 minutes) are exactly the start-and-walk-away workload, and interrupted or failed runs are precisely when an away-from-keyboard user needs the ping. `--notify-url` POSTs a JSON payload (event, runId, flow, status, duration, credit usage, summary path) on terminal events, auto-wrapping for Slack and Discord webhook hosts, raw JSON for everything else. Delivery is best-effort — five-second timeout, one retry, and a delivery failure can never affect run status or exit code.

## 12. `nax clean`: artifact retention and pruning (`nax-p39`)

`.nax/` grows without bound — every run adds a workflow dir plus N runner dirs plus M session dirs. `nax clean` prunes safely: select by `--older-than` or `--keep-last`, with hard protections (latest symlink targets, unfinished/interrupted workflows — resumable state is sacred — and anything referenced by a kept workflow). The default is a dry-run plan with counts and byte totals; `--force` moves to a `.nax/.trash/` staging area rather than deleting outright, so a mistake is recoverable for seven days. Never glob-deletes; walks known structures only and refuses to touch paths outside `.nax`.

## 13. `nax watch`: live status for in-flight workflows (`nax-lcv`)

A read-only live status board for a running workflow: per step, per agent — status, elapsed time, runner/session links, usage so far — rendered as refreshing boxes in a second terminal, polling `workflow.json` plus the same session-status endpoint the orchestrator uses. Watch never mutates state: no resume offers, no lock acquisition. It auto-exits with the final summary when the run reaches a terminal state, and `--once` (composable with `--json`) renders a single machine-readable snapshot for scripts.

## 14. `nax schedule`: cron GitHub Actions workflows for flows (`nax-c7w`)

Audit flows — security, SEO, accessibility, performance — are periodic by nature. `nax schedule security-audit --cron '0 6 * * 1'` generates a cron-triggered GitHub Actions workflow (plus a manual `workflow_dispatch` trigger) that dispatches the existing run-nax machinery using the secrets `nax init` already wired. The cron string is validated with a next-three-occurrences preview so timezone and cadence mistakes are caught at confirm time. This converts nax from an on-demand tool into a continuous practice — a weekly security audit posting consensus issues — with essentially zero new runtime surface, since GitHub owns the scheduler.

## 15. `nax sync --all`: discover every remote runner for the site (`nax-acw`)

Straight from the README limitations section: "Sync starts with known local runners… It does not yet discover every remote Agent Runner for a site." `nax sync --all` lists all runners for the linked site via the Netlify API, diffs against local `.nax/agent-runners/`, and pulls the missing ones through the existing sync path. The no-argument TTY form becomes an interactive picker of remote runners not yet local — the common "a teammate or another machine ran something" case becomes a two-keystroke pull. A companion `--runs` mode discovers recent GitHub Actions runs carrying nax artifacts so users stop pasting run URLs. Artifacts are the handoff currency of nax; this makes them flow in both directions, and completes the loop for "orchestrate in CI on a schedule, pull results locally."

## 16. Pluggable agent registry (`nax-v42`)

"Three agents. Adding more requires extending the runner action and the flow schema" — the README admits the agent set is hardcoded across flow defaults, validation, title casing, and mention building. A central `agent-registry.js` holds the built-ins and accepts additions from `nax.config.json`, validated at load and checked by flow lint, so the day the Netlify runner supports a new model, users add four lines of config instead of waiting for a nax release. An honesty guard matters here: nax cannot make the runner support a model it doesn't — unverifiable registrations are flagged in `nax doctor` as "will fail at submit if unsupported" rather than silently accepted.

---

## How the pieces depend on each other

The P1 foundations unblock the most downstream work: the prompt-budget module (idea 1) feeds the diff ledger (8); mid-step resubmission (2) is reused by `onFailure: retry` (7); the flow schema (4) gates the control-flow keys (7) and the agent registry (16); `findings.json` (5) feeds the GitHub-issues, beads, and PR-review targets (5, 10) and the `findingsAtLeast` condition (7); the `--json` contract (3) shapes `nax usage` and `nax watch` output (6, 13). A documentation-wave bead (`nax-qgr`) gates the whole graph so the README keeps pace with the surface area.

Run `br ready` for the current unblocked frontier, or `bv` for the interactive graph.
