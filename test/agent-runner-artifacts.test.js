const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  agentRunnerDir,
  listAgentRunnerArtifacts,
  persistAgentRunnerArtifact,
} = require('../lib/agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('../lib/agent-session-artifacts')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-agent-runner-artifacts-'))
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

test('persistAgentRunnerArtifact writes a runner thread rollup', () => {
  const projectRoot = tmpRoot()
  const first = persistAgentSessionArtifact({
    projectRoot,
    run: {
      agent: 'codex',
      status: 'completed',
      runnerId: 'runner-1',
      sessionId: 'session-1',
      resultText: 'First result.',
      usage: { totalCreditsCost: 1, stepsCount: 2, totalTokens: 100 },
    },
    updatedAt: '2026-05-20T20:00:00.000Z',
  })
  const second = persistAgentSessionArtifact({
    projectRoot,
    run: {
      agent: 'codex',
      status: 'completed',
      runnerId: 'runner-1',
      sessionId: 'session-2',
      resultText: 'Second result.',
      usage: { totalCreditsCost: 2, stepsCount: 3, totalTokens: 200 },
    },
    updatedAt: '2026-05-20T21:00:00.000Z',
  })

  persistAgentRunnerArtifact({ projectRoot, runnerId: 'runner-1', session: first.session })
  const result = persistAgentRunnerArtifact({ projectRoot, runnerId: 'runner-1', session: second.session })

  const dir = agentRunnerDir(projectRoot, 'runner-1')
  assert.equal(result.dir, dir)
  assert.equal(fs.existsSync(path.join(dir, 'agent-runner.json')), true)
  assert.equal(fs.existsSync(path.join(dir, 'summary.md')), true)
  assert.equal(fs.existsSync(path.join(dir, 'usage.json')), true)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'session-1.json')), true)
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'session-2.json')), true)

  const runner = readJson(path.join(dir, 'agent-runner.json'))
  assert.equal(runner.latestSessionId, 'session-2')
  assert.deepEqual(runner.sessionIds, ['session-1', 'session-2'])
  assert.deepEqual(runner.usage, { totalCreditsCost: 3, stepsCount: 5, totalTokens: 300 })
  assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /session-2/)
})

test('listAgentRunnerArtifacts returns newest runner threads first', () => {
  const projectRoot = tmpRoot()
  const oldSession = persistAgentSessionArtifact({
    projectRoot,
    run: { agent: 'claude', status: 'completed', runnerId: 'runner-old', sessionId: 'session-old', resultText: 'old' },
    updatedAt: '2026-05-20T20:00:00.000Z',
  })
  const newSession = persistAgentSessionArtifact({
    projectRoot,
    run: { agent: 'claude', status: 'completed', runnerId: 'runner-new', sessionId: 'session-new', resultText: 'new' },
    updatedAt: '2026-05-20T21:00:00.000Z',
  })
  persistAgentRunnerArtifact({ projectRoot, runnerId: 'runner-old', session: oldSession.session })
  persistAgentRunnerArtifact({ projectRoot, runnerId: 'runner-new', session: newSession.session })

  assert.deepEqual(listAgentRunnerArtifacts(projectRoot).map((runner) => runner.runnerId), ['runner-new', 'runner-old'])
})
