const { test, expect } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { startDashboardServer } = require('../../src/dashboard/server')

/** @typedef {import('@playwright/test').Locator} Locator */

let instance

test.beforeAll(async () => {
  instance = await startDashboardServer({
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-dashboard-e2e-'))
}

/**
 * @param {string} baseUrl
 * @param {string} routePath
 * @returns {string}
 */
function dashboardRouteUrl(baseUrl, routePath) {
  return new URL(routePath, `${baseUrl}/`).toString()
}

/**
 * @param {string} color
 * @returns {{ red: number, green: number, blue: number, alpha: number }}
 */
function parseCssColor(color) {
  const values = color.match(/-?\d*\.?\d+/g)?.map(Number) || []
  return {
    red: values[0] || 0,
    green: values[1] || 0,
    blue: values[2] || 0,
    alpha: values.length > 3 ? values[3] : 1,
  }
}

/**
 * @param {Locator} locator
 * @returns {Promise<{ red: number, green: number, blue: number, alpha: number }>}
 */
async function computedBackground(locator) {
  const color = await locator.evaluate((element) => {
    const target = /** @type {{ ownerDocument: { defaultView: { getComputedStyle: (element: unknown) => { backgroundColor: string } } | null } }} */ (element)
    const view = target.ownerDocument.defaultView
    return view ? view.getComputedStyle(element).backgroundColor : ''
  })
  return parseCssColor(String(color))
}

/**
 * @param {{ red: number, green: number, blue: number, alpha: number }} color
 */
function expectVisibleTeal(color) {
  expect(color.alpha).toBeGreaterThan(0.1)
  expect(color.green).toBeGreaterThan(color.red)
  expect(color.green).toBeGreaterThan(color.blue)
}

/**
 * @param {Locator} locator
 * @returns {Promise<{ red: number, green: number, blue: number, alpha: number }>}
 */
async function computedTextColor(locator) {
  const color = await locator.evaluate((element) => {
    const target = /** @type {{ ownerDocument: { defaultView: { getComputedStyle: (element: unknown) => { color: string } } | null } }} */ (element)
    const view = target.ownerDocument.defaultView
    return view ? view.getComputedStyle(element).color : ''
  })
  return parseCssColor(String(color))
}

/**
 * @param {string} projectRoot
 * @param {{ staleRunStatus?: string, staleWorkflowStatus?: string }} [options]
 * @returns {string}
 */
function writeCompletedRunFixture(projectRoot, options = {}) {
  const runId = 'fixture-run-details'
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', 'review')
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  const artifactsDir = path.join(dir, 'artifacts')
  const stepDir = path.join(artifactsDir, 'steps', '01-review')
  const runnerDir = path.join(stepDir, 'agent-runners')
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.mkdirSync(runnerDir, { recursive: true })

  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: review',
    'title: Review',
    'description: Fixture review flow',
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: review',
    '    title: Review',
    '    prompt: prompts/review.md',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'review.md'), '---\ntitle: Review\n---\n\nReview this fixture prompt.\n')

  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'review',
    flowTitle: 'Review',
    status: options.staleWorkflowStatus || 'completed',
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
      dir: flowDir,
      steps: [
        { id: 'review', title: 'Review', prompt: 'prompts/review.md', agents: ['codex'], submit: 'new-run' },
      ],
    },
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'completed',
      agents: ['codex'],
      runs: [{ agent: 'codex', status: options.staleRunStatus || 'completed', runnerId: 'runner-1', sessionId: 'session-1' }],
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
  fs.writeFileSync(path.join(runnerDir, 'codex.md'), '# Codex result\n\n## Findings\n\nFinal result text.\n')

  return runId
}

