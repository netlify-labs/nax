## 1. Repository State

- `pinned_sha`: `0a9a6b1ae0da161bbacabcdfa06d38069c20fdf0`
- `checked_out_sha`: `0a9a6b1ae0da161bbacabcdfa06d38069c20fdf0`
- `state_match`: `yes`
- `drift_commits`: `0`
- `drift_acceptable`: `yes`
- `git_status_clean`: `yes`

The reviewed checkout exactly matched the pinned commit. No repository source files were changed, staged, or committed during synthesis.

## 2. Structured Consensus

```json
{
  "consensus_findings": [
    {
      "id": "S1",
      "category": "defect",
      "severity": "high",
      "status": "open",
      "file": "src/cli/main.js",
      "line": 565,
      "claim": "The root quality gate is red, including a production type error where an unknown projectRoot value is passed to a string parameter.",
      "evidence": "Claude reproduced the root typecheck failure; Gemini and Codex independently confirmed it during cross-review. The reviews reported 15 root diagnostics, with the new costs handler as a directly traced production failure.",
      "suggested_fix": "Narrow CLI option values at their boundaries, fix all remaining root diagnostics, and restore a green npm run check before adding enforcement.",
      "confidence": "high"
    },
    {
      "id": "S2",
      "category": "defect",
      "severity": "high",
      "status": "open",
      "file": ".github/workflows/run-nax.yml",
      "line": 1,
      "claim": "No pull-request or push workflow enforces npm run check and npm test.",
      "evidence": "Claude found the missing gate, and both other models confirmed that none of the four workflows runs the repository checks or test suite. The red root typecheck demonstrates the practical impact.",
      "suggested_fix": "Add dedicated pull-request and master-branch CI running npm ci, npm run check, and npm test.",
      "confidence": "high"
    },
    {
      "id": "S3",
      "category": "defect",
      "severity": "high",
      "status": "open",
      "file": "src/workflows/engine/runner.js",
      "line": 196,
      "claim": "Overlapping in-process workflows can cross-route output and restore process-global state in the wrong order.",
      "evidence": "Codex traced process-global console replacement and process.chdir usage against a dashboard guard keyed only by flow ID. Claude and Gemini accepted the finding as a high-impact concurrency defect.",
      "suggested_fix": "Replace global console capture with a run-scoped logger or worker isolation, serialize in-process runs as an interim safeguard, and add an overlapping-run regression test.",
      "confidence": "high"
    },
    {
      "id": "S4",
      "category": "defect",
      "severity": "high",
      "status": "open",
      "file": "tests/unit/cli-command-surface.test.js",
      "line": 38,
      "claim": "The CLI command-surface fixture omits the costs handler, causing a type error and leaving the new command dispatch untested.",
      "evidence": "Claude identified the missing required handler; Gemini and Codex confirmed the diagnostic and coverage gap during cross-review.",
      "suggested_fix": "Add the costs handler and assert parsing and dispatch for representative costs options.",
      "confidence": "high"
    },
    {
      "id": "S5",
      "category": "defect",
      "severity": "medium",
      "status": "open",
      "file": "site/app/layout.tsx",
      "line": 67,
      "claim": "Documentation edit links target the nonexistent main branch instead of master.",
      "evidence": "Gemini and Codex found the broken branch URL, Claude verified that origin/main is absent, and all cross-reviews agreed. The models differed only on severity.",
      "suggested_fix": "Point docsRepositoryBase at master or derive the branch from deployment configuration.",
      "confidence": "high"
    },
    {
      "id": "S6",
      "category": "defect",
      "severity": "medium",
      "status": "open",
      "file": "site/app/favicon.ico/route.ts",
      "line": 1,
      "claim": "The favicon route serves a structurally truncated ICO payload.",
      "evidence": "Codex found the malformed binary and both other models confirmed that its declared image length exceeds the available payload. Reviewers disagreed on the decoded byte count, not the defect; the corrected cross-review count was 175 bytes versus 318 required.",
      "suggested_fix": "Replace the generated route with a valid static icon and add a lightweight asset-validity check.",
      "confidence": "high"
    },
    {
      "id": "S7",
      "category": "defect",
      "severity": "low",
      "status": "open",
      "file": "tests/unit/netlify-api-client.test.js",
      "line": 75,
      "claim": "A missing-token test depends on the host environment and fails when NETLIFY_AUTH_TOKEN is present.",
      "evidence": "Claude reproduced the environment leak, and Codex confirmed that token: '' falls back to process.env rather than guaranteeing a missing-token case.",
      "suggested_fix": "Inject an explicit empty environment in token-validation tests.",
      "confidence": "high"
    },
    {
      "id": "S8",
      "category": "polish",
      "severity": "low",
      "status": "open",
      "file": "src/dashboard/web/src/run-format.ts",
      "line": 69,
      "claim": "The dashboard renders raw credit floats while the CLI applies stable rounding and zero trimming.",
      "evidence": "Claude and Codex found the inconsistent formatting, and Gemini confirmed it during cross-review.",
      "suggested_fix": "Use one shared credit formatter across CLI and dashboard surfaces.",
      "confidence": "high"
    },
    {
      "id": "S9",
      "category": "polish",
      "severity": "low",
      "status": "open",
      "file": "src/cli/display/costs-report.js",
      "line": 68,
      "claim": "The costs report does not clearly disclose when its total covers only the recent-run window.",
      "evidence": "Claude identified the hidden totalCount, Gemini supported an N-of-M label, and Codex reversed its initial rejection after distinguishing intentional limiting from incomplete disclosure.",
      "suggested_fix": "Print Showing N of M, distinguish runs that contributed usage, and document the default window and related flags.",
      "confidence": "high"
    },
    {
      "id": "S10",
      "category": "polish",
      "severity": "low",
      "status": "open",
      "file": "src/integrations/netlify/dashboard-context.js",
      "line": 126,
      "claim": "Dashboard startup blocks on access checks for every linked site and repeats the same account lookup for each site.",
      "evidence": "Codex traced the fan-out; Claude sharpened it to 2N requests with N redundant user lookups, and Gemini accepted the performance concern.",
      "suggested_fix": "Resolve account identity once, prioritize the selected target, and load secondary site status lazily or within a shared deadline.",
      "confidence": "high"
    }
  ],
  "contested_findings": [
    {
      "id": "C1",
      "category": "polish",
      "severity": "low",
      "status": "dropped",
      "file": "site/components/council-viz.tsx",
      "line": 137,
      "claim": "A phase transition may render one stale completion frame.",
      "evidence": "Gemini described a React effect-ordering lag; Codex considered it plausible but unproven, while Claude traced reachable transitions and found no visible state change.",
      "suggested_fix": "Do not change behavior without a visual regression test that reproduces user-visible flicker.",
      "confidence": "medium"
    },
    {
      "id": "C2",
      "category": "polish",
      "severity": "low",
      "status": "dropped",
      "file": "site/public/workflow-showcase.html",
      "line": 1,
      "claim": "An unreferenced showcase file should be deleted.",
      "evidence": "Claude considered the HTML file a real orphan; Codex found absence of references insufficient to prove it is unintended. All reviewers rejected deleting the separately referenced video thumbnail.",
      "suggested_fix": "Confirm product intent before either linking or removing the HTML file.",
      "confidence": "medium"
    }
  ],
  "merge_dependent_findings": [
    {
      "id": "M1",
      "category": "defect",
      "severity": "unknown",
      "status": "merge_dependent",
      "file": "PR #31",
      "line": 0,
      "claim": "Open PR #31 may overlap some reviewed files, but none of its changes are present in the pinned SHA.",
      "evidence": "The merge-state ledger marks the PR head as not contained in the pinned commit and its merge state as unknown.",
      "suggested_fix": "Recheck affected findings after the PR merges; do not treat any item as already fixed now.",
      "confidence": "high"
    }
  ]
}
```

