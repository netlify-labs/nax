# Plan: `nax try` — offline mock transport

> Exercise the full `nax` flow engine with zero setup: no `gh` auth, no Netlify
> site, no credits, no network. One command, the whole UX, in seconds.

Status: **DRAFT v1** (initial plan, pre-review). Owner: David. Author: Claude.

---

## 1. Goal & intent

Ship a first-class `mock` transport and a `nax try` command that runs any flow —
bundled or custom — end to end against synthesized agent results, instantly and
offline.

Two payoffs from one feature:

1. **Onboarding.** Today the first-run cliff is brutal: `gh auth login` +
   `netlify login` + `nax init` + repo secrets + a linked Netlify site before a
   user sees *anything* happen. `npx @davidwells/netlify-agent-executor try`
   should render the whole experience — fan-out, step gating, artifacts under
   `.nax/`, the visualizer graph going green — in ~10 seconds with none of that.
   That is the difference between a star and a bounce.

2. **Testability.** The engine — steps, fan-out, `waitFor` gating, round-results
   chaining, artifact persistence, resume — lives in the 7,375-line, directly
   *untested* `bin/nax.js`. A mock transport is the deterministic seam that lets
   us assert end-to-end orchestration without burning credits or hitting the
   network. It is also the replay substrate the recorded-transcript harness
   (`nax-mgi`) needs, so this *accelerates* that bead rather than competing.

### What "done" looks like (user's eye view)

```bash
npx @davidwells/netlify-agent-executor try
# 🧪  MOCK MODE — no real agents, no credits, no network.
# pick a flow → watch review → cross-review → synthesize run green
# artifacts written to .nax/  (browse with `nax recent`, open in `nax visualize`)

nax try review            # run a specific bundled flow
nax try ./my-flow         # run a custom flow with synthesized results
nax try review --json     # robot-mode summary for scripts/CI
nax visualize review      # then Run → fully offline graph demo
```

---

## 2. Non-goals (explicit scope fence)

- **Not** a fidelity guarantee for the real transports. `mock` exercises the
  *engine*, prompt assembly, gating, round-results, and artifacts. It does **not**
  prove the Netlify API or GitHub Actions drivers work — those shell out to
  external services we cannot test offline. We say this loudly in docs and code.
- **Not** the full record/replay harness. Recording real CLI traffic is
  `nax-mgi`. This plan defines a fixture format *compatible with* recordings and
  an extension point for replay, but core scope is the transport-level mock +
  synthetic generator. Record path is a defined follow-on, not in core.
- **Not** a real blob upload. In mock mode blob offload to Netlify is stubbed;
  we still exercise the *decision* logic and write the local debug mirrors.
- **Not** a refactor of `bin/nax.js`. We introduce the *smallest* driver seam
  needed (see §4) and leave the monolith split to its own idea.

---

## 3. Current architecture (grounding facts)

| Concern | Where | Notes |
|---|---|---|
| Transport kinds | `src/transports.js:7` | `TRANSPORTS = ['github', 'netlify-api']` + alias map (`:8`) |
| Detection | `src/transports.js:55` `detectTransports` | github = action present; netlify = CLI + linked site |
| Resolution | `src/transports.js:79` `resolveTransport` | maps aliases, validates against `TRANSPORTS` |
| Per-agent submit (netlify) | `bin/nax.js:2141` `runSingleNetlifyAgent` | → `waitForLocalAgentRuns` (`src/local-runner.js:818`) |
| Per-agent submit (github) | `bin/nax.js:2311` `runSingleGithubAgent` | → `waitForGithubStep` (`bin/nax.js:5289`) |
| Step dispatch | `bin/nax.js:6430` / `:6450` | engine picks one of the two per transport |
| Transport branches | `bin/nax.js:4102`, `:6519` | `runState.transport === 'github'` conditionals |
| Run id / clock | `src/run-state.js:12,196` | `createRunId(flowId, now)` — clock already injectable |
| Auto-context | `src/review-context.js:245` `buildAutomaticContext` | pins SHA, builds PR ledger — **shells to git + gh** |
| Round-results chaining | `src/round-results.js:101` `fetchRoundResults` | pulls prior step output forward |
| Result normalization | `src/agent-run-results.js:497` `normalizeAgentRunResult` | the shape a mock must produce |
| Visualizer re-entry | `src/workflow-runner.js:24` | runs engine in-process with `--transport <kind>` |
| Blob offload | `src/prompt-offload.js`, `src/netlify-blobs.js` | shells `netlify blobs:set/get` |

