---
title: Audit Security
description: Independently inspect the codebase for exploitable security issues.
instruction: perform a deep SaaS/web application security audit and report concrete vulnerabilities with file references
---

# Security Audit

This run is analysis-only. Do not edit files, stage files, commit, or open PRs.

Remote Agent Runner cannot load local skills dynamically, so this prompt embeds the core `security-audit-for-saas` protocol directly. Treat it as a cognitive toolkit, not a simple checklist.

## Repository State

Before substantial analysis:

1. Run `git rev-parse HEAD` and compare it with the pinned SHA in Additional Context.
2. If the checked-out SHA differs by a small fast-forward from the same branch, continue and mention the drift.
3. If the checkout is unrelated, on a different branch, or more than about 5 commits away, stop and report the mismatch.
4. Run `git status --short` before finishing. If your own actions changed files, revert them before answering.

## Phase 1: Threat Model And Surface Map

Build this map before reporting findings:

- Crown jewels: customer data, payment state, subscriptions, tenant data, admin credentials, secrets, source code, generated artifacts, model/tool outputs, logs, backups, and trust-sensitive metadata.
- Attacker personas: unauthenticated visitor, free user, paid user, org member, org admin, financial fraudster, competitor, compromised integration, malicious webhook sender, disgruntled insider, and CI/build supply-chain attacker.
- Entry points: public pages, API routes, serverless functions, webhooks, OAuth callbacks, checkout callbacks, cron jobs, queues, admin panels, CLIs, import/export, file upload/download, OG/image endpoints, health/debug endpoints, old API versions, scripts, tests that may run in production, and third-party callbacks.
- Trust boundaries: browser -> edge/proxy -> route/middleware -> service/domain logic -> database/storage/cache -> third-party APIs -> logs/analytics.
- Security properties that must hold: who can read/write each sensitive object, what grants paid access, what proves identity, what proves tenant membership, what validates third-party events, and what happens when dependencies fail.

## Phase 2: Security Kernel

Apply every axiom below. If an axiom may be violated, investigate until you can confirm or reject it.

1. Every fail-open is a possible bypass. If Redis, DB, Stripe, PayPal, JWKS, OAuth, cache, rate limiter, or subscription service fails, auth/billing/rate-limit/tenant checks must not silently allow unsafe access.
2. Duplicate parsers diverge. Proxy, middleware, route handlers, schemas, URL validators, CORS/CSRF checks, and frontend/backend validators must not interpret the same input differently.
3. Normalize before validate. Paths, URLs, emails, filenames, domains, unicode, casing, whitespace, encodings, symlinks, and trailing slashes need canonical form before validation and action.
4. Self-heal down, never up. Reconciliation, sync, migration, and cron code must not re-add revoked admin flags, subscriptions, roles, seats, or entitlements without a secure source of truth and audit trail.
5. Every error can be an oracle. Auth, reset, invite, promo, subscription, and tenant endpoints should not reveal existence, state, roles, plan, provider, or internal schema through messages, status codes, timing, or logs.
6. Presence-only header checks are worthless. Do not trust `Authorization`, `X-Admin`, `X-User`, `X-Forwarded-*`, `CF-Access-JWT-Assertion`, or similar headers without cryptographic verification and trusted proxy assumptions.
7. Recovery paths are a shadow codebase. Webhook replay, reconciliation, admin override, migration, restore, DLQ, and batch repair paths must re-enforce signature, authorization, idempotency, tenant, and audit invariants.
8. Attack surfaces expand faster than defenses. Enumerate all surfaces before auditing any one surface deeply.
9. Prices, identities, roles, org IDs, plan IDs, feature flags, and entitlements are server-side. Client-submitted authority values are attacker-controlled.
10. Multi-tenancy needs data-layer and app-layer checks. RLS alone is insufficient when service roles exist; app checks alone are insufficient when one handler forgets them.

## Phase 3: Domain Sweep

Work through these domains in priority order. If the project has no relevant surface, mark the domain `N/A` with evidence rather than inventing findings.

### 1. Payment And Billing

