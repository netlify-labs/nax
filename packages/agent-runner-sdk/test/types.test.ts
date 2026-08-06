import test from 'node:test'

import { isAgentRunnerSdkError } from '../src/index.js'
import type {
  EffectiveFollowUpInput,
  EffectiveStartInput,
  Handle,
  LandingOutcome,
  MemberInput,
  ReconciliationResult,
  RunHandle,
  RunOutcome,
  RunResult,
  SessionHandle,
  StartInput,
  FollowUpInput,
} from '../src/index.js'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false
type Assert<T extends true> = T

type _StartHasExpectedKeys = Assert<Equal<
  keyof StartInput,
  | 'prompt'
  | 'promptRef'
  | 'siteId'
  | 'agent'
  | 'model'
  | 'effort'
  | 'branch'
  | 'deployId'
  | 'mode'
  | 'fileKeys'
  | 'land'
  | 'deadlineMs'
  | 'retryBudget'
  | 'requestId'
>>

type _FollowUpHasExpectedKeys = Assert<Equal<
  keyof FollowUpInput,
  | 'prompt'
  | 'promptRef'
  | 'agent'
  | 'model'
  | 'effort'
  | 'mode'
  | 'fileKeys'
  | 'requestId'
>>

function inputContractChecks(): void {
  const inline: StartInput = {
    siteId: 'site-1',
    prompt: 'hello',
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    mode: 'normal',
    land: 'auto',
  }
  const referenced: StartInput = {
    siteId: 'site-1',
    promptRef: {
      store: 'store',
      key: 'key',
      tenant: 'tenant',
      expiresAt: Date.now() + 1_000,
    },
  }
  const followUp: FollowUpInput = {
    prompt: 'continue',
    effort: 'max',
    mode: 'ask',
  }
  const effectiveInline: EffectiveStartInput = {
    ...inline,
    requestId: 'request-1',
  }
  const effectiveFollowUp: EffectiveFollowUpInput = {
    ...followUp,
    requestId: 'request-2',
  }

  void referenced
  void effectiveInline
  void effectiveFollowUp

  // @ts-expect-error PromptInput requires exactly one prompt representation.
  const missingPrompt: StartInput = { siteId: 'site-1' }
  // @ts-expect-error PromptInput forbids inline and referenced prompts together.
  const duplicatePrompt: StartInput = {
    siteId: 'site-1',
    prompt: 'hello',
    promptRef: {
      store: 'store',
      key: 'key',
      tenant: 'tenant',
      expiresAt: 10,
    },
  }
  const branchFollowUp: FollowUpInput = {
    prompt: 'continue',
    // @ts-expect-error Follow-ups do not select a branch.
    branch: 'other',
  }
  const deadlineFollowUp: FollowUpInput = {
    prompt: 'continue',
    // @ts-expect-error Follow-ups preserve the original deadline.
    deadlineMs: 1_000,
  }

  void missingPrompt
  void duplicatePrompt
  void branchFollowUp
  void deadlineFollowUp
}

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`)
}

function resultIsExhaustive(result: RunResult): string {
  const usage = result.usage
  void usage
  switch (result.status) {
    case 'succeeded':
      if (result.changes === 'unknown') return 'not proven unchanged'
      return result.resultText
    case 'failed':
      return result.failure.code
    case 'cancelled':
      return result.runnerId
    case 'timedOut':
      return String(result.cancelledRunner)
    default:
      return assertNever(result)
  }
}

function landingIsExhaustive(outcome: LandingOutcome): string {
  switch (outcome.kind) {
    case 'merged':
      return outcome.mergeSha
    case 'prOpen':
      return String(outcome.merged)
    case 'published':
      return outcome.deployUrl ?? ''
    case 'unsupported':
      return outcome.reason
    case 'failed':
      return outcome.failure.code
    case 'skipped':
      return ''
    default:
      return assertNever(outcome)
  }
}

function reconciliationIsExhaustive(
  result: ReconciliationResult<RunHandle>,
): string {
  switch (result.kind) {
    case 'matched':
      return result.handle.runnerId
    case 'none':
      return ''
    case 'ambiguous':
      return result.candidates.map((candidate) => candidate.runnerId).join(',')
    default:
      return assertNever(result)
  }
}

function handleNarrowing(handle: Handle): string {
  if (handle.kind === 'session') {
    const session: SessionHandle = handle
    return `${session.sessionId}:${session.sessionInput.requestId}`
  }
  const run: RunHandle = handle
  return run.currentSessionId
}

function genericOutcomePreservesHandle(
  outcome: RunOutcome<SessionHandle>,
): SessionHandle {
  return outcome.handle
}

function memberInputChecks(): void {
  const commit: MemberInput<'commit'> = { targetBranch: 'agent-change' }
  const archive: MemberInput<'archive'> = {}
  // @ts-expect-error Commit landing always names its target branch.
  const invalidCommit: MemberInput<'commit'> = {}
  // @ts-expect-error Archive accepts no action-specific values.
  const invalidArchive: MemberInput<'archive'> = { sessionId: 'session-1' }
  void commit
  void archive
  void invalidCommit
  void invalidArchive
}

function errorNarrowing(error: unknown): string {
  if (!isAgentRunnerSdkError(error)) return ''
  if (
    error.code === 'create-ambiguous'
    || error.code === 'session-create-ambiguous'
    || error.code === 'session-already-active'
  ) {
    return `${error.effectiveInput.requestId}:${error.window.sentAt}`
  }
  return error.code
}

test('public contract type assertions compile', () => {
  void inputContractChecks
  void resultIsExhaustive
  void landingIsExhaustive
  void reconciliationIsExhaustive
  void handleNarrowing
  void genericOutcomePreservesHandle
  void memberInputChecks
  void errorNarrowing
})
