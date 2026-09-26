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
