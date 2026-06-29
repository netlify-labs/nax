const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  createRunState,
  dismissRunState,
  findLatestUnfinishedRun,
  findLatestUnfinishedLocalRun,
  hasRepairableRuns,
  isUnfinishedRun,
  isUnfinishedLocalRun,
  listWorkflowStatePage,
  listRunStates,
  saveRunState,
  workflowStatePath,
} = require('../../src/storage/local/run-state')

function runState(tmp, overrides = {}) {
  const runId = overrides.runId || `run-${Math.random().toString(16).slice(2)}`
  return {
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.flow ? { flow: overrides.flow } : {}),
    transport: overrides.transport || 'netlify-api',
    projectRoot: tmp,
    createdAt: overrides.createdAt || '2026-05-12T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-05-12T00:00:00.000Z',
    options: {},
    steps: overrides.steps || [],
    dir: path.join(tmp, '.nax', 'workflows', runId),
  }
}

function writeRunState(state) {
  fs.mkdirSync(state.dir, { recursive: true })
  fs.writeFileSync(path.join(state.dir, 'workflow.json'), JSON.stringify(state, null, 2) + '\n')
  return state
}

function setWorkflowMtime(state, iso) {
  const time = new Date(iso)
  fs.utimesSync(path.join(state.dir, 'workflow.json'), time, time)
}

test('isUnfinishedLocalRun detects submitted local runner ids', () => {
  assert.equal(isUnfinishedLocalRun(runState('/tmp/x', {
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'runner-1', status: 'submitted' }] }],
  })), true)

  assert.equal(isUnfinishedLocalRun(runState('/tmp/x', {
    steps: [{ id: 'review', status: 'completed', runs: [{ runnerId: 'runner-1', status: 'completed' }] }],
  })), false)
})

test('createRunState persists immutable target and branch aliases', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-target-test-'))
  const target = {
    branch: 'main',
    ref: 'origin/main',
    sha: '0123456789abcdef0123456789abcdef01234567',
    sourceType: 'current-branch',
    verified: true,
    caveats: [],
  }

  const state = createRunState({
    projectRoot: tmp,
    flow: { id: 'review', title: 'Review' },
    transport: 'netlify-api',
    target,
    now: new Date('2026-05-12T00:00:00.000Z'),
  })

  assert.deepEqual(state.target, target)
  assert.equal(state.branch, 'main')
  assert.equal(state.branchSource, 'current-branch')
})

test('hasRepairableRuns ignores terminal failed and timeout runs', () => {
  const failedStep = {
    id: 'review',
    status: 'failed',
    runs: [{ runnerId: 'runner-1', status: 'failed', resultText: '' }],
  }
  const timeoutStep = {
    id: 'review',
    status: 'failed',
    runs: [{ runnerId: 'runner-1', status: 'timeout', resultText: '' }],
  }

  assert.equal(hasRepairableRuns(failedStep), false)
  assert.equal(hasRepairableRuns(timeoutStep), false)
  assert.equal(isUnfinishedLocalRun(runState('/tmp/x', { steps: [failedStep] })), false)
})

test('hasRepairableRuns still flags in-flight submitted and running runs', () => {
  assert.equal(hasRepairableRuns({
    runs: [{ runnerId: 'runner-1', status: 'submitted' }],
  }), true)
  assert.equal(hasRepairableRuns({
    runs: [{ runnerId: 'runner-1', status: 'running' }],
  }), true)
})

test('isUnfinishedRun treats cancelled remote runner ids as terminal', () => {
  const state = runState('/tmp/x', {
    status: 'cancelled',
    steps: [{
      id: 'review',
      status: 'cancelled',
      runs: [{ runnerId: 'runner-1', status: 'cancelled' }],
    }],
  })

  assert.equal(isUnfinishedRun(state), false)
  assert.equal(isUnfinishedLocalRun(state), false)
})

test('findLatestUnfinishedLocalRun returns newest unfinished local run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-test-'))
  writeRunState(runState(tmp, {
    runId: 'old',
    updatedAt: '2026-05-12T00:00:00.000Z',
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'old-runner', status: 'submitted' }] }],
  }))
  writeRunState(runState(tmp, {
    runId: 'new',
    updatedAt: '2026-05-12T01:00:00.000Z',
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'new-runner', status: 'submitted' }] }],
  }))

  assert.deepEqual(listRunStates(tmp).map((state) => state.runId), ['new', 'old'])
  assert.equal(findLatestUnfinishedLocalRun(tmp, { flowId: 'review' }).runId, 'new')
})

