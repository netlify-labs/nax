# Multi-instance live canary flows

These flows are intentionally harmless, bounded fixtures for
`scripts/run-multi-instance-canary.mjs`. They exercise NAX's real Netlify API
executor against a dedicated disposable site. They are not unit-test mocks.

The runner requires both an explicit site ID and the
`ALLOW_MULTI_INSTANCE_CANARY=1` mutation gate. It clones the configured canary
repository into a temporary directory, runs every fixture, asserts the durable
workflow state and event log, archives every created Agent Runner, and removes
the temporary clone.

The two unsupported model IDs are deliberate. NAX passes unknown future model
names through with a warning so the backend remains the authority; the backend
must reject these impossible canary IDs. That gives the partial- and all-failed
flows a real remote failure without asking an agent to edit or damage anything.
