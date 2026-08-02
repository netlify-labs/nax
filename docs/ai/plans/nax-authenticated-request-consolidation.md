# Plan: consolidate Netlify authentication and authenticated API calls

> Preserve every current authentication, preflight, retry, parsing, and error
> behavior while adding OS-correct Netlify CLI credential discovery, a Nax user
> agent, and value-free failure telemetry.

Status: **IMPLEMENTED IN `agent-runner-sdk`** (2026-08-02). This document is
the retained characterization and migration record; the implementation home
is `packages/agent-runner-sdk/src/auth/`. Nax's CommonJS modules consume the
package's built CJS export through
`src/integrations/netlify/{auth,api-client,preflight}.js`.
Scope: Netlify token discovery, direct Netlify API request construction, and
the existing account/site access preflight.
Out of scope: OAuth/JWE support, pagination, UI work, and changing which
Netlify credentials users configure.

Implementation deltas required by the Agent Runner SDK specification:

- The shared core is strict TypeScript in the independently published
  `agent-runner-sdk`, rather than a nax-only CommonJS module.
- Token precedence is per-operation `token`, SDK-constructor `token`,
  `NETLIFY_AUTH_TOKEN`, then Netlify CLI config discovery.
- `NETLIFY_AUTH_TOKEN` is the sole environment-token contract.
  `NETLIFY_AGENT_RUNNER_TOKEN` is deliberately unsupported.
- Direct requests identify as `agent-runner-sdk/<version>`. The nax adapter
  retains its legacy error/verdict surface while delegating auth, request,
  retry, redaction, and telemetry mechanics to the SDK.
- The package-level callback is `onTelemetry`; the nax compatibility adapter
  also accepts this plan's `onRequestFailure` event shape.
- ESM and CommonJS consumers receive separate declaration entrypoints from
  the same strict public contract.

---

## 1. Goal and intent

Nax currently has the right user-facing behavior, but the implementation has
two seams that can drift:

1. Netlify CLI token discovery is implemented as a hand-maintained list of
   macOS, XDG, and legacy paths.
2. The normal Netlify API client and the access preflight construct separate
   authenticated `fetch` calls.

The MCP implementation demonstrates three useful improvements:

1. Derive the Netlify CLI config path with the same OS-aware convention as the
   Netlify CLI.
2. Send a product-specific `User-Agent` on Netlify API calls.
3. Emit failure telemetry containing method, pathname, and status while
   excluding credentials and request/response values.

The implementation must add those capabilities without weakening what Nax
already does better than the MCP code:

- explicit token and site precedence;
- noninteractive behavior;
- wrong-account preflight verdicts;
- configurable timeouts;
- bounded retries for selected HTTP statuses;
- structured runner error codes;
- token redaction;
- injected `fetch`, sleep, environment, and warning callbacks for tests;
- response normalization used by hosted Agent Runner consumers;
- Node 18 support for the published CLI;
- CommonJS module compatibility;
- precise JSDoc types with no `any`.

The governing rule is **characterize first, refactor second**. Every existing
behavior listed in this plan receives a regression assertion before its
implementation moves.

---

## 2. User outcomes

### 2.1 Existing users

Existing macOS and Linux users should observe no CLI-output or workflow change:

- `NETLIFY_AUTH_TOKEN` still wins over every config file.
- A token from Netlify CLI config still works.
- A missing token still produces the current guidance.
- Wrong-account and expired-token checks still produce the current verdicts.
- Offline preflight remains a warning rather than a blocker.
- Local and hosted Agent Runner calls retain their current request and result
  shapes.

### 2.2 Windows users

Nax discovers the token from the same Windows config location used by
`env-paths('netlify', { suffix: '' })`, while retaining the legacy fallback
candidate.

### 2.3 Netlify API operators

Direct requests identify themselves as:

```text
agent-runner-sdk/<package-version>
```

Failures can be observed through a structured callback without exposing the
Bearer token, prompt text, body, response payload, query string, or arbitrary
error message.

---

## 3. Current architecture and contracts

### 3.1 Token discovery

`readNetlifyCliToken()` currently lives in
`src/integrations/netlify/init.js` even though it is consumed outside init:

- `src/integrations/transports.js` decides whether the local Netlify API
  transport is available.
- `src/integrations/netlify/preflight.js` verifies the current account and
  linked site.
- `src/integrations/netlify/local-runner.js` injects the token into the
  Netlify CLI subprocess environment.
- `src/integrations/netlify/init.js` uses it for GitHub Actions secret setup.

Current precedence:

1. `env.NETLIFY_AUTH_TOKEN`.
2. `~/Library/Preferences/netlify/config.json`.
3. `$XDG_CONFIG_HOME/netlify/config.json`, or
   `~/.config/netlify/config.json`.