test('isUnfinishedRun detects submitted GitHub issue runs', () => {
  const state = runState('/tmp/x', {
    transport: 'github',
    steps: [{ id: 'review', status: 'running', runs: [{ issueNumber: 123, status: 'submitted' }] }],
  })

  assert.equal(isUnfinishedRun(state), true)
  assert.equal(isUnfinishedLocalRun(state), false)
})

test('isUnfinishedRun detects interrupted workflow with completed prefix and remaining steps', () => {
  const state = runState('/tmp/x', {
    status: 'interrupted',
    transport: 'github',
    flow: {
      id: 'ideas',
      steps: [
        { id: 'ideate' },
        { id: 'cross-score' },
        { id: 'react' },
      ],
    },
    steps: [
      { id: 'ideate', status: 'completed', runs: [{ issueNumber: 1, status: 'completed' }] },
      { id: 'cross-score', status: 'completed', runs: [{ issueNumber: 1, status: 'completed' }] },
    ],
  })

  assert.equal(isUnfinishedRun(state), true)
})

test('findLatestUnfinishedRun can filter by transport', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-generic-test-'))
  writeRunState(runState(tmp, {
    runId: 'github-run',
    transport: 'github',
    updatedAt: '2026-05-12T02:00:00.000Z',
    steps: [{ id: 'review', status: 'running', runs: [{ issueNumber: 99, status: 'submitted' }] }],
  }))
  writeRunState(runState(tmp, {
    runId: 'local-run',
    transport: 'netlify-api',
    updatedAt: '2026-05-12T01:00:00.000Z',
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'runner-1', status: 'submitted' }] }],
  }))

  assert.equal(findLatestUnfinishedRun(tmp, { flowId: 'review' }).runId, 'github-run')
  assert.equal(findLatestUnfinishedRun(tmp, { flowId: 'review', transport: 'netlify-api' }).runId, 'local-run')
  assert.equal(findLatestUnfinishedRun(tmp, { flowId: 'review', transport: 'local' }).runId, 'local-run')
})

test('listRunStates migrates legacy .nax/runs state to .nax/workflows once', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-legacy-test-'))
  const legacyDir = path.join(tmp, '.nax', 'runs', 'legacy-run')
  fs.mkdirSync(legacyDir, { recursive: true })
  const state = {
    ...runState(tmp, {
      runId: 'legacy-run',
      steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'runner-1', status: 'submitted' }] }],
    }),
    dir: legacyDir,
  }
  fs.writeFileSync(path.join(legacyDir, 'run.json'), JSON.stringify(state, null, 2) + '\n')

  const states = listRunStates(tmp)

  assert.equal(states[0].runId, 'legacy-run')
  assert.equal(fs.existsSync(path.join(tmp, '.nax', 'runs')), false)
  assert.equal(fs.existsSync(path.join(tmp, '.nax', 'workflows', 'legacy-run', 'workflow.json')), true)
})

test('listWorkflowStatePage returns newest durable page using file mtimes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-page-test-'))
  const old = writeRunState(runState(tmp, { runId: 'old' }))
  const middle = writeRunState(runState(tmp, { runId: 'middle' }))
  const newest = writeRunState(runState(tmp, { runId: 'newest' }))
  setWorkflowMtime(old, '2026-05-12T00:00:00.000Z')
  setWorkflowMtime(middle, '2026-05-12T00:01:00.000Z')
  setWorkflowMtime(newest, '2026-05-12T00:02:00.000Z')

  const first = listWorkflowStatePage(tmp, { limit: 2 })
  assert.equal(first.total, 3)
  assert.equal(first.limit, 2)
  assert.equal(first.offset, 0)
  assert.deepEqual(first.items.map((state) => state.runId), ['newest', 'middle'])

  const second = listWorkflowStatePage(tmp, { limit: 2, offset: 2 })
  assert.deepEqual(second.items.map((state) => state.runId), ['old'])
  assert.equal(second.total, 3)
})

test('listWorkflowStatePage parses only selected workflow state files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-page-invalid-test-'))
  const valid = writeRunState(runState(tmp, { runId: 'valid' }))
  const invalidDir = path.join(tmp, '.nax', 'workflows', 'invalid')
  fs.mkdirSync(invalidDir, { recursive: true })
  fs.writeFileSync(path.join(invalidDir, 'workflow.json'), '{not json')
  setWorkflowMtime(valid, '2026-05-12T00:02:00.000Z')
  fs.utimesSync(path.join(invalidDir, 'workflow.json'), new Date('2026-05-12T00:01:00.000Z'), new Date('2026-05-12T00:01:00.000Z'))

  const first = listWorkflowStatePage(tmp, { limit: 1 })
  assert.deepEqual(first.items.map((state) => state.runId), ['valid'])
  assert.equal(first.total, 2)

  const second = listWorkflowStatePage(tmp, { limit: 1, offset: 1 })
  assert.deepEqual(second.items, [])
  assert.equal(second.total, 2)
})

