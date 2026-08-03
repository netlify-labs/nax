# Agent Runner SDK live contract evidence

Recorded on 2026-08-02 against dedicated disposable resources:

- Netlify team/site: `netliclaw/agent-sdk-canary`
- GitHub repository: `netlify-labs/agent-sdk-canary`
- Evidence fixture:
  `packages/agent-runner-sdk/test/fixtures/contracts/live-v1-2026-08-02.json`

The repository and site remain as the dedicated canary fixture. Probe runners
were archived, the generated branch was deleted, the pull request was merged,
and `main` was restored to the original canary content.

## Verified contracts

- Runner create/get/list/cancel use the snake-case
  `/api/v1/agent_runners` routes. Runner cancellation is `DELETE` and returns
  an empty `202`.
- Site-scoped list queries accept `site_id`, `account_id`, Unix-second
  `from`/`to`, `page`, and `per_page`. Responses carry `Total` and RFC-style
  `Link` headers. Supplying the same time values as milliseconds matched
  nothing.
- The backend caps `per_page` at 100. A live account query requesting 101
  returned 100 rows.
- Runner lists are descending by `last_session_created_at`. Creating a
  follow-up on the older of two runners moved it to the first position.
- Account-scoped
  `GET /api/v1/{account_slug}/agent_runners` works when the account feature is
  enabled and returns a distinct account projection. It returned `404` for
  the canary team because that team does not have the account-list feature;
  site-scoped access remained available.
- Session create/get/list/cancel use nested snake-case routes. The default
  session list is oldest-first, matching `order_by=asc`; `order_by=desc`
  reverses it. Session cancellation returns an empty `202`.
- A second session create while one is active returns `409` with
  `error_code: active_session_exists`.
- The reserved request marker survived exactly once in both initial and
  follow-up session prompts.
- The fresh GitHub-backed site exposed
  `build_settings.installation_coding_id` as an integer for the org-wide
  `netlify-coding` installation.
- Direct `pull_request` changed `pr_is_being_created` from `true` to `false`
  and populated `pr_url`, `pr_number`, `pr_branch`, and `pr_state`.
- Each session exposes its own `commit_sha`. A newer completed session had a
  null `commit_sha` while runner `merge_commit_sha` still held the prior
  session's SHA, proving that runner-level state cannot short-circuit current
  session landing.

## Netlify Git publish source contract

The production-publish boundary was verified on 2026-08-03 against
`netlify/bitballoon` `origin/main` at
[`cf79de11`](https://github.com/netlify/bitballoon/tree/cf79de118d63b2d2b98d01a1612d4de5100c9997):

- `POST /api/v1/agent_runners/{id}/publish_to_production` returns the reloaded
  runner with HTTP `200` after enqueue.
- The model admits only `code_origin == "netlify-git"` with a resolved diff
  and uses an atomic `merge_commit_is_being_created` guard.
- An already-active publish returns HTTP `400` with the exact backend error
  `Publish to production already in progress`. The HTTP transport normalizes
  only that message to `publish-in-progress`; unrelated `400` responses remain
  landing failures.
- The publish worker pushes the production branch and a ready production
  deploy marks the attributable Agent Runner session `is_published: true`.
  That exact current-session field is the SDK completion proof. Runner
  `merge_commit_sha` is linkage/state, not publication proof.
- A session `deploy_url` is optional, so `LandingOutcome` includes it only
  when the session serializer exposes one.

## Corrections to the reviewed plan

Three previously assumed wire details differed from the live services:

1. GitHub's merge endpoint returned `409 Conflict` for a deliberately
   mismatched expected-head `sha`, not `422`. The PR remained open with the
   same head. Repeating the request with the observed head merged it.
2. Sessions serialize `commit_sha` but not `merge_commit_error`. Commit errors
   and `merge_commit_is_being_created` are runner-level fields.
3. Runner payloads expose canonical `code_origin`, not `git_host`.
   Git-provider identity is available as site `build_settings.provider` and
   account-list `site_git_provider`.

The SDK transport and landing state machine must encode these observed
contracts. General HTTP `422` validation handling remains necessary, but a
GitHub expected-head mismatch is classified from `409`.

## Safety and provenance

The fixture contains no authorization headers, PATs, GitHub tokens, full
prompt/result bodies, blob instructions, or raw response headers. Resource
identifiers and commit SHAs are replaced with stable placeholders. The marker
shape is retained because its exact server-visible serialization is itself
part of the contract.
