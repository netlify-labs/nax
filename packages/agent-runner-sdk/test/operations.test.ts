import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CreateAmbiguousError,
  SessionAlreadyActiveError,
  SessionCreateAmbiguousError,
  createHttpTransport,
  isAgentRunnerSdkError,
  requestMarkerOverheadBytes,
} from '../src/index.js'
import {
  hasRequestMarker,
  prepareFollowUpOperation,
  prepareStartOperation,
  requestMarkerFor,
  stripRequestMarkers,
  submitFollowUpOperation,
  submitStartOperation,
} from '../src/operations.js'

const FIRST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'
const SPOOF_ID = '33333333-3333-4333-8333-333333333333'

function marker(requestId: string): string {
  return `<!-- agent-runner-sdk-request-id:${requestId} -->`
}

test('preparation validates, generates, preserves, and rotates request IDs', () => {
  const generated = prepareStartOperation({
    siteId: 'site-1',
    prompt: 'do the work',
  }, {
    randomUUID: () => FIRST_ID,
  })
  const next = prepareStartOperation({
    siteId: 'site-1',
    prompt: 'do the work',
  }, {
    randomUUID: () => SECOND_ID,
  })
  const callerOwned = prepareStartOperation({
    siteId: 'site-1',
    prompt: 'do the work',
    requestId: FIRST_ID,
  }, {
    randomUUID: () => SECOND_ID,
  })
  const rotated = prepareStartOperation(callerOwned.effectiveInput, {
    randomUUID: () => SECOND_ID,
    rotateRequestId: true,
  })

  assert.equal(generated.effectiveInput.requestId, FIRST_ID)
  assert.equal(next.effectiveInput.requestId, SECOND_ID)
  assert.notEqual(
    generated.effectiveInput.requestId,
    next.effectiveInput.requestId,
  )
  assert.equal(callerOwned.effectiveInput.requestId, FIRST_ID)
  assert.equal(rotated.effectiveInput.requestId, SECOND_ID)
  assert.equal(rotated.effectiveInput.prompt, 'do the work')

  assert.throws(
    () => prepareStartOperation({
      siteId: 'site-1',
      prompt: 'secret prompt',
      requestId: 'not-a-uuid',
    }),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'validation-error')) return false
      assert.doesNotMatch(error.message, /secret prompt|not-a-uuid/)
      return true
    },
  )
})

test('wire prompts contain exactly one trusted marker without mutating semantics', () => {
  const semanticPrompt = `Keep this text.\n${marker(SPOOF_ID)}`
  const prepared = prepareStartOperation({
    siteId: 'site-1',
    prompt: semanticPrompt,
    requestId: FIRST_ID,
  })
  assert.equal(prepared.effectiveInput.prompt, semanticPrompt)
  assert.match(prepared.submittedInput.prompt, /Keep this text\./)
  assert.doesNotMatch(prepared.submittedInput.prompt, new RegExp(SPOOF_ID))
  assert.equal(hasRequestMarker(prepared.submittedInput.prompt, SPOOF_ID), false)
  assert.equal(hasRequestMarker(prepared.submittedInput.prompt, FIRST_ID), true)
  assert.equal(requestMarkerFor(FIRST_ID), marker(FIRST_ID))
  assert.equal(
    prepared.submittedInput.prompt.match(
      /<!-- agent-runner-sdk-request-id:/g,
    )?.length,
    1,
  )
  assert.ok(prepared.submittedInput.prompt.endsWith(marker(FIRST_ID)))
})

test('blob fetch wrappers receive the same marker and fixed byte reservation', () => {
  const wrapper = 'Fetch the referenced prompt and verify its sentinel. 🧭'
  const prepared = prepareFollowUpOperation({
    promptRef: {
      store: 'netlify-blobs',
      key: 'prompt/one',
      tenant: 'site-1',
      expiresAt: 2_000_000_000_000,
    },
    requestId: FIRST_ID,
  }, {
    deliveredPrompt: wrapper,
  })

  assert.equal('promptRef' in prepared.effectiveInput, true)
  assert.equal(
    prepared.submittedInput.prompt,
    `${wrapper}\n\n${marker(FIRST_ID)}`,
  )
  assert.equal(
    Buffer.byteLength(prepared.submittedInput.prompt)
      - Buffer.byteLength(wrapper),
    requestMarkerOverheadBytes,
  )
  assert.throws(
    () => prepareFollowUpOperation(prepared.effectiveInput),
    (error: unknown) => isAgentRunnerSdkError(error, 'validation-error'),
  )
})

