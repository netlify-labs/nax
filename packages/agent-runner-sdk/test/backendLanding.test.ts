import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  createAgentRunnerSdk,
} from '../src/index.js'
import type {
  EffectiveStartInput,
  LandingMode,
  MemberAction,
  MemberInput,
  MemberResult,
  RunHandle,
  Runner,
  Session,
  SessionHandle,
  Transport,
} from '../src/index.js'

const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FOLLOW_UP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PR_URL = 'https://github.com/netlify-labs/repo/pull/7'

function runner(overrides: Partial<Runner> = {}): Runner {
  return {
    runnerId: 'runner-1',
    state: 'completed',
    siteId: 'site-1',
    branch: 'feature/base',
    codeOrigin: 'github',
    ...overrides,
  }
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    runnerId: 'runner-1',
    sessionId: 'session-1',
    state: 'completed',
    hasResultDiff: true,
    usage: null,
    ...overrides,
  }
}

function fakeTransport(overrides: Partial<Transport> = {}): Transport {
  const unexpected = (operation: string): never => {
    throw new Error(`unexpected transport operation: ${operation}`)
  }
  return {
    createRunner: async () => unexpected('createRunner'),
    createSession: async () => unexpected('createSession'),
    getRunner: async () => unexpected('getRunner'),
    listRunners: async () => unexpected('listRunners'),
    listAccountRunners: async () => unexpected('listAccountRunners'),
    getSession: async () => unexpected('getSession'),
    listSessions: async () => unexpected('listSessions'),
    cancelRunner: async () => unexpected('cancelRunner'),
    cancelSession: async () => unexpected('cancelSession'),
    member: async <A extends MemberAction>(
      _runnerId: string,
      _action: A,
      _input: MemberInput<A>,
    ): Promise<MemberResult<A>> => unexpected('member'),
    ...overrides,
  }
}

function input(landing: LandingMode): EffectiveStartInput {
  return {
    siteId: 'site-1',
    prompt: 'make changes',
    agent: 'claude',
    land: landing,
    deadlineMs: 10_000,
    retryBudget: { capacity: 0 },
    requestId: REQUEST_ID,
  }
}

function runHandle(
  landing: LandingMode,
  overrides: Partial<RunHandle> = {},
): RunHandle {
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: 'claude',
    origin: {
      codeOrigin: 'github',
      branch: 'feature/base',
    },
    input: input(landing),
    policy: {
      landing,
      deadlineAt: 2_000_000_000_000,
      retryBudget: { capacity: 0 },
    },
    retries: { capacity: 0 },
    currentSessionId: 'session-1',
    ...overrides,
  }
}

function sessionHandle(
  landing: LandingMode,
  overrides: Partial<SessionHandle> = {},
): SessionHandle {
  return {
    ...runHandle(landing),
    kind: 'session',
    currentSessionId: 'session-2',
    sessionId: 'session-2',
    sessionInput: {
      prompt: 'follow up',
      requestId: FOLLOW_UP_ID,
    },
    ...overrides,
  }
}

