const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  buildFollowupPrompt,
  buildHandoffPrompt,
  submitFollowupPlan,
  submitFollowupSession,
  submitFreshAgentRunner,
} = require('../../src/handoff-runner')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-handoff-runner-'))
}

test('buildHandoffPrompt preserves CLI handoff prompt shape', () => {
  const prompt = buildHandoffPrompt({
    instructions: 'Please implement the top finding.',
    summaryPath: '.nax/workflows/run-1/artifacts/summary.md',
    summaryText: '# Summary\n\nResult text.',
  })

  assert.equal(prompt, [
    '# Additional Instructions',
    '',
    'Please implement the top finding.',
    '',
    '---',
    '',
    '# Prior Results Summary',
    'Source: .nax/workflows/run-1/artifacts/summary.md',
    '# Summary',
    '',
    'Result text.',
  ].join('\n'))
})

test('buildFollowupPrompt requires instructions and optionally includes context', () => {
  const prompt = buildFollowupPrompt({
    instructions: 'Fix the confirmed issue.',
    contextText: 'Use the attached context.',
  })

  assert.match(prompt, /^# Follow-up Instructions/)
  assert.match(prompt, /Fix the confirmed issue/)
  assert.match(prompt, /# Prior Results Context/)
  assert.match(prompt, /Use the attached context/)
})

test('submitFreshAgentRunner submits and persists submitted artifacts through injected seam', async () => {
  const projectRoot = tmpRoot()
  const calls = []
  const result = await submitFreshAgentRunner({
    projectRoot,
    agent: 'codex',
    promptText: 'Do work',
    branch: 'main',
    siteId: 'site-1',
    netlifyFilter: 'filter-1',
    env: { NETLIFY_AUTH_TOKEN: 'token' },
    now: () => '2026-06-20T00:00:00.000Z',
    submitRun: async (input) => {
      calls.push(input)
      return {
        ...input.run,
        status: 'submitted',
        runnerId: 'runner-fresh',
        sessionId: 'session-fresh',
        links: { agentRunUrl: 'https://example.test/runner-fresh' },
      }
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].run.existingRunnerId, '')
  assert.equal(calls[0].branch, 'main')
  assert.equal(result.run.runnerId, 'runner-fresh')
  assert.equal(result.warnings.length, 0)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax', 'agent-sessions', 'session-fresh', 'summary.md')), true)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax', 'agent-runners', 'runner-fresh', 'summary.md')), true)
})

test('submitFollowupSession passes existing runner id and persists submitted session', async () => {
  const projectRoot = tmpRoot()
  const result = await submitFollowupSession({
    projectRoot,
    agent: 'codex',
    promptText: 'Follow up',
    existingRunnerId: 'runner-1',
    now: () => '2026-06-20T00:00:00.000Z',
    submitRun: async (input) => ({
      ...input.run,
      status: 'submitted',
      runnerId: input.run.existingRunnerId,
      sessionId: 'session-2',
      links: { sessionUrl: 'https://example.test/session-2' },
    }),
  })

  assert.equal(result.run.runnerId, 'runner-1')
  assert.equal(result.run.sessionId, 'session-2')
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax', 'agent-sessions', 'session-2', 'summary.md')), true)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax', 'agent-runners', 'runner-1', 'summary.md')), true)
})

test('submitFreshAgentRunner returns success with warning when local persistence fails after remote acceptance', async () => {
  const projectRoot = tmpRoot()
  const result = await submitFreshAgentRunner({
    projectRoot,
    agent: 'gemini',
    promptText: 'Do work',
    submitRun: async (input) => ({
      ...input.run,
      status: 'submitted',
      runnerId: 'runner-warning',
      sessionId: 'session-warning',
    }),
    persistSession: () => {
      throw new Error('disk full')
    },
  })

  assert.equal(result.run.status, 'submitted')
  assert.equal(result.run.runnerId, 'runner-warning')
  assert.deepEqual(result.warnings, ['disk full'])
  assert.equal(result.sessionArtifact, null)
  assert.equal(result.runnerArtifact, null)
})

test('submitFollowupPlan dispatches mixed follow-up and fresh submissions in order', async () => {
  const projectRoot = tmpRoot()
  const seen = []
  const results = await submitFollowupPlan({
    projectRoot,
    promptText: 'Do next',
    submissions: [
      { mode: 'continue-runner', agent: 'codex', runnerId: 'runner-1', sourceTargetId: 'target-1', sourceArtifactIds: ['a'] },
      { mode: 'fresh-runner', agent: 'claude', sourceTargetId: 'target-1', sourceArtifactIds: ['a'] },
    ],
    shared: {
      persist: false,
      submitRun: async (input) => {
        seen.push(input.run)
        return {
          ...input.run,
          status: 'submitted',
          runnerId: input.run.existingRunnerId || `runner-${input.run.agent}`,
          sessionId: `session-${input.run.agent}`,
        }
      },
    },
  })

  assert.deepEqual(seen.map((run) => [run.agent, run.existingRunnerId]), [
    ['codex', 'runner-1'],
    ['claude', ''],
  ])
  assert.deepEqual(results.map((result) => [result.submission.agent, result.run.runnerId]), [
    ['codex', 'runner-1'],
    ['claude', 'runner-claude'],
  ])
})
