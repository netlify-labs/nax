const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  artifactsRootForRunState,
  buildStepJson,
  nextAttemptNumber,
  persistRunArtifact,
  persistWorkflowArtifacts,
  safeArtifactName,
  stepDirectoryName,
  updateLatestSymlink,
  writeGithubStepSummary,
} = require('../lib/workflow-artifacts')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-workflow-artifacts-'))
}

function sampleRunState(projectRoot = tmpRoot(), overrides = {}) {
  const runId = overrides.runId || '2026-05-20T20-39-05-695Z-review'
  const step = {
    id: 'review',
    title: 'Review',
    action: 'issue',
    agents: ['claude', 'codex'],
    status: 'completed',
    runs: [
      {
        transport: 'netlify-api',
        agent: 'claude',
        status: 'completed',
        runnerId: 'runner-claude',
        sessionId: 'session-claude',
        resultText: 'Claude result',
        usage: { totalTokens: 1000, stepsCount: 3, totalCreditsCost: 2.5 },
        links: {
          sessionUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-claude?session=session-claude',
        },
      },
      {
        transport: 'github',
        agent: 'codex',
        status: 'completed',
        runnerId: 'runner-codex',
        sessionId: 'session-codex',
        resultText: 'Codex result',
        usage: { totalTokens: 2000, stepsCount: 4, totalCreditsCost: 3.5 },
        links: {
          commentUrl: 'https://github.com/o/r/issues/1#issuecomment-1',
        },
      },
    ],
  }
  return {
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    transport: 'netlify-api',
    projectRoot,
    createdAt: '2026-05-20T20:39:05.695Z',
    updatedAt: '2026-05-20T20:55:11.000Z',
    status: 'completed',
    options: {},
    steps: overrides.steps || [step],
    dir: path.join(projectRoot, '.nax', 'workflows', runId),
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

test('safeArtifactName sanitizes path-like and dot-prefixed names', () => {
  assert.equal(safeArtifactName('../Codex Review!'), 'codex-review')
  assert.equal(safeArtifactName(''), 'run')
  assert.equal(safeArtifactName('a'.repeat(80)).length, 64)
})

test('stepDirectoryName uses zero-padded execution ordinal', () => {
  assert.equal(stepDirectoryName({ id: 'cross review' }, 2), '02-cross-review')
  assert.equal(stepDirectoryName({ id: 'review' }, 10), '10-review')
})

test('persistWorkflowArtifacts writes summaries, usage, step files, and agent files', () => {
  const state = sampleRunState()

  const root = persistWorkflowArtifacts(state)

  assert.equal(root, artifactsRootForRunState(state))
  assert.equal(fs.existsSync(path.join(root, 'summary.md')), true)
  assert.equal(fs.existsSync(path.join(root, 'usage.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'steps', '01-review', 'step.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'steps', '01-review', 'summary.md')), true)
  assert.equal(fs.existsSync(path.join(root, 'steps', '01-review', 'usage.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'steps', '01-review', 'agent-runners', 'claude.md')), true)
  assert.equal(fs.existsSync(path.join(root, 'steps', '01-review', 'agent-runners', 'claude.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'steps', '01-review', 'agent-runners', 'claude.attempt-1.json')), true)
  assert.equal(fs.existsSync(path.join(state.projectRoot, '.nax', 'agent-sessions', 'session-claude', 'summary.md')), true)
  assert.equal(fs.existsSync(path.join(state.projectRoot, '.nax', 'agent-runners', 'runner-claude', 'summary.md')), true)

  const usage = readJson(path.join(root, 'usage.json'))
  assert.deepEqual(usage.total, {
    totalTokens: 3000,
    stepsCount: 7,
    totalCreditsCost: 6,
  })

  const topSummary = fs.readFileSync(path.join(root, 'summary.md'), 'utf8')
  assert.ok(topSummary.includes('[summary](steps/01-review/summary.md)'))
  assert.ok(topSummary.includes('[metadata](steps/01-review/step.json)'))
  assert.ok(topSummary.includes('[usage](steps/01-review/usage.json)'))
  assert.ok(topSummary.includes('[result](steps/01-review/agent-runners/claude.md)'))
  assert.ok(topSummary.includes('[attempt 1](steps/01-review/agent-runners/claude.attempt-1.md)'))

  const stepSummary = fs.readFileSync(path.join(root, 'steps', '01-review', 'summary.md'), 'utf8')
  assert.ok(stepSummary.includes('[step metadata](step.json)'))
  assert.ok(stepSummary.includes('[usage](usage.json)'))
  assert.ok(stepSummary.includes('[result](agent-runners/claude.md)'))
  assert.ok(stepSummary.includes('[attempt 1](agent-runners/claude.attempt-1.md)'))

  const agent = readJson(path.join(root, 'steps', '01-review', 'agent-runners', 'claude.json'))
  assert.equal(agent.resultText, 'Claude result')
  assert.equal(agent.runnerId, 'runner-claude')
  assert.equal(agent.attemptNumber, 1)
  assert.equal(agent.links.sessionUrl, 'https://app.netlify.com/projects/site/agent-runs/runner-claude?session=session-claude')
})

test('persistRunArtifact appends immutable attempts and refreshes latest copy', () => {
  const state = sampleRunState()
  const step = state.steps[0]
  const first = step.runs[0]
  persistRunArtifact(state, step, first)

  const second = {
    ...first,
    runnerId: 'runner-claude-retry',
    sessionId: 'session-claude-retry',
    resultText: 'Claude retry result',
    usage: { totalTokens: 1500, stepsCount: 5, totalCreditsCost: 4 },
  }
  step.runs[0] = second
  persistRunArtifact(state, step, second)

  const runsDir = path.join(artifactsRootForRunState(state), 'steps', '01-review', 'agent-runners')
  assert.equal(fs.existsSync(path.join(runsDir, 'claude.attempt-1.json')), true)
  assert.equal(fs.existsSync(path.join(runsDir, 'claude.attempt-2.json')), true)
  assert.equal(readJson(path.join(runsDir, 'claude.attempt-1.json')).runnerId, 'runner-claude')
  assert.equal(readJson(path.join(runsDir, 'claude.attempt-2.json')).runnerId, 'runner-claude-retry')
  assert.equal(readJson(path.join(runsDir, 'claude.json')).runnerId, 'runner-claude-retry')
  assert.equal(nextAttemptNumber(runsDir, 'claude'), 3)
})

test('buildStepJson lists immutable attempts in attempt-number order', () => {
  const state = sampleRunState()
  const step = state.steps[0]
  persistRunArtifact(state, step, step.runs[0])
  step.runs[0] = {
    ...step.runs[0],
    runnerId: 'runner-claude-retry',
    sessionId: 'session-claude-retry',
  }
  persistRunArtifact(state, step, step.runs[0])

  const json = buildStepJson({ runState: state, step })
  assert.deepEqual(json.runs[0].attempts.map((attempt) => attempt.attemptNumber), [1, 2])
})

test('summaryOnly rebuild skips new immutable attempt files', () => {
  const state = sampleRunState()
  const step = state.steps[0]
  persistWorkflowArtifacts(state, { summaryOnly: true })

  const runsDir = path.join(artifactsRootForRunState(state), 'steps', '01-review', 'agent-runners')
  assert.equal(fs.existsSync(path.join(runsDir, 'claude.attempt-1.json')), false)

  persistRunArtifact(state, step, step.runs[0])
  const before = fs.statSync(path.join(runsDir, 'claude.attempt-1.json')).mtimeMs
  persistWorkflowArtifacts(state, { summaryOnly: true })
  const after = fs.statSync(path.join(runsDir, 'claude.attempt-1.json')).mtimeMs
  assert.equal(after, before)
})

test('run with no meaningful terminal data produces no per-agent file', () => {
  const state = sampleRunState(tmpRoot(), {
    steps: [{
      id: 'empty',
      title: 'Empty',
      agents: ['codex'],
      status: 'completed',
      runs: [{ agent: 'codex', status: 'completed', resultText: '' }],
    }],
  })
  persistWorkflowArtifacts(state)

  const runsDir = path.join(artifactsRootForRunState(state), 'steps', '01-empty', 'agent-runners')
  assert.equal(fs.existsSync(path.join(runsDir, 'codex.json')), false)
})

test('updateLatestSymlink points to the current run directory when supported', () => {
  const state = sampleRunState()
  fs.mkdirSync(state.dir, { recursive: true })
  const ok = updateLatestSymlink(state)
  const latest = path.join(path.dirname(state.dir), 'latest')

  if (ok) {
    assert.equal(fs.readlinkSync(latest), path.basename(state.dir))
  }
})

test('writeGithubStepSummary writes compact summary for oversized content', () => {
  const state = sampleRunState()
  persistWorkflowArtifacts(state)
  const root = artifactsRootForRunState(state)
  fs.writeFileSync(path.join(root, 'summary.md'), `${'x'.repeat(950 * 1024)}\n`)
  const target = path.join(tmpRoot(), 'step-summary.md')

  writeGithubStepSummary(state, { githubStepSummary: target })

  const written = fs.readFileSync(target, 'utf8')
  assert.match(written, /Full output: download the `nax-review-/)
  assert.ok(Buffer.byteLength(written) < 900 * 1024)
})