test('first GitHub landing invokes pull_request and returns resumable prOpen state', async () => {
  let memberCalls = 0
  let runnerReads = 0
  const checkpoints: RunHandle[] = []
  const transport = fakeTransport({
    getRunner: async () => {
      runnerReads += 1
      return runnerReads === 1
        ? runner()
        : runner({
            prUrl: PR_URL,
            prBranch: 'agent/runner-1',
            prState: 'open',
            prIsBeingCreated: false,
          })
    },
    getSession: async () => session(),
    member: async <A extends MemberAction>(
      _runnerId: string,
      action: A,
      _input: MemberInput<A>,
    ): Promise<MemberResult<A>> => {
      assert.equal(action, 'pull_request')
      memberCalls += 1
      return runner({ prIsBeingCreated: true }) as MemberResult<A>
    },
  })
  const sdk = createAgentRunnerSdk({
    transport,
    pollIntervalMs: 5,
    now: () => 0,
    sleep: async () => {},
    onLandingCheckpoint: (checkpoint) => {
      assert.equal(checkpoint.kind, 'run')
      checkpoints.push(checkpoint as RunHandle)
    },
  })

  const landed = await sdk.land(runHandle('pr'))

  assert.equal(memberCalls, 1)
  assert.deepEqual(landed.landing, {
    kind: 'prOpen',
    prUrl: PR_URL,
    merged: false,
  })
  assert.equal(landed.handle.landing?.prUrl, PR_URL)
  assert.deepEqual(
    landed.handle.landing?.committedSessionIds,
    ['session-1'],
  )
  assert.equal(checkpoints.length, 1)
  assert.equal(checkpoints[0]?.landing?.prUrl, PR_URL)

  const resumed = await sdk.land(
    sdk.parseHandle(sdk.serializeHandle(landed.handle)) as RunHandle,
  )
  assert.equal(resumed.landing.kind, 'prOpen')
  assert.equal(memberCalls, 1)
})

test('follow-up landing commits the exact current session and ignores a stale runner SHA', async () => {
  const actions: Array<{
    action: MemberAction
    targetBranch?: string
  }> = []
  let runnerReads = 0
  let sessionReads = 0
  const oldSha = 'old-session-sha'
  const currentSha = 'current-session-sha'
  const transport = fakeTransport({
    getRunner: async () => {
      runnerReads += 1
      return runnerReads === 1
        ? runner({
            prUrl: PR_URL,
            prBranch: 'agent/runner-1',
            mergeCommitSha: oldSha,
            mergeCommitIsBeingCreated: false,
          })
        : runner({
            prUrl: PR_URL,
            prBranch: 'agent/runner-1',
            mergeCommitSha: currentSha,
            mergeCommitIsBeingCreated: false,
          })
    },
    getSession: async (_runnerId, sessionId) => {
      assert.equal(sessionId, 'session-2')
      sessionReads += 1
      return sessionReads === 1
        ? session({
            sessionId: 'session-2',
            commitSha: undefined,
          })
        : session({
            sessionId: 'session-2',
            commitSha: currentSha,
          })
    },
    member: async <A extends MemberAction>(
      _runnerId: string,
      action: A,
      memberInput: MemberInput<A>,
    ): Promise<MemberResult<A>> => {
      const targetBranch = action === 'commit'
        ? (memberInput as MemberInput<'commit'>).targetBranch
        : undefined
      actions.push({
        action,
        ...(targetBranch === undefined ? {} : { targetBranch }),
      })
      return runner({
        prUrl: PR_URL,
        prBranch: 'agent/runner-1',
        mergeCommitSha: oldSha,
        mergeCommitIsBeingCreated: true,
      }) as MemberResult<A>
    },
  })
  const sdk = createAgentRunnerSdk({
    transport,
    pollIntervalMs: 5,
    now: () => 0,
    sleep: async () => {},
  })

  const landed = await sdk.land(sessionHandle('pr'))

  assert.deepEqual(actions, [{
    action: 'commit',
    targetBranch: 'agent/runner-1',
  }])
  assert.equal(landed.landing.kind, 'prOpen')
  assert.deepEqual(
    landed.handle.landing?.committedSessionIds,
    ['session-2'],
  )
})

