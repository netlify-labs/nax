const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { persistAgentRunnerArtifact } = require('../../src/workflows/artifacts/agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('../../src/workflows/artifacts/agent-session-artifacts')
const {
  sessionsFromListPayload,
  syncLastAgentRunner,
} = require('../../src/workflows/artifacts/agent-runner-sync')

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

test('syncLastAgentRunner persists out-of-band remote sessions and rebuilds runner rollup', async () => {
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

  const result = await syncLastAgentRunner({
    projectRoot,
    env: {},
    sdk: /** @type {import('agent-runner-sdk').AgentRunnerSdk} */ (/** @type {unknown} */ ({
      transport: {
        listSessions: async () => [
          {
            sessionId: 'session-1',
            runnerId: 'runner-1',
            state: 'completed',
            resultText: 'Initial result',
            usage: { totalTokens: 10, totalCreditsCost: 1, stepsCount: 1 },
            createdAt: Date.parse('2026-05-29T01:00:00.000Z'),
            updatedAt: Date.parse('2026-05-29T01:01:00.000Z'),
          },
          {
            sessionId: 'session-2',
            runnerId: 'runner-1',
            state: 'completed',
            resultText: 'Follow-up result',
            usage: { totalTokens: 20, totalCreditsCost: 2, stepsCount: 2 },
            createdAt: Date.parse('2026-05-29T02:00:00.000Z'),
            updatedAt: Date.parse('2026-05-29T02:01:00.000Z'),
          },
        ],
      },
    })),
  })

  assert.equal(result.runnerId, 'runner-1')
  assert.equal(result.remoteSessionCount, 2)
  assert.equal(result.syncedSessionCount, 2)
  assert.deepEqual(result.sessionIds, ['session-1', 'session-2'])
  const runner = readJson(path.join(projectRoot, '.nax', 'agent-runners', 'runner-1', 'agent-runner.json'))
  assert.equal(runner.latestSessionId, 'session-2')
  assert.deepEqual(runner.sessionIds, ['session-1', 'session-2'])
  assert.deepEqual(runner.usage, { totalTokens: 30, totalCreditsCost: 3, stepsCount: 3 })

  const second = readJson(path.join(projectRoot, '.nax', 'agent-sessions', 'session-2', 'agent-session.json'))
  assert.equal(second.resultText, 'Follow-up result')
  assert.equal(second.links.sessionUrl, 'https://app.netlify.com/projects/www/agent-runs/runner-1?session=session-2')
})
