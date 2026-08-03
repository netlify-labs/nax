# nax Agent Runner SDK cutover audit

Date: 2026-08-02

This audit records the Phase 1 nax migration from direct Netlify CLI and
provisional HTTP lifecycle calls to the built `nax-agent-runner-sdk` package.
Historical design documents and test strings are not runtime call sites.

## Runtime call-site mapping

| Former responsibility | SDK-backed replacement |
| --- | --- |
| CLI `agents:create` and follow-up session creation | `submitLocalAgentRun` calls `sdk.start` or `sdk.followUp` through `src/integrations/netlify/agent-runner-sdk.js`. |
| CLI `agents:show` polling | `waitForLocalAgentRuns` uses `sdk.getSnapshot` with the persisted handle's exact `currentSessionId`. |
| CLI session listing | `listAgentSessions` uses `sdk.transport.listSessions`. |
| CLI runner cancel and archive | `stopAgentRun` uses `sdk.stop` or `transport.cancelRunner`; `archiveAgentRun` uses the typed `archive` member action. |
| Local retry loop | SDK failure classification, `shouldRetry`, handle retry budgets, and `followUp`; nax retains presentation and compact-prompt policy only. |
| Netlify token discovery and access preflight | SDK auth resolution and `preflightNetlifyAccess`; only `NETLIFY_AUTH_TOKEN` is accepted. |
| Hosted dashboard provisional kebab endpoints | `src/integrations/netlify/api-client.js` delegates runner lifecycle methods to the SDK snake-v1 transport. |
| Dashboard follow-up and remote synchronization | Submission persists the full versioned handle; polling and sync use SDK transport results and exact session identity. |
| Workflow and standalone artifacts | `sdkHandle` is stored in workflow state, per-agent JSON, session artifacts, and runner rollups. Pre-SDK artifacts are upgraded at the adapter boundary by resolving their recorded session from the remote session list. |

The hosted dashboard transport retains its existing browser-facing method names
(`createAgentRunner`, `getAgentRunner`, and `cancelAgentRunner`) as a compatibility
facade. Those methods do not issue lifecycle HTTP requests themselves. The
generic authenticated request helper remains for non-runner Netlify user/site
API calls.

## Search results

The runtime audit excludes `packages/agent-runner-sdk/**`, generated dashboard
assets, `.beads`, historical plans, and tests:

```bash
rg -n \
  -g '!packages/agent-runner-sdk/**' \
  -g '!src/dashboard/web/dist/**' \
  '(/agent_runners|/agent-runners|agents:(create|show|sessions|cancel|archive)|NETLIFY_AGENT_RUNNER_TOKEN)' \
  src
```

Expected result:

- no runner endpoint or runner-lifecycle CLI invocation;
- no `NETLIFY_AGENT_RUNNER_TOKEN` alias;
- `.nax/agent-runners` artifact-directory strings only.

Named lifecycle searches resolve only to SDK-backed compatibility facades,
presentation helpers, and injected test seams:

```bash
rg -n \
  '(createAgentRunner|createAgentSession|getAgentRunner|listAgentSessions|cancelAgentRunner|archiveAgentRunner)' \
  src
```

## Compatibility and verification

- Existing workflow YAML, dashboard routes, progress output, cancellation
  behavior, and `.nax` directory layout are unchanged.
- New state carries the full versioned handle and its original absolute
  deadline. Follow-ups retain current-session identity across serialization.
- Old runner/session artifacts remain readable. The compatibility adapter
  reconstructs a minimum handle from the exact stored session rather than
  adopting a runner-wide latest session.
- nax prompt preparation remains outside the SDK and reserves
  `requestMarkerOverheadBytes` before compacting or offloading.
- Application source consumes the package's built CommonJS export. Import
  direction checks reject SDK source-internal imports.

Verification for the cutover:

```bash
npm run check
npm test
npm run sdk:ci
npm run dashboard:build
```