The engine is fused into `bin/nax.js`, but the transport choice already funnels
through two clear functions per phase (submit, wait). That is our seam.

---

## 4. Design

### 4.1 Add `mock` as a real transport

`src/transports.js`:

```diff
-const TRANSPORTS = ['github', NETLIFY_API_TRANSPORT]
+const MOCK_TRANSPORT = 'mock'
+const TRANSPORTS = ['github', NETLIFY_API_TRANSPORT, MOCK_TRANSPORT]
 const TRANSPORT_ALIASES = {
   github: 'github',
   'github-actions': 'github',
   actions: 'github',
   [NETLIFY_API_TRANSPORT]: NETLIFY_API_TRANSPORT,
   local: NETLIFY_API_TRANSPORT,
   'local-machine': NETLIFY_API_TRANSPORT,
   machine: NETLIFY_API_TRANSPORT,
+  [MOCK_TRANSPORT]: MOCK_TRANSPORT,
+  try: MOCK_TRANSPORT,
+  offline: MOCK_TRANSPORT,
+  demo: MOCK_TRANSPORT,
 }
```

In `detectTransports`, `mock` is **always available** (no prereqs) but is **never
auto-selected** — `--transport auto` must keep preferring github → netlify-api.
Mock is opt-in only (`nax try`, or explicit `--transport mock`). This keeps real
runs unaffected.

### 4.2 Standard transport interface (DECIDED: D1)

**Decision:** transports conform to a single, standard interface. Today the engine
hard-branches between the two drivers at ~4 sites (`:4102`, `:6430`, `:6450`,
`:6519`). We **derive** a `Transport` contract from what the engine actually calls
today — do not invent methods (YAGNI) — and have all three drivers implement it.

```js
// src/transports/types.js — the contract every transport satisfies.
/**
 * @typedef {Object} Transport
 * @property {string} kind                          // 'github' | 'netlify-api' | 'mock'
 * @property {() => TransportAvailability} detect    // prereqs / availability + reason
 * @property {(args: SubmitArgs) => Promise<AgentRun>} submitAgent
 *           // one agent, one step; honors submit:new-run | follow-up
 * @property {(args: WaitArgs) => Promise<AgentRun[]>} waitForStep
 *           // block until every fanned-out agent for the step is terminal
 */
```

Derivation map (current → interface):

| Interface method | github today | netlify-api today |
|---|---|---|
| `detect` | `detectTransports` github branch | `detectTransports` netlify branch |
| `submitAgent` | `runSingleGithubAgent` (`:2311`) | `runSingleNetlifyAgent` (`:2141`) |
| `waitForStep` | `waitForGithubStep` (`:5289`) | `waitForLocalAgentRuns` (`local-runner.js:818`) |

```js
// src/transports/index.js
function getTransport(kind) { /* returns the Transport impl for kind */ }
```

Engine call sites become `const t = getTransport(runState.transport)` then
`t.submitAgent(...)` / `t.waitForStep(...)`, replacing every `=== 'github'`
branch. The interface stays **lean** in v1 (detect + submit + wait); it can grow
(cleanup, capabilities, resultFetch) when a real need appears.

**Sequencing (de-risk the refactor):** the real github/netlify drivers are the
untested high-risk surface. Order: (1) define the interface from current
behavior, (2) ship the **mock** driver + its engine tests to lock orchestration
semantics, (3) refactor github/netlify to implement the interface *under* those
tests, keeping existing transport unit tests green. Mock is the safety net for
its own prerequisite refactor.

### 4.3 The mock driver

`src/mock-transport.js`:

