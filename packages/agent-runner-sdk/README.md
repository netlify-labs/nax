# nax-agent-runner-sdk

Typed, resumable access to Netlify Agent Runner.

`nax-agent-runner-sdk` provides a stateless execution engine, an HTTP transport,
versioned durable handles, ambiguity reconciliation, and safe GitHub landing.
It supports Node.js 18 and newer, ESM, CommonJS, and strict TypeScript.

## Install

```sh
npm install nax-agent-runner-sdk
```

The package is unscoped. It is developed in the
[`netlify-labs/nax`](https://github.com/netlify-labs/nax) repository but has
independent versions and releases.

## Quick start

```ts
import { createAgentRunnerSdk } from 'nax-agent-runner-sdk'

const sdk = createAgentRunnerSdk({
  token: process.env.NETLIFY_AUTH_TOKEN,
})

const outcome = await sdk.run({
  siteId: 'your-site-id',
  prompt: 'Update the documentation and open a pull request.',
  land: 'pr',
  deadlineMs: 25 * 60 * 1_000,
})

// Persist this even when execution or landing did not succeed.
await saveHandle(sdk.serializeHandle(outcome.handle))

if (outcome.result.status === 'succeeded') {
  console.log(outcome.result.resultText)
  console.log(outcome.result.usage)
}

if (outcome.landing?.kind === 'prOpen') {
  console.log(outcome.landing.prUrl)
}
```

`RunResult` and `LandingOutcome` are independent. A run can succeed while
landing fails, and `resultText` exists only after narrowing
`result.status === 'succeeded'`.

## Authentication

Netlify token precedence is:

1. Per-operation `options.token`
2. SDK-constructor `token`
3. `NETLIFY_AUTH_TOKEN`
4. Netlify CLI config discovery

`NETLIFY_AUTH_TOKEN` is the sole environment-token contract.
`NETLIFY_AGENT_RUNNER_TOKEN` is intentionally not supported. Server-side
consumers such as Revenue Engine should pass their token explicitly instead
of changing process-wide environment state.

`githubToken` is separate and optional. It is used only when GitHub landing
must merge a pull request. PR-only runs need no GitHub credential.

```ts
const sdk = createAgentRunnerSdk({
  token: netlifyToken,
  githubToken,
})

// A per-call token overrides the constructor token.
const snapshot = await sdk.getSnapshot(handle, { token: rotatedToken })
```

Authenticated requests are constrained to the configured Netlify API base.
The optional `onTelemetry` callback receives value-free request metadata and
API-drift events; it never receives tokens, prompts, response bodies, or
request markers.

## Construct the SDK

```ts
import { createAgentRunnerSdk } from 'nax-agent-runner-sdk'

const sdk = createAgentRunnerSdk({
  transport: 'http',
  apiStyle: 'v1',
  token: process.env.NETLIFY_AUTH_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  defaultDeadlineMs: 25 * 60 * 1_000,
  pollIntervalMs: 15_000,
  retryAttempts: 3,
  onLandingCheckpoint: async (handle) => {
    await saveHandle(JSON.stringify(handle))
  },
  onRetryCheckpoint: async (handle) => {
    await saveHandle(JSON.stringify(handle))
  },
})
```

Important constructor options include:

| Option | Meaning |
| --- | --- |
| `transport` | `'http'` by default, or an injected `Transport`. |
| `apiStyle` | `'v1'` by default; `'bb-api'` targets the legacy access-control API shape. |
| `token` | Constructor-level Netlify token. |
| `baseUrl` | Override the API base for a proxy or test server. |
| `githubToken` | Optional token for `land: 'merge'`. |
| `defaultDeadlineMs` | Default relative deadline; 25 minutes. |
| `pollIntervalMs` | Default polling interval; 15 seconds. |
| `retryAttempts` | Transport attempts for retry-safe operations. |
| `clockSkewAllowanceMs` | Reconciliation-window allowance; 5 seconds. |
| `blobStore` | `BlobStore` used for prompt-reference delivery and terminal cleanup. |
| `promptDelivery` | Final-byte budget, compactor, blob TTL, and tenant/key policy. |
| `promptRefDelivery` | Compatibility override that turns a `BlobRef` into a runner fetch wrapper. |
| `onBlobCleanupError` | Receives a value-free cleanup failure event; cleanup never changes the run result. |
| `onLandingCheckpoint` | Persists irreversible landing progress before the next mutation. |
| `onRetryCheckpoint` | Persists consumed retry capacity and safe reason/timing metadata before replacement I/O. |
| `onTelemetry` | Receives redacted auth/transport events. |

`fetch`, `sleep`, `now`, `random`, and `generateRequestId` can be injected for
tests. HTTP is the only built-in Phase 1 transport; the public `Transport`
interface supports other implementations.

### HTTP API styles

The default `apiStyle: 'v1'` uses
`https://api.netlify.com/api/v1/agent_runners`. The opt-in `'bb-api'` style
uses the access-control base and accepts its legacy camel-case response
aliases. Both normalize into the same `Runner` and `Session` types.

Create requests are never blindly replayed after an uncertain write. Safe
GET/DELETE operations retry `408`, `409`, `425`, `429`, and server errors with
bounded backoff. Ambiguous creates use reconciliation instead.

## Inputs

`StartInput` accepts exactly one prompt source:

```ts
type StartInput = (
  | { prompt: string; promptRef?: never }
  | { prompt?: never; promptRef: BlobRef }
) & {
  siteId: string
  agent?: string
  model?: string
  branch?: string
  deployId?: string
  mode?: 'normal' | 'create' | 'ask'
  fileKeys?: string[]
  land?: 'pr' | 'merge' | 'publish' | 'none' | 'auto'
  deadlineMs?: number
  retryBudget?: { capacity: number }
  requestId?: string
}
```

Defaults are `agent: 'claude'`, `land: 'none'`, a 25-minute deadline, and no
engine retries. A caller-supplied `requestId` must be a UUID unique to that
logical create attempt.

`FollowUpInput` also accepts exactly one prompt source and supports `agent`,
`model`, `mode`, `fileKeys`, and `requestId`. It intentionally does not replace
the original site, landing, deadline, or retry policy.

## Methods

| Method | Purpose |
| --- | --- |
| `start(input, options?)` | Create a runner and return a `RunHandle` with its exact initial session. |
| `run(input, options?)` | Convenience path: `start` → `waitFor`, bounded safe retries, then `land` after success. |
| `getSnapshot(handle, options?)` | Return a running snapshot or terminal result without waiting. |
| `getResult(handle, options?)` | Return a terminal result; reject if still running. |
| `waitFor(handle, options?)` | Poll to a terminal result, enforcing the handle deadline. |
| `land(handle, options?)` | Resume landing and return `{ handle, landing }`. |
| `stop(handle, options?)` | Cancel the exact run/session and return the handle. |
| `followUp(handle, input, options?)` | Create a session and return a full `SessionHandle`. |
| `classifyFailure(error)` | Normalize a thrown value into the SDK failure taxonomy. |
| `shouldRetry(handle, failure)` | Check retryability and the persisted budget. |
| `retry(handle, { failure, ...options }?)` | Back off, checkpoint, and create a replacement logical attempt. |
| `reconcileCreate(input, window, options?)` | Resolve an uncertain runner create. |
| `reconcileSession(handle, input, window, options?)` | Resolve an uncertain/409 session create. |
| `serializeHandle(handle)` | Validate and serialize a versioned handle. |
| `parseHandle(value)` | Parse and validate a serialized or object handle. |

The underlying normalized transport is available as `sdk.transport`, including
typed `member(...)` actions for advanced consumers.

## Durable handles and deadlines

The SDK keeps no hidden run state. Persist the complete handle returned by
every mutating SDK method:

```ts
let handle = await sdk.start(input)
await saveHandle(sdk.serializeHandle(handle))

// In another process:
handle = sdk.parseHandle(await loadHandle())
const snapshot = await sdk.getSnapshot(handle)

if (snapshot.kind === 'terminal' && snapshot.result.status === 'succeeded') {
  const landed = await sdk.land(handle)
  handle = landed.handle
  await saveHandle(sdk.serializeHandle(handle))
}
```

Handles are version-stamped and contain the original effective input, exact
`currentSessionId`, policy, retry count, last safe retry reason/timing, and
landing checkpoints. A
`SessionHandle` additionally contains its effective follow-up input and
maintains `sessionId === currentSessionId`.

`deadlineMs` is converted once into the absolute
`handle.policy.deadlineAt`. `waitFor` enforces it in-process. Out-of-band
workers must compare the current time to `deadlineAt` and call `stop`.
Reconciliation, follow-ups, and retries do not restart the clock.

Use `serializeHandle` and `parseHandle` at storage boundaries. Do not persist
only runner/session IDs or construct handles by hand.

## Results, usage, and changes

`RunResult` is a four-way discriminated union:

- `succeeded` contains `resultText`, `links`, optional diff/deploy data, and
  `changes`.
- `failed` contains a classified `failure`.
- `cancelled` records cancellation.
- `timedOut` records whether the SDK successfully requested runner
  cancellation.

Every variant contains `usage: Usage | null`. Persist usage even for failures,
cancellations, and timeouts. `changes` exists on successful results and is
tri-state:

- `changed`: a diff was reported.
- `unchanged`: the service explicitly reported no diff.
- `unknown`: the API did not provide enough information.

Never treat `unknown` as `unchanged`.

`run()` returns:

```ts
interface RunOutcome {
  result: RunResult
  landing?: LandingOutcome
  handle: RunHandle
}
```

Landing is attempted only after successful execution. Always persist
`outcome.handle`, then inspect `outcome.result` and `outcome.landing`
independently.

## Landing

Phase 1's default handler supports GitHub-origin runners:

- `none` returns `skipped`.
- `pr` creates or resumes a pull request and returns `prOpen`.
- `merge` creates/resumes the PR and uses `githubToken` to compare-and-swap
  merge the exact observed head.
- `auto` merges when a GitHub token is configured and otherwise returns the
  open PR.

Follow-up landing commits the exact `handle.currentSessionId`; a stale
runner-level merge SHA from an earlier session is never accepted. GitHub merge
persists the observed PR head before mutation and refuses to merge if it
changes.

The complete `LandingOutcome` union is:

```ts
type LandingOutcome =
  | { kind: 'merged'; prUrl: string; mergeSha: string; deployUrl?: string }
  | { kind: 'prOpen'; prUrl: string; merged: false }
  | { kind: 'published'; deployUrl?: string }
  | { kind: 'unsupported'; reason: string }
  | {
      kind: 'failed'
      step: 'commit' | 'pr' | 'merge' | 'publish'
      failure: FailureClassification
    }
  | { kind: 'skipped' }
```

Netlify Git publishing is a Phase 3 implementation. In Phase 1, non-GitHub
origins return `unsupported`; `published` remains part of the stable result
contract and may also be returned by an injected `landingHandler`.

Landing failures are returned as data rather than thrown. Persist both the
returned handle and every handle passed to `onLandingCheckpoint`. Retry
checkpoints use the separate `onRetryCheckpoint` callback.

## Ambiguous create reconciliation

The SDK appends a reserved UUID marker to the submitted prompt. It retains the
unmarked semantic prompt and request ID on the handle/error, strips markers
from normalized result text, and redacts markers from telemetry and emitted
error messages. Typed ambiguity errors intentionally retain the effective
input in memory for reconciliation. Treat the marker as private SDK metadata.

`start` and `followUp` perform one reconciliation attempt automatically after
an ambiguous response. If a unique match cannot be proven, they rethrow the
typed create error so the caller can reconcile later:

```ts
import {
  createAgentRunnerSdk,
  isAgentRunnerSdkError,
} from 'nax-agent-runner-sdk'

try {
  const handle = await sdk.start(input)
  await persist(handle)
} catch (error: unknown) {
  if (!isAgentRunnerSdkError(error, 'create-ambiguous')) throw error

  const resolution = await sdk.reconcileCreate(
    error.effectiveInput,
    error.window,
  )

  switch (resolution.kind) {
    case 'matched':
      await persist(resolution.handle)
      break
    case 'none':
      await recordManualReview('No matching runner was found.')
      break
    case 'ambiguous':
      await recordCandidates(resolution.candidates)
      break
  }
}
```

Reconciliation searches the bounded `{ sentAt, failedAt }` window plus the
configured clock-skew allowance and requires an exact marker and defensive
input fingerprint. It never adopts a later same-prompt run. A matched create
rebuilds the original policy and computes the deadline from the original
`sentAt`, not from reconciliation time.

For `session-already-active`, pass the typed error back as `conflict` so only
the reported active session can be adopted:

```ts
if (isAgentRunnerSdkError(error, 'session-already-active')) {
  const resolution = await sdk.reconcileSession(
    handle,
    error.effectiveInput,
    error.window,
    { conflict: error },
  )
}
```

Do not blindly submit another create after `none` or `ambiguous`. Escalate or
inspect the safe candidate IDs first.

## Retry

`run()` automatically retries only classified capacity, rate-limit, and
platform-server failures within the persisted budget and original deadline.
Out-of-band workers use the same policy explicitly:

```ts
const failure = sdk.classifyFailure(error)

if (sdk.shouldRetry(handle, failure)) {
  handle = handle.kind === 'run'
    ? await sdk.retry(handle, { failure })
    : await sdk.retry(handle, { failure })
  await saveHandle(sdk.serializeHandle(handle))
}
```

Retry uses the constructor's injected exponential-jitter backoff, rotates
`requestId`, increments the handle retry count, preserves the semantic input
and original deadline, and creates a new logical attempt. The SDK calls
`onRetryCheckpoint` before waiting or sending replacement I/O so a restart
cannot reset the consumed budget.

Transport retry remains operation-specific. Network/request timeouts,
authentication, permission, validation, argv-too-long, terminal failures,
prompt/blob failures, API drift, ambiguous creates/session conflicts, and
GitHub head drift never create automatic replacement attempts.

## BlobStore and prompt references

The package ships a Netlify Blobs adapter with tenant-scoped,
collision-resistant keys, mandatory logical expiries, and hard size/lifetime
ceilings:

```ts
import {
  compactPromptByBytes,
  createAgentRunnerSdk,
  createNetlifyBlobStore,
} from 'nax-agent-runner-sdk'

const blobStore = createNetlifyBlobStore({
  siteId: process.env.NETLIFY_SITE_ID!,
  token: process.env.NETLIFY_AUTH_TOKEN!,
})

const sdk = createAgentRunnerSdk({
  blobStore,
  promptDelivery: {
    // Defaults to NAX_SAFE_PROMPT_BYTES, then 16 KiB.
    safeBytes: 16 * 1_024,
    tenant: ({ siteId }) => `${siteId}/art_123`,
    key: 'artifact-art_123',
    // Optional: compactPromptByBytes or a deterministic domain compactor.
    compact: compactPromptByBytes,
  },
})

const handle = await sdk.start({
  siteId: process.env.NETLIFY_SITE_ID!,
  prompt: largePrompt,
})
```

Raw prompts are measured after request-marker decoration. The SDK submits
inline when the final UTF-8 payload fits, optionally compacts and remeasures,
then uses `blobStore` as the fallback. Blob fallback stores the original
semantic prompt and changes the effective handle input to the resulting
`promptRef`, so retry reuses the same logical input. Inline and compact
delivery keep the original semantic `prompt` in the handle. The submitted
representation and exact byte counts live in `handle.promptDelivery`.

The adapter stores a sentinel with the semantic prompt. Its runner instruction
uses the runner's own site-scoped `netlify blobs:get` authorization and never
embeds the caller token. The SDK validates `expiresAt`, appends its request
marker, and preserves the original `promptRef` in the handle.

Terminal success, cancellation, and timeout delete the current attempt's blob.
Failed attempts retain the reference until its logical expiry so
`retry(handle)` can reuse the exact input. Cleanup is idempotent and
best-effort; failures emit only the value-free `onBlobCleanupError` event. A
restored handle performs the same cleanup when its terminal result is observed.

`DEFAULT_PROMPT_BLOB_TTL_SECONDS` is one day. The built-in hard ceilings are
`MAX_PROMPT_BLOB_TTL_SECONDS` (seven days) and
`MAX_PROMPT_BLOB_BYTES` (5 MiB); callers may configure lower limits. A delete
must match the adapter's full store, tenant, and key identity. `expiresAt` is
an SDK-enforced retry boundary stored in blob metadata; Netlify Blobs does not
automatically delete the object at that time. Consumers that can abandon
failed handles must separately sweep expired entries from the configured
store.

Existing stores can implement the `BlobStore` interface. The older
`promptRefDelivery` option remains available as a delivery-only override; when
it is used without `blobStore`, the caller continues to own cleanup.

`requestMarkerOverheadBytes` is exported for adapters that must pre-budget
content. The SDK itself always measures after decoration, including at exact
below/at/above boundaries and for multi-byte UTF-8 input. An expired reference
fails with `prompt-ref-expired`; it is never silently re-uploaded.

`classifySentinelEvidence` normalizes runner proof to `confirmed`, `failed`,
`probable`, or `suspect` without returning the sentinel value. Use
`blobOnlyNeedles` only for facts that cannot appear in the inline wrapper.

## Migrating a direct client

Replace direct lifecycle HTTP or Netlify CLI calls as follows:

| Direct operation | SDK replacement |
| --- | --- |
| Create runner | `sdk.start(input)` |
| Read runner/latest session | `sdk.getSnapshot(handle)` using the persisted exact session |
| Poll | `sdk.waitFor(handle)` or out-of-band `getSnapshot` ticks |
| Create follow-up | `sdk.followUp(handle, input)` |
| Cancel | `sdk.stop(handle)` |
| Create PR/commit/merge | `sdk.land(handle)` |
| Retry a create | `sdk.shouldRetry` + `sdk.retry` |
| Raw member action | `sdk.transport.member(...)` |

Migration requirements:

1. Persist the full serialized handle wherever runner/session IDs were stored.
2. Keep the exact current session for reads, usage, results, and follow-up
   landing.
3. Preserve existing absolute deadlines; do not restart them when a worker
   resumes.
4. Remove duplicate auth, retry, response normalization, and create replay
   logic.
5. Use only `NETLIFY_AUTH_TOKEN`, or pass a token explicitly.
6. Configure `blobStore` and `promptDelivery`, then remove consumer-owned
   sizing, offload, sentinel, and cleanup branches.

See
[`examples/eventbridge-resume.ts`](./examples/eventbridge-resume.ts) for a
typechecked durable worker and [`examples/run-outcome.ts`](./examples/run-outcome.ts)
for exhaustive result/landing narrowing.

## Release process

Releases are manual and run from `packages/agent-runner-sdk`. Git tags use the
package-specific prefix `nax-agent-runner-sdk-vX.Y.Z`, separate from nax CLI tags.

For an authorized prerelease:

```sh
npm run ci
npm version 0.2.0-next.1 --allow-same-version \
  --tag-version-prefix=nax-agent-runner-sdk-v
npm run release:next
```

Use the intended package version in place of `0.2.0-next.1`. `release:next` publishes
with the `next` distribution tag, then installs that registry artifact in clean
ESM and CommonJS projects and compiles its shipped examples. `npm run
pack:smoke` performs the equivalent check against the exact local tarball
before publication.