function writeRunningRunFixture(projectRoot) {
  const runId = 'fixture-running-details'
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', 'security-audit')
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })

  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    'id: security-audit',
    'title: Security Audit',
    'description: Fixture security flow',
    'defaults:',
    '  agents: [claude, gemini, codex]',
    'steps:',
    '  - id: audit-security',
    '    title: Audit Security',
    '    prompt: prompts/audit.md',
    '    agents: [claude, gemini, codex]',
    '  - id: synthesize-security-findings',
    '    title: Synthesize Security Findings',
    '    prompt: prompts/synthesize.md',
    '    agents: [codex]',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'audit.md'), 'Audit security.\n')
  fs.writeFileSync(path.join(flowDir, 'prompts', 'synthesize.md'), 'Synthesize security findings.\n')

  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    flowId: 'security-audit',
    flowTitle: 'Security Audit',
    status: 'running',
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
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:01:00.000Z',
    dir,
    flow: {
      id: 'security-audit',
      title: 'Security Audit',
      dir: flowDir,
      steps: [
        { id: 'audit-security', title: 'Audit Security', prompt: 'prompts/audit.md', agents: ['claude', 'gemini', 'codex'], submit: 'new-run' },
        { id: 'synthesize-security-findings', title: 'Synthesize Security Findings', prompt: 'prompts/synthesize.md', agents: ['codex'], submit: 'new-run' },
      ],
    },
    steps: [
      {
        id: 'audit-security',
        title: 'Audit Security',
        status: 'running',
        agents: ['claude', 'gemini', 'codex'],
        runs: [{
          agent: 'claude',
          status: 'submitted',
          runnerId: 'runner-claude',
          sessionId: 'session-claude',
          links: {
            sessionUrl: 'https://example.test/session-claude',
          },
        }],
      },
    ],
  }, null, 2))

  return runId
}

