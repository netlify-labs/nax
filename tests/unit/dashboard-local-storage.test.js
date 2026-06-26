const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createLocalArtifactStore } = require('../../src/dashboard/storage/local-artifacts')
const { createLocalEventStore } = require('../../src/dashboard/storage/local-events')
const { createLocalRunStore, decodeRunsCursor } = require('../../src/dashboard/storage/local-runs')
const { createLocalWorkflowStore } = require('../../src/dashboard/storage/local-workflows')
const { appendEventLog } = require('../../src/workflows/events/runner-event-log')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-storage-'))
}

function writeProjectFlow(projectRoot, id = 'review') {
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', id)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    `id: ${id}`,
    `title: ${id} title`,
    'description: Project-local flow',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    title: One',
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), 'Prompt\n')
}

function writeRunState(projectRoot, runId, { flowId = 'review', title = runId, updatedAt = '2026-06-22T00:00:00.000Z' } = {}) {
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId,
    flowTitle: title,
    status: 'completed',
    branch: 'main',
    createdAt: updatedAt,
    updatedAt,
    dir,
    flow: {
      id: flowId,
      title,
      steps: [{ id: 'one', title: 'One', agents: ['codex'] }],
    },
    steps: [{
      id: 'one',
      title: 'One',
      status: 'completed',
      agents: ['codex'],
      runs: [{ agent: 'codex', status: 'completed' }],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'artifacts', 'summary.md'), `# ${title}\n`)
  const time = new Date(updatedAt)
  fs.utimesSync(path.join(dir, 'workflow.json'), time, time)
  return dir
}

function writeActiveFollowupRunState(projectRoot, runId = 'followup-run') {
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    branch: 'main',
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:00.000Z',
    dir,
    flow: {
      id: 'review',
      title: 'Review',
      steps: [{ id: 'one', title: 'One', agents: ['codex'] }],
    },
    steps: [
      {
        id: 'one',
        title: 'One',
        status: 'completed',
        agents: ['codex'],
        runs: [{ agent: 'codex', status: 'completed' }],
      },
      {
        id: 'dashboard-followup-1',
        title: 'Follow-up 1: One (codex)',
        status: 'submitted',
        agents: ['codex'],
        source: { type: 'dashboard-followup', id: 'followup-1' },
        runs: [{ agent: 'codex', status: 'submitted', runnerId: 'runner-1', sessionId: 'session-1' }],
      },
    ],
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'artifacts', 'summary.md'), '# Follow-up\n')
  return dir
}

test('local workflow store lists workflows and builds graph responses', async () => {
  const projectRoot = tmpRoot()
  writeProjectFlow(projectRoot, 'review')
  const store = createLocalWorkflowStore({ projectRoot })

  const list = await store.listWorkflows()
  assert.equal(list.items.some((flow) => flow.id === 'review'), true)

  const workflow = await store.getWorkflow('review')
  assert.equal(workflow.id, 'review')

  const graph = await store.getWorkflowGraph('review')
  assert.equal(graph.workflow.id, 'review')
  assert.ok(Array.isArray(graph.graph.nodes))
})

test('local run store pages durable runs before parsing workflow JSON', () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'newest', { updatedAt: '2026-06-22T03:00:00.000Z' })
  writeRunState(projectRoot, 'middle', { updatedAt: '2026-06-22T02:00:00.000Z' })
  const badDir = path.join(projectRoot, '.nax', 'workflows', 'old-bad')
  fs.mkdirSync(badDir, { recursive: true })
  fs.writeFileSync(path.join(badDir, 'workflow.json'), '{')
  const oldTime = new Date('2026-06-22T01:00:00.000Z')
  fs.utimesSync(path.join(badDir, 'workflow.json'), oldTime, oldTime)

  const store = createLocalRunStore({ projectRoot })
  const page = store.listRunsPage({ limit: 1 })
  assert.deepEqual(page.runs.map((run) => run.runId), ['newest'])
  assert.equal(page.pagination.total, 3)
  assert.equal(page.pagination.hasMore, true)

  const second = store.listRunsPage({ limit: 1, cursor: page.pagination.nextCursor })
  assert.deepEqual(second.runs.map((run) => run.runId), ['middle'])
})

