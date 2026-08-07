// Artifact path collision test for the Arena program (nax-2rx6.4.6): same-provider instances
// must never share an artifact base; single-instance steps keep the legacy provider path.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { runArtifactBase } = require('../../src/workflows/artifacts/workflow-artifacts')

test('single instance of a provider keeps the provider path (back-compat)', () => {
  const step = { runs: [{ agent: 'claude', instanceId: 'claude:auto:auto' }] }
  assert.equal(runArtifactBase(step, step.runs[0]), 'claude')
})

test('same-provider instances get distinct, non-colliding bases', () => {
  const step = {
    runs: [
      { agent: 'claude', model: 'claude-opus-5', instanceId: 'claude:claude-opus-5:auto' },
      { agent: 'claude', model: 'claude-opus-4-8', instanceId: 'claude:claude-opus-4-8:auto' },
      { agent: 'claude', model: 'claude-opus-5', effort: 'high', instanceId: 'claude:claude-opus-5:high' },
    ],
  }
  const bases = step.runs.map((run) => runArtifactBase(step, run))
  assert.equal(new Set(bases).size, 3, `bases collided: ${bases}`)
  assert.equal(bases[0], 'claude__claude-opus-5__auto')
  assert.equal(bases[2], 'claude__claude-opus-5__high')
})

test('different providers keep their provider paths even in a multi-instance step', () => {
  const step = {
    runs: [
      { agent: 'claude', model: 'claude-opus-5', instanceId: 'claude:claude-opus-5:auto' },
      { agent: 'claude', model: 'claude-opus-4-8', instanceId: 'claude:claude-opus-4-8:auto' },
      { agent: 'gemini', instanceId: 'gemini:auto:auto' },
    ],
  }
  // gemini is single-instance → provider path; claudes are slugged
  assert.equal(runArtifactBase(step, step.runs[2]), 'gemini')
  assert.notEqual(runArtifactBase(step, step.runs[0]), runArtifactBase(step, step.runs[1]))
})

test('non-fs-safe model ids are slugged safely', () => {
  const step = {
    runs: [
      { agent: 'opencode', model: 'z-ai/glm-5.2', instanceId: 'opencode:z-ai/glm-5.2:high' },
      { agent: 'opencode', model: 'moonshotai/kimi-k3', instanceId: 'opencode:moonshotai/kimi-k3:auto' },
    ],
  }
  const bases = step.runs.map((run) => runArtifactBase(step, run))
  assert.equal(new Set(bases).size, 2)
  assert.ok(bases.every((b) => /^[a-z0-9_-]+$/.test(b)), `unsafe base: ${bases}`)
})
