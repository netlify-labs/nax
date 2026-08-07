// Confirms the SDK is instance-agnostic: several runs of the SAME provider with different
// model/effort submit as independent runners. This is the Phase 0 gate for nax-2rx6 — if it
// passes, the multi-instance program needs no SDK change (the provider-uniqueness constraint
// lives entirely in NAX, not the SDK).
import assert from 'node:assert/strict'
import test from 'node:test'

import { createHttpTransport } from '../src/index.js'
import { prepareStartOperation, submitStartOperation } from '../src/operations.js'

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/**
 * A transport whose runnerId echoes the request's model+effort, so two same-provider runs
 * can only share a runnerId if the SDK collapsed them (it must not).
 */
function recordingTransport(bodies: Array<Record<string, unknown>>) {
  return createHttpTransport({
    token: 'fake-token',
    baseUrl: 'https://api.example.test/api/v1',
    fetch: async (_input, init): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const model = String(body.model ?? 'auto')
      const effort = String(body.effort ?? 'auto')
      return new Response(JSON.stringify({
        id: `runner-${body.agent}-${model}-${effort}`,
        state: 'running',
      }))
    },
  })
}

test('two same-provider models submit as independent runners (bake-off)', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const transport = recordingTransport(bodies)

  const opus5 = prepareStartOperation({
    siteId: 'site-1',
    prompt: 'audit the services directory',
    agent: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
    requestId: ID_A,
  })
  const opus48 = prepareStartOperation({
    siteId: 'site-1',
    prompt: 'audit the services directory',
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    requestId: ID_B,
  })

  const a = await submitStartOperation(opus5, (input) => transport.createRunner(input))
  const b = await submitStartOperation(opus48, (input) => transport.createRunner(input))

  assert.equal(bodies.length, 2)
  assert.equal(bodies[0]?.agent, 'claude')
  assert.equal(bodies[1]?.agent, 'claude')
  assert.equal(bodies[0]?.model, 'claude-opus-5')
  assert.equal(bodies[1]?.model, 'claude-opus-4-8')
  assert.notEqual(bodies[0]?.model, bodies[1]?.model)
  // Independent handles — the SDK never collapses same-provider runs.
  assert.notEqual(a.value.runnerId, b.value.runnerId)
  assert.equal(a.value.runnerId, 'runner-claude-claude-opus-5-high')
  assert.equal(b.value.runnerId, 'runner-claude-claude-opus-4-8-high')
  // Effective inputs stay independent (distinct request ids, preserved config).
  assert.notEqual(a.effectiveInput.requestId, b.effectiveInput.requestId)
  assert.equal(a.effectiveInput.model, 'claude-opus-5')
  assert.equal(b.effectiveInput.model, 'claude-opus-4-8')
})

test('one model at two efforts submits as independent runners (effort sweep)', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const transport = recordingTransport(bodies)

  const low = prepareStartOperation({
    siteId: 'site-1',
    prompt: 'sweep',
    agent: 'claude',
    model: 'claude-opus-5',
    effort: 'low',
    requestId: ID_A,
  })
  const high = prepareStartOperation({
    siteId: 'site-1',
    prompt: 'sweep',
    agent: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
    requestId: ID_C,
  })

  const a = await submitStartOperation(low, (input) => transport.createRunner(input))
  const b = await submitStartOperation(high, (input) => transport.createRunner(input))

  // Same provider AND same model — only the effort differs, yet the runs are independent.
  assert.equal(bodies[0]?.effort, 'low')
  assert.equal(bodies[1]?.effort, 'high')
  assert.notEqual(a.value.runnerId, b.value.runnerId)
})
