const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  agentSessionDir,
  listAgentSessionArtifacts,
  persistAgentSessionArtifact,
} = require('../lib/agent-session-artifacts')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-agent-session-artifacts-'))
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

test('persistAgentSessionArtifact writes canonical session files', () => {
  const projectRoot = tmpRoot()
  const result = persistAgentSessionArtifact({
    projectRoot,
    run: {
      agent: 'codex',
      status: 'completed',
      runnerId: 'runner-1',
      sessionId: 'session-1',
      resultText: 'Done.',
      usage: { totalCreditsCost: 1.25, stepsCount: 2, totalTokens: 300 },
      links: { sessionUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-1?session=session-1' },
    },
    source: { type: 'manual', reason: 'test' },
    createdAt: '2026-05-20T20:00:00.000Z',
    updatedAt: '2026-05-20T20:01:00.000Z',
  })

  const dir = agentSessionDir(projectRoot, 'session-1')
  assert.equal(result.dir, dir)
  assert.equal(fs.existsSync(path.join(dir, 'agent-session.json')), true)
  assert.equal(fs.existsSync(path.join(dir, 'summary.md')), true)
  assert.equal(fs.existsSync(path.join(dir, 'usage.json')), true)
  assert.equal(fs.existsSync(path.join(dir, 'result.md')), true)

  const session = readJson(path.join(dir, 'agent-session.json'))
  assert.equal(session.sessionId, 'session-1')
  assert.equal(session.runnerId, 'runner-1')
  assert.equal(session.source.type, 'manual')
  assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /1.25 credits, 2 steps, 300 tokens/)
})

test('persistAgentSessionArtifact omits result.md when there is no result text', () => {
  const projectRoot = tmpRoot()
  const result = persistAgentSessionArtifact({
    projectRoot,
    run: {
      agent: 'claude',
      status: 'failed',
      runnerId: 'runner-2',
      sessionId: 'session-2',
      resultText: '',
    },
  })

  assert.equal(fs.existsSync(path.join(result.dir, 'result.md')), false)
})

test('listAgentSessionArtifacts returns newest sessions first', () => {
  const projectRoot = tmpRoot()
  persistAgentSessionArtifact({
    projectRoot,
    run: { agent: 'codex', status: 'completed', runnerId: 'runner-old', sessionId: 'session-old', resultText: 'old' },
    updatedAt: '2026-05-20T20:00:00.000Z',
  })
  persistAgentSessionArtifact({
    projectRoot,
    run: { agent: 'codex', status: 'completed', runnerId: 'runner-new', sessionId: 'session-new', resultText: 'new' },
    updatedAt: '2026-05-20T21:00:00.000Z',
  })

  assert.deepEqual(listAgentSessionArtifacts(projectRoot).map((session) => session.sessionId), ['session-new', 'session-old'])
})