test('dashboard renders Review graph on desktop', async ({ page }, testInfo) => {
  await openReview(page, { width: 1360, height: 860 })
  await testInfo.attach('desktop', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})

test('dashboard renders Review graph on narrow viewport', async ({ page }, testInfo) => {
  await openReview(page, { width: 390, height: 820 })
  await testInfo.attach('narrow', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})

test('dashboard dry-run simulation updates step, model pill, and output without credits', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.goto(instance.url, { waitUntil: 'networkidle' })

  await page.locator('.workflow-item').filter({ hasText: 'Local Smoke Test' }).click()
  await expect(page.locator('.workflow-node')).toHaveCount(1)

  await page.getByRole('button', { name: 'Dry run' }).click()

  await expect(page.locator('.workflow-node.status-running')).toHaveCount(1, { timeout: 2000 })
  await expect(page.locator('.agent-chip.agent-completed')).toHaveCount(1, { timeout: 7000 })
  await expect(page.locator('.workflow-node.status-dry-run')).toHaveCount(1, { timeout: 2000 })
  await expect(page.getByText(/Dry run only/)).toBeVisible()

  await testInfo.attach('dry-run-event-state', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})

test('dashboard deep-links workflow routes and prompt modal routes', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.goto(instance.url, { waitUntil: 'networkidle' })
  await expect(page.getByRole('heading', { name: 'Netlify Agent Executor' })).toBeVisible()

  await page.goto(dashboardRouteUrl(instance.url, '/workflows/review'), { waitUntil: 'networkidle' })

  await expect(page).toHaveURL(/\/workflows\/review$/)
  await expect(page.locator('.workflow-node')).toHaveCount(3)
  await expect(page.locator('.inspector').getByRole('heading', { name: 'Review' })).toBeVisible()

  await page.goto(dashboardRouteUrl(instance.url, '/workflows/review/steps/cross-review'), { waitUntil: 'networkidle' })
  await expect(page).toHaveURL(/\/workflows\/review\/steps\/cross-review$/)
  await expect(page.locator('.workflow-node.selected').getByRole('heading', { name: 'Cross Review' })).toBeVisible()
  await expect(page.locator('.inspector').getByRole('heading', { name: 'Cross Review' })).toBeVisible()

  await page.goto(dashboardRouteUrl(instance.url, '/workflows/review/prompts/cross-review'), { waitUntil: 'networkidle' })
  const promptDialog = page.getByRole('dialog', { name: /"Review" prompt sequence/ })
  await expect(promptDialog).toBeVisible()
  await expect(promptDialog.getByRole('heading', { name: 'Step 2: Cross Review' })).toBeVisible()

  await page.goto(dashboardRouteUrl(instance.url, '/workflows/review/prompts/synthesize'), { waitUntil: 'networkidle' })
  await expect(page).toHaveURL(/\/workflows\/review\/prompts\/synthesize$/)
  await expect(promptDialog.getByRole('heading', { name: 'Step 3: Summarize Consensus' })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/workflows\/review\/prompts\/cross-review$/)
  await expect(promptDialog.getByRole('heading', { name: 'Step 2: Cross Review' })).toBeVisible()

  await page.goForward()
  await expect(page).toHaveURL(/\/workflows\/review\/prompts\/synthesize$/)
  await expect(promptDialog.getByRole('heading', { name: 'Step 3: Summarize Consensus' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(promptDialog).toBeHidden()
  await expect(page).toHaveURL(/\/workflows\/review\/steps\/synthesize$/)
})

test('run details timeline shows all configured agents for running steps', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeRunningRunFixture(projectRoot)
  const server = await startDashboardServer({
    projectRoot,
    initialWorkflow: 'security-audit',
  })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })

    const runItem = page.locator('.run-item').filter({ hasText: runId })
    await expect(runItem).toBeVisible()
    await runItem.getByText('Security Audit').first().click()

    await expect(page.getByRole('dialog', { name: /Workflow results for "Security Audit"/ })).toBeVisible()
    const timeline = page.locator('.run-details-timeline')
    await expect(timeline.locator('.run-details-timeline-card').filter({ hasText: 'Audit Security' })).toContainText('In progress')
    await expect(timeline.locator('.run-details-timeline-child-button')).toHaveCount(4)
    await expect(timeline.locator('.run-details-timeline-child-button').filter({ hasText: 'Claude - In progress' })).toBeVisible()
    await expect(timeline.locator('.run-details-timeline-child-button').filter({ hasText: 'Gemini - In progress' })).toBeVisible()
    await expect(timeline.locator('.run-details-timeline-child-button').filter({ hasText: 'Codex - In progress' })).toBeVisible()
    await expect(timeline.locator('.run-details-timeline-card').filter({ hasText: 'Synthesize Security Findings' })).toContainText('Queued')
    await expect(timeline.locator('.run-details-timeline-child-button').filter({ hasText: 'Codex - Queued' })).toBeVisible()
    await expect(timeline.locator('.run-details-timeline-card').filter({ hasText: '"Security Audit" Workflow Queued' })).toContainText('Queued')
    await expect(timeline.locator('.run-details-timeline-card').filter({ hasText: '"Security Audit" Workflow Queued' })).not.toContainText('click to view results')
  } finally {
    await server.close()
  }
})

test('dashboard deep-links run details modal routes', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot)
  const server = await startDashboardServer({
    projectRoot,
    initialWorkflow: 'review',
  })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Netlify Agent Executor' })).toBeVisible()

    await page.goto(dashboardRouteUrl(server.url, `/runs/${runId}/details`), { waitUntil: 'networkidle' })

    const detailsDialog = page.getByRole('dialog', { name: /Workflow results for "Review"/ })
    await expect(detailsDialog).toBeVisible()
    await expect(detailsDialog.getByRole('heading', { name: 'Review summary' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/details$`))

    await page.goto(dashboardRouteUrl(server.url, `/runs/${runId}/steps/review`), { waitUntil: 'networkidle' })
    await expect(detailsDialog).toBeVisible()
    await expect(detailsDialog.getByText('No saved step details were found for this workflow step.')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review$`))

    await page.goto(dashboardRouteUrl(server.url, `/runs/${runId}/steps/review/agents/codex`), { waitUntil: 'networkidle' })
    await expect(detailsDialog).toBeVisible()
    await expect(detailsDialog.getByRole('heading', { name: 'Codex result' })).toBeVisible()
    await expect(detailsDialog.getByText('Final result text.')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review/agents/codex$`))

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review$`))
    await expect(detailsDialog.getByText('No saved step details were found for this workflow step.')).toBeVisible()
  } finally {
    await server.close()
  }
})

