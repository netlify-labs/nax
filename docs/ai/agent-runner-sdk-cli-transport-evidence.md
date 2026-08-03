# Agent Runner SDK Netlify CLI transport evidence

Recorded on 2026-08-03 from the public
[`netlify/cli`](https://github.com/netlify/cli) source.

## Decision

The SDK does not expose `transport: 'cli'`. HTTP remains the only built-in
transport, and callers may inject a custom `Transport`.

Neither the GitHub Action-pinned Netlify CLI `24.8.1` nor the current stable
CLI `27.0.2` implements the complete machine-readable Agent Runner contract.
A partial CLI adapter would lose exact session identity, pagination,
reconciliation, cancellation, and landing semantics. The SDK must not infer
those values from timestamps or human-readable output.

## Versions inspected

| Netlify CLI | Source commit | Why inspected |
| --- | --- | --- |
| `24.8.1` | [`26eaa6c7`](https://github.com/netlify/cli/tree/26eaa6c7e68e962c82c90736688b4f2ad21e9054) | Exact version pinned by `netlify-labs/agent-runner-action`. |
| `27.0.2` | [`d4945e23`](https://github.com/netlify/cli/tree/d4945e2385acd0d3c7aa33037c398f63b2ae9c14) | Current stable npm release on 2026-08-03. |

The Agent Runner command implementation is materially identical at both
commits for the capabilities below.

## Command contract

The CLI registers exactly four Agent Runner commands in
[`agents.ts`](https://github.com/netlify/cli/blob/d4945e2385acd0d3c7aa33037c398f63b2ae9c14/src/commands/agents/agents.ts):

| Command | Machine output | SDK coverage |
| --- | --- | --- |
| `agents:create` | `--json` returns the created runner. | Initial runner create only. |
| `agents:list` | `--json` returns the first 15 site runners. | Incomplete: page and page size are hard-coded. |
| `agents:show <id>` | `--json` returns the runner only. | Incomplete: sessions are fetched only for human output. |
| `agents:stop <id>` | `--json` returns `{ success: true }`. | Runner cancellation only. |

Source details:

- [`agents-list.ts`](https://github.com/netlify/cli/blob/d4945e2385acd0d3c7aa33037c398f63b2ae9c14/src/commands/agents/agents-list.ts)
  hard-codes `page=1` and `per_page=15`.
- [`agents-show.ts`](https://github.com/netlify/cli/blob/d4945e2385acd0d3c7aa33037c398f63b2ae9c14/src/commands/agents/agents-show.ts)
  returns the runner immediately in JSON mode; its five-session request is
  only used by the human presenter.
- [`agents-stop.ts`](https://github.com/netlify/cli/blob/d4945e2385acd0d3c7aa33037c398f63b2ae9c14/src/commands/agents/agents-stop.ts)
  stops the runner as a whole.

No documented machine command exists for:

- follow-up session creation;
- exact session get or complete session listing;
- session cancellation;
- account-scoped runner listing;
- member actions such as `pull_request`, `commit`, `diff`,
  `publish_to_production`, or `archive`;
- caller-controlled pagination needed for bounded create reconciliation.

## Consequence for the SDK

There is no proven minimum Netlify CLI version that satisfies the SDK
`Transport` interface. The planned version gate, binary discovery, CLI
fixtures, and `cli-transport-unavailable` /
`cli-transport-incompatible` errors are therefore not activated.

This is a fail-closed compatibility decision, not a deferred partial
implementation. A future CLI transport may be added only after one released
CLI version exposes all required identities and operations as documented
machine-readable output. At that point the SDK must record that exact minimum
version and pass the shared transport conformance suite before exposing
`transport: 'cli'`.
