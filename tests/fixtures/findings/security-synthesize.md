## Consensus Summary

Confirmed/likely findings: 0 critical, 4 high, 2 medium, 3 low. Needs-runtime-validation findings: 0 critical, 1 high, 0 medium, 0 low. The top risk is the GitHub Actions author-association guard bypass, because it allows an untrusted public-repo actor to trigger privileged agent runs that receive repository write permissions and Netlify secrets.

Ship recommendation: **ship after high fixes**. The codebase is generally defensive, but the CI trigger guard and hosted runner object-authorization issue should be fixed before broad public use.

## Methodology Coverage

The synthesis covered CI trust boundaries, dashboard authentication, hosted Netlify Agent Runner transport, local filesystem access, token transport, blob retention, CSP, outbound webhooks, and command execution. Payment, subscription entitlements, OAuth callbacks, database authorization, file uploads, and webhook verification were skipped as not present in this snapshot.

Highest-risk blind spots are external behavior of `netlify-labs/agent-runner-action` after the CI guard is bypassed, Netlify API-side runner scoping, and whether the hosted dashboard runtime is deployed beyond localhost-style development.

## Structured Consensus

```json
[
  {
    "id": "SEC-CONSENSUS-1",
    "severity": "high",
    "status": "confirmed",
    "domain": "infrastructure",
    "title": "GitHub workflow guard checks the issue or PR author before the triggering commenter",
    "file": ".github/workflows/netlify-agents.yml",
    "line": 41,
    "agents": ["claude"],
    "kernel_axiom": "Axiom 6 - presence/identity checks must verify the actual actor",
    "attack_vector": "On a public repository, an untrusted user comments on or reviews an issue or pull request opened by an OWNER, MEMBER, or COLLABORATOR. The workflow `if` expression short-circuits on `github.event.issue.author_association` or `github.event.pull_request.author_association` before checking the actual comment or review actor.",
    "impact": "Unauthorized launch of `agent-runner-action` with repository write permissions and access to Netlify secrets. Downstream impact may include attacker-influenced repository writes or secret exposure depending on the action's prompt handling.",
    "evidence": "Lines 47-52 pass `github.event.pull_request.author_association || github.event.issue.author_association || github.event.comment.author_association || github.event.review.author_association` to `contains(...)`, so issue or PR author trust can satisfy the guard for comment/review events.",
    "recommended_fix": "Replace the single fallthrough expression with event-specific conditions that validate the actual triggering actor: comment association for comment events, review association for review events, issue association for issue events, and pull request association for pull request events.",
    "verification": "Evaluate synthetic `issue_comment`, `pull_request_review_comment`, and `pull_request_review` payloads where the issue/PR author is trusted but the comment/review author is `NONE`; each must evaluate false.",
    "regression_test": "Add a workflow-policy test for each supported event type asserting untrusted triggering actors cannot pass through trusted issue/PR opener associations.",
    "confidence": "high"
  },
  {
    "id": "SEC-CONSENSUS-2",
    "severity": "high",
    "status": "confirmed",
    "domain": "infrastructure",
    "title": "Scaffolded workflow template propagates the same GitHub trigger-guard bypass",
    "file": "src/templates/netlify-agents.yml",
    "line": 41,
    "agents": ["claude"],
    "kernel_axiom": "Axiom 8 - attack surfaces expand faster than defenses",
    "attack_vector": "Any downstream repository initialized from this template inherits the same event-author confusion and can be triggered by an untrusted commenter on a trusted user's issue or pull request.",
    "impact": "The vulnerable guard is distributed to user repositories, multiplying the privileged CI execution risk across installations.",
    "evidence": "The template contains the same line 47-52 author-association fallthrough as the live workflow.",
    "recommended_fix": "Apply the same event-specific actor check to the template and document the required policy for existing users who already scaffolded the workflow.",
    "verification": "Run the same synthetic GitHub event-policy tests against the template file.",
    "regression_test": "Add a template regression test that parses `src/templates/netlify-agents.yml` and confirms comment/review events depend only on comment/review actor association.",
    "confidence": "high"
  },
  {
    "id": "SEC-CONSENSUS-3",
    "severity": "high",
    "status": "needs-runtime-validation",
    "domain": "multi-tenant isolation",
    "title": "Hosted dashboard forwards arbitrary runner IDs without local ownership checks",
    "file": "src/dashboard/transports/netlify-api.js",
    "line": 482,
    "agents": ["codex"],
    "kernel_axiom": "Axiom 10 - multi-tenancy needs app-layer and data-layer checks",
    "attack_vector": "A holder of a valid dashboard token calls hosted dashboard routes with a runner ID they know or can guess. The transport forwards the ID to `getAgentRunner` or `cancelAgentRunner` using the server-side Netlify API token without first requiring that the runner was started or registered by this dashboard/site context.",
    "impact": "Potential cross-dashboard or cross-project runner metadata/results exposure and unauthorized cancellation within whatever scope the Netlify API token accepts.",
    "evidence": "`getRun`, `getRunGraph`, `getRunDetails`, and `listEvents` call `client.getAgentRunner({ runnerId })` or `{ runnerId: runId }` directly at lines 482-508. `cancelRun` calls `client.cancelAgentRunner({ runnerId })` at line 458. `cancelFollowup` accepts `body.runnerId || body.id` and cancels it at lines 628-631. The in-memory maps are populated after remote reads and are not used as pre-authorization.",
    "recommended_fix": "Maintain a durable registry of runner IDs started or explicitly imported for this dashboard and site. Require registry membership before read, event, cancel, or follow-up operations, and verify remote runner metadata matches the configured site/source before returning data or mutating state.",
    "verification": "Use tests with unregistered runner IDs and assert no Netlify API client read/cancel method is invoked. Add positive tests where registered runner IDs with matching site/source metadata succeed.",
    "regression_test": "Add hosted transport tests for `/api/runs/:id`, details, events, cancel, and follow-up cancellation that reject unregistered or mismatched runner IDs.",
    "confidence": "medium-high"
  },
  {
    "id": "SEC-CONSENSUS-4",
    "severity": "medium",
    "status": "confirmed",
    "domain": "web",
    "title": "Local file opener validates symlink path before real target",
    "file": "src/dashboard/runtime/local-files.js",
    "line": 22,
    "agents": ["claude"],
    "kernel_axiom": "Axiom 3 - normalize before validate",
    "attack_vector": "A malicious repository places a symlink under the project root that points outside the root. The dashboard resolves and bounds the symlink path, then `fs.statSync` follows the link and the OS opener receives the external path.",
    "impact": "Limited local file-boundary bypass: an operator can be induced through dashboard UI/API to open an arbitrary file or directory outside the project root.",
    "evidence": "Lines 23-27 compare `path.resolve(filePath)` against `path.resolve(projectRoot)`, while line 31 uses `fs.statSync`, which follows symlinks. There is no `realpath` containment check or symlink rejection before line 36 opens the path.",
    "recommended_fix": "Canonicalize both project root and target with `fs.realpathSync` before containment checks, or reject symlinks with `lstatSync`, then open only the validated real target.",
    "verification": "Create a symlink inside the project to a file outside it and verify the endpoint returns 403 after the fix.",
    "regression_test": "Add a `local-files` unit test that asserts symlink escapes are rejected and ordinary in-root files still open.",
    "confidence": "medium"
  },
  {
    "id": "SEC-CONSENSUS-5",
    "severity": "medium",
    "status": "confirmed",
    "domain": "secrets",
    "title": "Dashboard session cookie omits the Secure attribute",
    "file": "src/dashboard/api/auth.js",
    "line": 56,
    "agents": ["gemini", "codex"],
    "kernel_axiom": "Axiom 5 - avoid leaking authority through side channels",
    "attack_vector": "In hosted or HTTPS deployments, a browser may send the bearer dashboard cookie over plain HTTP on the same host if that host is reachable without HTTPS or before a redirect completes.",
    "impact": "Dashboard session token exposure on insecure transport could allow run reads and authenticated dashboard mutations.",
    "evidence": "`sessionCookieHeader` returns `nax_dashboard_token=...; Path=/; HttpOnly; SameSite=Strict` at line 57 with no `Secure`. Security headers in `src/dashboard/api/security.js` do not include HSTS.",
    "recommended_fix": "Add `Secure` for HTTPS/web deployment mode and consider HSTS for hosted deployments. Keep localhost behavior explicit if HTTP development needs a non-Secure exception.",
    "verification": "Assert hosted/web bootstrap responses set `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/` on the session cookie.",
    "regression_test": "Add cookie serialization tests for hosted/web mode plus a documented local-mode exception test if needed.",
    "confidence": "high"
  },
  {
    "id": "SEC-CONSENSUS-6",
    "severity": "low",
    "status": "confirmed",
    "domain": "secrets",
    "title": "Dashboard token is accepted from URL query strings",
    "file": "src/dashboard/api/auth.js",
    "line": 20,
    "agents": ["claude"],
    "kernel_axiom": "Axiom 5 - avoid leaking authority through side channels",
    "attack_vector": "The bearer token can appear as `?token=` in browser history, shell history, bookmarks, screenshots, or access logs.",
    "impact": "Increased risk of dashboard token leakage. `Referrer-Policy: no-referrer` reduces referer leakage but does not address local history or logs.",
    "evidence": "`explicitTokenFromRequest` falls back to `requestUrl.searchParams.get('token')` at line 24. The Hono path separately accepts `c.req.query('token')` in `src/dashboard/api/app.js` lines 52 and 57.",
    "recommended_fix": "Prefer header or cookie authentication. If URL bootstrap remains necessary, consume it once to set the HttpOnly cookie and immediately remove the query parameter from the browser URL.",
    "verification": "Confirm authenticated requests work with header/cookie only and that the bootstrap token does not remain in the address bar or logs.",
    "regression_test": "Add auth tests that reject normal API requests authenticated only by query string after bootstrap handling is moved to a one-time flow.",
    "confidence": "high"
  },
  {
    "id": "SEC-CONSENSUS-7",
    "severity": "low",
    "status": "confirmed",
    "domain": "data-security",
    "title": "Offloaded prompt/result blobs use deterministic keys and lack enforced retention",
    "file": "src/workflows/prompts/offload.js",
    "line": 222,
    "agents": ["claude"],
    "kernel_axiom": "Axiom 11 - data retention must match product promises",
    "attack_vector": "Any principal with site blob-read access can locate historical run context under deterministic `nax-<runId>` stores and step-based keys, and there is no guaranteed cleanup after runs complete.",
    "impact": "Sensitive prompts, prior audit results, repository context, or task details can persist longer than expected for site-level blob readers.",
    "evidence": "`blobRefForStep` derives `store = nax-${runId}` and keys from `${stepId}-full-prompt` or `${stepId}-prior-results` at lines 223-228. The sentinel proves context loading; it is not an access-control mechanism.",
    "recommended_fix": "Define and enforce a retention policy for `nax-<runId>` stores and document that offloaded prompts/results may contain sensitive context.",
    "verification": "After completed runs, verify blobs are deleted or expired according to policy.",
    "regression_test": "Add a blob-lifecycle test that ensures completed-run stores are cleaned up or assigned retention metadata.",
    "confidence": "medium"
  },
  {
    "id": "SEC-CONSENSUS-8",
    "severity": "low",
    "status": "confirmed",
    "domain": "infrastructure",
    "title": "`nax ci` uses shell execution for operator-supplied command text",
    "file": "src/cli/commands/ci.js",
    "line": 70,
    "agents": ["claude"],
    "kernel_axiom": "Axiom 7 - recovery and utility paths must preserve invariants",
    "attack_vector": "Today the command is operator-supplied CLI argv and is gated to Agent Runner environments. If future callers pass untrusted workflow, branch, issue, or comment content into `commandParts`, shell metacharacters become executable.",
    "impact": "No current exploit was confirmed; this is a latent command-injection sink if the trusted input boundary changes.",
    "evidence": "Line 70 calls `runCommand(commandText, [], { shell: true, stdio: 'inherit' })`, with `commandText` produced by joining the variadic CLI command parts.",
    "recommended_fix": "Document the trusted-input invariant or change the API to preserve argv arrays and avoid `shell: true` where shell features are not required.",
    "verification": "Confirm all call sites are operator CLI argv only and add tests that no network-derived input reaches this API.",
    "regression_test": "Add a unit test or static check that dashboard/API inputs cannot call `handleCi` with arbitrary command text.",
    "confidence": "high"
  },
  {
    "id": "SEC-CONSENSUS-9",
    "severity": "low",
    "status": "confirmed",
    "domain": "third-party",
    "title": "Notification webhook destination lacks SSRF validation",
    "file": "src/integrations/notifications.js",
    "line": 201,
    "agents": ["claude"],
    "kernel_axiom": "Axiom 9 - treat user-supplied outbound endpoints as SSRF surfaces",
    "attack_vector": "An operator-supplied `notifyUrl` or `NAX_NOTIFY_URL` can target any URL, including internal or link-local addresses.",
    "impact": "Bounded SSRF risk because dashboard mutation allowlists do not expose `notifyUrl`; exploitation requires operator configuration or a future network-reachable setter.",
    "evidence": "`postWebhook` sends to the provided URL at line 201. `resolveNotifyUrl` reads options/env, while dashboard `normalizeDryRunOptions` does not include `notifyUrl`.",
    "recommended_fix": "If notification URLs become remotely configurable, validate scheme and host, block private/link-local ranges, and consider an allowlist.",
    "verification": "Confirm no network-reachable API accepts `notifyUrl`; if that changes, verify private IP and non-HTTP(S) destinations are rejected.",
    "regression_test": "Add tests proving dashboard workflow-start bodies cannot set `notifyUrl`, and add URL validation tests if remote configuration is introduced.",
    "confidence": "high"
  }
]
```