- `runSingleMockAgent({ flowId, stepId, agent, promptText, options })` →
  resolves a fixture (see §4.4), returns a `normalizeAgentRunResult`-shaped
  object: `{ agent, status, resultText, usage, links, runnerId, sessionId, ... }`.
  Synthetic ids are deterministic (`mock-<flow>-<step>-<agent>`).
- `waitForMockStep(...)` → resolves immediately by default; honors a per-fixture
  `delayMs` and `status` so tests can drive slow / failed / timeout paths.
- Emits the same structured lifecycle events (`runner-events.js`) so the
  visualizer graph transitions submitted → running → completed exactly like real
  runs.

### 4.4 Fixture resolution: synthetic-by-default, override-by-file

Resolution order for `(flowId, stepId, agent)`:

1. **Explicit fixture file** if present:
   `tests/fixtures/mock/<flowId>/<stepId>/<agent>.json` (or a dir set via
   `NAX_MOCK_FIXTURES`). Ships realistic recorded results for bundled `review`.
2. **Synthetic generator** otherwise: deterministic, seeded by
   `hash(flowId, stepId, agent, seed)`. Produces a plausible structured result
   (a few fake `file:line` findings, a short summary, fake usage) so **any** flow
   — including a user's brand-new custom flow — runs with zero authored fixtures.

This is the key to the onboarding promise: `nax try ./whatever-flow` always works.

Fixture schema (also the recording target for `nax-mgi`):

```json
{
  "schemaVersion": 1,
  "agent": "claude",
  "status": "completed",        // completed | failed | timeout
  "delayMs": 0,                  // simulate latency / gating
  "resultText": "## Findings\n- src/auth.ts:42 ...",
  "usage": { "credits": 0, "inputTokens": 0, "outputTokens": 0, "costUsd": 0 },
  "links": [],
  "meta": { "source": "synthetic" | "recorded" }
}
```

### 4.5 Auto-context in mock mode

`buildAutomaticContext` shells to git + gh, which breaks the zero-setup promise
(must work in a fresh `npx` dir, possibly not even a git repo). In mock mode:

- Supply a **deterministic synthetic context** (fake pinned SHA, empty/fake PR
  ledger) so the prompt-assembly path is still exercised — we *want* to test it —
  but nothing shells out.
- `--no-auto-context` still works.
- Never crash when not in a git repo.

### 4.6 Blob offload in mock mode

Stub `netlify blobs:set/get` (no network). Still run the offload *decision*
(`buildAndMaybeFallbackPlan`) so the size-budget logic is exercised, and still
write the local debug mirrors under `.nax/workflows/<id>/blobs/`. Mark blob refs
`mode: mock` so `nax clean blobs` skips remote deletes for them.

### 4.7 Determinism for tests

For stable artifact snapshots, gate non-determinism behind an env/flag used by
tests (and optionally by `nax try` for reproducible demos):

- `NAX_FIXED_NOW` → fixed clock threaded into `createRunState({ now })`
  (`run-state.js:196` already accepts `now`; thread it at the call site).
- Stable run-id, dates (`--date` exists), and **deterministic synthetic
  fixtures**. Symlink creation stays filesystem-dependent; snapshot tests assert
  on `workflow.json` + artifact contents, not on symlink inodes.

### 4.8 `nax try` command (UX sugar)

`nax try [flow]` = `nax run [flow] --transport mock --force` plus:

- Loud banner: `🧪 MOCK MODE — no real agents, no credits, no network`.
- Default flow `review` (or interactive picker if a TTY and no flow given).
- Tags the run `mode: "mock"` in `workflow.json`.
- Works outside a git repo and in an empty `npx` directory.
- Prints where artifacts landed + the next commands (`nax recent`,
  `nax visualize <flow>`, `nax handoff`).

### 4.9 Artifacts: sandboxed under `.nax/try/` (DECIDED: D2)

**Decision:** mock runs write to a sandbox root `.nax/try/` — never the real
`.nax/`. Zero pollution of real `latest` symlinks, handoff, or resume by
construction. Mock runs are still tagged `mode:mock` in `workflow.json` for
defense in depth.