Question: can a user get paid value without paying, hijack a subscription, underpay, over-credit, or keep access after refund/cancellation?

- Stripe/PayPal/webhook signatures verified using provider APIs and raw bodies where required.
- Event ID deduplication enforced with durable uniqueness, not only memory.
- Checkout prices, plan IDs, coupon/promo rules, seat counts, and credits are server-derived.
- PayPal `custom_id`, Stripe metadata, `client_reference_id`, `customer`, `subscription`, and `payer_id` identity chains are cross-verified.
- Checkout and seat changes are protected against races with transactions, locks, constraints, and idempotency keys.
- Subscription state machine rejects unknown provider statuses and does not write unsafe "none" or active states silently.
- Pending checkout state, cache, dashboard state, and entitlement checks update consistently after provider events.
- Dunning, refunds, chargebacks, reconciliation, replay, and recovery paths preserve the same invariants.

### 2. Auth And Authorization

- Every sensitive route/action requires auth at the actual resource being accessed.
- RBAC/ABAC checks use the target resource/org, not default org or stale session claims.
- Permission checks that guard writes are inside the transaction or otherwise protected from TOCTOU.
- OAuth state, nonce, redirect URI, PKCE/device flow, SSO, and callback validation are enforced.
- Session cookies use secure, httpOnly, sameSite, scoped domains, and safe expiration.
- Secret/token/hash/HMAC comparisons are timing-safe.
- Auth endpoints have abuse controls without unsafe fail-open behavior.

### 3. Entitlements And Feature Gating

- Server actions and API handlers enforce paid tiers, not just UI.
- Cache staleness, grace periods, cancellation windows, trials, provider outages, and org-only users cannot create free access.
- Entitlement decisions have one authoritative source or a clearly consistent cache invalidation path.
- Unknown subscription or provider states fail safely and log operationally useful signals.

### 4. Secrets And Key Management

- No real secrets in git, public assets, client bundles, logs, screenshots, health endpoints, issue templates, or generated artifacts.
- Environment access is centralized where the stack supports it.
- Only explicitly public env vars reach client code.
- Service-role/admin keys are isolated to server-only code and narrow helper functions.
- Health/debug endpoints redact secrets and do not reveal suffixes useful for matching leaked keys.

### 5. Database And Data Access

- Tenant/user tables have RLS or equivalent data-layer controls where applicable.
- Mutations have both read and write constraints, including `WITH CHECK`-equivalent protections.
- Service-role/admin clients are fenced by app-layer checks and audited.
- Raw SQL, query builders, filters, sort keys, and search are parameterized and bounded.
- Migrations/backfills do not create unsafe defaults, privilege escalation, or invariant breaks.

### 6. Web Security

- Redirects use a shared safe redirect helper and reject protocol-relative or external redirects unless intentionally allowlisted.
- SSRF-prone URLs are validated at configuration time and delivery time, including private IP/DNS rebinding defenses where relevant.
- User-generated markdown/HTML/model output is sanitized with allowlists before rendering.
- CSRF, CORS, CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame protections, and cookie settings are appropriate.
- File upload/download paths validate MIME, extension, size, storage key, authorization, and content-disposition.

### 7. Infrastructure And Operations

- Rate limiting, locks, queues, caches, and sessions are durable enough for serverless/cloud deployment, not process-local when that breaks security.
- Shell/process execution passes separate args and never concatenates untrusted strings.
- Batch processors paginate safely and respect serverless timeout budgets.
- Logs are useful for incident response without leaking PII or secrets.
- Deployment/build/CI workflows do not expose secrets to forks, PRs, untrusted scripts, or logs.

### 8. Rate Limiting And Abuse

- Auth, token exchange, checkout, webhooks, expensive AI/API calls, file uploads, exports, and public forms have endpoint-appropriate limits.
- Redis/cache outages do not become unlimited brute force or cost-exhaustion.
- Webhooks and trusted system sources are exempted deliberately, not by broad allowlists attackers can spoof.
- Abuse signals include multiple dimensions, not one fragile metric.

