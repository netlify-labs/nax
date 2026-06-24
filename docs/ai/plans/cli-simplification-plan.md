# `nax` CLI Simplification Spec

## Status

This is a major-version CLI contract reset. The goal is not to preserve every old
invocation. The goal is to make the CLI easier to understand by moving all
execution under `nax run`, keeping the few daily commands visible, and removing
old top-level shortcuts that made root help read like an admin console.

## Goals

- Make bare `nax` print a compact help menu and exit `0`.
- Remove the root workflow shortcut: `nax review` is no longer valid.
- Remove root single-agent flags: `nax --agent codex --prompt "..."` is no
  longer valid.
- Make `nax run` the only public entrypoint for workflow runs, single-agent runs,
  and retrying failed workflow work.
- Keep `nax dashboard`, `nax handoff`, `nax list`, and `nax init` public.
- Keep `nax ci` top-level and hidden for agent prompts.
- Hide `nax admin`; use it for maintenance commands.
- Do not add migration docs or compatibility aliases for removed commands. This
  ships as a major release.

## Non-Goals

- Do not redesign workflow execution internals.
- Do not rewrite dashboard behavior.
- Do not preserve removed top-level commands with aliases.
- Do not add a public `open` or `continue` command in this pass.
- Do not add README migration tables for old commands.

## Target Public Surface

```text
Usage: nax [command]

Run Netlify agent workflows.

Commands:
  run [workflow]       Start a workflow or single-agent run
  dashboard [workflow] Open the local workflow dashboard
  handoff [run-id]     Browse, copy, open, or continue from saved results
  list                 List available workflows
  init                 Set up this repository for nax

Examples:
  nax run
  nax run review --branch '#123' --transport netlify-api --force
  nax run agent codex "Check this branch"
  nax dashboard
  nax handoff -c
```

Bare `nax` prints this help and exits `0`.

## Command Contract

### `nax run`

`nax run` is the only public command for starting agent work.

```bash
nax run
nax run review
nax run review --branch '#123' --transport netlify-api --force
nax run --retry <run-id>
nax run review --retry <run-id>
nax run agent codex "Review this branch"
nax run agent codex --prompt "Review this branch"
```

Behavior:

- `nax run` with no workflow opens the existing interactive picker. Keep the
  current picker shape: single-agent run plus available workflows in one flow.
- `nax run <workflow>` runs that workflow.
- `nax run agent <type> [prompt]` starts a single Netlify agent run.
- `agent` is a reserved submode under `run`. A workflow named `agent` is not
  addressable as `nax run agent`; project authors should choose a different flow
  id.
- `nax run --retry <run-id>` retries one failed Netlify API runner and continues
  the workflow using saved run state as the source of truth.
- `nax run <workflow> --retry <run-id>` is allowed. The workflow argument acts as
  a validation/filter for the saved run, not as a replacement for saved state.
- If `--retry` finds no retryable failed agents, fail with a helpful message:
  `No retryable failed agents found for <run-id>. Use nax handoff <run-id> to
  work from completed results.`
- In a TTY, `nax run --retry` with no run id may open a picker over retryable
  failed runs.
- In non-TTY mode, `nax run --retry` requires a run id and must fail clearly if
  one is not provided.

Single-agent details:

- Supported agents are exactly `claude`, `codex`, and `gemini`.
- Unknown agents fail with a did-you-mean style error when possible.
- Prompt text can be positional or passed with `--prompt`.
- If no prompt is provided in a TTY, use the existing multiline prompt utility.
- If no prompt is provided in non-TTY mode, fail with a clear error explaining
  that `nax run agent <type>` requires prompt text.

Common public flags for `nax run`:

```text
--branch <branch-or-pr>
--context <text>
--context-file <path>
--models <list>
--step <id>
--from-step <id>
--transport <transport>
--dry
--force
--retry <run-id>
```

Advanced flags remain available on `nax help run --all` or equivalent advanced
help, but should not appear in compact help:

```text
--repo <owner/name>
--site-id <id>
--filter <app>
--sha <rev>
--pr-limit <count>
--label <list>
--runner <mention>
--issue <list>
--from-issues <list>
--timeout-minutes <count>
--notify
--notify-url <url>
--notify-events <list>
--flows-dir <path>
--output-budget
--output-budget-bytes <bytes>
--archive
--project-root <path>
--step-models <step=models>
--date <yyyy-mm-dd>
--no-auto-context
--no-fetch-results
```

### `nax dashboard`

Keep `dashboard` as the public command. Do not add `open` in this pass.

```bash
nax dashboard
nax dashboard review
nax dashboard --run <workflow-run-id>
nax dashboard --no-open
nax dashboard --no-open --tail
```

Compact help should expose the ordinary dashboard flags:

```text
--run <runId>
--no-open
--tail
```

Advanced help may include:

```text
--project-root <path>
--host <host>
--port <port>
--dev
--flows-dir <path>
```

### `nax handoff`

`handoff` remains public. It is the artifact browsing and follow-up command.
`recent` is removed as a public and callable command.

```bash
nax handoff
nax handoff <run-id>
nax handoff -c
nax handoff --open
nax handoff --path
nax handoff --flow review
nax handoff --agent codex
nax handoff --workflow <id>
nax handoff --runner <id>
nax handoff --session <id>
```

Behavior:

- `nax handoff` in a TTY keeps the existing interactive artifact/action picker.
- `-c, --copy` copies selected/latest summary content to the clipboard.
- `--open` opens the selected/latest summary file in the editor.
- `--path` prints the selected/latest summary path to stdout only.
- If clipboard path support is still desired, expose it as `--copy-path`, not
  `--path`.
- `--flow <id>` runs a workflow with the selected summary as context.
- `--agent <claude|codex|gemini>` starts a fresh single-agent run seeded with the
  selected summary.
- In non-TTY mode, `nax handoff` with no action prints the selected/latest source
  kind and summary path and exits `0`.
- If the selected run has retryable failures, handoff may print a short hint:
  `Retry failed agents with nax run --retry <run-id>`, but it should not switch
  modes automatically.

Selector flags:

- Keep `--workflow`, `--runner`, and `--session` as explicit selectors.
- Remove or hide `--source` and `--source-type` unless implementation needs them
  internally.
- It is acceptable for `--runner` to mean artifact runner id in `handoff`, because
  command context disambiguates it from `run`'s advanced GitHub runner mention.

### `nax list`

Keep public.

```bash
nax list
nax list --json
nax list --verbose
```

### `nax init`

Keep public. `nax init` should offer bundled skill installation as part of setup.

```bash
nax init
nax init --dry
nax init --create --site-name my-app
nax init --no-github-actions
```

Interactive skill prompt:

```text
Install nax workflow skills for local agents?
  Codex
  Claude
  Cursor
  Gemini
  Skip
```

Repeat skill maintenance belongs under `nax admin skills`, not root-level
`nax skills`.

### Hidden `nax admin`

`admin` is hidden from root help. It is available for maintenance commands.

```bash
nax admin sync last
nax admin clean blobs
nax admin clean blobs --ttl-hours 1 --force
nax admin skills install
nax admin skills check
nax admin skills update
```

Behavior:

- `nax admin clean blobs` remains dry-run by default.
- `nax admin clean blobs --force` deletes eligible stale/pending refs, matching
  today's safety model.
- `nax admin sync` owns the current `sync` behavior.
- `nax admin skills` owns repeat install/check/update operations after `init`.

### Hidden `nax ci`

Keep `nax ci <command...>` as a hidden top-level command.

```bash
nax ci 'npm test'
nax ci 'npm test -- --runInBand'
```

Do not list it in compact root help. It exists mainly for agent prompts and
Netlify Agent Runner environments.

## Removed Commands And Invocations

These are removed in the major release. They should not be hidden aliases.

```bash
nax <workflow>
nax --agent <name> --prompt <text>
nax recent
nax retry
nax sync
nax clean
nax skills
```

Canonical replacements:

```bash
nax run <workflow>
nax run agent <name> <prompt>
nax handoff
nax run --retry <run-id>
nax admin sync
nax admin clean
nax admin skills
```

No migration section is required in README. The major version is the migration
boundary.

## Help Model

Default help is compact. Advanced help is explicit.

Preferred syntax:

```bash
nax help
nax help run
nax help run --all
nax help dashboard --all
nax help handoff --all
nax help admin --all
```

`nax --help` and bare `nax` should match compact root help.

`nax run --help`, `nax dashboard --help`, `nax handoff --help`, `nax list --help`,
and `nax init --help` should show compact command help.

Implementation may use a custom help command or a `helpInformation()` override.
Do not rely on commander `.alias()` when an old command must stay hidden: commander
prints aliases in command help, as shown by the current `list|ls` output.

## Implementation Notes

- Update `src/cli/commands/nax.js` command registration first.
- Remove the root `[workflow]` argument and root run action.
- Make root action print help and exit `0`.
- Move root run flags to `run` only.
- Add `run agent <type> [prompt...]`.
- Add or adapt `run --retry <run-id>` to call the current retry handler.
- Add hidden `admin` command group and move sync/clean/skills registrations under
  it.
- Keep hidden top-level `ci`.
- Delete top-level registrations for `recent`, `retry`, `sync`, `clean`, and
  `skills`.
- Keep `issue`, `comment`, `preview-boxes`, and `preview-spinner` hidden only if
  they are still needed by tests or development workflows. Otherwise remove them
  in the same major cleanup after confirming no internal caller depends on them.
- Centralize visible alias cleanup in `normalizeOptionAliases` only for aliases
  that remain valid. Do not preserve aliases solely for old public CLI syntax.

## Testing Requirements

Update and expand:

- `tests/unit/cli-help-smoke.test.js`
- `scripts/check-cli-help.js`
- `tests/unit/command-options.test.js`
- retry tests around `nax run --retry`
- handoff tests for `--path`, `--open`, `--copy`, non-TTY behavior, and selectors
- init/skills tests for optional skill install and `admin skills`
- admin command smoke tests for `sync`, `clean`, and `skills`
- hidden `nax ci` forwarding tests, especially commands with unknown options after
  the command payload

Specific parser cases to cover:

```bash
nax
nax --help
nax review
nax run
nax run review --dry --force
nax run agent codex "Review this branch"
nax run agent codex --prompt "Review this branch"
nax run agent codex
nax run agent unknown "Review"
nax run --retry run-123
nax run review --retry run-123
nax handoff
nax handoff -c
nax handoff --path
nax handoff --open
nax admin clean blobs
nax admin clean blobs --force
nax admin sync last
nax admin skills check
nax ci 'npm test -- --runInBand'
```

Expected failures:

```bash
nax review
nax --agent codex --prompt "Review"
nax recent
nax retry run-123
nax sync last
nax clean blobs
nax skills check
```

## Documentation Requirements

Docs are updated after the CLI shape lands.

Required updates:

- README quickstart and examples
- README command list
- README dashboard section only if command text changes
- README handoff section
- README run flags table
- `src/templates/skills/nax-workflows/SKILL.md`
- workflow docs that reference removed top-level commands

Do not add a migration guide. This is a major version reset.

## Acceptance Criteria

- Bare `nax` prints compact help and exits `0`.
- Root workflow shortcut is removed.
- Root single-agent flags are removed.
- `nax run` owns workflow runs, single-agent runs, and retries.
- `nax run agent` supports positional and `--prompt` prompt text, with multiline
  TTY fallback and clear non-TTY failure.
- `nax dashboard`, `nax handoff`, `nax list`, and `nax init` remain public.
- `nax admin` works but does not appear in compact root help.
- `nax ci` works but does not appear in compact root help.
- Removed commands are not registered as compatibility aliases.
- Compact help stays short enough to scan quickly.
- Advanced/admin help remains discoverable through explicit help commands.
- Tests cover command parsing, help output, removed command failures, handoff
  behavior, retry behavior, and admin routing.