```text
.nax/try/workflows/<run-id>/workflow.json      # mode: "mock"
.nax/try/workflows/<run-id>/artifacts/summary.md
.nax/try/workflows/latest -> <run-id>          # sandbox-local latest
.nax/try/agent-runners/... / agent-sessions/...
```

Cost: `recent`, `visualize`, and `handoff` must learn a **second search root**.
Approach — introduce a `naxRoots()` resolver returning `[.nax]` normally and
`[.nax, .nax/try]` when mock browsing is in scope:

- `nax recent` — include `.nax/try` only with `--mock`/`--include-mock`; tag
  mock entries with 🧪 so they're never confused with real runs.
- `nax visualize` — resolve a run id across both roots; mock runs render with a
  🧪 badge.
- `nax handoff` — does **not** include `.nax/try` by default (handing off fake
  results is almost never intended); `--from-try` opts in explicitly.
- `nax try` prints the exact sandbox path + the `nax visualize <flow>` /
  `nax recent --mock` follow-ups.

`gitignore`: `.nax/try/` should be ignored (mock output is ephemeral demo data).

---

## 5. User workflows enabled

1. **Evaluator** runs `npx ... try`, sees fan-out + gating + a green graph in
   the visualizer, decides nax is worth wiring up — *then* does `nax init`.
2. **Flow author** iterates on a custom `flow.yml` with `nax try ./my-flow`,
   confirming step order, `input` chaining, and prompt assembly with no credits.
3. **Contributor / CI** asserts engine behavior deterministically:
   `nax try review --json` in CI guards against orchestration regressions.
4. **Failure-mode drill**: a fixture with `status: failed`/`timeout` reproduces
   partial-failure and resume paths offline.

---

## 6. Testing strategy (TDD)

Write failing tests first; `node --import tsx --test` per repo convention.

**Unit**
- `mock-transport.test.js`: synthetic generator is deterministic for a fixed
  seed; fixture-file override beats synthetic; result matches
  `normalizeAgentRunResult` shape; `status`/`delayMs` honored.
- `transports.test.js` additions: `mock` resolves, aliases (`try`/`offline`)
  map, `auto` never selects mock, mock always "available".

**Integration** (the high-value, previously-missing engine coverage)
- `try-review.test.js`: `nax try review` runs all three steps; asserts step
  gating order, that cross-review sees round-1 output (`round-results` chaining),
  and that `.nax/workflows/<id>/workflow.json` + `artifacts/summary.md` exist
  with expected structure. No network (assert no `gh`/`netlify` spawn).
- `try-custom-flow.test.js`: a fixture-less custom flow runs purely on synthetic
  results.
- `try-failure-paths.test.js`: `status: failed` → failure surfaced, downstream
  still runs on survivors; `status: timeout` → timeout path; resume from an
  interrupted mock run continues from first incomplete step.
- Determinism: `NAX_FIXED_NOW` → stable `workflow.json` snapshot.

**Visualizer**
- Extend `visualize:smoke` (Playwright): launch a mock run, assert graph reaches
  all-green and an artifact opens — a fully offline e2e of the visualizer.

**Robot mode**
- `nax try --json` emits one stable JSON doc on stdout, decorative output to
  stderr (consistent with `nax-pja` `--json` contract).

All test output must be pristine; intentional failure/timeout fixtures capture
and assert their error output.

---

## 7. Task breakdown & dependencies