4. `~/.netlify/config.json` as a legacy fallback.
5. Empty token/source result.

Config parsing selects:

```text
config.users[config.userId].auth.token
```

Missing files, invalid JSON, unfamiliar shapes, and unreadable candidates are
silently skipped. The return shape is always:

```js
{ token: string, source: string }
```

### 3.2 Direct API client

`src/integrations/netlify/api-client.js` owns the provisional Agent Runner API
surface and exports:

- `DEFAULT_BASE_URL`;
- `createNetlifyApiClient()`;
- `errorCodeForStatus()`;
- `normalizeAgentRunner()`;
- `redactToken()`.

`createNetlifyApiClient()` currently preserves these contracts:

- Token precedence: explicit `token`, then `env.NETLIFY_AUTH_TOKEN`.
- Site precedence: explicit `siteId`, then `env.NETLIFY_SITE_ID`.
- Default base URL: `https://api.netlify.com/api/v1`.
- Default timeout: 30 seconds.
- Default `retryAttempts`: one total attempt.
- Retryable statuses: `408`, `409`, `425`, `429`, and `5xx`.
- Retry delay: `min(1000 * attempt, 5000)` using injected `sleep`.
- JSON request bodies receive `content-type: application/json`.
- All requests receive `accept: application/json` and Bearer auth.
- Empty successful responses normalize to `null`.
- JSON responses normalize to parsed values.
- Non-JSON responses normalize to `{ text }`.
- Non-2xx responses throw an `Error` carrying `statusCode`, `code`, and
  `payload`.
- The configured token is redacted from the thrown message.
- Paths are joined to the configured base URL; callers cannot supply an
  arbitrary absolute destination that receives the Bearer token.

Status mapping:

| HTTP result | Nax error code |
|---|---|
| `401` | `runner_auth_failed` |
| `403` | `runner_permission_denied` |
| `404` | `runner_not_found` |
| `400`, `422` | `runner_validation_failed` |
| `429` or rate-limit detail | `runner_rate_limited` |
| `5xx` and all other failures | `runner_transport_error` |

### 3.3 Access preflight

`src/integrations/netlify/preflight.js` directly calls:

```text
GET /user
GET /sites/:siteId
```

It intentionally returns verdicts instead of throwing:

```text
ok | no_token | no_site | bad_token | no_access | network_error
```

Behavior that must remain exact:

- Missing token performs no network request and returns `no_token`.
- Missing linked site performs no network request and returns `no_site`.
- `/user` status `401` returns `bad_token`.
- Every `/user` status other than `401` continues to the site lookup; account
  email is captured only when the user response is successful. This includes
  preserving today's behavior when the user endpoint fails but the site
  endpoint succeeds.
- A successful `/user` captures the account email when present.
- `/sites/:siteId` status `403` or `404` returns `no_access` and preserves the
  account detail already obtained.
- Any other unsuccessful site response returns `network_error` with the HTTP
  status in its friendly message.
- Fetch, DNS, connection, and timeout exceptions return `network_error`.
- Error details are token-redacted.
- `enforceRunPreflight()` blocks only `bad_token` and `no_access`.
- Every other non-OK verdict warns and allows execution to continue.
- Dashboard startup uses a 3-second timeout.
- The reusable preflight defaults to a 5-second timeout.

### 3.4 Why consolidation is safe only after characterization

The API client's high-level `request()` throws on every non-2xx response,
whereas preflight needs to inspect HTTP status and continue from `/user` to the
site check in some cases. Replacing preflight with the existing throwing method
would change behavior. The shared layer therefore needs both:

1. a non-throwing HTTP-response primitive; and
2. the existing throwing JSON convenience method built on top of it.

This distinction is the key architectural constraint.

---

## 4. Design decisions

### D1. Extract credential discovery from `init.js`

Create `src/integrations/netlify/auth.js` as the owner of Netlify credential
discovery.

Exports:

```js
readNetlifyCliToken(options)
netlifyCliConfigCandidates(options)
```

Both exports are public API: tests assert candidate ordering directly against
`netlifyCliConfigCandidates()`, and a future diagnostics command can show
which paths were checked. Candidate ordering is therefore a contract, not an
implementation detail.

`init.js` re-exports `readNetlifyCliToken` permanently (approved by David,
2026-07-27). Internal callers migrate to `auth.js` imports; the init.js
forwarding export stays so any consumer requiring through init.js keeps
working indefinitely.

Rationale:

- Auth discovery is not init-specific.
- The permanent re-export makes the refactor purely additive.
- A dedicated module can be tested on simulated OS/environment combinations
  without invoking init behavior.