test('landing resumes in-flight PR and commit actions without replaying them', async () => {
  for (const scenario of ['pr', 'commit'] as const) {
    let memberCalls = 0
    let runnerReads = 0
    let sessionReads = 0
    const isPr = scenario === 'pr'
    const transport = fakeTransport({
      getRunner: async () => {
        runnerReads += 1
        if (runnerReads === 1) {
          return isPr
            ? runner({ prIsBeingCreated: true })
            : runner({
                prUrl: PR_URL,
                prBranch: 'agent/runner-1',
                mergeCommitIsBeingCreated: true,
              })
        }
        return runner({
          prUrl: PR_URL,
          prBranch: 'agent/runner-1',
          prIsBeingCreated: false,
          mergeCommitIsBeingCreated: false,
        })
      },
      getSession: async () => {
        sessionReads += 1
        return session({
          sessionId: isPr ? 'session-1' : 'session-2',
          ...(isPr || sessionReads === 1
            ? {}
            : { commitSha: 'current-session-sha' }),
        })
      },
      member: async <A extends MemberAction>(
        _runnerId: string,
        _action: A,
        _input: MemberInput<A>,
      ): Promise<MemberResult<A>> => {
        memberCalls += 1
        return runner() as MemberResult<A>
      },
    })
    const sdk = createAgentRunnerSdk({
      transport,
      pollIntervalMs: 5,
      now: () => 0,
      sleep: async () => {},
    })

    const landed = await sdk.land(
      isPr ? runHandle('pr') : sessionHandle('pr'),
    )

    assert.equal(landed.landing.kind, 'prOpen')
    assert.equal(memberCalls, 0)
  }
})

test('committedSessionIds makes follow-up landing idempotent', async () => {
  let memberCalls = 0
  const handle = sessionHandle('pr', {
    landing: {
      prUrl: PR_URL,
      committedSessionIds: ['session-2'],
    },
  })
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      getRunner: async () => runner({
        prUrl: PR_URL,
        prBranch: 'agent/runner-1',
        mergeCommitSha: 'stale-sha',
      }),
      getSession: async () => session({
        sessionId: 'session-2',
        commitSha: 'current-sha',
      }),
      member: async <A extends MemberAction>(
        _runnerId: string,
        _action: A,
        _input: MemberInput<A>,
      ): Promise<MemberResult<A>> => {
        memberCalls += 1
        return runner() as MemberResult<A>
      },
    }),
  })

  const landed = await sdk.land(
    sdk.parseHandle(sdk.serializeHandle(handle)) as SessionHandle,
  )

  assert.equal(memberCalls, 0)
  assert.equal(landed.landing.kind, 'prOpen')
  assert.deepEqual(
    landed.handle.landing?.committedSessionIds,
    ['session-2'],
  )
})

test('merge-capable landing waits for backend PR and target-sync flags to settle', async () => {
  let runnerReads = 0
  let sleeps = 0
  const sdk = createAgentRunnerSdk({
    transport: fakeTransport({
      getRunner: async () => {
        runnerReads += 1
        return runner({
          prUrl: PR_URL,
          prBranch: 'agent/runner-1',
          mergeCommitIsBeingCreated: runnerReads === 1,
        })
      },
      getSession: async () => session({ commitSha: 'session-sha' }),
    }),
    pollIntervalMs: 5,
    now: () => 0,
    sleep: async () => {
      sleeps += 1
    },
  })
  const handle = runHandle('auto', {
    landing: {
      prUrl: PR_URL,
      committedSessionIds: ['session-1'],
    },
  })

  const landed = await sdk.land(handle)

  assert.equal(sleeps, 1)
  assert.equal(landed.landing.kind, 'prOpen')
})

