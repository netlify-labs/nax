## 1. Repository State
- `pinned_sha`: `885ba58ef1889eb46b500d02dbf7b09fd221b65b`
- `checked_out_sha`: `885ba58ef1889eb46b500d02dbf7b09fd221b65b`
- `state_match`: `yes`
- `drift_commits`: `0`
- `drift_acceptable`: `yes`
- `git_status_clean`: `yes` before writing this requested results file

## 2. Structured Consensus
```json
{
  "consensus_findings": [
    {
      "id": "S1",
      "category": "defect",
      "severity": "high",
      "status": "open",
      "file": "netlify.toml",
      "line": 5,
      "claim": "The hosted dashboard API wrapper is not deployable because the configured Netlify Functions directory has no handler entrypoint.",
      "evidence": "The first-round and cross-review Codex outputs both converged on missing hosted deploy wiring; the cross-review tied it to netlify.toml pointing at netlify/functions while only a library wrapper exists under src/dashboard/runtime/netlify-function.js.",
      "suggested_fix": "Add a Netlify Function entrypoint under netlify/functions that instantiates createNetlifyDashboardFunction with environment-derived configuration.",
      "confidence": "high"
    },
    {
      "id": "S2",
      "category": "defect",
      "severity": "high",
      "status": "open",
      "file": "src/dashboard/transports/netlify-api.js",
      "line": 469,
      "claim": "Hosted run listing is process-local and loses runs across cold starts or separate function instances.",
      "evidence": "Both Codex review passes identified in-memory hosted run listing as a dashboard hosted-mode defect; the cross-review specified that listRunsPage serializes a runsById Map rather than querying a durable or Netlify API-backed source.",
      "suggested_fix": "Replace hosted run listing with a durable or API-backed listing implementation, or disable read capability until reliable listing exists.",
      "confidence": "high"
    },
    {
      "id": "S3",
      "category": "defect",
      "severity": "medium",
      "status": "open",
      "file": "src/dashboard/web/src/api.ts",
      "line": 62,
      "claim": "Cross-origin dashboard token bootstrap is likely unreliable because the health request does not include credentials before the URL token is stripped.",
      "evidence": "Both Codex outputs flagged cross-origin token bootstrap; the cross-review downgraded it from confirmed to likely because same-origin deployments may work, while cross-origin hosted/static deployments depend on credentialed cookie behavior.",
      "suggested_fix": "Choose and test one hosted auth model: same-origin cookie bootstrap, cross-origin credentials plus CORS and cookie attributes, or persistent explicit token headers until bootstrap succeeds.",
      "confidence": "medium"
    }
  ],
  "contested_findings": [
    {
      "id": "C1",
      "category": "defect",
      "severity": "medium",
      "status": "dropped",
      "file": "src/dashboard/web/src/api.ts",
      "line": 62,
      "claim": "Token bootstrap is a confirmed bug for all deployments.",
      "evidence": "The cross-review narrowed the finding because default same-origin fetch cookie behavior can work; only cross-origin hosted/static configurations are clearly at risk.",
      "suggested_fix": "Keep the narrower cross-origin risk in the backlog rather than a blanket defect claim.",
      "confidence": "medium"
    }
  ],
  "merge_dependent_findings": []
}
```

## 3. Executive Summary
The available multi-model material produced a narrow but coherent consensus: the hosted dashboard path is not production-ready at the pinned commit because the function wrapper is not actually deployed, hosted run listing is not durable, and cross-origin auth bootstrap is probably fragile. No open PRs were reported, so none of these findings should be treated as merge-dependent or already fixed.

## 4. Consensus Findings
1. `netlify.toml:5` / `netlify/functions`: The top issue is missing deploy wiring for the hosted dashboard API. The repo has a reusable Netlify Function wrapper, but the configured functions directory lacks an entrypoint, so hosted dashboard API behavior will not exist after deploy. Severity: high. Confidence: high.
2. `src/dashboard/transports/netlify-api.js:469`: Hosted run listing relies on in-memory state. That makes `/api/runs` unreliable after cold starts, instance changes, or any path that did not populate the current process-local map. Severity: high. Confidence: high.
3. `src/dashboard/web/src/api.ts:62`: Cross-origin token-to-cookie bootstrap is risky. The best consensus version is not “always broken,” but “likely broken when the dashboard and API are on different origins and the token is stripped before a credentialed session is established.” Severity: medium. Confidence: medium.

## 5. Contested Findings
The main contested item is the auth bootstrap severity. The stronger bug argument is that cross-origin fetches do not store or send cookies unless credentials and CORS/cookie attributes are deliberately configured. The limiting argument is that same-origin deployments can rely on default cookie behavior, so the issue is configuration-dependent. Keep this in the backlog as a medium-severity hosted-mode defect, not a universal blocker.

The prompt did not include the full Claude or Gemini reports, so there is no defensible basis to confirm or reject model-specific findings outside the Codex review lineage. Those absent claims should not enter the backlog as consensus items.

## 6. Already Addressed Or Merge-Dependent
No findings are already addressed in the pinned snapshot based on the supplied review artifacts.

No findings are merge-dependent. The merge-state ledger reported no open pull requests at prompt generation time.

Tests around the wrapper or transport, if present, do not by themselves resolve the consensus defects: they do not create a deployed function entrypoint, make run listing durable, or prove cross-origin auth bootstrap works.

## 7. Recommended Action Plan
1. Add the deployed Netlify Function entrypoint under `netlify/functions` and wire it to `createNetlifyDashboardFunction` with token, site ID, and API client configuration from environment.
2. Add deployment-style integration coverage proving the configured function path responds as the hosted dashboard API expects.
3. Replace process-local hosted run listing with a durable or Netlify API-backed implementation. If no reliable listing API exists yet, advertise `canReadRuns: false` or otherwise disable the UI path instead of showing misleading partial state.
4. Decide the hosted auth model explicitly and implement it consistently across client and server: same-origin cookie bootstrap, cross-origin credentialed cookies with CORS, or explicit token headers until session bootstrap succeeds.
5. Add regression tests for cold-start run listing behavior and cross-origin session bootstrap so these hosted-mode failures are caught before release.

## 8. Model-Difference Notes
Codex was strongest at tying hosted dashboard concerns to concrete repository surfaces and at self-correcting the auth bootstrap claim from confirmed to likely.

The absent Claude and Gemini source reports limit useful comparison. The workflow only supports a real model-difference analysis when each first-round report and each cross-review is included verbatim.

## 9. Prompt/Workflow Improvements
Include every first-round review and every cross-review output verbatim in the synthesis prompt. The current prompt only supplied a Codex summary and Codex cross-review, which prevents true multi-model consensus scoring.

Require each reviewer to use stable finding IDs, `file:line`, severity, status, confidence, and evidence. Then require cross-reviewers to mark each original ID as confirmed, narrowed, rejected, already fixed, or merge-dependent.

Provide a machine-readable merge ledger with PR numbers, heads, merge status, and whether each finding depends on branch-only code. That would reduce ambiguity between pinned reality and proposed fixes.

Ask reviewers to distinguish “confirmed by repository state” from “likely in a deployment topology.” The auth bootstrap item is the clearest example where this distinction materially changes severity.

## 10. Dropped Or Rejected Items
Drop the blanket claim that token bootstrap is confirmed broken for all deployments. Keep only the narrower cross-origin hosted/static risk.

Drop any backlog item attributed to Claude or Gemini unless the underlying report text is supplied. The synthesis evidence provided here does not support accepting or rejecting those claims.

Do not classify the hosted wrapper as dead code. The consensus issue is missing deployment wiring, not proof that the wrapper should be removed.
