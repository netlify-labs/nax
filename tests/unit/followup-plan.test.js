const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FollowupPlanError,
  buildFollowupSubmissionPlan,
  defaultAgentsForTarget,
  normalizeAgents,
} = require('../../src/workflows/followups/plan')

const codexTarget = {
  id: 'agent-result:review:runner-1:session-1:codex',
  kind: 'agent-result',
  agent: 'codex',
  runnerId: 'runner-1',
  sessionId: 'session-1',
}

test('follow-up plan continues matching prior runner agent', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: codexTarget,
    agents: ['codex'],
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

test('follow-up plan turns additional agents into fresh runners', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: codexTarget,
    agents: ['codex', 'claude', 'gemini'],
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

test('follow-up plan uses fresh runner for non-matching single agent', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: codexTarget,
    agents: ['claude'],
  })

  assert.equal(plan.submissions.length, 1)
  assert.equal(plan.submissions[0].agent, 'claude')
  assert.equal(plan.submissions[0].mode, 'fresh-runner')
  assert.equal(plan.submissions[0].runnerId, '')
})

test('fresh-runner requested mode makes every agent fresh', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'fresh-runner',
    target: codexTarget,
    agents: ['codex', 'claude'],
  })

  assert.deepEqual(plan.submissions.map((submission) => [submission.agent, submission.mode]), [
    ['codex', 'fresh-runner'],
    ['claude', 'fresh-runner'],
  ])
})

test('target without a runner makes all agents fresh', () => {
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: { id: 'step-summary:review', agent: '', runnerId: '' },
    agents: ['codex'],
  })

  assert.equal(plan.submissions[0].mode, 'fresh-runner')
})

test('follow-up plan defaults to prior target agent', () => {
  assert.deepEqual(defaultAgentsForTarget(codexTarget), ['codex'])
  const plan = buildFollowupSubmissionPlan({
    requestedMode: 'follow-up-thread',
    target: codexTarget,
  })
  assert.deepEqual(plan.submissions.map((submission) => submission.agent), ['codex'])
})

test('agent normalization dedupes and lowercases selections', () => {
  assert.deepEqual(normalizeAgents([' Codex ', 'codex', 'CLAUDE', '']), ['codex', 'claude'])
})

test('follow-up plan rejects unsupported agents', () => {
  assert.throws(
    () => buildFollowupSubmissionPlan({
      requestedMode: 'follow-up-thread',
      target: codexTarget,
      agents: ['watson'],
    }),
    /** @param {unknown} error */
    (error) => {
      assert.equal(error instanceof FollowupPlanError, true)
      if (!(error instanceof FollowupPlanError)) return false
      assert.equal(error.code, 'invalid_agent')
      return true
    },
  )
})

test('follow-up initializes from source configuration and allows an intentional override', () => {
  const target = {
    ...codexTarget,
    model: 'gpt-5.6-sol',
    effort: 'high',
  }
  const inherited = buildFollowupSubmissionPlan({
    target,
    agents: ['codex'],
  })
  assert.equal(inherited.submissions[0].model, 'gpt-5.6-sol')
  assert.equal(inherited.submissions[0].effort, 'high')

  const overridden = buildFollowupSubmissionPlan({
    target,
    agents: ['codex'],
    models: { codex: 'gpt-5.6-terra' },
    efforts: { codex: 'low' },
  })
  assert.equal(overridden.submissions[0].model, 'gpt-5.6-terra')
  assert.equal(overridden.submissions[0].effort, 'low')
})