test('dismissRunState marks unfinished runs ignored by resume detection', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-dismiss-test-'))
  const state = saveRunState(runState(tmp, {
    runId: 'dismiss-me',
    steps: [{ id: 'review', status: 'running', runs: [{ runnerId: 'runner-1', status: 'submitted' }] }],
  }))

  const dismissed = dismissRunState(state, {
    now: new Date('2026-05-12T02:00:00.000Z'),
  })

  assert.equal(dismissed.status, 'dismissed')
  assert.equal(dismissed.dismissedAt, '2026-05-12T02:00:00.000Z')
  assert.equal(dismissed.dismissReason, 'user-declined-resume')
  assert.equal(isUnfinishedLocalRun(dismissed), false)
  assert.equal(findLatestUnfinishedLocalRun(tmp, { flowId: 'review' }), null)
})

test('saveRunState refreshes workflow artifact summaries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-artifacts-test-'))
  const state = saveRunState(runState(tmp, {
    runId: 'artifact-run',
    status: 'completed',
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'completed',
      runs: [{
        agent: 'codex',
        status: 'completed',
        resultText: 'done',
        usage: { totalTokens: 10, stepsCount: 1, totalCreditsCost: 0.5 },
      }],
    }],
  }))

  assert.equal(fs.existsSync(path.join(state.dir, 'artifacts', 'summary.md')), true)
  assert.equal(fs.existsSync(path.join(state.dir, 'artifacts', 'usage.json')), true)
})

test('saveRunState preserves durable runner metadata from newer state snapshots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-merge-test-'))
  const current = saveRunState(runState(tmp, {
    runId: 'merge-run',
    status: 'running',
    steps: [{
      id: 'review',
      status: 'running',
      runs: [{
        agent: 'gemini',
        status: 'submitted',
        runnerId: 'runner-gemini',
        sessionId: 'session-gemini',
        submittedAfterSeconds: 11,
        links: { agentRunUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-gemini' },
        raw: { create: { id: 'runner-gemini' } },
      }],
    }],
  }))

  saveRunState({
    ...current,
    status: 'cancelled',
    steps: [{
      id: 'review',
      status: 'cancelled',
      runs: [{
        agent: 'gemini',
        status: 'cancelled',
        runnerId: '',
        sessionId: '',
      }],
    }],
  })

  const saved = JSON.parse(fs.readFileSync(workflowStatePath(current.dir), 'utf8'))
  assert.equal(saved.status, 'cancelled')
  assert.equal(saved.steps[0].runs[0].status, 'cancelled')
  assert.equal(saved.steps[0].runs[0].runnerId, 'runner-gemini')
  assert.equal(saved.steps[0].runs[0].sessionId, 'session-gemini')
  assert.equal(saved.steps[0].runs[0].submittedAfterSeconds, 11)
  assert.equal(saved.steps[0].runs[0].links.agentRunUrl, 'https://app.netlify.com/projects/site/agent-runs/runner-gemini')
  assert.deepEqual(saved.steps[0].runs[0].raw.create, { id: 'runner-gemini' })
  assert.equal(fs.existsSync(`${workflowStatePath(current.dir)}.lock`), false)
  assert.equal(fs.readdirSync(current.dir).some((entry) => entry.includes('.tmp')), false)
})

test('saveRunState preserves dashboard retry replacement over stale agent snapshot', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-run-state-retry-merge-test-'))
  const current = saveRunState(runState(tmp, {
    runId: 'retry-merge-run',
    status: 'running',
    steps: [{
      id: 'review',
      status: 'running',
      runs: [{
        agent: 'codex',
        status: 'submitted',
        runnerId: 'runner-new',
        raw: {
          dashboardRetry: {
            requestedAt: '2026-06-28T21:48:10.000Z',
            previous: { runnerId: 'runner-old' },
          },
        },
      }],
    }],
  }))

  saveRunState({
    ...current,
    steps: [{
      id: 'review',
      status: 'running',
      runs: [{
        agent: 'codex',
        status: 'completed',
        runnerId: 'runner-old',
        resultText: 'stale result',
        raw: { create: { id: 'runner-old' } },
      }],
    }],
  })

  const saved = JSON.parse(fs.readFileSync(workflowStatePath(current.dir), 'utf8'))
  assert.equal(saved.steps[0].runs[0].runnerId, 'runner-new')
  assert.equal(saved.steps[0].runs[0].status, 'submitted')
  assert.equal(saved.steps[0].runs[0].raw.dashboardRetry.previous.runnerId, 'runner-old')
})