### D2. Match `env-paths` semantics without making auth asynchronous

Nax is a CommonJS package supporting Node 18. Current `env-paths` releases are
ES modules, and the current Netlify CLI uses an ESM release requiring a newer
Node runtime. Converting `readNetlifyCliToken()` to async would ripple through
transport detection, init secret setup, and local runner environment creation.
That expansion is unnecessary and increases regression risk.

Implementation approach:

- Implement the small config-directory subset locally in `auth.js`, matching
  the current `env-paths('netlify', { suffix: '' })` algorithm exactly and
  documenting the source in a code comment.
- Do not add an `env-paths` dependency. The config-directory subset is a few
  lines per platform; a dependency adds supply-chain and Node 18/CommonJS
  loading considerations for no meaningful savings.
- Do not use the existing transitive `env-paths@3` dependency: transitive
  availability is not an API contract, and CommonJS loading differs by Node
  version.

Required platform semantics:

| Platform | Config directory |
|---|---|
| macOS | `<home>/Library/Preferences/netlify` |
| Windows | `%APPDATA%/netlify/Config`, falling back to `<home>/AppData/Roaming/netlify/Config` |
| Linux/other | `$XDG_CONFIG_HOME/netlify`, falling back to `<home>/.config/netlify` |

Candidate ordering:

1. On Windows only: the Windows config path from the table above.
2. The existing candidates in their current order: macOS Preferences path,
   XDG path, then `<home>/.netlify/config.json` legacy fallback.

On macOS and Linux the candidate order is byte-for-byte identical to today.
Prepending the platform-correct path on every platform would flip resolution
for a Linux home directory containing both a Preferences-path config and an
XDG config, contradicting the no-change guarantee in section 2.1; only Windows
gains a new candidate.

Deduplicate candidates while preserving order. Keep the `home`, `env`, and
platform inputs injectable so tests never read a developer's real credentials.

### D3. Do not add new token aliases

This change will not add `NETLIFY_PERSONAL_ACCESS_TOKEN` or change credential
precedence. `NETLIFY_AUTH_TOKEN` remains the only environment-token contract.

Rationale:

- The requested work is discovery consistency, not a new configuration API.
- Adding an alias raises precedence and documentation questions.
- GitHub workflow templates and current site documentation consistently use
  `NETLIFY_AUTH_TOKEN`.

### D4. Introduce a non-throwing authenticated response primitive

Inside `createNetlifyApiClient()`, introduce
`requestResponse(method, path, options)`, exposed on the returned client
object alongside the existing `request` method. It is public API for
embedders, symmetric with `request`.

It returns a precise shape:

```js
{
  ok: boolean,
  status: number,
  statusText: string,
  text: string,
  payload: unknown,
  method: string,
  apiPath: string,
  attempts: number,
}
```

The native `Response` object is not exposed. `apiPath` is the pathname of the
joined request URL (`new URL(url).pathname`); it never contains the query
string, the host, or the scheme.

Responsibilities:

- Validate that an auth token exists, throwing the same `runner_auth_failed`
  error `request()` throws today when the token is absent.
- Join the API base URL and relative path using existing semantics.
- Uppercase the HTTP method.
- Add authorization, accept, conditional content-type, and user-agent headers.
- Serialize the existing object body shape.
- Apply the existing timeout and retry policy.
- Preserve the current policy of retrying selected HTTP responses but not
  retrying fetch/network exceptions.
- Read the response body exactly once.
- Normalize empty, JSON, and non-JSON bodies using existing rules.
- Return non-2xx HTTP responses instead of throwing.
- Continue to throw network-level exceptions after emitting safe telemetry.

The existing `request()` becomes a thin policy wrapper:

1. Call `requestResponse()`.
2. Return `payload` on success.
3. Build the same redacted error on HTTP failure.
4. Preserve `statusCode`, `code`, and `payload` properties.
5. Add a value-free `requestMeta` property (`{ method, apiPath, attempts }`)
   without removing any existing property. The name deliberately avoids
   `request`, which axios/got-style code sniffs for a full request object.

The six Agent Runner convenience methods remain unchanged and continue using
`request()`.

### D5. Keep the client destination constrained

Do not copy MCP's `new URL(urlOrPath, base)` behavior for arbitrary absolute
URLs. `requestResponse()` accepts API-relative paths and joins them to the
configured base URL exactly as the current client does.

Rationale: a generic authenticated fetch that accepts arbitrary destinations
can accidentally send a Netlify token to an attacker-controlled host. Upload
URLs or other cross-origin calls should use a separate unauthenticated/signed
request path.

### D6. Add a versioned Nax user agent

Add and export:

```text
DEFAULT_USER_AGENT = agent-runner-sdk/<package-version>
```