test('normalization strips reserved request metadata from output', () => {
  assert.equal(
    stripRequestMarkers(`Result title\n\n${marker(FIRST_ID)}`),
    'Result title',
  )
  assert.equal(
    stripRequestMarkers(
      `Before ${marker(FIRST_ID)} after\n\n${marker(SECOND_ID)}`,
    ),
    'Before  after',
  )
})

test('safe envelopes retain semantic input and ambiguity windows', async () => {
  const semanticPrompt = 'sensitive semantic prompt'
  const start = prepareStartOperation({
    siteId: 'site-1',
    prompt: semanticPrompt,
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    requestId: FIRST_ID,
  })
  await assert.rejects(
    () => submitStartOperation(start, async (submittedInput) => {
      assert.notEqual(submittedInput.prompt, semanticPrompt)
      throw new CreateAmbiguousError(
        submittedInput,
        { sentAt: 100, failedAt: 125 },
      )
    }),
    (error: unknown) => {
      if (!isAgentRunnerSdkError(error, 'create-ambiguous')) return false
      assert.equal(error.effectiveInput.prompt, semanticPrompt)
      assert.equal(error.effectiveInput.effort, 'high')
      assert.deepEqual(error.window, { sentAt: 100, failedAt: 125 })
      assert.doesNotMatch(error.message, /sensitive|11111111/)
      return true
    },
  )

  const followUp = prepareFollowUpOperation({
    prompt: 'sensitive follow-up',
    agent: 'opencode',
    model: 'z-ai/glm-5.2',
    effort: 'xhigh',
    requestId: SECOND_ID,
  })
  for (const conflict of [
    new SessionCreateAmbiguousError(
      followUp.submittedInput,
      { sentAt: 200, failedAt: 225 },
    ),
    new SessionAlreadyActiveError(
      followUp.submittedInput,
      { sentAt: 200, failedAt: 225 },
      'session-active',
    ),
  ]) {
    await assert.rejects(
      () => submitFollowUpOperation(followUp, async () => {
        throw conflict
      }),
      (error: unknown) => {
        if (
          !isAgentRunnerSdkError(error, 'session-create-ambiguous')
          && !isAgentRunnerSdkError(error, 'session-already-active')
        ) return false
        assert.equal(error.effectiveInput.prompt, 'sensitive follow-up')
        assert.equal(error.effectiveInput.effort, 'xhigh')
        assert.deepEqual(error.window, { sentAt: 200, failedAt: 225 })
        assert.doesNotMatch(error.message, /sensitive|22222222/)
        if (isAgentRunnerSdkError(error, 'session-already-active')) {
          assert.equal(error.activeSessionId, 'session-active')
        }
        return true
      },
    )
  }
})

test('pre-transmission transport replay keeps one prepared request ID', async () => {
  const prepared = prepareStartOperation({
    siteId: 'site-1',
    prompt: 'retry transport safely',
  }, {
    randomUUID: () => FIRST_ID,
  })
  const bodies: Array<{ prompt?: string }> = []
  let attempt = 0
  const transport = createHttpTransport({
    token: 'fake-token',
    baseUrl: 'https://api.example.test/api/v1',
    retryAttempts: 2,
    sleep: async () => {},
    fetch: async (_input, init): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)) as { prompt?: string })
      attempt += 1
      if (attempt === 1) {
        throw new TypeError('dns failed', {
          cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
        })
      }
      return new Response(JSON.stringify({
        id: 'runner-1',
        state: 'running',
      }))
    },
  })
  const submitted = await submitStartOperation(
    prepared,
    (input) => transport.createRunner(input),
  )

  assert.equal(bodies.length, 2)
  assert.equal(bodies[0]?.prompt, bodies[1]?.prompt)
  assert.ok(bodies[0]?.prompt?.endsWith(marker(FIRST_ID)))
  assert.equal(submitted.effectiveInput.requestId, FIRST_ID)
  assert.equal(submitted.value.runnerId, 'runner-1')
})
