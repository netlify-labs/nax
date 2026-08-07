// Exhaustive resolver/pipeline tests for the Arena program (nax-2rx6.2.8), driven by the
// Phase 0 goldens plus edge cases: fan-out, dedupe, latest alias, effort clamping, transport
// determinism, and validation errors.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const { resolveLineup, agentInstanceId } = require('../../src/core/agents/instances')

const FIX = path.join(__dirname, '..', 'fixtures', 'multi-instance')
const goldens = JSON.parse(fs.readFileSync(path.join(FIX, 'goldens.json'), 'utf8'))

/** Load a fixture flow's single-step lineup. */
function lineupOf(fixture) {
  const flow = yaml.load(fs.readFileSync(path.join(FIX, fixture), 'utf8'))
  return flow.steps[0].agents
}

for (const c of goldens.cases) {
  test(`golden: ${c.fixture}`, () => {
    const lineup = lineupOf(c.fixture)
    if (c.error) {
      assert.throws(
        () => resolveLineup(lineup, { requestedTransport: 'auto' }),
        { code: c.error.code },
      )
      return
    }
    const resolved = resolveLineup(lineup, { requestedTransport: 'auto' })
    // instance ids + tuple fields match the golden
    assert.deepEqual(
      resolved.instances.map((i) => i.id),
      c.instances.map((i) => i.id),
      `${c.fixture} ids`,
    )
    for (let i = 0; i < c.instances.length; i++) {
      const got = resolved.instances[i]
      const want = c.instances[i]
      assert.equal(got.agent, want.agent)
      assert.equal(got.model ?? null, want.model)
      assert.equal(got.effort ?? null, want.effort)
      assert.equal(got.resolvedFrom, want.resolvedFrom)
      if (want.wireEffort) assert.equal(got.wireEffort, want.wireEffort)
    }
    // transport
    if (c.transport === 'netlify-api') {
      assert.equal(resolved.forcedNetlifyApi, true, `${c.fixture} should force netlify-api`)
      assert.equal(resolved.transport, 'netlify-api')
    } else if (c.transport === 'github-eligible') {
      assert.equal(resolved.forcedNetlifyApi, false, `${c.fixture} should be github-eligible`)
    }
    // warnings (by code)
    if (c.warnings) {
      const codes = resolved.warnings.map((w) => w.code).sort()
      const wantCodes = c.warnings.map((w) => w.code).sort()
      assert.deepEqual(codes, wantCodes, `${c.fixture} warnings`)
    }
  })
}

test('id is tuple-derived (label does not change identity)', () => {
  const a = resolveLineup([{ agent: 'claude', model: 'claude-opus-5', effort: 'high', label: 'Champion' }])
  const b = resolveLineup([{ agent: 'claude', model: 'claude-opus-5', effort: 'high', label: 'Underdog' }])
  assert.equal(a.instances[0].id, b.instances[0].id)
  assert.equal(a.instances[0].id, 'claude:claude-opus-5:high')
  assert.equal(a.instances[0].label, 'Champion')
})

test('bare provider is Auto on the wire and github-eligible', () => {
  const r = resolveLineup(['claude'], { requestedTransport: 'auto' })
  assert.equal(r.instances[0].id, 'claude:auto:auto')
  assert.equal(r.instances[0].model, undefined)
  assert.equal(r.instances[0].resolvedFrom, 'open')
  assert.equal(r.forcedNetlifyApi, false)
})

test('latest resolves to the provider default with provenance', () => {
  const r = resolveLineup([{ agent: 'claude', model: 'latest' }])
  assert.equal(r.instances[0].id, 'claude:claude-fable-5:auto')
  assert.equal(r.instances[0].resolvedFrom, 'latest')
  assert.equal(r.forcedNetlifyApi, true) // latest is pinned intent
})

test('max clamps nowhere on GLM but translates to xhigh at the wire', () => {
  const r = resolveLineup([{ agent: 'opencode', model: 'z-ai/glm-5.2', effort: 'max' }])
  assert.equal(r.instances[0].effort, 'max') // id keeps catalog id
  assert.equal(r.instances[0].wireEffort, 'xhigh') // wire translation surfaced
})

test('explicit github transport with a pinned model fails the whole flow', () => {
  assert.throws(
    () => resolveLineup([{ agent: 'claude', model: 'claude-opus-5' }], { requestedTransport: 'github' }),
    { code: 'github_transport_unsupported' },
  )
})

test('explicit github transport with >1 same-provider instance fails', () => {
  assert.throws(
    () => resolveLineup([{ agent: 'claude', models: ['claude-opus-5', 'claude-opus-4-8'] }], { requestedTransport: 'github' }),
    { code: 'github_transport_unsupported' },
  )
})

test('bare providers on github stay eligible (no pin)', () => {
  const r = resolveLineup(['claude', 'gemini'], { requestedTransport: 'github' })
  assert.equal(r.forcedNetlifyApi, false)
  assert.equal(r.transport, 'github')
})

test('effort pinned on a model belonging to another provider errors', () => {
  assert.throws(
    () => resolveLineup([{ agent: 'codex', model: 'claude-opus-5' }]),
    { code: 'model_provider_mismatch' },
  )
})

test('agentInstanceId encodes auto placeholders', () => {
  assert.equal(agentInstanceId('claude', undefined, undefined), 'claude:auto:auto')
  assert.equal(agentInstanceId('claude', 'claude-opus-5', undefined), 'claude:claude-opus-5:auto')
})