The value is derived from the root `package.json` rather than duplicated.
`createNetlifyApiClient({ userAgent })` permits injection for tests and future
embedders, with the versioned default used in production.

The value is name/version only: no platform, Node version, or transport hint.
Netlify CLI-style environment fingerprinting was considered and rejected;
minimal and stable wins until an operator need appears.

Every direct Netlify API request made through the shared primitive receives:

```text
user-agent: <resolved user agent>
```

Caller-controlled headers will not be allowed to replace `authorization` or
silently remove the user agent as part of this work.

### D7. Add value-free, non-disruptive failure telemetry

Add an optional `onRequestFailure` callback to `NetlifyApiClientOptions`.
Default: no-op, preserving current console output.

Scope: plumbing only. No production code path passes a callback in this
change; tests inject it to verify the schema and safety guarantees. Wiring a
real consumer (for example smart-log debug output) is deliberately deferred
until a concrete need exists. Events carry no timing field (`durationMs` was
considered and rejected as YAGNI); the schema is additive, so timing can be
introduced later without breaking observers.

HTTP failure event:

```js
{
  kind: 'http_failure',
  method: 'GET',
  apiPath: '/api/v1/user',
  status: 401,
  attempt: 1,
  maxAttempts: 1,
  retrying: false,
}
```

Network failure event:

```js
{
  kind: 'network_error',
  method: 'GET',
  apiPath: '/api/v1/user',
  attempt: 1,
  maxAttempts: 1,
  retrying: false,
  errorName: 'TypeError',
}
```

Explicitly forbidden telemetry fields:

- URL query string;
- authorization header or token fragment;
- request headers;
- request body or prompt;
- response body or parsed payload;
- status text;
- raw error message, cause, or stack;
- arbitrary caller context values.

The `apiPath` field uses the D4 definition: joined-URL pathname only, with the
query string stripped before the event object is constructed.

Emit one event per failed attempt so retry behavior is observable. The event's
`retrying` boolean records whether another attempt will occur.

Observer failures must never change request behavior:

```text
onRequestFailure throws -> swallow observer error -> preserve original API result
```

The final thrown API error gains the `requestMeta` property described in D4,
containing the same value-free method/path/attempt information, and retains
every existing field.

### D8. Rebuild preflight on the non-throwing primitive

`checkNetlifyAccess()` will:

1. Resolve token and site ID exactly as today.
2. Return early for missing values exactly as today.
3. Create the API client with:
   - the resolved token;
   - injected `fetch`;
   - preflight's `timeoutMs`;
   - `retryAttempts: 1` to preserve one-shot preflight behavior;
   - optional injected `onRequestFailure`;
   - optional test base URL.
4. Call `requestResponse('GET', '/user')`.
5. Apply the current `/user` verdict logic.
6. Call `requestResponse('GET', '/sites/:encodedSiteId')`.
7. Apply the current site verdict logic.
8. Catch network exceptions and preserve the existing redacted
   `network_error` verdict.

Preflight must not call the throwing `request()` wrapper. This preserves its
ability to distinguish status-based verdicts without exception-driven control
flow.

**Payload-shape guard.** The client normalizes an empty successful body to
`null` and a non-JSON body to `{ text }`, while preflight's current inline
helper guarantees `body` is always at least `{}`. Preflight must therefore
wrap `payload` in an object guard (`objectValue()`-style) before reading
`email`, `name`, or `account_slug`; without the guard, an empty-body `/user`
200 would throw a `TypeError` and flip today's continue-without-email behavior
into a `network_error` verdict.

One deliberate exception to exact preservation: a successful response whose
body is the JSON literal `null` currently throws a `TypeError` on property
access and lands in the `network_error` catch-all. After the guard, it
continues without email/site fields, matching the empty-body case. This is a
documented, tested behavior change for a pathological response shape.

### D9. Preserve all injection points

The refactor must retain:

- `checkNetlifyAccess({ projectRoot, env, home, fetch, baseUrl, timeoutMs })`;
- `enforceRunPreflight({ warn, ...options })`;
- `createNetlifyApiClient({ fetch, token, env, siteId, baseUrl, timeoutMs,
  retryAttempts, sleep })`;
- `readNetlifyCliToken({ env, home })`.

New options (`platform`, `userAgent`, `onRequestFailure`) are additive.

---

## 5. Feature-parity matrix

Every row must have a test that passes before and after implementation.

