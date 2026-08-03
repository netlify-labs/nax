import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  recommendRecovery,
  serializeHandle,
} from '../src/index.js'
import type {
  FailureClassification,
  RunHandle,
  Runner,
  Session,
  SessionHandle,
} from '../src/index.js'

const DEADLINE = 2_000_000_000_000

function runHandle(overrides: Partial<RunHandle> = {}): RunHandle {
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: 'claude',
    origin: {
      codeOrigin: 'github',
      branch: 'feature/recovery',
    },
    input: {
      siteId: 'site-1',
      prompt: 'repair the build',
      requestId: '11111111-1111-4111-8111-111111111111',
      land: 'merge',
    },
    policy: {
      landing: 'merge',
      deadlineAt: DEADLINE,
      retryBudget: { capacity: 0 },
    },
    retries: { capacity: 0 },
    currentSessionId: 'session-1',
    ...overrides,
  }
}

function sessionHandle(
  overrides: Partial<SessionHandle> = {},
): SessionHandle {
  return {
    ...runHandle(),
    kind: 'session',
    currentSessionId: 'session-2',
    sessionId: 'session-2',
    sessionInput: {
      prompt: 'apply the follow-up',
      requestId: '22222222-2222-4222-8222-222222222222',
    },
    ...overrides,
  }
}

function runner(overrides: Partial<Runner> = {}): Runner {
  return {
    runnerId: 'runner-1',
    state: 'completed',
    siteId: 'site-1',
    codeOrigin: 'github',
    ...overrides,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    runnerId: 'runner-1',
    sessionId: 'session-1',
    state: 'completed',
    resultText: 'done',
    hasResultDiff: true,
    usage: null,
    ...overrides,
  }
}

function forbiddenFailure(
  overrides: Partial<FailureClassification> = {},
): FailureClassification {
  return {
    category: 'validation',
    code: 'validation-error',
    title: 'Invalid input',
    message: 'Correct the input.',
    remediation: ['Correct the input before a new attempt.'],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate',
    ...overrides,
  }
}

test('ambiguity recovery requires exact-marker reconciliation or manual review', () => {
  const create = recommendRecovery({
    kind: 'createAmbiguity',
    effectiveInput: runHandle().input,
    window: { sentAt: 10, failedAt: 20 },
  })
  assert.deepEqual(create, {
    confidence: 'high',
    recoveryAction: {
      kind: 'reconcileCreate',
      strategy: 'exact-request-marker',
      window: { sentAt: 10, failedAt: 20 },
    },
  })
  assert.doesNotMatch(
    JSON.stringify(create),
    /repair the build|11111111-1111-4111-8111-111111111111/,
  )

  const followUp = recommendRecovery({
    kind: 'sessionAmbiguity',
    serializedHandle: serializeHandle(runHandle()),
    effectiveInput: sessionHandle().sessionInput,
    window: { sentAt: 30, failedAt: 40 },
  })
  assert.deepEqual(followUp, {
    confidence: 'high',
    recoveryAction: {
      kind: 'reconcileSession',
      strategy: 'exact-request-marker',
      runnerId: 'runner-1',
      window: { sentAt: 30, failedAt: 40 },
    },
  })

  const ambiguous = recommendRecovery({
    kind: 'createAmbiguity',
    effectiveInput: runHandle().input,
    window: { sentAt: 10, failedAt: 20 },
    candidateCount: 2,
  })
  assert.deepEqual(ambiguous.recoveryAction, {
    kind: 'manualReview',
    reason: 'ambiguous-candidates',
  })
  assert.throws(
    () => recommendRecovery({
      kind: 'createAmbiguity',
      effectiveInput: runHandle().input,
      window: { sentAt: 20, failedAt: 10 },
    }),
    /finite sentAt <= failedAt/,
  )
})

test('live recovery refreshes exact state and stops only the deadline target', () => {
  const refresh = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle()),
    runner: runner({ state: 'running' }),
    session: session({ state: 'running' }),
    now: 100,
  })
  assert.deepEqual(refresh, {
    confidence: 'high',
    recoveryAction: {
      kind: 'refreshResult',
      runnerId: 'runner-1',
      sessionId: 'session-1',
    },
  })

  const missing = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle()),
    runner: runner({ state: 'completed' }),
    now: 100,
  })
  assert.equal(missing.confidence, 'medium')
  assert.equal(missing.recoveryAction.kind, 'refreshResult')

  const expiredRun = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle({
      policy: {
        landing: 'merge',
        deadlineAt: 50,
        retryBudget: { capacity: 0 },
      },
    })),
    runner: runner({ state: 'running' }),
    session: session({ state: 'running' }),
    now: 50,
  })
  assert.deepEqual(expiredRun.recoveryAction, {
    kind: 'stopAtDeadline',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    target: 'runner',
  })

  const expiredSession = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(sessionHandle({
      policy: {
        landing: 'merge',
        deadlineAt: 50,
        retryBudget: { capacity: 0 },
      },
    })),
    runner: runner({ state: 'running' }),
    session: session({
      sessionId: 'session-2',
      state: 'running',
    }),
    now: 50,
  })
  assert.equal(expiredSession.recoveryAction.kind, 'stopAtDeadline')
  if (expiredSession.recoveryAction.kind === 'stopAtDeadline') {
    assert.equal(expiredSession.recoveryAction.target, 'session')
  }
})

