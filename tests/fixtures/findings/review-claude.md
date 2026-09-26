## 1. Repository State

- `pinned_sha`: `0a9a6b1ae0da161bbacabcdfa06d38069c20fdf0`
- `checked_out_sha`: `0a9a6b1ae0da161bbacabcdfa06d38069c20fdf0`
- `state_match`: yes
- `drift_commits`: 0
- `drift_acceptable`: yes
- `git_status_clean`: yes

Review-only run. No files were edited, staged, or committed.

## 2. Structured Findings

```json
[
  {
    "id": "R1",
    "category": "defect",
    "severity": "high",
    "status": "confirmed",
    "file": "src/cli/main.js",
    "line": 565,
    "claim": "The repo's own `npm run check` gate is red: tsc reports TS2345 in production code because `options.projectRoot` (typed `unknown`) is passed to `resolveProjectRoot(optionRoot: string)`.",
    "evidence": "`npm run check` runs typecheck last and fails. handleCosts was added in e5b439d with a correct `@param {JsonMap}` annotation, so `options.projectRoot` is `unknown`; `resolveProjectRoot` (src/integrations/netlify/project-selection.js:143) infers `string` from `path.resolve(optionRoot)`. Sibling handlers at main.js:552 and :581 do the same thing but carry no JSDoc, so they infer `any` and stay silent.",
    "suggested_fix": "Narrow at the boundary: `const rootOption = typeof options.projectRoot === 'string' ? options.projectRoot : undefined`, then pass that. Do not drop the JSDoc annotation to silence it.",
    "confidence": "high"
  },
  {
    "id": "R2",
    "category": "defect",
    "severity": "high",
    "status": "confirmed",
    "file": "tests/unit/cli-command-surface.test.js",
    "line": 38,
    "claim": "The CLI command-surface test no longer type-checks and does not cover `nax costs`, because the fake handler map was not updated when `costs` was added to the `NaxCommandHandlers` typedef.",
    "evidence": "tsc: TS2741 `Property 'costs' is missing in type '{ clean: ...; }' but required in type 'NaxCommandHandlers'`. src/cli/commands/nax.js:44 added `costs` to the typedef and :528 registered the command; the test's handlers object was not extended, so no test asserts that `nax costs` dispatches to its handler.",
    "suggested_fix": "Add `costs: (options) => record('costs', options)` to the handler map and an assertion that `costs --limit 5 --json` reaches the handler with parsed options.",
    "confidence": "high"
  },
  {
    "id": "R3",
    "category": "defect",
    "severity": "high",
    "status": "confirmed",
    "file": ".github/workflows/run-nax.yml",
    "line": 1,
    "claim": "No CI workflow runs `npm test` or `npm run check`, so a 731-test suite and three quality gates are never enforced on push or PR.",
    "evidence": "All four workflows (`run-nax.yml`, `run-local-nax.yml`, `netlify-agents.yml`, `blob-roundtrip-probe.yml`) invoke nax itself; `grep 'npm run check\\|npm test' .github/workflows/*.yml` returns nothing. This is the direct reason R1 and R2 reached master.",
    "suggested_fix": "Add a `ci.yml` running `npm ci && npm run check && npm test` on `pull_request` and pushes to master.",
    "confidence": "high"
  },
  {
    "id": "R4",
    "category": "defect",
    "severity": "medium",
    "status": "confirmed",
    "file": "src/dashboard/web/src/run-format.ts",
    "line": 71,
    "claim": "Dashboard credit rendering interpolates the raw float while the CLI rounds to two decimals, so the same run can display different credit values in the two surfaces.",
    "evidence": "run-format.ts:71 returns `${credits} cr` and :78 `${totals.totalCreditsCost} credits` with no rounding. The CLI path formats the identical `totalCreditsCost` field through `formatCredits` (src/workflows/results/agent-run-results.js:262), which does `value.toFixed(2)` before trimming zeros. A value like 7.523456 renders `7.523456 cr` in the dashboard and `7.52 credits` in `nax costs`.",
    "suggested_fix": "Apply the same two-decimal trim in `usageBadgeText`/`usageSummaryLabel`, or expose a single formatter both surfaces import.",
    "confidence": "high"
  },
  {
    "id": "R5",
    "category": "defect",
    "severity": "medium",
    "status": "confirmed",
    "file": "src/cli/display/costs-report.js",
    "line": 65,
    "claim": "`nax costs` silently truncates to the 20 most recent runs and labels the partial sum as a plain total, so the number reads as all-time spend.",
    "evidence": "`buildCostsReport` computes `totalCount: runStates.length` (costs-report.js:52) and exposes it in the typedef (:21) and in `--json`, but `formatCostsTable` never prints it — the last line is only `Total (${report.shownCount} runs)`. `shownCount` also counts runs that reported no usage, so `Total (20 runs)` can describe a sum drawn from 3. The dashboard already does this correctly (`Showing X of Y saved runs`, src/dashboard/web/src/components/RecentRuns.tsx:167).",
    "suggested_fix": "Print `Showing N of M saved runs (--limit to widen)` when `totalCount > shownCount`, and label the total with the count of runs that actually reported usage.",
    "confidence": "high"
  },
  {
    "id": "R6",
    "category": "defect",
    "severity": "low",
    "status": "likely",
    "file": "src/integrations/netlify/dashboard-context.js",
    "line": 52,
    "claim": "`automaticTargetReason` OR-matches candidates, so the user-facing \"Selection reason\" can name a config that is not the resolved target.",
    "evidence": "The `candidates.find` predicate matches on siteId OR configSource OR filter. When the resolved siteId matches no candidate but some other candidate shares the filter, `candidate` becomes that unrelated entry and the returned string asserts `Auto-selected ${candidate.source} because it is the only detected Netlify project`. This string exists specifically to build trust about which site receives remote work (commit 0a9a6b1). Only the filter branch is asserted in tests (tests/unit/dashboard-netlify-context.test.js:86).",
    "suggested_fix": "Match on siteId first and fall back to configSource/filter only when siteId is absent; add a case where siteId and filter point at different candidates.",
    "confidence": "medium"
  },
  {
    "id": "R7",
    "category": "defect",
    "severity": "low",
    "status": "confirmed",
    "file": "site/content/reference/configuration.mdx",
    "line": 62,
    "claim": "`NAX_STALLED_AFTER_MINUTES` is a shipped user-facing knob that is absent from the canonical env-var reference.",
    "evidence": "src/dashboard/shared/run-liveness.js:14 reads it (default 10, `0` disables stalled detection). The \"State and debugging\" table documents peers like `NAX_INCLUDE_COST` and `NAX_STATE_LOCK_TIMEOUT_MS`; grep for `stalled` across site/content returns no hits, and AGENTS.md names site/content the canonical docs source.",
    "suggested_fix": "Add a row for `NAX_STALLED_AFTER_MINUTES` and mention the Stalled badge in guides/use-the-dashboard.mdx.",
    "confidence": "high"
  },
  {
    "id": "R8",
    "category": "defect",
    "severity": "low",
    "status": "confirmed",
    "file": "tests/unit/netlify-api-client.test.js",
    "line": 75,
    "claim": "A test asserts a missing-token rejection but does not isolate the environment, so it fails on any machine or CI runner where `NETLIFY_AUTH_TOKEN` is set.",
    "evidence": "The test constructs the client with `token: ''`; src/integrations/netlify/api-client.js:141 resolves `token || env.NETLIFY_AUTH_TOKEN || ''` with `env` defaulting to `process.env`. With that var exported the client authenticates and the assertion fails with `Missing expected rejection` — reproduced in this environment.",
    "suggested_fix": "Pass `env: {}` to `createNetlifyApiClient` in this test (and in the sibling `siteId` case, which reads `NETLIFY_SITE_ID` the same way).",
    "confidence": "high"
  },
  {
    "id": "R9",
    "category": "defect",
    "severity": "low",
    "status": "confirmed",
    "file": "site/README.md",
    "line": 20,
    "claim": "The docs-site README tells readers to deploy to Vercel and to consult a generator skill, but the site is a Netlify deploy.",
    "evidence": "site/README.md:20 reads \"This site can deploy to Vercel (recommended)\" and :21 defers to the `documentation-website-for-software-project` skill. netlify.toml pins `base = \"site\"`, `publish = \".next\"`, and `@netlify/plugin-nextjs`. Nothing documents the `postbuild` pagefind index step that search depends on.",
    "suggested_fix": "Replace the deploy section with the actual Netlify config and note that `postbuild` builds the Pagefind index into `public/_pagefind`.",
    "confidence": "high"
  },
  {
    "id": "R10",
    "category": "polish",
    "severity": "low",
    "status": "confirmed",
    "file": "package.json",
    "line": 22,
    "claim": "`check:cli-help` is a passing quality gate that nothing invokes.",
    "evidence": "The script is defined but is absent from the `check` chain (which runs import-direction, jsdoc-types, typecheck), from `test`, and from every workflow file — grep finds exactly one reference, the definition itself. Run manually it reports `checked 5 help targets`.",
    "suggested_fix": "Chain it into `npm run check` alongside the other gates.",
    "confidence": "high"
  },
  {
    "id": "R11",
    "category": "polish",
    "severity": "low",
    "status": "confirmed",
    "file": "src/dashboard/shared/run-liveness.js",
    "line": 31,
    "claim": "The event-log filename is hardcoded here instead of reusing the existing path helper, duplicating a storage-layout detail.",
    "evidence": "`path.join(String(runState.dir), 'events.jsonl')` re-derives what `eventLogPathForRunDir` (src/workflows/events/runner-event-log.js:32) already exports. The dashboard layer already imports from `workflows/` elsewhere (src/dashboard/storage/local-runs.js:9), so the boundary checker permits it.",
    "suggested_fix": "Import `eventLogPathForRunDir` and call it.",
    "confidence": "high"
  },
  {
    "id": "R12",
    "category": "polish",
    "severity": "low",
    "status": "confirmed",
    "file": "src/integrations/netlify/dashboard-context.js",
    "line": 126,
    "claim": "Dashboard startup now issues one Netlify access check per linked site before printing the URL, so startup latency grows with the number of `.netlify/state.json` links.",
    "evidence": "`Promise.all` over every discovered siteId, each a `checkNetlifyAccess` call with a 3s timeout. Commit 0a9a6b1 replaced a single `checkNetlifyAccess` with this fan-out, and the results are awaited before `startServer`. In a monorepo with several links, a slow or offline network makes the user wait on all of them.",
    "suggested_fix": "Verify the resolved target synchronously and resolve the other links lazily (on opening the Agent runs menu), or bound the fan-out with one overall deadline.",
    "confidence": "medium"
  },
  {
    "id": "R13",
    "category": "polish",
    "severity": "low",
    "status": "confirmed",
    "file": "src/cli/main.js",
    "line": 566,
    "claim": "`nax costs --limit garbage` silently falls back to 20 rather than telling the user the flag was ignored.",
    "evidence": "`Number.parseInt(String(options.limit || ''), 10)` then `Number.isFinite(limit) && limit > 0 ? limit : 20`. No warning path; `buildCostsReport` additionally clamps with `Math.max(1, limit)`, so two layers quietly normalize bad input.",
    "suggested_fix": "Reject non-numeric or non-positive `--limit` with a one-line actionable error.",
    "confidence": "high"
  },
  {
    "id": "R14",
    "category": "polish",
    "severity": "low",
    "status": "likely",
    "file": "site/next.config.ts",
    "line": 41,
    "claim": "A 26-line `experimental.turbo` → `turbopack` migration shim is dead weight on Next 16 / Nextra 4.",
    "evidence": "The block only executes if `'turbo' in config.experimental`. The installed stack is next 16.2.9 with nextra 4.0.0, where the key is `turbopack`; nothing in the tree sets `experimental.turbo`. Site typecheck (`npx tsc --noEmit`) passes with or without it.",
    "suggested_fix": "Delete the block, or add a comment naming the Nextra version whose output required it.",
    "confidence": "medium"
  },
  {
    "id": "R15",
    "category": "polish",
    "severity": "low",
    "status": "confirmed",
    "file": "site/content/reference/commands.mdx",
    "line": 69,
    "claim": "The `nax costs` reference omits `--project-root` and does not state the default 20-run window.",
    "evidence": "The command registers `--project-root <path>`, `--limit <count>` (default 20), and `--json` (src/cli/commands/nax.js:528-532); the docs show only `--limit` and `--json` and describe the output as \"recent workflow runs\" without naming the cap.",
    "suggested_fix": "Document `--project-root` and the default limit; pairs with R5.",
    "confidence": "high"
  },
  {
    "id": "R16",
    "category": "polish",
    "severity": "low",
    "status": "confirmed",
    "file": "src/cli/main.js",
    "line": 552,
    "claim": "`handleList` and `handleDashboard` carry no JSDoc `@param`, violating the AGENTS.md typing rule and masking the same unsafe `unknown` pass-through that R1 surfaces.",
    "evidence": "main.js:552 and :581 declare `options = {}` with no annotation, so tsc infers `any` and their identical `resolveProjectRoot(options.projectRoot, ...)` calls type-check silently. AGENTS.md requires JSDoc annotations on all JavaScript. `check:jsdoc-types` reports 104 files checked and passes, so it does not enforce parameter coverage on these handlers.",
    "suggested_fix": "Annotate both handlers as `JsonMap` and narrow the option reads; consider extending check:jsdoc-types to flag unannotated exported handlers.",
    "confidence": "high"
  }
]
```

## Exploration Notes

**What this is.** `nax` (netlify-agent-executor, v1.0.5) is a CommonJS Node CLI that runs multi-step, multi-agent AI workflows against a repository. Workflows are declarative files (`flow.yml|json|toml`) with markdown prompts, executed through one of three transports — in-process local, local subprocess, or the Netlify Agent Runner API. It ships a Vite/React/Mantine dashboard (Hono API, React Query, XYFlow canvas) and a separate Nextra 4 docs site under `site/`, which is what `netlify.toml` deploys.

**Layering** is unusually disciplined for a project this size (~32k LOC of `src`): `core/` (pure), `storage/` (fs), `integrations/` (github, git, netlify), `workflows/` (engine, artifacts, events, followups), `dashboard/` (api, storage, transports, shared, web), `cli/`. The direction is machine-enforced by `scripts/check-import-direction.js`, and `src/contracts/*.ts` holds the API payload types shared with the web client. 731 unit/integration tests plus a Playwright dashboard smoke.

**Flows traced.**
1. `nax costs` → `resolveProjectRoot` → `listRunStates` (mtime-sorted, paginated durable state) → `buildCostsReport` → `formatCostsTable`. This is where R1, R5, and R13 live.
2. `nax dashboard` → `resolveDashboardNetlifyContext` (link discovery, filter-candidate selection, per-site access verdicts) → `startServer` with `netlifyContext` + `defaultRunOptions` → Hono app with host allowlist, token auth, CSP. R6 and R12 live here.
3. Run list → `createLocalRunStore.publicRunWithLiveness` → `publicRunState` + `livenessFields` (events.jsonl mtime vs threshold) + `usageTotals` → `RecentRuns` badges. R4, R7, and R11 live here.

**Local dashboard security holds up.** Host-header allowlist (`server.js:544`), token compared with `crypto.timingSafeEqual` over SHA-256 digests, `HttpOnly; SameSite=Strict` session cookie, and a restrictive CSP with `frame-ancestors 'none'`. Config loading is routed through configorama `safeMode` with `allowedFileRoots` scoped to the flow directory (`flows.js:56`).

## Review Notes

**The recent commits** implement a coherent "run visibility" quartet — per-run credit usage on cards and details, a stalled badge from event-log quiet time, sidebar text/status filtering, and a `nax costs` CLI report — plus Netlify target clarification for dashboard-launched runs. The work is well-tested per feature (each commit adds its own unit tests) and consistently avoids status mutation for presentational signals (`run-liveness.js` header comment is explicit about this).

**Root cause of the highest-severity findings is a missing gate, not sloppy code.** R1 and R2 are both narrow, mechanical type errors that any CI run of `npm run check` would have blocked. Because the only automation in `.github/workflows` is nax invoking itself, the repo's own three-stage `check` script and its 731 tests are enforced only by whoever remembers to run them. R1 is even a sign of *improving* discipline: `handleCosts` is the first of its neighbors to carry the JSDoc annotation AGENTS.md requires, and the annotation is what exposed the unchecked `unknown`.

**Test-suite health in this environment.** 719/741 pass. I attributed every failure to one of four causes and only one is a repo defect:
- 11 failures need `git init`, which is disabled in this sandbox (`target.test.js`, `resolveProjectRoot`, gitignore-scoped config discovery) — environmental.
- 5 failures expect configorama safe-mode blocking messages; `node_modules` has configorama **0.9.15** installed while `package-lock.json` pins **1.0.0**, and 0.9.15 has no `safeMode` — stale install in this sandbox, not a code defect.
- 1 failure is R8, a genuine environment-leak in the test.
- The remaining count is harness-level rollup of the above.

**Positive observations.** The `contracts/` + `check-import-direction` + `check-jsdoc-types` combination is a real architectural asset. `RecentRuns.tsx:167` explicitly discloses truncation and that filtering applies only to loaded runs — exactly the honesty `nax costs` is missing (R5). Credit formatting on the CLI side already handles sub-cent USD and zero-trimming carefully (`agent-run-results.js:262-296`).

## Improvement Notes, Ranked

1. **Add a CI workflow** (R3). Everything else in this report would have been caught pre-merge. Highest leverage change available.
2. **Fix the two typecheck errors** (R1, R2) so `npm run check` is green and the new command is covered.
3. **Unify credit formatting** (R4). One shared formatter removes a class of dashboard/CLI drift, not just today's instance.
4. **Make `nax costs` honest about its window** (R5) and reject bad `--limit` (R13). The dashboard already sets the pattern to copy.
5. **Close the docs gaps** (R7, R15, R9). AGENTS.md makes `site/content` canonical; a shipped env var and two shipped flags are missing from it, and the site README points at the wrong host.
6. **Tighten target-reason matching** (R6) and make dashboard startup access checks lazy (R12) — both affect first-run trust in which Netlify site receives remote work.
7. **Small cleanups**: wire `check:cli-help` (R10), reuse `eventLogPathForRunDir` (R11), annotate the two untyped handlers (R16), drop the Next.js turbo shim (R14).

## Items Considered And Rejected

1. **Local dashboard CSRF via cookie auth.** State-changing POSTs authenticate from a cookie, which normally invites cross-site abuse against a localhost server. Rejected: the cookie is `SameSite=Strict`, the server enforces a `localhost`/`127.0.0.1`/`::1` Host allowlist (`server.js:536-547`) which also blocks DNS rebinding, and the bootstrap cookie is only issued when a matching `x-nax-token` header is presented. No gap to report.
2. **configorama safe-mode failures as a security regression.** Five tests asserting that `flow.js` / `nax.config.js` are blocked fail here. Rejected as a repo defect: `package-lock.json` pins configorama 1.0.0 (which provides `safeMode`); this sandbox has a stale 0.9.15 in `node_modules`. Worth knowing, though, that nax has no defense-in-depth of its own — it lists `js`/`cjs`/`mjs`/`ts` in `FLOW_FILE_EXTENSIONS` and relies entirely on the dependency to refuse them, with no installed-version assertion.
3. **`formatCredits` zero-trimming regex.** `value.toFixed(2).replace(/\.?0+$/, '')` looked like it could eat significant trailing zeros in values such as `100` or `1000`. Traced by hand across integers, sub-cent values, and zero — the `$` anchor plus optional `\.` confines the match to the fractional tail in every case. Correct as written.
