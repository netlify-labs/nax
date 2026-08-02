# agent-runner-sdk

Typed, resumable access to Netlify Agent Runner.

The package is under active development. Its public handle, result, and HTTP
transport contracts are available; the higher-level execution and landing
engine is being introduced in the next implementation slices.

## Runtime support

- Node.js 18, 20, and 22
- ESM and CommonJS
- Strict TypeScript declarations

## Authentication

Netlify token precedence is:

1. per-operation `token`
2. SDK-constructor `token`
3. `NETLIFY_AUTH_TOKEN`
4. Netlify CLI config discovery

`NETLIFY_AGENT_RUNNER_TOKEN` is intentionally not supported. Authenticated
requests are constrained to the configured Netlify API base and emit only
value-free telemetry when an `onTelemetry` callback is supplied.

## HTTP transport

```ts
import { createHttpTransport } from 'agent-runner-sdk'

const transport = createHttpTransport({ token: process.env.NETLIFY_AUTH_TOKEN })
const runner = await transport.createRunner({
  siteId: 'site-id',
  prompt: 'Update the site',
  requestId: crypto.randomUUID(),
})
```

The default transport uses the verified `/api/v1/agent_runners` API, converts
wire responses into camel-case `Runner` and `Session` objects, paginates
sessions oldest-first, and applies operation-specific retry rules. Create
ambiguity is surfaced with the effective input and request window so callers
can reconcile instead of creating duplicates.

Releases use package-specific Git tags such as `agent-runner-sdk-v0.1.0`, kept
separate from nax CLI release tags.