```
T0  Spike: derive Transport interface from current dispatch; thread `now` into createRunState   (no dep)
T1  transports: add `mock` kind, aliases (try/offline/demo), detection (always avail / never auto)  (dep T0)
T2  Define Transport interface (types) + getTransport(kind) registry                  (dep T0)   [D1]
T3  mock-transport.js: mock Transport impl (submitAgent/waitForStep) + lifecycle events  (dep T1,T2)
T4  fixtures: synthetic generator (deterministic) + file resolver + schema             (dep T3)
T5  mock auto-context (synthetic, non-git safe) + blob stub                            (dep T3)
T6  `nax try` command + 🧪 MOCK banner + mode:mock tag + non-git safety                 (dep T3,T4,T5)
T7  sandbox artifacts under .nax/try/ + naxRoots() resolver + .gitignore               (dep T6)   [D2]
T8  determinism hooks (NAX_FIXED_NOW threading)                                        (dep T3)
T9  recorded `review` fixture (realistic demo)                                         (dep T4)
T10 --json robot mode for `nax try`                                                    (dep T6)
T11 second search root in recent/visualize/handoff (🧪 badge, opt-in flags)            (dep T7)
T12 Refactor github + netlify-api to implement Transport interface (under mock tests)  (dep T2,T3,T13) [seq]
T13 Tests: mock unit + engine integration + failure-path + determinism (TDD, FIRST)    (dep T3-T8)
T14 visualizer offline mock run + smoke test                                           (dep T3,T6,T11)
T15 Docs: README (`nax try`, mock transport, fidelity caveat) + roadmap update         (dep T6)
T16 Extension-point note: fixture == recording format for nax-mgi                      (dep T4)
```

Critical path: T0 → T1/T2 → T3 → T4 → T6 → T7 → T11. **Sequencing rule:** T13
(mock engine tests) lands *before* T12 (real-driver refactor), so the high-risk
github/netlify rewrite happens under a green safety net. T13 is written first per
TDD and goes green as T3–T8 land.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Fidelity drift** — mock green, real broken | Loud docs/code caveat; generate `review` fixtures from real recordings (T9 ← nax-mgi); CI note that mock tests engine, not transports |
| **Mock mistaken for real** | `🧪 MOCK MODE` banner, `mode:mock` in `workflow.json`, artifacts labeled, handoff/resume guard (T7) |
| **`latest`/handoff pollution** | Mock runs excluded from real `latest`; handoff refuses/warns on `mode:mock` (D2) |
| **Fixture maintenance burden** | Synthetic-default means near-zero authored fixtures; recordings optional |
| **Scope creep into nax-mgi** | Fixture format == recording format, but core ships synthetic-only; record path is T14 note + separate bead |
| **Driver extraction regresses real transports** | T2 is behavior-preserving; existing transport tests must stay green; spike (T0) first |
| **Non-git / empty-dir crashes** | Explicit non-git safety in auto-context (T5) + a test in an empty tmpdir |

---

## 9. Relationship to existing beads

- **`nax-mgi` (recorded-transcript harness):** this delivers the replay engine
  and fixture schema it needs. Recordings become mock fixtures. Sequence: ship
  mock core first, then nax-mgi records into this format.
- **`nax-pja` (`--json` / doctor):** `nax try --json` follows the same robot
  contract; reuse it.
- **Everything downstream** (consensus engine, `nax review --fix`, control-flow
  beads): all gain a deterministic, credit-free engine test seam.

---

## 10. Decisions (RESOLVED 2026-06-20)

- **D1 — Driver seam.** ✅ **Standard `Transport` interface** all three drivers
  implement (not a thin selector, not inline branches). Derived from current
  behavior; real drivers refactored under mock's test net. See §4.2.
- **D2 — Artifact location.** ✅ **Sandboxed `.nax/try/`** by default; `recent`/
  `visualize`/`handoff` gain a second, opt-in search root. See §4.9.
- **D3 — v1 scope.** ✅ **Synthetic generator + one recorded `review` fixture.**
  Ships independent of `nax-mgi`.
- **D4 — Command surface.** ✅ **`nax try` sugar + raw `--transport mock`.**

---

## 11. Open questions

- Should `nax try` be omitted from the *real* interactive flow picker, or shown
  with a 🧪 marker as a "try it" entry?
- Do we want a `nax try --record` later that promotes a real run's results into
  fixtures, or keep recording entirely inside `nax-mgi`?
- Synthetic findings: purely lorem-ish, or lightly seeded from the actual repo
  (e.g. real file paths) to make the demo more convincing? (Leaning lorem to
  avoid any impression of a real audit.)
```
