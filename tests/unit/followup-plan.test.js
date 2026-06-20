const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FollowupPlanError,
  buildFollowupSubmissionPlan,
  defaultModelsForTarget,
  normalizeModels,
} = require('../../src/followup-plan')

const codexTarget = {
  id: 'agent-result:review:runner-1:session-1:codex',
  kind: 'agent-result',
  agent: 'codex',
  runnerId: 'runner-1',
  sessionId: 'session-1',
}

test('follow-up plan continues matching prior runner model', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: codexTarget,
    models: ['codex'],
    sourceArtifactIds: ['artifact-1'],
    targetSha: 'abc123',
    targetBranch: 'main',
  })

  assert.equal(plan.submissions.length, 1)
  assert.equal(plan.submissions[0].mode, 'continue-runner')
  assert.equal(plan.submissions[0].agent, 'codex')
  assert.equal(plan.submissions[0].runnerId, 'runner-1')
  assert.equal(plan.submissions[0].sessionId, 'session-1')
  assert.deepEqual(plan.submissions[0].sourceArtifactIds, ['artifact-1'])
  assert.equal(plan.submissions[0].target.sha, 'abc123')
  assert.deepEqual(plan.summary, ['Codex: follow-up session'])
})

test('follow-up plan turns additional models into fresh runners', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: codexTarget,
    models: ['codex', 'claude', 'gemini'],
  })

  assert.deepEqual(plan.submissions.map((submission) => [submission.agent, submission.mode]), [
    ['codex', 'continue-runner'],
    ['claude', 'fresh-runner'],
    ['gemini', 'fresh-runner'],
  ])
  assert.deepEqual(plan.summary, [
    'Codex: follow-up session',
    'Claude: fresh runner',
    'Gemini: fresh runner',
  ])
})

test('follow-up plan uses fresh runner for non-matching single model', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: codexTarget,
    models: ['claude'],
  })

  assert.equal(plan.submissions.length, 1)
  assert.equal(plan.submissions[0].agent, 'claude')
  assert.equal(plan.submissions[0].mode, 'fresh-runner')
  assert.equal(plan.submissions[0].runnerId, '')
})

test('fresh-runner requested mode makes every model fresh', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'fresh-runner',
    target: codexTarget,
    models: ['codex', 'claude'],
  })

  assert.deepEqual(plan.submissions.map((submission) => [submission.agent, submission.mode]), [
    ['codex', 'fresh-runner'],
    ['claude', 'fresh-runner'],
  ])
})

test('target without a runner makes all models fresh', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: { id: 'step-summary:review', agent: '', runnerId: '' },
    models: ['codex'],
  })

  assert.equal(plan.submissions[0].mode, 'fresh-runner')
})

test('follow-up plan defaults to prior target model', () => {
  assert.deepEqual(defaultModelsForTarget(codexTarget), ['codex'])
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: codexTarget,
  })
  assert.deepEqual(plan.submissions.map((submission) => submission.agent), ['codex'])
})

test('model normalization dedupes and lowercases selections', () => {
  assert.deepEqual(normalizeModels([' Codex ', 'codex', 'CLAUDE', '']), ['codex', 'claude'])
})

test('follow-up plan rejects unsupported models', () => {
  assert.throws(
    () => buildFollowupSubmissionPlan({
      requestedMode: 'follow-up-thread',
      target: codexTarget,
      models: ['watson'],
    }),
    /** @param {any} error */
    (error) => {
      assert.equal(error instanceof FollowupPlanError, true)
      assert.equal(error.code, 'invalid_model')
      return true
    },
  )
})