test('dashboard opens shared run details modal from runs and graph agent results', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot, { staleRunStatus: 'submitted', staleWorkflowStatus: 'running' })
  const server = await startDashboardServer({
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
    await expect(page.locator('.run-details-timeline-card').filter({ hasText: '"Review" Workflow Completed' })).toBeVisible()
    await expect(page.locator('.run-details-timeline-card').filter({ hasText: '"Review" Workflow Running' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeHidden()

    await runItem.getByRole('button', { name: 'Load run graph' }).click()
    await expect(page.locator('.workflow-node.status-completed')).toHaveCount(1)

    const reviewNode = page.locator('.workflow-node').filter({ has: page.getByRole('heading', { name: 'Review', exact: true }) })
    await reviewNode.getByRole('button', { name: 'Codex' }).click()

    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Codex result' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review/agents/codex$`))
    await expect(page.getByText('Final result text.')).toBeVisible()
    const codexTimelineButton = page.locator('.run-details-timeline-child-button').filter({ hasText: 'Codex - completed' })
    await expect(codexTimelineButton).toBeVisible()
    await page.locator('.run-details-timeline-button').filter({ hasText: '"Review" Workflow Completed' }).click()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/details$`))
    await codexTimelineButton.click()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review/agents/codex$`))
    const activeResultsButton = page.locator('.run-details-content-switch-button[data-active="true"]').filter({ hasText: 'Results' })
    await expect(activeResultsButton).toBeVisible()
    expectVisibleTeal(await computedTextColor(activeResultsButton))
    const tocLink = page.locator('.run-details-toc-link').filter({ hasText: 'Findings' })
    await expect(tocLink).toBeVisible()
    await tocLink.click()
    await expect(tocLink).toHaveAttribute('data-active', 'true')
    expectVisibleTeal(await computedTextColor(tocLink))
    const activeTocRow = page.locator('.run-details-toc-row[data-active="true"]').filter({ hasText: 'Findings' })
    await expect(activeTocRow).toBeVisible()
    expectVisibleTeal(await computedBackground(activeTocRow))
    await page.locator('.run-details-content-switch').getByRole('button', { name: 'Prompt' }).click()
    await expect(page.getByRole('heading', { name: 'Review prompt' })).toBeVisible()
    await expect(page.getByText('Review this fixture prompt.')).toBeVisible()
    await page.locator('.run-details-content-switch').getByRole('button', { name: 'Results' }).click()
    await expect(page.getByText('Final result text.')).toBeVisible()
  } finally {
    await server.close()
  }
})

test('dashboard submits a follow-up from run details composer', async ({ page }) => {
  test.setTimeout(45_000)
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot)
  const followupRequests = []
  const submissions = []
  const server = await startDashboardServer({
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

    const followupDialog = page.getByRole('dialog', { name: 'Send to next agent' })
    await expect(followupDialog).toBeVisible()
    await expect(followupDialog.getByText('Follow-up started')).toBeVisible()
    await expect(followupDialog.getByRole('button', { name: 'Run follow-up' })).toBeDisabled()
    await expect(followupDialog.getByRole('button', { name: 'Back to results' })).toBeVisible()
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

    await followupDialog.getByRole('button', { name: 'Back to results' }).click()
    await expect(followupDialog).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeHidden()
    await expect(page.locator('.run-item').filter({ hasText: 'Follow-up on Review (Gemini)' })).toBeVisible()
  } finally {
    await server.close()
  }
})