| Contract | Current behavior | Required after change | Test location |
|---|---|---|---|
| Explicit client token | Wins over env | Unchanged | `netlify-api-client.test.js` |
| Environment client token | Used when explicit absent | Unchanged | `netlify-api-client.test.js` |
| Auth resolver env token | Wins over all files | Unchanged | `netlify-auth.test.js` |
| macOS config | Preferences path | Unchanged | `netlify-auth.test.js` |
| XDG config | Honors supplied XDG root | Unchanged | `netlify-auth.test.js` |
| Legacy config | `~/.netlify/config.json` fallback | Unchanged | `netlify-auth.test.js` |
| Windows config | Not currently covered | Newly supported | `netlify-auth.test.js` |
| Corrupt config | Skip and continue | Unchanged | `netlify-auth.test.js` |
| Unknown user | Return empty result | Unchanged | `netlify-auth.test.js` |
| Token source | File path or env label | Unchanged | `netlify-auth.test.js` |
| Site precedence | Explicit then env | Unchanged | `netlify-api-client.test.js` |
| Missing token error | `runner_auth_failed` | Unchanged | `netlify-api-client.test.js` |
| Missing IDs | `runner_validation_failed` | Unchanged | `netlify-api-client.test.js` |
| Request endpoint/body | Current provisional API shapes | Unchanged | `netlify-api-client.test.js` |
| Timeout default | 30 seconds | Unchanged | focused injected-signal test |
| Caller signal | Wins over generated timeout | Unchanged | `netlify-api-client.test.js` |
| Retry statuses | 408/409/425/429/5xx | Unchanged | parameterized client test |
| Retry count/delay | Existing attempt semantics | Unchanged | client test with injected sleep |
| Network exception retry | Throws immediately | Unchanged | client test |
| Successful JSON | Parsed value | Unchanged | client test |
| Successful empty body | `null` | Unchanged | client test |
| Successful text | `{ text }` | Unchanged | client test |
| HTTP error fields | message/statusCode/code/payload | Unchanged plus `requestMeta` | client test |
| Token redaction | Token absent from message | Unchanged | client and preflight tests |
| `/user` 401 | `bad_token` | Unchanged | preflight test |
| Empty-body preflight success | Continue without email/name | Unchanged | preflight test |
| JSON `null`-body preflight success | `network_error` via `TypeError` | Continue without email/name (documented change, D8) | preflight test |
| Site 403/404 | `no_access` with account | Unchanged | preflight test |
| Other site error | `network_error` | Unchanged | preflight test |
| Offline preflight | warning, not block | Unchanged | preflight test |
| Bad token/no access | blocks run | Unchanged | preflight test |
| User agent | absent | Versioned Nax value | client + preflight tests |
| Telemetry | absent | Safe callback only | client + preflight tests |
| Console output | No client diagnostics | Unchanged by default | callback-default test |
| Arbitrary auth URL | Not supported | Still unsupported | URL-construction test |

---

## 6. Implementation phases

### Phase 0: characterization tests

Add tests before moving production code:

1. Expand `tests/unit/netlify-api-client.test.js` to cover:
   - explicit-token-over-env precedence;
   - env fallback;
   - site precedence;
   - empty and non-JSON success bodies;
   - all retryable status classes;
   - a non-retryable `403`;
   - injected `AbortSignal` preservation;
   - exact existing error properties;
   - no absolute-destination behavior.
2. Create `tests/unit/netlify-auth.test.js` and move the existing
   token-discovery cases out of `tests/unit/init.test.js` (move, not copy;
   `init.test.js` keeps only init-workflow tests). Add:
   - corrupt first candidate falling through to a valid later candidate;
   - unknown `userId` returning the empty result;
   - legacy `.netlify` fallback;
   - source value preservation.
3. Expand `tests/unit/netlify-preflight.test.js` with:
   - a non-401 `/user` failure followed by a successful site lookup;
   - site `500` behavior;
   - non-JSON response behavior;
   - empty-body `/user` and site success responses;
   - JSON literal `null` body success responses (characterizing today's
     `network_error` result before the D8 documented change);
   - exact request count per verdict.
4. Remove the existing `Record<string, any>` test annotation encountered in
   `netlify-preflight.test.js`, replacing it with a precise call shape while
   touching that test helper.

Exit criterion: all new characterization tests pass against production code
before the refactor begins, except tests for Windows discovery, user agent,
and telemetry, which represent additive behavior.

### Phase 1: auth module and OS-correct discovery

1. Create `src/integrations/netlify/auth.js` with precise JSDoc types for:
   - token result;
   - candidate options;
   - token reader options.
2. Implement candidate generation and stable deduplication.
3. Preserve environment precedence and tolerant file parsing.
4. Add Windows coverage using injected `platform`, `home`, and env values.
5. Keep `readNetlifyCliToken` re-exported by `init.js`.
6. Migrate direct imports in:
   - `src/integrations/transports.js`;
   - `src/integrations/netlify/preflight.js`;
   - `src/integrations/netlify/local-runner.js`.
