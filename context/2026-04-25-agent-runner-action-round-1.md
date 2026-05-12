# Round 1 Outputs

## Claude (#8)

Source issue: https://github.com/netlify-labs/agent-runner-action/issues/8  
Result comment: https://github.com/netlify-labs/agent-runner-action/issues/8#issuecomment-4320323805

Pinned SHA reviewed:

- `091e1e4cba36d8e3ee5f2c90984ac0ade5259e50`

Key findings:

- README drift: `README.md` documents `act:*` maintainer scripts that do not exist in `package.json`.
- Framework detection in `action.yml` uses broad substring `grep`s against `package.json`, which can misidentify frameworks from incidental dependency names.
- The docs-drift checker does not validate the live dogfood workflow `.github/workflows/netlify-agents.yml`, so the real workflow can drift from the published examples/templates unnoticed.
- In-progress status comment PATCH failures are fully swallowed in `action.yml`, masking auth/network/comment-write failures.
- Deploy URL validation drops anything not exactly HTTP `200`, which can hide usable previews behind redirects or transient statuses.
- Lower-priority drift/polish concerns:
  - duplicated bot blocklist between workflow and code
  - stale step numbering in `action.yml`
  - README typo-alias list lags behind code
  - hardcoded `actor: david` default in the dogfood workflow
  - duplicated trigger alias regex in PR-title cleanup
  - dry-run keyword detection only checks the first line

Claude's strongest defect calls:

1. Missing `act:*` scripts in README/package.json mismatch
2. Incorrect framework detection by broad substring matching
3. Missing docs-drift coverage for the dogfood workflow
4. Silent failure swallowing in status-comment PATCH
5. Overly strict deploy URL validation

## Gemini (#9)

Source issue: https://github.com/netlify-labs/agent-runner-action/issues/9  
Issue result comment: https://github.com/netlify-labs/agent-runner-action/issues/9#issuecomment-4320323823  
PR opened by run: https://github.com/netlify-labs/agent-runner-action/pull/11  
Cross-posted PR result comment: https://github.com/netlify-labs/agent-runner-action/pull/11#issuecomment-4320335268

Pinned SHA reviewed:

- `091e1e4cba36d8e3ee5f2c90984ac0ade5259e50`

Key findings:

- Critical bash/jq bug in `action.yml:911`: `SESSION_HAS_DIFF=$(jq -r '.has_result_diff // .has_diff // empty')` collapses explicit boolean `false` to empty, which can cause the action to fall back to `RUNNER_HAS_DIFF` and potentially commit even when the latest session had no diff.
- `timezone` input is not passed to the steps that generate in-progress/success/error comments, so the new human-readable timestamp work is only partially applied.
- `src/utils.js` still leaves `via https://...` prompt-source URLs inside cleaned prompt blocks after the newer “See full prompt” link behavior, which is mostly polish.
- Structural recommendation: move the longest inline bash/jq business logic out of `action.yml` into testable Node helpers.

Gemini's strongest defect calls:

1. Broken session diff false-handling in `action.yml`
2. Missing `TZ` propagation to multiple comment-generation steps

## Codex (#10)

Source issue: https://github.com/netlify-labs/agent-runner-action/issues/10  
Result comment: https://github.com/netlify-labs/agent-runner-action/issues/10#issuecomment-4320323972

Pinned SHA reviewed:

- `091e1e4cba36d8e3ee5f2c90984ac0ade5259e50`

Key findings:

- Critical authorization concern in `src/check-trigger.js`: users with GitHub `CONTRIBUTOR` association are treated as trusted enough to start privileged agent runs, which is looser than the documented collaborator-only trust model.
- `allowed-users` is not enforced as a strict allowlist for normal issue/PR/review triggers; it only participates in a limited workflow_dispatch path.
- Preflight validates the default agent, not necessarily the selected workflow_dispatch agent, so bad manual agent values can bypass early validation.
- `generate-history-comment.js` assumes sessions JSON is iterable even though fixtures already model the object shape `{ "sessions": [...] }`.
- `action.yml` writes `agent-title` to `GITHUB_OUTPUT` as a single-line echo even though titles may contain newlines/control characters.
- README still documents `act` scripts that do not exist.

Codex's strongest defect calls:

1. Over-trusting `CONTRIBUTOR` association in trigger authorization
2. `allowed-users` not acting like a real allowlist on most event types
3. Preflight validating default agent instead of selected agent
4. History comment generator shape mismatch on session payloads
5. Potential multiline corruption when writing `agent-title` to `GITHUB_OUTPUT`

## Human Notes

Shared context for round 2:

- All three reviews reported `state_match: yes` for the same pinned SHA:
  - `091e1e4cba36d8e3ee5f2c90984ac0ade5259e50`
- The highest-signal overlap across the three reports is not broad style critique. It clusters around:
  - workflow/action correctness bugs in `action.yml`
  - trust / authorization drift in trigger handling
  - docs/workflow drift
  - shell/JSON shape brittleness in comment/session handling
- Important process note:
  - Gemini still opened PR `#11` even though the prompt explicitly said review-only / do not open or update PRs.
  - Treat PR `#11` as **unmerged side-effect output**, not as code that exists in the pinned review SHA.
  - Cross-review should judge Gemini's findings on their evidence, but should not assume PR `#11` is merged unless explicitly verified against the pinned SHA.
- What round 2 should do:
  - identify each model's own first-round position
  - evaluate the other two models, not just summarize them
  - separate true defects from polish
  - explicitly reject weak claims
  - keep PR merge state separate from review conclusions
