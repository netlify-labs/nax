const { test, expect } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')
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

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-visualize-e2e-'))
}

function writeCompletedRunFixture(projectRoot) {
  const runId = 'fixture-run-details'
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  const artifactsDir = path.join(dir, 'artifacts')
  const stepDir = path.join(artifactsDir, 'steps', '01-review')
  const runnerDir = path.join(stepDir, 'agent-runners')
  fs.mkdirSync(runnerDir, { recursive: true })

  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    transport: 'netlify-api',
    branch: 'main',
    target: {
      branch: 'main',
      ref: 'origin/main',
      sha: '0123456789abcdef0123456789abcdef01234567',
      sourceType: 'current-branch',
      verified: true,
      caveats: [],
    },
    options: {
      branch: 'main',
      transport: 'netlify-api',
      stepModels: {
        review: ['codex'],
      },
    },
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:01:00.000Z',
    dir,
    flow: {
      id: 'review',
      title: 'Review',
      steps: [
        { id: 'review', title: 'Review', agents: ['codex'], submit: 'new-run' },
      ],
    },
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'completed',
      agents: ['codex'],
      runs: [{ agent: 'codex', status: 'completed', runnerId: 'runner-1', sessionId: 'session-1' }],
    }],
  }, null, 2))

  fs.writeFileSync(path.join(artifactsDir, 'summary.md'), '# Review summary\n\nFinal workflow summary.\n')
  fs.writeFileSync(path.join(stepDir, 'step.json'), JSON.stringify({
    id: 'review',
    title: 'Review',
    status: 'completed',
  }, null, 2))
  fs.writeFileSync(path.join(stepDir, 'summary.md'), '# Review\n\nStep summary.\n')
  fs.writeFileSync(path.join(runnerDir, 'codex.json'), JSON.stringify({
    agent: 'codex',
    stepId: 'review',
    status: 'completed',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    links: {
      sessionUrl: 'https://example.test/session-1',
    },
  }, null, 2))
  fs.writeFileSync(path.join(runnerDir, 'codex.md'), '# Codex result\n\nFinal result text.\n')

  return runId
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

  await page.locator('.workflow-item').filter({ hasText: 'Local Smoke Test' }).click()
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

test('visualize opens shared run details modal from runs and graph agent results', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot)
  const server = await startVisualizeServer({
    projectRoot,
    initialWorkflow: 'review',
  })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })

    const runItem = page.locator('.run-item').filter({ hasText: runId })
    await expect(runItem).toBeVisible()
    await runItem.getByText('Review').first().click()

    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Review summary' })).toBeVisible()
    await expect(page.getByText('Final workflow summary.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeHidden()

    await runItem.getByRole('button', { name: 'Load run graph' }).click()
    await expect(page.locator('.workflow-node.status-completed')).toHaveCount(1)

    const reviewNode = page.locator('.workflow-node').filter({ has: page.getByRole('heading', { name: 'Review', exact: true }) })
    await reviewNode.getByRole('button', { name: 'Codex' }).click()

    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Codex result' })).toBeVisible()
    await expect(page.getByText('Final result text.')).toBeVisible()
  } finally {
    await server.close()
  }
})

test('visualize submits a follow-up from run details composer', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot)
  const followupRequests = []
  const submissions = []
  const server = await startVisualizeServer({
    projectRoot,
    initialWorkflow: 'review',
    siteName: 'netlify-agent-executor',
    followupSubmitRun: async ({ run }) => {
      submissions.push({ ...run })
      return {
        ...run,
        status: 'submitted',
        runnerId: run.existingRunnerId || `runner-${run.agent}`,
        sessionId: run.existingRunnerId ? `session-${run.agent}-followup` : `session-${run.agent}`,
      }
    },
  })

  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes(`/api/runs/${runId}/followups`)) return
    followupRequests.push(request.postDataJSON())
  })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })

    const runItem = page.locator('.run-item').filter({ hasText: runId })
    await expect(runItem).toBeVisible()
    await runItem.getByText('Review').first().click()

    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeVisible()
    await page.getByRole('button', { name: 'Send to next agent' }).click()
    await page.getByRole('menuitem', { name: 'Run a followup' }).click()

    await expect(page.getByRole('dialog', { name: 'Send to next agent' })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Select the previous Agent Run to follow up on' })).toBeVisible()
    await page.getByText('Start fresh agent runner').click()
    await expect(page.getByRole('combobox', { name: 'Select the previous Agent Run to follow up on' })).toBeHidden()
    await page.getByText('Follow-up prompt on previous Agent Run').click()
    await expect(page.getByRole('combobox', { name: 'Select the previous Agent Run to follow up on' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Select the previous Agent Run to follow up on' }).click()
    await page.getByRole('option', { name: 'Step 1: Review · Codex result' }).click()
    await expect(page.getByText('Codex: follow-up prompt on existing thread')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /Workflow summary/ })).toBeChecked()
    await expect(page.getByRole('button', { name: /Open Workflow summary/ })).toBeVisible()
    await expect(page.getByText('Show advanced artifacts')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Run follow-up' })).toBeDisabled()

    await page.locator('.run-followup-model-chip').filter({ hasText: 'Gemini' }).click()
    await expect(page.getByText('Gemini: start fresh agent runner')).toBeVisible()
    await page.getByLabel('What should the next agent do?').fill('Verify the proposed fix and call out risk.')
    await page.getByRole('button', { name: 'Run follow-up' }).click()

    await expect(page.locator('.mantine-Notification-root').filter({ hasText: 'Follow-up submitted' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Send to next agent' })).toBeHidden()
    expect(followupRequests).toHaveLength(1)
    expect(followupRequests[0]).toMatchObject({
      mode: 'follow-up-thread',
      prompt: 'Verify the proposed fix and call out risk.',
      targetId: 'agent-result:review:runner-1:session-1:codex',
      models: ['codex', 'gemini'],
    })
    expect(followupRequests[0].artifacts).toEqual([{ id: 'workflow-summary:summary.md', kind: 'workflow-summary' }])
    expect(submissions.map((submission) => [submission.agent, submission.existingRunnerId])).toEqual([
      ['codex', 'runner-1'],
      ['gemini', ''],
    ])

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeHidden()
    await expect(page.locator('.run-item').filter({ hasText: 'Follow-up on Review (Gemini)' })).toBeVisible()
  } finally {
    await server.close()
  }
})