## 3. Executive Summary

The review converged on three priority risks: the repository's own quality gate was already failing, no CI enforced that gate, and concurrent dashboard workflows could corrupt process-global output capture. The remaining strong consensus consisted of two user-visible documentation-shell defects, two deterministic test/coverage gaps, and several lower-risk clarity and performance improvements. No reviewed issue was already fixed in the pinned commit.

## 4. Consensus Findings

### Defects

1. **Restore the root quality gate** at `src/cli/main.js:565` and the other reported diagnostics. This was directly reproduced and confirmed by all models in cross-review.
2. **Enforce checks in CI** at `.github/workflows/run-nax.yml:1` or a dedicated workflow. This was the highest-leverage prevention measure and explained how the red gate reached `master`.
3. **Eliminate process-global workflow capture** at `src/workflows/engine/runner.js:196`. The console and working-directory mutations were unsafe when different flows overlapped.
4. **Repair command coverage** at `tests/unit/cli-command-surface.test.js:38`. The missing `costs` handler both failed typechecking and left dispatch untested.
5. **Fix the docs shell** at `site/app/layout.tsx:67` and `site/app/favicon.ico/route.ts:1`. The edit action pointed to a missing branch and the favicon payload was malformed.
6. **Isolate environment-sensitive tests** at `tests/unit/netlify-api-client.test.js:75` so ambient credentials could not change expected behavior.

