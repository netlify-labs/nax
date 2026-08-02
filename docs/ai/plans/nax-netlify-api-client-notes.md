# Netlify API Client Notes

## Purpose

The hosted dashboard runtime cannot shell out to the Netlify CLI.
`src/integrations/netlify/api-client.js` preserves nax's compatibility surface,
while authentication and authenticated request mechanics live in
`packages/agent-runner-sdk/src/auth/`.

## Dashboard Runtime Usage

`src/dashboard/runtime/netlify-function.js` wires `createNetlifyApiClient()` compatible objects into `createHostedNetlifyApiTransport()`. With a client and site ID configured, hosted mode can start runs, cancel runs, poll run status, read `events.json`, build hosted run details/graphs from runner payloads, submit fresh-runner follow-ups, and cancel those follow-ups.

Hosted mode does not expose local filesystem behavior. `/api/files/open`, dry-run, review-gate resume/cancel, and SSE streaming remain unsupported unless a future hosted implementation supplies those capabilities. Hosted artifact details should use remote-safe fields such as `id`, `url`, `blobKey`, and `store`; local absolute paths must not be returned.

## Provisional Endpoints

- `POST /sites/:siteId/agent-runners` creates a fresh Agent Runner.
- `POST /agent-runners/:runnerId/sessions` creates a follow-up session.
- `GET /agent-runners/:runnerId` reads runner status.
- `GET /agent-runners/:runnerId/sessions` lists sessions.
- `POST /agent-runners/:runnerId/cancel` requests cancellation.
- `POST /agent-runners/:runnerId/archive` archives completed work.

These paths are deliberately isolated in the client so the hosted dashboard transport can adjust endpoint names without changing Hono route code.

## Auth And Targets

Token precedence is per-request `token`, SDK-constructor `token`,
`env.NETLIFY_AUTH_TOKEN`, then Netlify CLI config discovery.
`NETLIFY_AGENT_RUNNER_TOKEN` is not an alias. Site ID precedence remains
explicit option `siteId`, then `env.NETLIFY_SITE_ID`. Missing auth maps to
`runner_auth_failed`; missing site/runner IDs map to
`runner_validation_failed`.

Every direct request carries `agent-runner-sdk/<version>` as its user agent.
CLI token discovery is owned by the SDK and re-exported through
`src/integrations/netlify/auth.js`; the permanent `init.js` compatibility
export remains available.

## Response modes and telemetry

`requestResponse()` is the non-throwing authenticated primitive. It returns
normalized status, text/payload, method, pathname, and attempt metadata for
both successful and non-2xx responses. `request()` wraps it and preserves
nax's legacy thrown error codes, payload, and value-free `requestMeta`.

SDK `onTelemetry` events are constructed from an allowlist: operation,
method, pathname, status, attempt/retry state, safe duration, and network
error name. Query strings, headers, tokens, prompts, request/response bodies,
status text, raw error messages, causes, and stacks are forbidden. Observer
exceptions are swallowed. The nax adapter also exposes the older
`onRequestFailure` event names for compatibility.

Authenticated destinations remain constrained to the configured Netlify API
base; absolute-looking input is treated as a relative path and never receives
credentials at another origin.

The required token scope is still an open Netlify product/API question. Hosted transport work should verify the minimum scope for creating, reading, cancelling, and archiving Agent Runners.

## Error Mapping

- `401` -> `runner_auth_failed`
- `403` -> `runner_permission_denied`
- `404` -> `runner_not_found`
- `400` / `422` -> `runner_validation_failed`
- `429` -> `runner_rate_limited`
- `5xx` and unknown failures -> `runner_transport_error`

Error messages redact the configured token before throwing.

## Retry Policy

The client retries only retryable HTTP statuses: `408`, `409`, `425`, `429`, and `5xx`. Retry count and sleep are injectable so hosted functions can keep strict timeout budgets.
