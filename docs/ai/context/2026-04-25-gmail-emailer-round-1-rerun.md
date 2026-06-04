# Round 1 Outputs

Pinned SHA reviewed by all three agents:

- `6ee18af23e5f0b1bc04ea826fe289dbef709ac25`

Important run note:

- No new PRs were opened during this round. All three issue runs remained review-only.
- Claude reported `git_status_clean: no` only because the runner checkout contained a pre-existing untracked `CLAUDE.local.md` harness file. Claude explicitly reported no edits, staging, or commits.

## Claude (#37)

Source issue: https://github.com/netlify-labs/gmail-emailer/issues/37  
Result comment: https://github.com/netlify-labs/gmail-emailer/issues/37#issuecomment-4320401281

Key findings:

- Critical bug in `services/api/src/functions/email/generate.js:338`: regeneration + auto-approve can throw because `emailRecord` is referenced outside the branch where it is declared.
- Likely migration-script safety issue in `services/api/scripts/migrate-nodeid-to-ksuid.js:188`: `PutCommand` then `DeleteCommand` is non-atomic and can leave duplicate or partially migrated action rows.
- Reply payload mismatch between `routes/enrollments.ts` thread and summarize handlers (`metadata.body/category` vs `replyBody/classification.category`), which likely causes one route to silently drop reply text or categories.
- Duplicate cadence helpers between `routes/workflows.ts` and `functions/workflows/enroll.js`, creating schedule drift risk.
- Hot-path waste and cleanup issues:
  - `send.js` reads `SystemConfig.get()` four times per send
  - `generate.js` can key `byStep` counters by KSUID when step resolution fails
  - `ooo-handler.ts` still uses a dead numeric fallback for KSUID node IDs
  - `schedule-email.js` still aliases `step` and `nodeId` with stale numeric JSDoc

## Gemini (#38)

Source issue: https://github.com/netlify-labs/gmail-emailer/issues/38  
Result comment: https://github.com/netlify-labs/gmail-emailer/issues/38#issuecomment-4320401185

Key findings:

- Critical timeout mismatch in `netlify/functions/lib/ai-provider.ts:90`: generation fallback timeouts can exceed Netlify synchronous execution limits, so the platform may 502 before provider fallback finishes.
- High-severity callback contract bug in `netlify/functions/generate-email.ts:31`: validation failures return early and skip the shared async failure callback path, leaving async callers without completion signals.
- Strict-typing violation in `netlify/functions/lib/prompts/outbound-workflow.ts:464`: `Record<string, any>` remains in prompt-building types despite project rules against `any`.
- Prompt polish problem in `outbound-workflow.ts:530`: nested account data values stringify as `[object Object]`.
- Minor AI-context bug in `netlify/functions/summarize-thread.ts:69`: `msg.step || '?'` turns real step `0` into `?`.

## Codex (#39)

Source issue: https://github.com/netlify-labs/gmail-emailer/issues/39  
Result comment: https://github.com/netlify-labs/gmail-emailer/issues/39#issuecomment-4320401225

Key findings:

- Workflow engine still assumes the first array node is always an email in `services/api/src/functions/workflows/enroll.js:284`, so workflows with delay/branch/in-app nodes can invoke email generation on non-email nodes.
- Frontend Message Center cache normalization collapses KSUID node IDs to step 1 in `frontend/src/hooks/queries/useEmails.ts:112`, so multiple drafts in one enrollment can overwrite/remove the wrong cached item.
- Some post-lock send failures leave actions stuck in `delivering` in `services/api/src/functions/email/send.js:212`, with no clean retry path.
- Likely EventBridge reschedule collision risk in `services/api/src/lib/scheduler.ts:44` because retry scheduling reuses deterministic schedule names while the previous one-time schedule may still exist.
- Auth safety concern in `services/api/src/lib/auth.ts:45`: if `JWT_SECRET` is missing or `DISABLED`, auth falls back to decode-only mode instead of failing closed.

## Human Synthesis Notes

Shared themes from this round:

- There are two clusters of concern:
  - workflow-engine / KSUID migration regressions in AWS handlers and frontend review state
  - Netlify AI gateway timeout/callback contract problems
- Claude and Codex both found concrete backend correctness issues that can break production flows.
- Gemini focused much more heavily on the Netlify functions boundary and platform constraints.
- The `emailRecord` regeneration bug from Claude is the clearest high-confidence production correctness issue in this round.
- The non-email-node workflow execution bug from Codex is another high-confidence structural issue if complex workflow graphs are already enabled.
- No round-one reviewer claimed to have fixed anything in code during this run; treat all findings as open unless cross-review disproves them.

What round two should do:

- Each model should identify its own first-round position.
- Each model should evaluate the other two reports, not just summarize them.
- Each model should separate:
  - confirmed still-open issues
  - weak or overstated claims
  - items that are real but lower leverage
- Each model should revise its own position if another reviewer found stronger evidence.