## Ranked Findings

1. **High confirmed: GitHub workflow guard checks the wrong actor** at `.github/workflows/netlify-agents.yml:41`. This is the highest practical risk because it affects public-repo CI with write permissions and secrets.
2. **High confirmed: Scaffolded template propagates the same guard bypass** at `src/templates/netlify-agents.yml:41`. This expands the blast radius to repositories initialized from the tool.
3. **High needs-runtime-validation: Hosted dashboard forwards arbitrary runner IDs** at `src/dashboard/transports/netlify-api.js:482`. The missing local object authorization is clear; the exact cross-project impact depends on Netlify API token scope and upstream runner checks.
4. **Medium confirmed: Dashboard session cookie lacks `Secure`** at `src/dashboard/api/auth.js:56`. Risk applies most strongly to hosted/web deployments.
5. **Medium confirmed: Symlink escape in local file opener** at `src/dashboard/runtime/local-files.js:22`. Exploitation requires malicious local repository content and operator interaction.
6. **Low confirmed: Dashboard token accepted in query string** at `src/dashboard/api/auth.js:20`. This is a side-channel leakage risk rather than an auth bypass.
7. **Low confirmed: Offloaded blobs lack enforced retention** at `src/workflows/prompts/offload.js:222`. Access still depends on site blob credentials.
8. **Low confirmed: `nax ci` uses `shell: true`** at `src/cli/commands/ci.js:70`. Current inputs are operator-trusted, so this is a latent sink.
9. **Low confirmed: Notification webhook lacks SSRF validation** at `src/integrations/notifications.js:201`. Current configurability is operator-side only.