### Polish

- Shared credit formatting at `src/dashboard/web/src/run-format.ts:69` would keep CLI and dashboard values consistent.
- Costs-window disclosure at `src/cli/display/costs-report.js:68` would prevent a recent-run subtotal from reading like an unrestricted total.
- Batched or lazy Netlify access checks at `src/integrations/netlify/dashboard-context.js:126` would reduce redundant requests and startup latency.
- Documentation for `NAX_STALLED_AFTER_MINUTES` and replacement of the Vercel-oriented scaffold text in `site/README.md:20` remained valid, low-risk follow-ups.

## 5. Contested Findings

- **CouncilViz stale frame:** Gemini identified a technically plausible effect-ordering lag, Codex requested visual evidence, and Claude found no reachable transition that visibly changed the prior state. This should be dropped from the active backlog unless a browser-level test reproduces flicker.
- **Costs report severity:** Reviewers agreed the disclosure could improve but disagreed whether it was a defect or polish. The calculation intentionally covers recent runs, so the item should remain as high-confidence polish rather than a correctness defect.
- **Unreferenced showcase HTML:** One model recommended removal, while another found that lack of references alone did not establish that public availability was accidental. This should remain out of the action plan until intent is confirmed.
- **Event-log helper reuse and machine-specific contributor instructions:** These were reasonable cleanups but did not receive broad enough support to compete with the ranked work.

## 6. Already Addressed Or Merge-Dependent

No reviewed finding was already fixed in `0a9a6b1ae0da161bbacabcdfa06d38069c20fdf0`. PR #31 was not contained in the pinned SHA and had an unknown merge state, so it could not remove or downgrade any finding. Recent work had already protected dashboard health data behind authentication and propagated selected Netlify targets correctly; those areas should not be reopened as generic security or target-selection defects without new evidence.

## 7. Recommended Action Plan

1. Fix every root typecheck diagnostic, starting with `src/cli/main.js:565` and `tests/unit/cli-command-surface.test.js:38`, and restore a green `npm run check`.
2. Add mandatory pull-request and `master` CI running `npm ci`, `npm run check`, and `npm test`.
3. Replace global console capture and guard other process-global workflow state; add a concurrent-run regression test.
4. Bundle the small user-facing corrections: the docs edit branch, valid favicon, shared credit formatting, and explicit costs-window disclosure.
5. Make infrastructure checks deterministic by isolating test environments and resolving Netlify account identity once before per-site access checks.

## 8. Model-Difference Notes

- **Claude** was strongest on executable repository gates, test determinism, CLI edge cases, and CI coverage. It initially missed the concurrency race, broken edit links, and malformed favicon.
- **Codex** was strongest on cross-module runtime tracing, especially process-global workflow state, favicon structure, and Netlify request fan-out. It initially missed the root gate and dismissed the costs disclosure too quickly.
- **Gemini** was strongest on the documentation-site shell and UI review. Its narrow site focus missed the root quality gate and backend risks, and several visual findings were overstated or insufficiently verified.

## 9. Prompt/Workflow Improvements

- Require every first-round reviewer to run the same root gate commands, not package-local substitutes, and record exact command outcomes in a shared field.
- Require a CI inventory, a process-global-state scan, and an environment-isolation check as standard review steps.
- Require binary or asset findings to report a reproducible parser command and avoid conflicting byte counts.
- Separate `confirmed`, `likely`, `polish`, and `rejected` from the first round so cross-review spends less effort correcting severity inflation.
- Require repository-wide reference searches before declaring assets unused, and require visual evidence before promoting one-frame UI state observations.
- Include open-PR diffs or commit objects in the merge ledger when available so merge-dependent claims can be evaluated instead of merely deferred.

## 10. Dropped Or Rejected Items

- Dropped the recommendation to delete `site/public/nax-video-thumbnail.webp`; it is referenced by the repository README and removal would cause a regression.
- Dropped the home-card arrow claim; `->` is rendered intentionally and changing it to a Unicode glyph is a design preference.
- Dropped the claim that `NETLIFY_SITE_ID` is missing from documentation; it is documented in the CI guide.
- Dropped generic dashboard CSRF concerns because the reviewed implementation combined strict host validation, `SameSite=Strict` cookies, and token authentication.
- Dropped configorama safe-mode and git-related test failures as environment artifacts rather than repository defects.
- Dropped the target-reason matching claim because the alleged mismatch was not established on a reachable normal path.
- Dropped removal of the Next.js compatibility shim because current configuration and typecheck evidence did not prove it was unnecessary across supported builds.
