// Verifies orchestration paths release the run lock when they fail after taking it, so a
// long-lived process (dashboard, MCP) never keeps a run locked after an error.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { handleRetry } = require('../../src/cli/main')
const { runLockDir } = require('../../src/storage/local/run-lock')

test('a retry that fails after taking the run lock releases it', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-retry-lock-'))
  const runId = '2026-09-25T12-00-00-000Z-retry-flow'
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId,
    flowId: 'retry-flow',
    transport: 'netlify-api',
    status: 'failed',
    branch: 'main',
    // The saved flow no longer has the failed step, so retry throws after taking the lock.
    flow: { id: 'retry-flow', title: 'Retry flow', steps: [{ id: 'other', prompt: 'p.md', agents: ['codex'] }] },
    steps: [{ id: 'review', status: 'failed', runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', status: 'failed', runnerId: 'r1', sessionId: 's1', promptText: 'p' }] }],
  }))
  await assert.rejects(handleRetry(runId, { projectRoot }), /no longer contains step review/)
  assert.equal(fs.existsSync(runLockDir(dir)), false)
})

test('a failed retry is saved as interrupted under its lock and leaves nothing tracked for exit', async () => {
  const { persistActiveRunState } = require('../../src/storage/local/graceful-run-state')
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-retry-settle-'))
  const runId = '2026-09-25T12-00-00-000Z-retry-flow'
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId,
    flowId: 'retry-flow',
    transport: 'netlify-api',
    status: 'running',
    branch: 'main',
    flow: { id: 'retry-flow', title: 'Retry flow', steps: [{ id: 'other', prompt: 'p.md', agents: ['codex'] }] },
    steps: [{ id: 'review', status: 'failed', runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', status: 'failed', runnerId: 'r1', sessionId: 's1', promptText: 'p' }] }],
  }))
  await assert.rejects(handleRetry(runId, { projectRoot }))
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8')).status, 'interrupted')
  assert.equal(persistActiveRunState('process-exit'), null, 'no stale snapshot left to write at exit')
})

test('resume by id takes the run lock before approving a review gate', async () => {
  const { resumeRunById } = require('../../src/cli/main')
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-resume-gate-lock-'))
  const runId = '2026-09-25T12-00-00-000Z-gate-flow'
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(runLockDir(dir), { recursive: true })
  fs.writeFileSync(path.join(runLockDir(dir), 'owner.json'), JSON.stringify({ pid: process.ppid, hostname: os.hostname(), nonce: 'other', command: 'nax dashboard' }))
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId,
    flowId: 'gate-flow',
    transport: 'netlify-api',
    status: 'awaiting_review',
    branch: 'main',
    flow: { id: 'gate-flow', title: 'Gate flow', steps: [{ id: 'approve', title: 'Approve', action: 'human-review', waitFor: 'human-review' }] },
    steps: [{ id: 'approve', status: 'awaiting_review', review: { status: 'awaiting_review' } }],
  }))
  await assert.rejects(resumeRunById(runId, { projectRoot }), (error) => /** @type {{ code?: string }} */ (error).code === 'run_locked')
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'workflow.json'), 'utf8'))
  assert.equal(saved.steps[0].review.status, 'awaiting_review', 'the gate was not approved without the lock')
})
