# Round 1 Outputs

Pinned SHA reviewed in every round:

- `6ee18af23e5f0b1bc04ea826fe289dbef709ac25`

Round 1 source issues:

- Claude: https://github.com/netlify-labs/gmail-emailer/issues/37
- Gemini: https://github.com/netlify-labs/gmail-emailer/issues/38
- Codex: https://github.com/netlify-labs/gmail-emailer/issues/39

Key round-1 themes:

- Claude found the clearest backend crash: `services/api/src/functions/email/generate.js` references `emailRecord` outside the branch where it is declared during regenerate + auto-approve.
- Gemini found Netlify AI gateway boundary issues: function timeout budgeting, validation paths that skip async failure callbacks, and prompt-typing/prompt-serialization cleanup.
- Codex found workflow-engine and frontend KSUID regressions: non-email nodes can still be fed to email generation, cached review drafts collapse to step 1, and some send failures leave actions stuck in `delivering`.

# Round 2 Cross Reviews

## Claude Cross Review

Source issue: https://github.com/netlify-labs/gmail-emailer/issues/37  
Prompt comment: https://github.com/netlify-labs/gmail-emailer/issues/37#issuecomment-4320415725  
Result comment: https://github.com/netlify-labs/gmail-emailer/issues/37#issuecomment-4320401281

Important note:

- Claude again reported `git_status_clean: no` only because the runner checkout had a pre-existing untracked `CLAUDE.local.md` harness file. It explicitly reported no tracked edits, no staging, and no commits.

Claude's confirmed high-confidence findings:

1. `services/api/src/functions/email/generate.js:338`
   Auto-approve regeneration can throw a `ReferenceError` because `emailRecord` is only declared in the non-regeneration branch.
2. `services/api/src/functions/workflows/enroll.js:284`
   The workflow engine still dispatches `email-generate` against `workflowNodes[0]` instead of the first actual email action node.
3. `netlify/functions/generate-email.ts:31`
   Validation failures return 400 before the shared async failure callback runs.
4. `services/api/src/functions/email/send.js:213`
   Some post-lock failures leave an action stuck in `delivering`.
5. `frontend/src/hooks/queries/useEmails.ts:112`
   Review-cache normalization collapses KSUID-backed drafts into the same slot.
6. `netlify/functions/lib/ai-provider.ts:90`
   Netlify generation timeout budgeting likely exceeds the synchronous function wall clock.
7. `services/api/src/routes/enrollments.ts:253`
   The summarize route reads reply payloads from the wrong TrackingEvent shape.

Claude's lower-priority but confirmed items:

- `services/api/src/functions/email/send.js:152` repeated `SystemConfig.get()` calls
- `services/api/src/routes/workflows.ts:39` duplicated cadence helpers
- `netlify/functions/lib/prompts/outbound-workflow.ts:530` `[object Object]` prompt pollution
- `services/api/src/functions/email/generate.js:326` KSUID-keyed counters
- `services/api/src/lib/ooo-handler.ts:328` dead numeric fallback
- `services/api/src/lib/schedule-email.js:30` stale `step` alias / numeric JSDoc
- `netlify/functions/lib/prompts/outbound-workflow.ts:464` `Record<string, any>`
- `netlify/functions/summarize-thread.ts:69` `msg.step || '?'`

Claude explicitly rejected:

- deterministic EventBridge schedule-name collision as an active proven bug

## Gemini Cross Review

Source issue: https://github.com/netlify-labs/gmail-emailer/issues/38  
Prompt comment: https://github.com/netlify-labs/gmail-emailer/issues/38#issuecomment-4320415775  
Result comment: https://github.com/netlify-labs/gmail-emailer/issues/38#issuecomment-4320401185

Gemini's ranked consensus findings:

1. `services/api/src/functions/email/generate.js:348`
   Regeneration with auto-approve throws because `emailRecord` is out of scope.
2. `services/api/src/lib/auth.ts:45`
   Missing `JWT_SECRET` falls back to decode-only JWT handling.
3. `frontend/src/hooks/queries/useEmails.ts:112`
   KSUID values collapse to step 1 in cache normalization.
4. `services/api/src/routes/enrollments.ts:247`
   Summarize endpoint drops reply payloads because it reads the wrong event shape.
5. `services/api/src/functions/email/send.js:212`
   Some failed sends remain permanently locked in `delivering`.
6. `services/api/src/functions/workflows/enroll.js:284`
   Enrollment still unconditionally invokes email generation for the first raw node.
7. `netlify/functions/generate-email.ts:31`
   Validation failures skip the async failure callback.
