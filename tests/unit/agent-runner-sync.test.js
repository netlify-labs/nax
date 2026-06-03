const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { persistAgentRunnerArtifact } = require('../../lib/agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('../../lib/agent-session-artifacts')
const {
  sessionsFromListPayload,
  syncLastAgentRunner,
} = require('../../lib/agent-runner-sync')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-agent-runner-sync-'))
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

test('sessionsFromListPayload supports array and sessions wrapper payloads', () => {
  assert.deepEqual(sessionsFromListPayload([{ id: 'session-1' }]), [{ id: 'session-1' }])
  assert.deepEqual(sessionsFromListPayload({ sessions: [{ id: 'session-2' }] }), [{ id: 'session-2' }])
  assert.deepEqual(sessionsFromListPayload({}), [])
})

test('syncLastAgentRunner persists out-of-band remote sessions and rebuilds runner rollup', () => {
  const projectRoot = tmpRoot()
  const first = persistAgentSessionArtifact({
    projectRoot,
    runnerId: 'runner-1',
    agent: 'codex',
    sessionId: 'session-1',
    status: 'completed',
    resultText: 'Initial result',
    usage: { totalTokens: 10, totalCreditsCost: 1, stepsCount: 1 },
    links: { agentRunUrl: 'https://app.netlify.com/projects/www/agent-runs/runner-1' },
    createdAt: '2026-05-29T01:00:00.000Z',
    updatedAt: '2026-05-29T01:01:00.000Z',
  })
  persistAgentRunnerArtifact({
    projectRoot,
    runnerId: 'runner-1',
    agent: 'codex',
    status: 'completed',
    session: first.session,
    links: { agentRunUrl: 'https://app.netlify.com/projects/www/agent-runs/runner-1' },
    createdAt: '2026-05-29T01:00:00.000Z',
    updatedAt: '2026-05-29T01:01:00.000Z',
  })

  const calls = []
  const result = syncLastAgentRunner({
    projectRoot,
    env: {},
    runCommand(command, args, options) {
      calls.push({ command, args, options })
      return {
        status: 0,
        stdout: JSON.stringify({
          sessions: [
            {
              id: 'session-1',
              state: 'completed',
              result: 'Initial result',
              usage: { total_tokens: 10, total_credits_cost: 1 },
              steps_count: 1,
              created_at: '2026-05-29T01:00:00.000Z',
              updated_at: '2026-05-29T01:01:00.000Z',
            },
            {
              id: 'session-2',
              state: 'completed',
              result: 'Follow-up result',
              usage: { total_tokens: 20, total_credits_cost: 2 },
              steps_count: 2,
              created_at: '2026-05-29T02:00:00.000Z',
              updated_at: '2026-05-29T02:01:00.000Z',
            },
          ],
        }),
        stderr: '',
      }
    },
  })

  assert.equal(result.runnerId, 'runner-1')
  assert.equal(result.remoteSessionCount, 2)
  assert.equal(result.syncedSessionCount, 2)
  assert.deepEqual(result.sessionIds, ['session-1', 'session-2'])
  assert.deepEqual(calls[0].args, [
    'api',
    'listAgentRunnerSessions',
    '--data',
    '{"agent_runner_id":"runner-1"}',
  ])

  const runner = readJson(path.join(projectRoot, '.nax', 'agent-runners', 'runner-1', 'agent-runner.json'))
  assert.equal(runner.latestSessionId, 'session-2')
  assert.deepEqual(runner.sessionIds, ['session-1', 'session-2'])
  assert.deepEqual(runner.usage, { totalTokens: 30, totalCreditsCost: 3, stepsCount: 3 })

  const second = readJson(path.join(projectRoot, '.nax', 'agent-sessions', 'session-2', 'agent-session.json'))
  assert.equal(second.resultText, 'Follow-up result')
  assert.equal(second.links.sessionUrl, 'https://app.netlify.com/projects/www/agent-runs/runner-1?session=session-2')
})