7. Leave internal calls in `init.js` using the locally imported auth helper.

Exit criterion: token resolution tests pass on simulated macOS, Windows, and
Linux/XDG inputs, and all existing callers remain synchronous.

### Phase 2: shared authenticated response primitive

1. Add precise response, telemetry, error metadata, and option typedefs in
   `api-client.js`.
2. Add `DEFAULT_USER_AGENT` derived from package metadata.
3. Extract URL, header, fetch, retry, body-read, and normalization logic into
   `requestResponse()`.
4. Reimplement `request()` as the throwing wrapper.
5. Preserve all Agent Runner convenience methods without signature changes.
6. Ensure every attempt receives a fresh timeout signal unless a caller signal
   was supplied, matching current behavior.
7. Ensure the response body is read once and shared by payload/error handling.

Exit criterion: all characterization tests pass unchanged and user-agent tests
pass.

### Phase 3: safe telemetry

1. Add `onRequestFailure` with a no-op default.
2. Emit the allowed HTTP event for each non-2xx attempt.
3. Emit the allowed network event for each thrown fetch attempt.
4. Set `retrying` from the exact retry decision used by control flow.
5. Guard the callback so observer exceptions cannot affect retries, returns,
   or thrown API errors.
6. Add `requestMeta` to final API errors only as an additive property.
7. Add negative assertions that recursively inspect telemetry events and
   confirm they contain none of:
   - a configured token;
   - a query parameter sentinel;
   - a request-body sentinel;
   - a response-body sentinel;
   - a network-error-message sentinel.
8. Verify that omitting the callback produces no console output.

Exit criterion: telemetry tests demonstrate useful method/path/status/attempt
data and value-free payloads.

### Phase 4: preflight consolidation

1. Replace preflight's nested `get()` fetch helper with a client configured for
   one attempt and the existing timeout.
2. Use `requestResponse()` for `/user` and `/sites/:siteId`.
3. Preserve all verdict mapping and messages.
4. Preserve encoded site IDs.
5. Pass through optional `onRequestFailure` and `userAgent` for tests/embedders.
6. Keep `enforceRunPreflight()` unchanged except for expanded option typing.
7. Verify dashboard startup's 3-second override and run preflight's default
   behavior at their existing call sites.

Exit criterion: the old inline authenticated fetch no longer exists, and every
preflight behavior in the parity matrix passes.

### Phase 5: documentation and cleanup

1. Update `docs/ai/plans/nax-netlify-api-client-notes.md` to describe:
   - `requestResponse()` versus `request()`;
   - versioned user agent;
   - failure telemetry schema and forbidden values;
   - token discovery ownership.
2. Do not modify canonical site documentation unless implementation adds or
   changes a user-facing environment variable or CLI workflow. This plan does
   neither.
3. Remove duplicated auth-path code from `init.js` only after compatibility
   exports and call-site tests pass.
4. Confirm no UI files changed. If implementation unexpectedly touches UI,
   run the required `npm run dashboard:build` and include the generated output.

---

## 7. Detailed testing strategy

### 7.1 Auth discovery tests

Create `tests/unit/netlify-auth.test.js` so auth behavior no longer lives among
unrelated init tests. Existing token-discovery cases move here from
`init.test.js`; each behavior has exactly one home.

Cases:

1. `NETLIFY_AUTH_TOKEN` returns immediately and performs no file read.
2. macOS resolves `Library/Preferences/netlify/config.json`.
3. Linux resolves supplied `XDG_CONFIG_HOME`.
4. Linux falls back to `<home>/.config`.
5. Windows honors supplied `APPDATA`.
6. Windows falls back to `<home>/AppData/Roaming`.
7. Legacy `<home>/.netlify/config.json` remains supported.
8. Duplicate candidates are read once.
9. Unreadable/missing candidates are skipped.
10. Invalid JSON candidates are skipped.
11. Missing `userId`, missing user, missing auth, and missing token return empty.
12. A later valid candidate succeeds after an earlier corrupt candidate.
13. Returned `source` is still the exact environment label or file path.
14. Explicit test paths cannot fall through to the developer's real home.

### 7.2 API client tests

Extend `tests/unit/netlify-api-client.test.js`.

Request behavior:

- method is uppercased;
- URL joining remains stable with/without boundary slashes;
- authorization and accept headers remain present;
- content-type remains conditional on body;
- versioned user agent is present;
- request body JSON is unchanged;
- success normalization is unchanged;
- missing token fails before fetch;
- domain methods retain their current endpoint/body contracts.

Retry behavior:

- one event per failed attempt;
- `retrying:true` only when another attempt occurs;
- sleep delay remains unchanged;
- non-retryable statuses do not sleep;
- network exceptions retain current throw semantics;
- caller signal remains authoritative.