## Attack Chains

Defensible chain: an untrusted GitHub user comments on a trusted maintainer's issue or pull request, bypasses the workflow actor guard, and triggers a privileged agent run with repository write permissions and Netlify secrets. The first step is confirmed in repository code; the final impact depends on `agent-runner-action` behavior and prompt/tool restrictions.

Defensible chain needing runtime validation: a dashboard-token holder obtains or guesses a remote runner ID, uses hosted dashboard APIs to fetch runner details/events, then cancels that runner. The local code lacks ownership checks; the chain's full cross-project scope depends on Netlify API enforcement.

No stronger chain combining query-string token leakage, missing `Secure`, and hosted runner object authorization was accepted because the audits did not establish a concrete token theft path in the deployed runtime.

## Disputed Or Rejected Findings

Stored XSS through markdown rendering was rejected. No exploitable sink was confirmed, and the audits noted sanitizing renderer/CSP protections.

CSRF on dashboard mutations was rejected. `SameSite=Strict`, lack of permissive CORS, and the unreadable bearer token make a practical cross-site mutation path unsupported by the reviewed code.

Path traversal through ordinary `../` paths was rejected. `path.resolve` plus `path.relative` containment blocks simple traversal; only the symlink realpath variant was accepted.

`style-src 'unsafe-inline'` in CSP was demoted/rejected as a standalone vulnerability. `script-src` remains `'self'`, and no concrete style-injection-to-impact path was shown.

