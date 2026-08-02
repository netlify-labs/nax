# agent-runner-sdk

Typed, resumable access to Netlify Agent Runner.

The package is under active development. Its public handle, result, transport,
and landing APIs will be introduced in the next implementation slices.

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

Releases use package-specific Git tags such as `agent-runner-sdk-v0.1.0`, kept
separate from nax CLI release tags.