test('local run store returns graph and details from durable state fallback flow', async () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'run-1', { title: 'Stored Flow' })
  const store = createLocalRunStore({ projectRoot })

  const run = store.getRun('run-1')
  assert.equal(run.runId, 'run-1')

  const graph = await store.getRunGraph('run-1')
  assert.equal(graph.workflow.title, 'Stored Flow')
  assert.equal(graph.run.options.branch, 'main')

  const details = await store.getRunDetails('run-1')
  assert.equal(details.run.runId, 'run-1')
  assert.ok(Array.isArray(details.details.sections))
})

test('local run store resolves active runtime ids to durable run state ids', async () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'run-1', { title: 'Resolved Flow' })
  const store = createLocalRunStore({
    projectRoot,
    resolveRunStateId: (id) => (id === 'active-1' ? 'run-1' : ''),
  })

  const run = store.getRun('active-1')
  assert.equal(run.runId, 'run-1')

  const graph = await store.getRunGraph('active-1')
  assert.equal(graph.run.runId, 'run-1')
  assert.equal(graph.workflow.title, 'Resolved Flow')

  const details = await store.getRunDetails('active-1')
  assert.equal(details.run.runId, 'run-1')
})

test('local run store refreshes contradictory detail state through bounded follow-up sync', () => {
  const projectRoot = tmpRoot()
  writeActiveFollowupRunState(projectRoot)
  let calls = 0
  const store = createLocalRunStore({
    projectRoot,
    followupSyncRunner: () => {
      calls += 1
      return {
        sessions: [{
          sessionId: 'session-1',
          runnerId: 'runner-1',
          agent: 'codex',
          status: 'completed',
          resultText: 'Remote result.',
          updatedAt: '2026-06-22T00:01:00.000Z',
        }],
      }
    },
  })

  const run = store.getRun('followup-run')

  assert.equal(calls, 1)
  assert.equal(run.status, 'completed')
  assert.equal(run.steps[1].status, 'completed')
  assert.equal(run.steps[1].runs[0].status, 'completed')
})

test('local run store keeps list pagination disk-only and cooldowns refresh attempts', () => {
  const projectRoot = tmpRoot()
  writeActiveFollowupRunState(projectRoot)
  let calls = 0
  const store = createLocalRunStore({
    projectRoot,
    refreshCooldownMs: 60000,
    followupSyncRunner: () => {
      calls += 1
      return { sessions: [] }
    },
  })

  const page = store.listRunsPage({ limit: 10 })
  assert.equal(page.runs[0].runId, 'followup-run')
  assert.equal(calls, 0)

  const state = store.getRunState('followup-run')
  store.refreshRunStateIfNeeded(state, { view: 'detail', now: new Date('2026-06-22T00:02:00.000Z') })
  store.refreshRunStateIfNeeded(state, { view: 'detail', now: new Date('2026-06-22T00:02:10.000Z') })

  assert.equal(calls, 1)
})

test('local event store replays durable events with since filtering', () => {
  const projectRoot = tmpRoot()
  const dir = writeRunState(projectRoot, 'run-events')
  const store = createLocalRunStore({ projectRoot })
  const eventStore = createLocalEventStore({ getRunState: store.getRunState })
  const eventPath = path.join(dir, 'events.jsonl')
  appendEventLog(eventPath, { seq: 1, type: 'stdout', text: 'old' })
  appendEventLog(eventPath, { seq: 2, type: 'stdout', text: 'new' })

  const replay = eventStore.listEvents({ runId: 'run-events', since: 1 })
  assert.equal(replay.run.runId, 'run-events')
  assert.deepEqual(replay.events.map((event) => event.text), ['new'])
  assert.deepEqual(replay.errors, [])
})

test('local artifact store builds details and follow-up context packages', () => {
  const projectRoot = tmpRoot()
  const dir = writeRunState(projectRoot, 'artifact-run')
  const runState = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8'))
  const store = createLocalArtifactStore({ projectRoot })
  const details = store.buildRunDetails(runState)
  const selected = details.followupArtifacts.find((artifact) => artifact.kind === 'workflow-summary')
  assert.ok(selected)
  const contextPackage = store.createFollowupContextPackage({
    details,
    artifacts: [{ id: selected.id, kind: selected.kind }],
  })

  assert.equal(details.summaryMarkdown.trim(), '# artifact-run')
  assert.equal(contextPackage.artifactCount, 1)
  assert.match(contextPackage.markdown, /artifact-run/)
})

test('local run store rejects invalid opaque cursors', () => {
  assert.throws(() => decodeRunsCursor('not-json'), {
    statusCode: 400,
    code: 'invalid_cursor',
  })
})
