// Verifies the dashboard dry-run shows readable flow diagnostics when a flow breaks while open.
// Runs a real dashboard server against a temp project and drives it with Playwright.
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { startDashboardServer } = require('../../src/dashboard/server')

let instance
let promptPath = ''

test.beforeAll(async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-diagnostics-'))
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', 'diag-flow')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: diag-flow',
    'title: Diagnostics Flow',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    title: One',
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))
  promptPath = path.join(flowDir, 'prompts', 'one.md')
  fs.writeFileSync(promptPath, '---\ntitle: One\n---\n\nOne\n')
  instance = await startDashboardServer({ projectRoot, initialWorkflow: 'diag-flow' })
})

test.afterAll(async () => {
  if (instance) await instance.close()
})

test('dry-run of a flow that broke after loading shows each diagnostic and its fix hint', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.goto(instance.url, { waitUntil: 'networkidle' })
  await page.locator('.workflow-item').filter({ hasText: 'Diagnostics Flow' }).click()
  await expect(page.locator('.workflow-node')).toHaveCount(1)

  fs.rmSync(promptPath)
  await page.getByRole('button', { name: 'Dry run' }).click()

  const alert = page.locator('.output-section .output-error-alert .mantine-Alert-message')
  await expect(alert).toContainText('Flow "diag-flow" is invalid', { timeout: 5000 })
  await expect(alert).toContainText('prompt file does not exist')
  await expect(alert).toContainText('Hint: Create the prompt file or update step.prompt.')
  await expect(alert).toHaveCSS('white-space', 'pre-wrap')
})
