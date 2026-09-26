// Verifies the run details modal shows a run's structured findings in a collapsible table.
// Runs a real dashboard against a temp project containing a saved review run built from a fixture.
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { startDashboardServer } = require('../../src/dashboard/server')

const RUN_ID = '2026-09-25T12-00-00-000Z-review'
let instance

test.beforeAll(async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-findings-'))
  const dir = path.join(projectRoot, '.nax', 'workflows', RUN_ID)
  fs.mkdirSync(dir, { recursive: true })
  const synthesizeText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'findings', 'synthesize-3-findings.md'), 'utf8')
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    runId: RUN_ID,
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    transport: 'netlify-api',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:30:00.000Z',
    completedAt: '2026-09-25T12:30:00.000Z',
    flow: { id: 'review', title: 'Review', findings: { step: 'synthesize', adapter: 'review-consensus' }, steps: [{ id: 'synthesize', title: 'Summarize Consensus', agents: ['codex'] }] },
    steps: [{
      id: 'synthesize',
      title: 'Summarize Consensus',
      status: 'completed',
      agents: ['codex'],
      runs: [{ agent: 'codex', instanceId: 'codex:auto:auto', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1', resultText: synthesizeText }],
    }],
  }))
  instance = await startDashboardServer({ projectRoot, initialWorkflow: 'review' })
})

test.afterAll(async () => {
  if (instance) await instance.close()
})

test('run details show a Findings panel with one row per finding, contested ones marked', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.goto(instance.url, { waitUntil: 'networkidle' })
  const runItem = page.locator('.run-item').filter({ hasText: RUN_ID })
  await expect(runItem).toBeVisible()
  await runItem.getByRole('button', { name: 'View run details' }).click()

  const panel = page.locator('.findings-panel')
  await expect(panel).toContainText('3 consensus')
  await expect(panel).toContainText('1 other')
  await panel.getByRole('button', { name: /Findings/ }).click()
  await expect(panel.locator('.findings-row')).toHaveCount(4)
  await expect(panel.locator('.findings-row').last()).toContainText('contested')
  await expect(panel.locator('.findings-row').first()).toContainText('1')
  await expect(panel.getByRole('button', { name: 'Copy S1' })).toBeVisible()
})