### 9. Multi-Tenant Isolation

- Every tenant-scoped read/write derives tenant from server-verified membership.
- Cache keys, object storage keys, analytics queries, exports, counts, search indexes, and background jobs include tenant boundaries.
- Shared/public resources have explicit visibility and ownership rules.
- Aggregate data does not leak competitor or tenant information by inference.
- Tests or fixtures cover at least two tenants where practical.

### 10. Third-Party Integrations

- Every webhook/callback is cryptographically verified.
- OAuth/SSO provider responses are validated and secrets are not logged.
- External API keys are scoped, rotated, server-only, and not bundled.
- User-supplied outbound endpoints are treated as SSRF surfaces.
- Provider outage/retry behavior is safe and idempotent.

### 11. Data Security And Privacy

- PII, sensitive data, secrets, and public data are distinguishable in code and logs.
- Sensitive exports, backups, analytics, screenshots, and support tooling are access controlled.
- Deletion, retention, and data portability paths are complete enough for the product's promises.
- Error messages, telemetry, and traces avoid PII/secrets.

### 12. Incident Response And Forensics

- Security-relevant actions have enough audit trail: actor, action, resource, tenant, result, timestamp, request id, IP/user agent where appropriate.
- Admin actions and entitlement changes are especially auditable.
- There are practical ways to detect billing bypass, tenant leaks, auth abuse, and webhook failures.
- Rollback/disable switches exist for dangerous integrations where appropriate.

### 13. Audit Logging And Compliance

- Audit log writes are append-only or tamper-resistant where required.
- Failures to write audit logs are handled intentionally.
- Compliance queries can answer who did what, when, from where, and to which resource.
- Retention policy is explicit where compliance or privacy requires it.

### 14. LLM And AI-Specific Security

If the app uses LLMs or agents:

- Prompt injection is assumed; tool calls re-check authorization at execution time.
- LLM output is untrusted and validated/sanitized before storage, display, or downstream tool use.
- Context mixes trusted and untrusted data with clear boundaries.
- Token/cost abuse is rate limited and tenant/user scoped.
- Agent runners cannot access secrets or production actions beyond intended scope.

### 15. API Security

- Every route validates input with strict schemas or equivalent.
- Unknown fields are rejected, not passed through.
- Updates use explicit allowlists or field-by-field assignment, not raw body spreads.
- Responses mask internal fields such as hashes, provider IDs, internal roles, secrets, and notes.
- Pagination is bounded, preferably cursor-based for large data.
- Idempotency keys are honored on retried writes.
- Error responses are stable and do not leak schema, stack traces, library versions, or tenant existence.

## Phase 4: Operator Chains

Apply these thinking moves to promising surfaces:

- Surface-Transpose: for each sensitive feature, list UI, API, webhook, CLI, import, cron, admin, old version, debug, and test-only paths. Find the weakest authorization.
- Shadow-Codebase Scan: find deprecated, old, test, backup, commented, or undocumented paths that still compile or deploy.
- Invariant-Extract: for each security mechanism, list what must be true about network, client, storage, timing, and config. Attack each assumption.
- Normalize-First plus Parser-Diverge: find validation/action mismatches and inconsistent parsing between layers.
- Mass-Assignment Probe: find every write route where client fields can become DB fields.
- Identity-Chain Trace: trace JWT/session/provider metadata/custom IDs through to writes and grants.
- Tenant-Leak Probe: try to make Tenant A read, modify, infer, export, cache-hit, or search Tenant B data.
- Self-Heal-Up Detector: grep for writes to role, admin, subscription, plan, tier, entitlement, or permissions. Any automatic privilege increase needs scrutiny.
- Fail-Open Probe: for each dependency, find the failure handler and classify fail-open vs fail-closed.
- Recovery-Path Walk: compare primary invariants against replay, repair, migration, cron, restore, admin override, and DLQ paths.
- Timing/Error Oracle Hunt: inspect endpoints where state can be inferred by response, timing, or logs.
- Attack-Chain Composer: combine low/medium findings into multi-step exploit chains.
- Impossible-Question Probe: ask 5-10 questions you think should be impossible, then search the code for the answer.