8. `netlify/functions/lib/ai-provider.ts:90`
   Fallback timeouts exceed the Netlify execution budget.
9. `services/api/src/lib/scheduler.ts:44`
   Deterministic EventBridge reschedules may collide.
10. `services/api/scripts/migrate-nodeid-to-ksuid.js:188`
    Migration script uses non-atomic Put + Delete.

Gemini also reaffirmed:

- duplicated cadence helpers in `enroll.js` / `routes/workflows.ts`
- `Record<string, any>` in prompt typing

Gemini explicitly rejected:

- `summarize-thread.ts:69` step `0` label issue as backlog-worthy
- stale numeric JSDoc in `schedule-email.js`
- dead numeric fallback in `ooo-handler.ts`

## Codex Cross Review

Source issue: https://github.com/netlify-labs/gmail-emailer/issues/39  
Prompt comment: https://github.com/netlify-labs/gmail-emailer/issues/39#issuecomment-4320415811  
Result comment: https://github.com/netlify-labs/gmail-emailer/issues/39#issuecomment-4320401225

Codex's confirmed findings after cross-review:

1. `services/api/src/functions/email/generate.js:338`
   Regeneration + auto-approve can crash on `emailRecord`.
2. `services/api/src/functions/workflows/enroll.js:284`
   Enrollment can invoke email generation for the first raw node instead of the first email action node.
3. `frontend/src/hooks/queries/useEmails.ts:112`
   Review-cache normalization collapses KSUID drafts into the same slot.
4. `services/api/src/functions/email/send.js:212`
   Some post-lock send failures leave actions stuck in `delivering`.
5. `netlify/functions/lib/ai-provider.ts:90`
   Netlify AI fallback timeouts likely exceed sync execution limits.
6. `netlify/functions/generate-email.ts:31`
   Validation failures bypass the shared async failure callback path.
7. `services/api/src/routes/enrollments.ts:253`
   Summarize reads reply text/category from the wrong TrackingEvent shape.
8. `services/api/scripts/migrate-nodeid-to-ksuid.js:195`
   Migration can leave duplicate/partially migrated action records if interrupted.
9. `netlify/functions/lib/prompts/outbound-workflow.ts:464`
   `Record<string, any>` remains in prompt typing.

Codex's updated ranking put these at the top:

- `emailRecord` regeneration crash
- first-node workflow dispatch bug
- KSUID draft-cache collision
- stuck `delivering` lock leak
- Netlify timeout-budget and callback-contract issues
- summarize-route metadata mismatch

Codex explicitly rejected:

- EventBridge schedule-name collision as a current proven production bug
- repeated `SystemConfig.get()` as high-priority defect
- stale numeric-step JSDoc as standalone defect

# Human Summary Notes

Clear multi-model convergence:

1. `services/api/src/functions/email/generate.js`
   Regeneration + auto-approve `emailRecord` crash is the strongest consensus item.
2. `services/api/src/functions/workflows/enroll.js`
   The engine still treats the first raw workflow node like an email node.
3. `frontend/src/hooks/queries/useEmails.ts`
   KSUID drafts collide in the review cache.
4. `services/api/src/functions/email/send.js`
   Some post-lock failures leave actions stuck in `delivering`.
5. `netlify/functions/generate-email.ts`
   Validation failures skip the async failure callback.
6. `netlify/functions/lib/ai-provider.ts`
   Netlify timeout budgets likely break the intended provider fallback behavior.
7. `services/api/src/routes/enrollments.ts`
   Summarize thread uses the wrong reply payload fields.

Partial / contested items:

- `services/api/src/lib/auth.ts:45`
  Gemini pushed this to critical because decode-only JWT fallback is real when `JWT_SECRET` is missing, but Claude/Codex treated it as lower-priority hardening because `serverless.yml` does wire `JWT_SECRET` from SSM.
- `services/api/scripts/migrate-nodeid-to-ksuid.js`
  All models that looked at it agreed it is non-atomic, but it is an operational migration-script risk rather than a hot-path production bug.
- `services/api/src/lib/scheduler.ts:44`
  Gemini kept schedule-name collision alive; Claude and Codex rejected it as unproven in the current runtime model.

Workflow-specific observations:

- The rerun succeeded in review-only mode: no new PRs were opened in either round.
- The false linked-PR redirect bug is fixed; all round-two prompts stayed on their issue threads and executed normally.
- The local prompt hardening changes are doing the right thing:
  - no dirty working-tree block in prompt context
  - no local repo-root path leakage
  - explicit review-only / no-commit / no-PR contract
