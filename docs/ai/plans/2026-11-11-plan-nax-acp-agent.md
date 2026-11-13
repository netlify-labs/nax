---
id: 2026-11-11-plan-nax-acp-agent
status: in-progress
created: 2026-11-11
---

# `nax acp`: run Netlify Agent Runners from ACP clients (t3code)

## Goal

t3code (and any ACP client, such as Zed) can use Netlify Agent Runners as a provider without a fork.
t3code has no runtime plugin API, but **Settings → Providers → Add provider → Local ACP command**
runs any stdio ACP agent. `nax acp` is that agent.

## Decisions (David, 2026-11-11)

- Lives in this repo as a `nax acp` subcommand.
- Changes reach the local workspace two ways, chosen per session with a config option:
  - `apply` (default): after each turn, apply that session's diff to `cwd` so t3code checkpoints and diff views work.
  - `pr`: open or update a pull request with the runner's `pull_request` action; leave `cwd` untouched.
- Branch: `feat/nax-acp` worktree off master.

## Verified API facts (bitballoon backend, `config/routes.rb`, `agent_runner_session_diffs_controller.rb`)

- `GET /agent_runners/:id/sessions/:sid/diff/result`: that session's own change, anchored on the HEAD the session started from. Used per turn.
- `GET .../diff/cumulative`: everything since the runner payload `sha`.
- `GET /agent_runners/:id/diff`: the runner's resolved diff.
- All three return 404 when the content is blank, including expired S3 objects. 404 means "no diff", not "missing route".

## Protocol mapping (ACP v1, `@agentclientprotocol/sdk` 2.4.0)

| ACP | nax |
| --- | --- |
| `initialize` | `loadSession: true`, text prompts only, no auth methods (token from env or Netlify CLI) |
| `session/new` | resolve `cwd` → project root → site id; save the session record; return config options |
| `session/set_config_option` | `agent`, `model`, `effort`, `changes` (`apply`/`pr`) |
| `session/prompt` | first: `sdk.start`; later: `sdk.followUp`; poll `getSnapshot`; send `currentTask` as a plan entry; `resultText` as the agent message; then land |
| `session/cancel` | `sdk.stop(handle)`; turn ends with `cancelled` |
| `session/load` | read the saved record and replay the saved transcript |

Session records live at `<projectRoot>/.nax/acp-sessions/<sessionId>.json` (`.nax` is already gitignored by `ensureNaxGitignore`).

## Apply mode safety

- Patch goes through `git apply --check` first; on failure the patch is saved to `.nax/acp-sessions/<id>/<session>.patch` and the turn reports where it is.
- Before the first turn, warn when the local HEAD differs from the remote branch tip the runner starts from, or the tree is dirty.

## Known limits

- No token streaming or tool-call events; the runner API only exposes state and `currentTask` between polls.
- No permission modes: runners are autonomous.
- 25-minute hard cap per session.
- ACP clients can't rewind the remote conversation after a checkpoint rollback.

## Tests

- Unit: config options, session store, diff apply (real git in a temp repo), prompt turn against an injected SDK and API client.
- Integration: in-process ACP client ↔ `nax acp` agent over a memory stream.
- Manual: t3code Local ACP command `nax` with argument `acp`.
