const { test, expect } = require('@playwright/test')
const { startVisualizeServer } = require('../../src/visualize-server')

let instance

test.beforeAll(async () => {
  instance = await startVisualizeServer({
    projectRoot: process.cwd(),
    initialWorkflow: 'review',
  })
})

test.afterAll(async () => {
  if (instance) await instance.close()
})

async function openReview(page, viewport) {
  await page.setViewportSize(viewport)
  await page.goto(instance.url, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: 'Netlify Agent Executor' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Review/ }).first()).toBeVisible()
  await expect(page.locator('.workflow-node')).toHaveCount(3)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(page.locator('.workflow-node').getByRole('heading', { name: 'Cross Review' })).toBeVisible()
  await expect(page.locator('.workflow-node').getByRole('heading', { name: 'Summarize Consensus' })).toBeVisible()
}

test('visualize renders Review graph on desktop', async ({ page }, testInfo) => {
  await openReview(page, { width: 1360, height: 860 })
  await testInfo.attach('desktop', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})

test('visualize renders Review graph on narrow viewport', async ({ page }, testInfo) => {
  await openReview(page, { width: 390, height: 820 })
  await testInfo.attach('narrow', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})

test('visualize dry-run simulation updates step, model pill, and output without credits', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.goto(instance.url, { waitUntil: 'networkidle' })

  await page.getByRole('button', { name: /Local Smoke Test/ }).click()
  await expect(page.locator('.workflow-node')).toHaveCount(1)

  await page.getByRole('button', { name: 'Run options' }).click()
  await page.getByRole('menuitem', { name: 'Dry run' }).click()
  await expect(page.getByRole('dialog', { name: 'Dry run workflow' })).toBeVisible()
  await page.getByRole('button', { name: 'Dry Run' }).click()

  await expect(page.locator('.workflow-node.status-running')).toHaveCount(1, { timeout: 2000 })
  await expect(page.locator('.agent-chip.agent-completed')).toHaveCount(1, { timeout: 7000 })
  await expect(page.locator('.workflow-node.status-dry-run')).toHaveCount(1, { timeout: 2000 })
  await expect(page.getByText(/Dry run only/)).toBeVisible()

  await testInfo.attach('dry-run-event-state', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})