Security behavior:

- configured token is absent from thrown messages and telemetry;
- query strings are absent from telemetry even when the API-relative path has
  query parameters;
- response and request sentinels are absent from telemetry;
- observer exceptions are swallowed;
- an absolute-looking path cannot redirect the authenticated request away from
  the configured base host.

### 7.3 Preflight tests

Keep existing verdict tests and add assertions that:

- the user agent reaches both calls;
- empty-body and `null`-body successes continue without email/site fields
  rather than becoming `network_error`;
- preflight does not retry a `429` or `500`;
- telemetry receives failure events when injected;
- telemetry contains no token, site query, response, or error values;
- an HTTP failure remains a verdict rather than escaping as an exception;
- a network exception remains a token-redacted `network_error`;
- `enforceRunPreflight()` still blocks exactly two verdict codes.

### 7.4 Call-site regression tests

Run and, where needed, extend:

- `tests/unit/transports.test.js`: env/config tokens still make the local
  transport available.
- `tests/unit/local-runner.test.js`: `buildNetlifyEnv()` still passes the token
  and site ID to Netlify CLI calls.
- `tests/unit/init.test.js`: GitHub secret setup still writes
  `NETLIFY_AUTH_TOKEN` from the same resolver.
- `tests/unit/netlify-preflight.test.js`: dashboard/run-facing verdicts remain
  stable.

---

## 8. Validation commands

Run focused tests during each phase:

```bash
node --import tsx --test \
  tests/unit/netlify-auth.test.js \
  tests/unit/netlify-api-client.test.js \
  tests/unit/netlify-preflight.test.js \
  tests/unit/transports.test.js \
  tests/unit/local-runner.test.js \
  tests/unit/init.test.js
```

Then run repository-wide verification:

```bash
npm run check
npm test
```

This plan adds no new dependencies (D2 implements the config-directory subset
locally), so no Node 18 package-loading verification is required. The
implementation must still avoid syntax or APIs absent from Node 18.

No dashboard build is required because this plan contains no UI change. If UI
scope changes during implementation, `npm run dashboard:build` becomes a
mandatory handoff check under `AGENTS.md`.

---

## 9. Dependency order and work breakdown

| # | Task | Depends on | Why |
|---|---|---|---|
| 1 | Add characterization tests | — | Establishes the no-regression contract |
| 2 | Extract `auth.js` with local config-path helper and OS path tests | 1 | Improves discovery while preserving sync callers |
| 3 | Migrate auth imports with compatibility re-export | 2 | Keeps module consumers stable |
| 4 | Add shared non-throwing response primitive | 1 | Enables reuse without changing preflight semantics |
| 5 | Add user agent | 4 | One header implementation covers all direct calls |
| 6 | Add safe telemetry | 4 | Uses the single retry/failure decision point |
| 7 | Move preflight to `requestResponse()` | 4, 5, 6 | Reuses all request behavior after it is tested |
| 8 | Update internal architecture notes | 2, 7 | Documents the final, not provisional, ownership |
| 9 | Run full validation and diff audit | all | Confirms feature parity and scope control |

Recommended implementation order: `1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9`.

Do not combine the auth extraction and request consolidation into one initial
patch. They are independent risk domains and should be reviewable separately.

---

## 10. Risks and mitigations

### Risk: local config-path helper drifts from `env-paths` semantics

Mitigation: implement exactly the algorithm in the D2 platform table, cite the
`env-paths('netlify', { suffix: '' })` source in a code comment, and cover
every platform branch with injected-input tests. Never rely on the transitive
v3 install or Node 26 interop.

### Risk: tests read the developer's real Netlify token

Mitigation: keep `home`, env, and platform injectable; explicit test inputs
must fully constrain candidate generation; use only temporary directories.

### Risk: preflight verdicts change when moved to the client

Mitigation: expose a non-throwing response primitive and freeze verdicts before
refactoring. Configure preflight for exactly one attempt.

### Risk: retries produce unexpected logs or duplicate user output

Mitigation: telemetry callback defaults to no-op and never writes directly to
stdout/stderr. Each event declares attempt and retrying state.

### Risk: telemetry leaks sensitive values

Mitigation: construct telemetry from allowlisted scalar fields only. Do not
sanitize a larger object after construction. Add sentinel-based negative tests.

### Risk: observer failures break authenticated calls

Mitigation: invoke telemetry through a guarded helper and swallow observer-only
exceptions.

### Risk: user-agent derivation causes package coupling

Mitigation: read only package name/version once at module load, export the
computed constant, and allow explicit injection in tests.

### Risk: adding raw-response access weakens encapsulation