test('backend landing surfaces PR and current-session commit failures', async () => {
  const prSdk = createAgentRunnerSdk({
    transport: fakeTransport({
      getRunner: async () => runner({
        prError: 'GitHub Coding installation not configured',
      }),
      getSession: async () => session(),
    }),
  })
  const prFailure = await prSdk.land(runHandle('pr'))
  assert.equal(prFailure.landing.kind, 'failed')
  if (prFailure.landing.kind !== 'failed') {
    assert.fail('expected a classified PR landing failure')
  }
  assert.equal(prFailure.landing.step, 'pr')
  assert.equal(prFailure.landing.failure.category, 'permission')
  assert.equal(
    prFailure.landing.failure.code,
    'missing-coding-installation',
  )
  assert.equal(prFailure.landing.failure.stage, 'landing')
  assert.equal(prFailure.landing.failure.retryable, false)

  const commitSdk = createAgentRunnerSdk({
    transport: fakeTransport({
      getRunner: async () => runner({
        prUrl: PR_URL,
        prBranch: 'agent/runner-1',
        mergeCommitSha: 'stale-sha',
        mergeCommitError: 'Failed to apply commit',
      }),
      getSession: async () => session({
        sessionId: 'session-2',
      }),
    }),
  })
  const commitFailure = await commitSdk.land(sessionHandle('pr'))
  assert.equal(commitFailure.landing.kind, 'failed')
  if (commitFailure.landing.kind !== 'failed') {
    assert.fail('expected a classified commit landing failure')
  }
  assert.equal(commitFailure.landing.step, 'commit')
  assert.equal(commitFailure.landing.failure.category, 'landing')
  assert.equal(commitFailure.landing.failure.code, 'commit-to-pr-failed')
  assert.equal(commitFailure.landing.failure.stage, 'landing')
  assert.equal(commitFailure.landing.failure.retryable, false)
})

test('PR polling errors and missing settled URLs fail without replay', async () => {
  for (const settled of [
    runner({
      prIsBeingCreated: false,
      prError: 'GitHub rejected the pull request',
    }),
    runner({ prIsBeingCreated: false }),
  ]) {
    let runnerReads = 0
    let memberCalls = 0
    const sdk = createAgentRunnerSdk({
      transport: fakeTransport({
        getRunner: async () => {
          runnerReads += 1
          return runnerReads === 1
            ? runner({ prIsBeingCreated: true })
            : settled
        },
        getSession: async () => session(),
        member: async <A extends MemberAction>(
          _runnerId: string,
          _action: A,
          _input: MemberInput<A>,
        ): Promise<MemberResult<A>> => {
          memberCalls += 1
          return runner() as MemberResult<A>
        },
      }),
      pollIntervalMs: 5,
      now: () => 0,
      sleep: async () => {},
    })

    const landed = await sdk.land(runHandle('pr'))

    assert.equal(landed.landing.kind, 'failed')
    if (landed.landing.kind === 'failed') {
      assert.equal(landed.landing.step, 'pr')
    }
    assert.equal(memberCalls, 0)
  }
})

test('landing never targets main and reports unsupported and skipped origins', async () => {
  let memberCalls = 0
  const mainSdk = createAgentRunnerSdk({
    transport: fakeTransport({
      getRunner: async () => runner({
        prUrl: PR_URL,
        prBranch: 'main',
      }),
      getSession: async () => session({ sessionId: 'session-2' }),
      member: async <A extends MemberAction>(
        _runnerId: string,
        _action: A,
        _input: MemberInput<A>,
      ): Promise<MemberResult<A>> => {
        memberCalls += 1
        return runner() as MemberResult<A>
      },
    }),
  })
  const main = await mainSdk.land(sessionHandle('pr'))
  assert.equal(main.landing.kind, 'failed')
  if (main.landing.kind === 'failed') {
    assert.equal(main.landing.step, 'commit')
    assert.equal(main.landing.failure.code, 'invalid-pr-branch')
  }
  assert.equal(memberCalls, 0)

  for (const origin of ['zip', 'drop', 'netlify-git']) {
    const originSdk = createAgentRunnerSdk({
      transport: fakeTransport({
        getRunner: async () => runner({ codeOrigin: origin }),
        getSession: async () => session(),
      }),
    })
    const unsupported = await originSdk.land(runHandle('pr'))
    assert.deepEqual(unsupported.landing, {
      kind: 'unsupported',
      reason: `Landing is not implemented for ${origin} runners.`,
    })
  }

  const skipped = await createAgentRunnerSdk({
    transport: fakeTransport(),
  }).land(runHandle('none'))
  assert.deepEqual(skipped.landing, { kind: 'skipped' })
})