Missing HSTS was not kept as a separate finding. It is best handled with the missing `Secure` cookie issue for hosted deployments.

Billing bypass, subscription/entitlement bypass, OAuth callback abuse, database row-level isolation, webhook forgery, and file upload issues were rejected as not applicable to this repository snapshot.

Generic "no rate limiting" concerns were rejected for the local single-operator dashboard and authenticated hosted endpoints absent a concrete expensive unauthenticated path.

## Remediation Roadmap

Immediate: fix both GitHub workflow guards with event-specific actor checks, add policy tests for untrusted comment/review actors, and add hosted runner allowlist checks before any Netlify API read/cancel operation.

This week: add hosted/web cookie hardening with `Secure` and HSTS where appropriate, canonicalize or reject symlinks in `openLocalFile`, and remove persistent query-token authentication outside a one-time bootstrap flow.

This sprint: add blob retention/cleanup for offloaded prompts/results and document sensitivity; constrain `nax ci` trusted input expectations; keep `notifyUrl` out of dashboard-start bodies and add validation before any remote configurability.

Backlog: evaluate nonce/hash-based style CSP if the UI stack supports it, add security audit logs for sensitive hosted runner operations, and document expected Netlify API-side runner scoping assumptions.

## Regression Prevention

Add workflow-policy tests for every GitHub event the workflow supports, especially cases where the issue/PR author is trusted but the triggering comment/review actor is untrusted.

Add hosted transport object-authorization tests that assert unregistered runner IDs cannot be read, detailed, streamed, canceled, or used for follow-up cancellation, and that remote runner metadata must match the configured site/source.

Add cookie/header tests for web and local modes covering `Secure`, `HttpOnly`, `SameSite=Strict`, `Path`, HSTS, and the intended bootstrap behavior.

Add local file tests for symlink escapes, normal in-root files, missing files, and non-file/non-directory paths.

Add blob lifecycle tests for completed runs and static checks or unit tests preventing `notifyUrl` and `nax ci` command text from crossing from network-controlled inputs into sensitive sinks.