## Useful Grep Patterns

Adapt these to the stack and file types:

```bash
rg -n "constructEvent|webhooks\.construct|verify-webhook-signature|paypal-transmission" .
rg -n "body\.(amount|price|unit_amount)|req\.body\.(amount|price)|price_id|plan_id|custom_id|client_reference_id" .
rg -n "ON CONFLICT|idempotency|payment_events|FOR UPDATE|advisory|forUpdate" .
rg -n "requireAdmin|requireUser|requireAuth|requireOrg|isAdmin|role|permission|policy" .
rg -n "csrf|CSRF|origin|referer|validateOrigin|sameSite|httpOnly|secure" .
rg -n "timingSafeEqual|timingSafeCompare|(secret|token|key|hash|hmac)\s*[!=]=" .
rg -n "process\.env\.|NEXT_PUBLIC_|SERVICE_ROLE|service_role|sk_live|sk_test|whsec_|password|secret" .
rg -n "ENABLE ROW LEVEL SECURITY|CREATE POLICY|USING\s*\(true\)|TO anon|TO public|CREATE TABLE" .
rg -n "redirect\(|returnTo|returnUrl|redirect_uri|callback_url|Location" .
rg -n "dangerouslySetInnerHTML|innerHTML|rehype-sanitize|DOMPurify|sanitize" .
rg -n "Access-Control-Allow-Origin|Content-Security-Policy|Strict-Transport-Security|X-Frame-Options" .
rg -n "new Map\(\)|new Set\(\)|child_process|execSync|exec\(|spawn\(" .
rg -n "db\.update|\.set\(.*body|Object\.assign|\.passthrough\(|\.strict\(" .
```

Do not treat grep hits as findings by themselves. Use them to choose code paths for manual validation.

## Severity

- Critical: direct data breach, tenant isolation break, auth bypass, billing bypass, subscription hijacking, secret exposure enabling compromise, remote code execution, or unsafe fail-open on auth/billing/rate-limit paths.
- High: practical privilege escalation, serious CSRF/SSRF/XSS, webhook forgery, TOCTOU in sensitive writes, broad data exposure with constraints, or exploitable mass assignment.
- Medium: real security weakness with limited scope, missing defense-in-depth on sensitive paths, stale entitlement risk, weak auditability for important actions, or bounded DoS/cost exhaustion.
- Low: hardening, best practice, narrow information leak, missing header with limited impact, or unproven but plausible risk.

## Output

Start with:

```markdown
## Repository State
- pinned_sha:
- checked_out_sha:
- state_match: yes | minor_drift | no
- git_status_clean: yes | no

## Threat Model And Surface Map

## Domains Audited
| Domain | Status | Findings | Notes |
```

Then emit `## Structured Findings` as fenced JSON using this exact shape:

```json
[
  {
    "id": "SEC-1",
    "severity": "critical",
    "status": "confirmed",
    "domain": "billing",
    "title": "Short title",
    "file": "path/to/file.ts",
    "line": 123,
    "kernel_axiom": "Axiom 9 - server-side authority",
    "attack_vector": "How an attacker exploits it",
    "impact": "Revenue loss / data exposure / privilege escalation / DoS",
    "evidence": "Concrete code-grounded evidence",
    "recommended_fix": "Specific fix",
    "verification": "How to prove the fix",
    "confidence": "high"
  }
]
```

After the JSON block, include prose sections:

- `## Critical Findings`
- `## High Findings`
- `## Medium Findings`
- `## Low Findings`
- `## Positive Findings`
- `## Attack Chains Considered`
- `## Items Considered And Rejected`
- `## Regression Tests To Add`

Rules:

- Every non-rejected finding needs `file:line`.
- Distinguish exploitable vulnerabilities from hardening.
- Reject weak findings explicitly rather than padding the report.
- If runtime testing is needed to confirm exploitability, mark status `needs-runtime-validation` and state the exact test.
