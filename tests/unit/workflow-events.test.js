const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createWorkflowEventContext, safeOptions } = require('../../src/workflow-events')
const { readEventLog } = require('../../src/runner-event-log')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-workflow-events-'))
}

test('workflow event context emits to injected sink without globals', () => {
  const events = []
  const context = createWorkflowEventContext({
    sink: (event) => events.push(event),
    env: {},
    now: () => new Date('2026-06-19T00:00:00.000Z'),
  })
  const dir = tmpDir()
  context.setRunState({
    runId: 'run-1',
    flowId: 'review',
    flowTitle: 'Review',
    transport: 'netlify-api',
    branch: 'master',
    projectRoot: dir,
    dir,
  })
  context.workflowStarted({ command: ['nax', 'run', 'review'], options: { branch: 'master', context: 'secret body' } })
  context.stepStatus('running', { id: 'review', title: 'Review', agents: ['codex'] })
  context.agentStatus('submitted', { agent: 'codex', runnerId: 'runner-1' }, { id: 'review', title: 'Review' })

  assert.deepEqual(events.map((event) => event.type), ['workflow_started', 'step_status', 'agent_status'])
  assert.equal(events[0].runId, 'run-1')
  assert.equal(events[0].status, 'running')
  assert.equal(events[0].options.context, undefined)
  assert.equal(events[2].agent, 'codex')
})

test('workflow event context writes durable events.jsonl after run state is known', () => {
  const dir = tmpDir()
  const context = createWorkflowEventContext({
    env: {},
    now: () => new Date('2026-06-19T00:00:00.000Z'),
  })
  context.setRunState({
    runId: 'run-2',
    flowId: 'review',
    flowTitle: 'Review',
    transport: 'netlify-api',
    branch: 'master',
    projectRoot: dir,
    dir,
  })
  context.workflowStarted()

  const replay = readEventLog(path.join(dir, 'events.jsonl'))
  assert.equal(replay.events.length, 1)
  assert.equal(replay.events[0].type, 'workflow_started')
  assert.equal(replay.events[0].eventId, 'run-2:1')
})

test('workflow event safe options omit large context and secrets', () => {
  assert.deepEqual(safeOptions({
    branch: 'main',
    target: { branch: 'main', verified: true },
    transport: 'netlify-api',
    context: 'do not include',
    token: 'secret',
    stepModels: { review: ['codex'] },
  }), {
    branch: 'main',
    branchSource: '',
    target: { branch: 'main', verified: true },
    transport: 'netlify-api',
    models: '',
    stepModels: { review: ['codex'] },
    fromStep: '',
    step: '',
  })
})
