import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  BasicAgentRunnerSdkError,
  CreateAmbiguousError,
  isAgentRunnerSdkError,
  parseHandle,
  serializeHandle,
} from '../src/index.js'
import type {
  RunHandle,
  SessionHandle,
} from '../src/index.js'

const runHandle: RunHandle = {
  v: AGENT_RUNNER_SDK_HANDLE_VERSION,
  kind: 'run',
  runnerId: 'runner-1',
  siteId: 'site-1',
  agent: 'claude',
  input: {
    siteId: 'site-1',
    prompt: 'Make the requested change.',
    requestId: '44444444-4444-4444-8444-444444444444',
  },
  policy: {
    landing: 'pr',
    deadlineAt: 2_000_000_000_000,
    retryBudget: { capacity: 1 },
  },
  retries: { capacity: 0 },
  currentSessionId: 'session-1',
}

test('run handles round-trip through the versioned serializer', () => {
  const serialized = serializeHandle(runHandle)
  assert.deepEqual(parseHandle(serialized), runHandle)
})

test('retry metadata round-trips and must agree with the persisted budget count', () => {
  const retried: RunHandle = {
    ...runHandle,
    retries: {
      capacity: 1,
      lastAttempt: {
        attempt: 1,
        category: 'capacity',
        code: 'model-capacity',
        scheduledAt: 1_000,
        delayMs: 125,
      },
    },
  }

  assert.deepEqual(parseHandle(serializeHandle(retried)), retried)
  assert.throws(
    () => parseHandle({
      ...retried,
      retries: {
        ...retried.retries,
        capacity: 2,
      },
    }),
    (error: unknown) => isAgentRunnerSdkError(error, 'invalid-handle'),
  )
})

test('session handles retain the base policy and enforce session attribution', () => {
  const sessionHandle: SessionHandle = {
    ...runHandle,
    kind: 'session',
    currentSessionId: 'session-2',
    sessionId: 'session-2',
    sessionInput: {
      promptRef: {
        store: 'netlify-blobs',
        key: 'prompts/2',
        tenant: 'site-1',
        expiresAt: 2_000_000_000_000,
      },
      requestId: '55555555-5555-4555-8555-555555555555',
    },
  }

  assert.deepEqual(parseHandle(serializeHandle(sessionHandle)), sessionHandle)

  assert.throws(
    () => parseHandle({ ...sessionHandle, sessionId: 'stale-session' }),
    (error: unknown) => (
      isAgentRunnerSdkError(error, 'invalid-handle')
      && /sessionId must equal currentSessionId/.test(error.message)
    ),
  )
})

test('handle parsing rejects malformed required fields and unknown versions', () => {
  assert.throws(
    () => parseHandle({ ...runHandle, runnerId: '' }),
    (error: unknown) => isAgentRunnerSdkError(error, 'invalid-handle'),
  )
  assert.throws(
    () => parseHandle({ ...runHandle, v: 99 }),
    (error: unknown) => isAgentRunnerSdkError(
      error,
      'unsupported-handle-version',
    ),
  )
})

test('handle parsing ignores additive fields at the serialization boundary', () => {
  const parsed = parseHandle({
    ...runHandle,
    futureTopLevelField: 'ignored',
    policy: {
      ...runHandle.policy,
      futurePolicyField: true,
    },
  })

  assert.deepEqual(parsed, runHandle)
  assert.equal('futureTopLevelField' in parsed, false)
})

test('typed SDK error guards preserve ambiguity payloads', () => {
  const error: unknown = new CreateAmbiguousError(
    runHandle.input,
    { sentAt: 10, failedAt: 20 },
  )

  assert.equal(isAgentRunnerSdkError(error), true)
  if (!isAgentRunnerSdkError(error, 'create-ambiguous')) {
    assert.fail('expected create-ambiguous')
  }
  assert.equal(error.effectiveInput.requestId, runHandle.input.requestId)
  assert.deepEqual(error.window, { sentAt: 10, failedAt: 20 })
  assert.equal(
    isAgentRunnerSdkError(
      new BasicAgentRunnerSdkError('github-token-required', 'missing'),
      'github-token-required',
    ),
    true,
  )
})