test('GitHub recovery resumes persisted steps and escalates changed heads', () => {
  const firstLanding = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle()),
    runner: runner(),
    session: session(),
    now: 100,
  })
  assert.equal(firstLanding.recoveryAction.kind, 'resumeLanding')
  if (firstLanding.recoveryAction.kind === 'resumeLanding') {
    assert.equal(firstLanding.recoveryAction.step, 'pr')
  }

  const followUp = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(sessionHandle({
      landing: { prUrl: 'https://github.com/netlify-labs/repo/pull/7' },
    })),
    runner: runner({
      prUrl: 'https://github.com/netlify-labs/repo/pull/7',
    }),
    session: session({
      sessionId: 'session-2',
      commitSha: undefined,
    }),
    now: 100,
  })
  assert.equal(followUp.recoveryAction.kind, 'resumeLanding')
  if (followUp.recoveryAction.kind === 'resumeLanding') {
    assert.equal(followUp.recoveryAction.step, 'commit')
  }

  const merge = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle({
      landing: {
        prUrl: 'https://github.com/netlify-labs/repo/pull/7',
        committedSessionIds: ['session-1'],
      },
    })),
    runner: runner({
      prUrl: 'https://github.com/netlify-labs/repo/pull/7',
    }),
    session: session({ commitSha: 'session-sha' }),
    now: 100,
  })
  assert.equal(merge.recoveryAction.kind, 'resumeLanding')
  if (merge.recoveryAction.kind === 'resumeLanding') {
    assert.equal(merge.recoveryAction.step, 'merge')
  }

  const drift = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle({
      landing: {
        prUrl: 'https://github.com/netlify-labs/repo/pull/7',
        expectedPrHeadSha: 'expected-head',
      },
    })),
    runner: runner({
      prUrl: 'https://github.com/netlify-labs/repo/pull/7',
    }),
    session: session({ commitSha: 'session-sha' }),
    pullRequest: {
      url: 'https://github.com/netlify-labs/repo/pull/7',
      state: 'open',
      headSha: 'newer-head',
      merged: false,
    },
    now: 100,
  })
  assert.deepEqual(drift.recoveryAction, {
    kind: 'escalateChangedHead',
    prUrl: 'https://github.com/netlify-labs/repo/pull/7',
    expectedHeadSha: 'expected-head',
    observedHeadSha: 'newer-head',
  })
  assert.equal(
    Object.values(drift.recoveryAction).includes('merge'),
    false,
  )
})

test('origin-specific recovery recognizes complete and resumable landing', () => {
  const publishedHandle = runHandle({
    origin: { codeOrigin: 'netlify-git' },
    policy: {
      landing: 'publish',
      deadlineAt: DEADLINE,
      retryBudget: { capacity: 0 },
    },
    landing: { publishRequested: true },
  })
  const publish = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(publishedHandle),
    runner: runner({ codeOrigin: 'netlify-git' }),
    session: session({ isPublished: false }),
    now: 100,
  })
  assert.equal(publish.recoveryAction.kind, 'resumeLanding')
  if (publish.recoveryAction.kind === 'resumeLanding') {
    assert.equal(publish.recoveryAction.step, 'publish')
  }

  const complete = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(publishedHandle),
    runner: runner({ codeOrigin: 'netlify-git' }),
    session: session({ isPublished: true }),
    now: 100,
  })
  assert.deepEqual(complete.recoveryAction, {
    kind: 'none',
    reason: 'landing-complete',
  })

  const prComplete = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle({
      policy: {
        landing: 'pr',
        deadlineAt: DEADLINE,
        retryBudget: { capacity: 0 },
      },
      landing: {
        prUrl: 'https://github.com/netlify-labs/repo/pull/7',
      },
    })),
    runner: runner({
      prUrl: 'https://github.com/netlify-labs/repo/pull/7',
    }),
    session: session({ commitSha: 'session-sha' }),
    now: 100,
  })
  assert.deepEqual(prComplete.recoveryAction, {
    kind: 'none',
    reason: 'landing-complete',
  })

  const skipped = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle({
      policy: {
        landing: 'none',
        deadlineAt: DEADLINE,
        retryBudget: { capacity: 0 },
      },
    })),
    runner: runner(),
    session: session(),
    now: 100,
  })
  assert.deepEqual(skipped.recoveryAction, {
    kind: 'none',
    reason: 'landing-skipped',
  })

  const incompatible = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle({
      origin: { codeOrigin: 'zip' },
    })),
    runner: runner({ codeOrigin: 'zip' }),
    session: session(),
    now: 100,
  })
  assert.deepEqual(incompatible.recoveryAction, {
    kind: 'manualReview',
    reason: 'incompatible-origin',
  })
})

test('recovery never retries forbidden failures or adopts mismatched live identity', () => {
  const forbidden = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle()),
    runner: runner(),
    session: session(),
    failure: forbiddenFailure(),
    now: 100,
  })
  assert.deepEqual(forbidden.recoveryAction, {
    kind: 'manualReview',
    reason: 'forbidden-retry',
  })

  const terminal = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle()),
    runner: runner({ state: 'error' }),
    session: session({ state: 'error' }),
    now: 100,
  })
  assert.deepEqual(terminal.recoveryAction, {
    kind: 'manualReview',
    reason: 'terminal-failure',
  })

  const mismatch = recommendRecovery({
    kind: 'live',
    serializedHandle: serializeHandle(runHandle()),
    runner: runner({ runnerId: 'someone-elses-runner' }),
    session: session(),
    now: 100,
  })
  assert.deepEqual(mismatch.recoveryAction, {
    kind: 'manualReview',
    reason: 'live-identity-mismatch',
  })

  const actionKinds: string[] = [
    forbidden.recoveryAction.kind,
    terminal.recoveryAction.kind,
    mismatch.recoveryAction.kind,
  ]
  assert.equal(actionKinds.includes('retry'), false)
})