Mitigation: keep the method scoped to the Netlify API client, return a typed
normalized response rather than the mutable native response body, and retain
the throwing convenience method for normal domain calls.

### Risk: absolute URL handling leaks the Bearer token

Mitigation: preserve relative-path joining and add a regression test. Do not
generalize this primitive into an unrestricted authenticated fetch.

---

## 11. Explicit non-goals

- Decrypting MCP OAuth JWE tokens.
- Inferring identity/team information from Bearer tokens.
- Starting `netlify login` automatically.
- Adding `NETLIFY_PERSONAL_ACCESS_TOKEN` precedence.
- Refreshing or rotating tokens.
- Changing preflight warning/block policy.
- Adding API pagination.
- Copying MCP's `Promise<any>`/`as any` typing.
- Logging bodies, query strings, response text, or raw errors.
- Changing Agent Runner endpoints or normalized payload shapes.
- Changing dashboard UI or API routes.
- Converting Nax from CommonJS to ESM.
- Raising the published CLI's Node minimum as part of this work.

---

## 12. Acceptance criteria

Implementation is complete only when all are true:

- [ ] Every parity-matrix row has automated coverage.
- [ ] Existing macOS, XDG, and legacy token paths still work.
- [ ] Windows Netlify CLI config discovery is covered and works.
- [ ] `NETLIFY_AUTH_TOKEN` precedence is unchanged everywhere.
- [ ] Token discovery remains synchronous.
- [ ] Preflight and Agent Runner requests use one authenticated response
      primitive.
- [ ] Preflight verdict codes, messages, and block/warn policy are unchanged.
- [ ] API retry statuses, counts, delays, timeouts, and injected controls are
      unchanged.
- [ ] Existing API error fields and normalization are unchanged.
- [ ] Direct API requests carry the versioned Nax user agent.
- [ ] Failure telemetry is opt-in, typed, value-free, and observer-safe.
- [ ] Authenticated destinations remain constrained to the configured API base.
- [ ] No `any`, broad `object`, TypeScript suppression, or untyped JavaScript is
      introduced.
- [ ] `npm run check` passes.
- [ ] `npm test` passes.
- [ ] No new runtime dependencies are added.
- [ ] The final diff contains no unrelated changes.

---

## 13. Rollout and rollback

This is a local library refactor with additive headers/telemetry and no data
migration.

Git strategy (decided 2026-07-27): commit directly to master, one conventional
commit per green phase — no feature branch. Commit units:

1. Characterization tests and auth extraction.
2. Shared response primitive and user agent.
3. Telemetry and preflight consolidation.
4. Documentation and final validation.

Each commit lands only after its phase's exit criterion passes, so master
stays green throughout.

Rollback is file-level:

- Auth discovery can revert to the compatibility export in `init.js`.
- Preflight can temporarily return to its nested fetch helper while the shared
  primitive remains used by Agent Runner calls.
- Telemetry can be disabled by omitting the callback.
- User-agent addition can be reverted independently.

No persisted artifacts, workflow schemas, site configuration, or user data
require rollback.

---

## 14. Resolved choices and review questions

Resolved:

- Preserve all existing behavior before reducing duplication.
- Keep token discovery synchronous.
- Keep `NETLIFY_AUTH_TOKEN` as the sole environment-token contract.
- Keep authenticated destinations constrained.
- Keep telemetry opt-in and value-free.
- Use a non-throwing response primitive underneath the current throwing API.
- Do not touch UI or canonical user documentation for this internal change.
- Implement the config-directory paths locally instead of adding an
  `env-paths` dependency; the subset is a few lines per platform and avoids
  Node 18/CommonJS loading questions entirely.
- Keep macOS/Linux candidate ordering byte-for-byte identical; only Windows
  gains a new candidate.
- Guard preflight payload access against `null`/non-object bodies, with the
  JSON-literal-`null` success case as the one documented behavior change.

Decisions from David interview (2026-07-27):

- `requestResponse()` is public API on the client object, alongside `request`.
- User agent is name/version only; no platform/Node fingerprint.
- Thrown API errors carry `requestMeta` (`{ method, apiPath, attempts }`);
  the name `request` is avoided because axios/got-style code sniffs it.
- Telemetry is plumbing only: no production consumer wired in this change,
  and no `durationMs` field.
- `netlifyCliConfigCandidates()` is exported; candidate ordering is a
  contract.
- Strict `config.users[config.userId]` lookup is kept; no sole-user fallback
  for malformed configs.
- The `readNetlifyCliToken` re-export from `init.js` is permanent.
- Existing token-discovery tests move from `init.test.js` to
  `netlify-auth.test.js` (move, not copy).
- Implementation commits directly to master, one commit per green phase.
