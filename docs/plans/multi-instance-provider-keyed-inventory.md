# Provider-keyed inventory (Arena re-key tripwires)

Every site that currently keys on the **provider string** and must become **instance-id-keyed**
for `nax-2rx6`. The guard test `tests/unit/multi-instance-inventory.test.js` asserts these
anchors still exist, so a re-key that misses one (or an intentional change) surfaces as a
failing tripwire that must be updated deliberately.

| Anchor | Current (provider-keyed) | Becomes (instance-keyed) | Bead |
|---|---|---|---|
| `src/workflows/followups/plan.js` | `agent === targetAgent` continuation match | `(sourceStepId, instanceId)` match | 2rx6.4.4 |
| `src/workflows/engine/local-executor.js` (`localStepStatus`) | binary `every(completed) ? completed : failed` | `completed` / `completed_with_failures` / `failed` | 2rx6.4.5 |
| `src/workflows/engine/local-executor.js` (submission) | unbounded `Promise.allSettled(runs.map(...))` | wave scheduler bounding non-terminal runners (cap 5) | 2rx6.4.3 |
| `src/cli/main.js` | `materializedAgentConfigurations` before `let transport` | normalize intent → transport → resolve pipeline | 2rx6.2.7 |
| `src/core/agents/configuration.js` | `resolveAgentRunConfig` per provider | per-instance resolution + tuple id + defaults + clamp | 2rx6.2.x |
| `src/workflows/engine/execution-context.js` (`sourceRunsForStep`) | source runs by provider | lineage `(sourceStepId, instanceId)` | 2rx6.4.4 |
| status maps / `agentStatuses` / `selectedAgents` / `stepAgents` | keyed by provider | keyed by instance id | 2rx6.4.2 |
| artifact paths (`<runner>/<provider>.md`) | provider-named | instance-slug (+ provider alias for single-instance) | 2rx6.4.6 |
| dashboard contracts/serializers/projections | provider lists / provider-keyed maps | instance descriptors | 2rx6.6.1 |

Characterization: the current single-per-provider behavior is captured by the existing
suites (`flows.test.js`, `dashboard-graph.test.js`, `followup-plan.test.js`,
`local-runner.test.js`); those goldens change only intentionally as each anchor is re-keyed.
