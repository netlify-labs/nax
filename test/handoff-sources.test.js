const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { persistAgentRunnerArtifact } = require('../lib/agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('../lib/agent-session-artifacts')
const { listHandoffSources, readHandoffSource } = require('../lib/handoff-sources')
const { persistWorkflowArtifacts } = require('../lib/workflow-artifacts')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-handoff-sources-'))
}

function writeWorkflow(projectRoot, runId, updatedAt) {
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  const state = {
    schemaVersion: 1,
    runId,
    flowId: 'do-next',
    flowTitle: 'Do Next',
    transport: 'netlify-api',
    projectRoot,
    createdAt: updatedAt,
    updatedAt,
    status: 'completed',
    steps: [{
      id: 'synthesize',
      title: 'Synthesize',
      status: 'completed',
      runs: [{ agent: 'codex', status: 'completed', resultText: 'Workflow result.' }],
    }],
    dir,
  }
  fs.writeFileSync(path.join(dir, 'workflow.json'), `${JSON.stringify(state, null, 2)}\n`)
  persistWorkflowArtifacts(state, { summaryOnly: true })
  return state
}

test('readHandoffSource prefers completed agent sessions over runners and workflows', () => {
  const projectRoot = tmpRoot()
  writeWorkflow(projectRoot, 'workflow-1', '2026-05-20T22:00:00.000Z')
  const session = persistAgentSessionArtifact({
    projectRoot,
    run: { agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1', resultText: 'Session result.' },
    updatedAt: '2026-05-20T20:00:00.000Z',
  })
  persistAgentRunnerArtifact({ projectRoot, runnerId: 'runner-1', session: session.session })

  const source = readHandoffSource(projectRoot)
  assert.equal(source.kind, 'agent-session')
  assert.equal(source.id, 'session-1')
  assert.equal(source.displayPath, '.nax/agent-sessions/session-1/summary.md')
})

test('readHandoffSource can select an explicit workflow source', () => {
  const projectRoot = tmpRoot()
  writeWorkflow(projectRoot, 'workflow-1', '2026-05-20T22:00:00.000Z')
  const session = persistAgentSessionArtifact({
    projectRoot,
    run: { agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1', resultText: 'Session result.' },
  })
  persistAgentRunnerArtifact({ projectRoot, runnerId: 'runner-1', session: session.session })

  const source = readHandoffSource(projectRoot, { kind: 'workflow', id: 'workflow-1' })
  assert.equal(source.kind, 'workflow')
  assert.equal(source.id, 'workflow-1')
})

test('listHandoffSources excludes incomplete sources', () => {
  const projectRoot = tmpRoot()
  persistAgentSessionArtifact({
    projectRoot,
    run: { agent: 'codex', status: 'failed', runnerId: 'runner-1', sessionId: 'session-1', resultText: 'failed' },
  })

  assert.deepEqual(listHandoffSources(projectRoot), [])
})
