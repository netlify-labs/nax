# SDK pre-send checkpoint: reconcile ambiguous submissions on resume

Status: DRAFT for review (bead nax-2hq7.21). No code yet.

## Problem

Mid-step resume (v1) stops with `resume_ambiguous_submission` when a submission may exist
remotely but nax never saved a runner id. Two cases reach that stop:

| Case | How it happens today | What nax has saved |
| --- | --- | --- |
| A. Failed response after send | `transport.createRunner` gets a 5xx, a 408/409/425/429 (ambiguous statuses), or a reset after send. The SDK throws `CreateAmbiguousError` (`httpTransport.ts:481-541`). `engine.start` already calls `reconcileCreate` in-process (`engine.ts:700-712`) and only rethrows when the result is `none` or `ambiguous`. nax records `raw.submissionErrorCode = 'create-ambiguous'` (commit d3bf902). | `sentAt`, the error code. **Not** the effective input or window. |
| B. Crash after send | nax (or the laptop) dies between `transport.createRunner` returning and `saveRunState` persisting the handle (`local-executor.js` `submitStepInstance`). | `sentAt` only (`status: pending`). |

In both cases a later reconcile could find the runner exactly: the SDK embeds a request marker
(from `effectiveInput.requestId`) in the delivered prompt, and `reconcileCreate` /
`reconcileSession` match on that marker plus a fingerprint (`reconciliation.ts:333-386`, `401-474`).
Both are already public on the SDK client (`engine.ts:1285-1296`). What nax lacks is the exact
`EffectiveStartInput` / `EffectiveFollowUpInput` (including `requestId`, and `prompt` or
`promptRef` after delivery planning) and a request window. Those are chosen inside `start` and
`followUp` (`prepareStartDelivery`, `engine.ts:489-534`) and never handed to the caller before
the send.

## Proposal

### 1. SDK: `onSubmitCheckpoint` (additive, minor bump 0.3.0 -> 0.4.0)

```ts
export interface SubmitCheckpoint {
  v: 1
  kind: 'create' | 'session'
  runnerId?: string                  // session only: the runner being followed up
  effectiveInput: EffectiveStartInput | EffectiveFollowUpInput
  sentAt: number                     // epoch ms taken immediately before the transport call
  promptDelivery?: PromptDeliveryAttempt  // safe metadata only (kind, bytes, blob ref status)
}

export interface AgentRunnerSdkOptions {
  // ...existing
  onSubmitCheckpoint?: (checkpoint: SubmitCheckpoint) => void | Promise<void>
}
```

- Called once per `start` / `followUp` (and per `retry` that creates), after delivery planning and
  immediately before `submitStartOperation` / `submitFollowUpOperation`. Transport-level
  pre-send retries reuse the same wire input and request id, so one checkpoint covers them.
- Awaited. If the hook throws, the SDK does **not** send and rethrows (fail safe: never send what
  the caller could not record).
- Modeled on `onRetryCheckpoint` / `onLandingCheckpoint` (`engine.ts:138-139`, `1172-1173`).
- Value-safe: `effectiveInput` already lives in the returned handle (`handle.input`), so the hook
  exposes nothing new. Blob fetch commands stay SDK-private, as `promptDeliveryArtifact` does today.

### 2. nax: persist the checkpoint before sending

- `submitLocalAgentRun` passes `onSubmitCheckpoint` through `createNaxAgentRunnerSdk`.
- `submitStepInstance` supplies a callback that sets `run.raw.submitCheckpoint = checkpoint` and
  calls `saveRunState(runState)` before returning. This replaces the bare `sentAt` pre-save with
  a strictly richer one (`sentAt` stays for display and backward compatibility of saved runs).
- On `CreateAmbiguousError` / `SessionCreateAmbiguousError` (case A), also persist
  `error.window` as `raw.submitWindow` so resume uses the SDK's exact window.

### 3. nax resume: a `reconcile` action

`reconcileStepInstances` gains one action for runs that `maybeCreated` today (pending with
`sentAt`, or failed with an ambiguous submission code) **and** have `raw.submitCheckpoint`:

| Reconcile result | Resume action |
| --- | --- |
| `matched` | Adopt the returned handle (`runnerId`, `sessionId`, `sdkHandle`) into the run, then `poll`. No new submission. |
| `none` | Stop with `resume_ambiguous_submission` (unchanged v1 behavior). Per the SDK contract, `none` is not proof of absence (eventual consistency, clock skew), so it needs a human or `--force`. |
| `ambiguous` | Stop with `resume_ambiguous_submission`, listing candidate runner ids. |
| error | Stop with the error (for example `resume_auth_failure`). |

- Window: `raw.submitWindow` when present (case A), else `{ sentAt: checkpoint.sentAt, failedAt: now }`
  (case B; wide but exact because matching is by request marker).
- Follow-ups call `reconcileSession` with the persisted source handle (`run.sdkHandle` of the
  source run, already saved today).
- Runs without a checkpoint (saved before this change) keep the v1 stop.
- The reconcile call happens during planning, so the preview shows `reconcile -> matched runner X`
  before anything is submitted. `planResume` stays pure by taking the reconcile results as input.
  A new async `reconcileAmbiguous(plan, sdk)` step runs between planning and the preview.

## Rollout

1. SDK change + tests in `packages/agent-runner-sdk`, CHANGELOG, version 0.4.0.
2. nax consumes it from the workspace package (no publish needed for nax itself).
3. `npm publish` of `nax-agent-runner-sdk@0.4.0`: **human handoff**.
4. Revenue Engine call sites (`clients/frontend/netlify/functions/lib/ops-agent-runner.ts`,
   `services/ops-stack/src/lib/agent-runner-finisher.ts`,
   `services/api/src/lib/artifact-adapters/site/customization-runner.ts`) need **no change**:
   the hook is optional. Adopting it there is a separate, optional follow-up.

## Tests

- SDK: checkpoint fires before the transport call with the exact wire request id; a throwing hook
  sends nothing; inline start, blob start, inline follow-up, blob follow-up.
- nax (network boundary only, as in `tests/unit/submission-retry.test.js`):
  - crash after send: fake API creates the runner, then the submit callback throws before the
    handle is saved; resume reconciles `matched` and polls with zero new creates.
  - `none`, `ambiguous`, and reconcile error each stop with zero creates.
  - case A: 503 on create with a runner that appears later; resume adopts it.
  - legacy run without a checkpoint keeps the v1 stop.

## Decisions for David

1. **Persisting `effectiveInput`.** It holds the full delivered prompt (inline) or a `promptRef`
   (blob), so inline prompts are stored twice in `workflow.json` (`promptText` plus checkpoint).
   Option: keep only `requestId` and rebuild the effective input from `promptText`, but that fails
   for blob delivery and after compaction. Recommendation: persist it as is.
2. **`none` handling.** Recommendation: keep stopping (SDK contract). Alternative: treat `none` as
   safe after a grace period (for example 10 minutes after `sentAt`), which trades a small duplicate
   risk for fewer manual steps.
3. **Scope of `retry` checkpoints.** Recommendation: also fire on capacity retries that create new
   sessions, so the same reconcile path covers them.
