// Verifies the run details Resume panel: per-agent preview, blocked runs, and starting a resume.
// Runs a real dashboard against temp saved runs; only the browser's resume POST is intercepted.
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { startDashboardServer } = require('../../src/dashboard/server')

const RESUMABLE_ID = '2026-09-25T12-00-00-000Z-resume-flow'
const LOCKED_ID = '2026-09-25T11-00-00-000Z-resume-flow'
let instance

/** @param {string} projectRoot @param {string} runId */
function writeRun(projectRoot, runId) {
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId,
    flowId: 'resume-flow',
    flowTitle: 'Resume flow',
    transport: 'netlify-api',
    status: 'interrupted',
    branch: 'main',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:30:00.000Z',
    flow: { id: 'resume-flow', title: 'Resume flow', dir: projectRoot, steps: [{ id: 'review', title: 'Review', submit: 'new-run', prompt: 'review.md', agents: ['claude', 'codex', 'opencode'] }] },
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'running',
      agents: ['claude', 'codex', 'opencode'],
      runs: [
        { agent: 'claude', instanceId: 'claude:auto:auto', status: 'completed', runnerId: 'r-claude', sessionId: 's-claude', resultText: 'Claude review.', promptText: 'p' },
        { agent: 'codex', instanceId: 'codex:auto:auto', status: 'failed', runnerId: 'r-codex', promptText: 'p' },
        { agent: 'opencode', instanceId: 'opencode:auto:auto', status: 'cancelled', runnerId: 'r-opencode', promptText: 'p' },
      ],
    }],
  }))
  return dir
}

test.beforeAll(async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-resume-'))
  fs.writeFileSync(path.join(projectRoot, 'review.md'), '---\ntitle: Review\n---\n\nReview it.\n')
  writeRun(projectRoot, RESUMABLE_ID)
  const lockedDir = writeRun(projectRoot, LOCKED_ID)
  fs.mkdirSync(path.join(lockedDir, 'run.lock'), { recursive: true })
  fs.writeFileSync(path.join(lockedDir, 'run.lock', 'owner.json'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), nonce: 'n', command: 'nax run --resume' }))
  instance = await startDashboardServer({ projectRoot, initialWorkflow: 'resume-flow' })
})

test.afterAll(async () => {
  if (instance) await instance.close()
})

/** @param {import('@playwright/test').Page} page @param {string} runId */
async function openResumePanel(page, runId) {
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.goto(instance.url, { waitUntil: 'networkidle' })
  const runItem = page.locator('.run-item').filter({ hasText: runId })
  await expect(runItem).toBeVisible()
  await runItem.getByRole('button', { name: 'View run details' }).click()
  const panel = page.locator('.resume-panel')
  await panel.getByRole('button', { name: /Resume run/ }).click()
  return panel
}

test('the Resume panel previews each agent and starts a resume', async ({ page }) => {
  /** @type {unknown[]} */
  const posted = []
  await page.route(`**/api/runs/${RESUMABLE_ID}/resume`, async (route) => {
    posted.push(route.request().postDataJSON())
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ run: { id: 'live-resume', runId: RESUMABLE_ID, flowId: 'resume-flow', status: 'running' }, preview: { runId: RESUMABLE_ID } }),
    })
  })
  const panel = await openResumePanel(page, RESUMABLE_ID)
  await expect(panel.locator('.resume-row')).toHaveCount(3)
  await expect(panel.locator('.resume-row').nth(0)).toContainText('keep')
  await expect(panel.locator('.resume-row').nth(1)).toContainText('resubmit')
  await expect(panel.locator('.resume-row').nth(2)).toContainText('skip')
  await expect(panel.locator('.resume-counts')).toContainText('New agent runs: 1')
  await panel.getByLabel('Also resubmit cancelled agents').check()
  await expect(panel.locator('.resume-counts')).toContainText('New agent runs: 2')
  await panel.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(panel).toContainText('Resume started.')
  expect(posted).toEqual([{ includeCancelled: true }])
})

test('a run another process is executing shows why and cannot be resumed', async ({ page }) => {
  const panel = await openResumePanel(page, LOCKED_ID)
  await expect(panel.locator('.resume-blocked')).toContainText('already being executed')
  await expect(panel.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled()
})
