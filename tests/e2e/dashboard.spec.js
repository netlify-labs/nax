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
    netlifyContext: {
      account: { email: 'david@example.com' },
      linkedSites: [
        {
          siteId: 'notify-site',
          name: 're-notify-demo',
          adminUrl: 'https://app.netlify.com/projects/re-notify-demo/agent-runs',
          source: '.netlify/state.json',
          configSource: '',
          filter: '',
          accessible: true,
          accessCode: 'ok',
        },
        {
          siteId: 'runner-site',
          name: 'revenue-engine-dev',
          adminUrl: 'https://app.netlify.com/projects/revenue-engine-dev/agent-runs',
          source: 'clients/frontend/.netlify/state.json',
          configSource: 'clients/frontend/netlify.toml',
          filter: 'revenue-engine-frontend',
          accessible: true,
          accessCode: 'ok',
        },
      ],
      target: {
        siteId: 'runner-site',
        name: 'revenue-engine-dev',
        adminUrl: 'https://app.netlify.com/projects/revenue-engine-dev/agent-runs',
        source: 'clients/frontend/.netlify/state.json',
        configSource: 'clients/frontend/netlify.toml',
        filter: 'revenue-engine-frontend',
        reason: 'Auto-selected clients/frontend/netlify.toml because it is the only detected config with a monorepo filter.',
        accessible: true,
        accessCode: 'ok',
      },
      targetError: '',
    },
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
 * @param {Locator} locator
 * @returns {Promise<{ backgroundImage: string, borderColor: string, color: string }>}
 */
async function computedPalette(locator) {
  return locator.evaluate((element) => {
    const target = /** @type {{ ownerDocument: { defaultView: { getComputedStyle: (element: unknown) => { backgroundImage: string, borderColor: string, color: string } } | null } }} */ (element)
    const view = target.ownerDocument.defaultView
    const style = view?.getComputedStyle(element)
    return {
      backgroundImage: style?.backgroundImage || '',
      borderColor: style?.borderColor || '',
      color: style?.color || '',
    }
  })
}

/**
 * @param {string} projectRoot
 * @param {{ staleRunStatus?: string, staleWorkflowStatus?: string, partialFailure?: boolean }} [options]
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
  const runs = options.partialFailure
    ? [
        {
          agent: 'codex',
          instanceId: 'codex:gpt-5.6-sol:high',
          model: 'gpt-5.6-sol',
          effort: 'high',
          status: 'completed',
          runnerId: 'runner-1',
          sessionId: 'session-1',
          usage: { totalCreditsCost: 7.5, totalTokens: 2150 },
        },
        {
          agent: 'claude',
          instanceId: 'claude:claude-opus-5:high',
          model: 'claude-opus-5',
          effort: 'high',
          status: 'failed',
          runnerId: 'runner-failed',
          sessionId: 'session-failed',
        },
      ]
    : [{ agent: 'codex', status: options.staleRunStatus || 'completed', runnerId: 'runner-1', sessionId: 'session-1', usage: { totalCreditsCost: 7.5, totalTokens: 2150 } }]

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
      stepAgents: {
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
      runs,
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
        runs: ['claude', 'gemini', 'codex'].map((agent) => ({
          agent,
          status: 'submitted',
          runnerId: `runner-${agent}`,
          sessionId: `session-${agent}`,
          links: {
            sessionUrl: `https://example.test/session-${agent}`,
          },
        })),
      },
    ],
  }, null, 2))

  return runId
}

/**
 * @param {string} projectRoot
 * @param {number} count
 */
function writeRecentRunPageFixtures(projectRoot, count) {
  const baseTime = Date.parse('2026-06-19T00:00:00.000Z')
  for (let index = 1; index <= count; index += 1) {
    const runId = `paged-run-${String(index).padStart(2, '0')}`
    const dir = path.join(projectRoot, '.nax', 'workflows', runId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
      schemaVersion: 1,
      runId,
      flowId: 'review',
      flowTitle: `Paged Run ${index}`,
      status: 'completed',
      transport: 'netlify-api',
      branch: 'main',
      createdAt: new Date(baseTime + index * 1000).toISOString(),
      updatedAt: new Date(baseTime + index * 1000).toISOString(),
      options: {},
      steps: [],
      dir,
    }, null, 2))
    const mtime = new Date(baseTime + index * 1000)
    fs.utimesSync(path.join(dir, 'workflow.json'), mtime, mtime)
  }
}

test('dashboard renders Review graph on desktop', async ({ page }, testInfo) => {
  await openReview(page, { width: 1360, height: 860 })
  const sidebar = page.locator('.workflow-sidebar')
  const runIndividualAgent = sidebar.getByRole('button', { name: 'Run an individual agent' })
  const workflowsHeading = sidebar.getByRole('heading', { name: 'Workflows' })
  await expect(runIndividualAgent).toBeVisible()
  await expect(page.locator('.header-actions').getByRole('button', { name: 'Run an individual agent' })).toHaveCount(0)
  await expect.poll(async () => {
    const actionBox = await runIndividualAgent.boundingBox()
    const headingBox = await workflowsHeading.boundingBox()
    return (actionBox?.y || 0) < (headingBox?.y || 0)
  }).toBe(true)
  const review = page.locator('.workflow-node').filter({ hasText: 'Review' }).first()
  await expect(review.locator('.agent-row > .add-agent-slot')).toHaveCount(0)
  await expect(review.locator('.node-footer > .add-agent-slot').getByRole('button', { name: 'Add agent' })).toBeVisible()
  const summarize = page.locator('.workflow-node').filter({
    has: page.getByRole('heading', { name: 'Summarize Consensus', exact: true }),
  })
  await expect(summarize.locator('.agent-row > .add-agent-slot').getByRole('button', { name: 'Add agent' })).toBeVisible()
  await expect(summarize.locator('.node-footer > .add-agent-slot')).toHaveCount(0)
  await review.locator('.node-header').click()
  await expect(review).toHaveClass(/selected/)

  const viewport = page.locator('.react-flow__viewport')
  const initialTransform = await viewport.getAttribute('style')
  const configureClaude = review.getByRole('button', { name: 'Configure Claude Auto for Review' })
  await configureClaude.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  const removeClaude = page.getByRole('button', { name: 'Remove Claude Auto from Review' })
  await expect(removeClaude).toHaveCSS('position', 'absolute')
  await expect(removeClaude).toHaveCSS('font-size', '11px')
  await expect.poll(() => viewport.getAttribute('style')).toBe(initialTransform)

  await page.keyboard.press('Escape')
  await configureClaude.dblclick()
  await expect.poll(() => viewport.getAttribute('style')).toBe(initialTransform)
  await page.keyboard.press('Escape')

  for (const provider of ['Claude', 'Gemini', 'Codex', 'OpenCode']) {
    await review.getByRole('button', { name: `Configure ${provider} Auto for Review` }).click()
    await page.getByRole('button', { name: `Remove ${provider} Auto from Review` }).click()
  }
  await review.getByRole('button', { name: 'Add agent' }).click()
  await page.getByRole('button', { name: 'All Claude models' }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  const crossReview = page.locator('.workflow-node').filter({ hasText: 'Cross Review' })
  const inheritedModels = ['Fable 5', 'Opus 5', 'Opus 4.8', 'Sonnet 5']
  await expect(review.locator('.agent-chip-config')).toHaveText(inheritedModels)
  await expect(crossReview.locator('.agent-chip-config')).toHaveText(inheritedModels)
  await expect(crossReview.locator('.node-footer')).toHaveCSS('min-height', '30px')
  await expect(crossReview.getByText('Inherits surviving instances from review')).toBeVisible()
  await expect(crossReview.getByRole('button', { name: 'Add agent' })).toHaveCount(0)
  await testInfo.attach('desktop', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})

test('dashboard identifies the Agent Runner target and lists every local site link', async ({ page }) => {
  await openReview(page, { width: 1360, height: 860 })
  const targetButton = page.getByRole('button', { name: 'Netlify project: revenue-engine-dev' })
  await expect(targetButton).toBeVisible()
  await expect(targetButton).toHaveText('Netlify project · revenue-engine-dev')
  await expect(targetButton).toHaveAttribute('data-variant', 'subtle')
  await expect(page.locator('.header-repo .lucide-folder')).toBeVisible()
  await expect(page.locator('.header-repo .lucide-folder-git-2')).toHaveCount(0)
  const branchSelector = page.getByRole('combobox', { name: 'Branch' })
  await expect(branchSelector).toHaveAttribute('aria-haspopup', 'listbox')
  await targetButton.click()
  await expect(page.getByText('Locally linked sites (2)')).toBeVisible()
  await expect(page.getByText('re-notify-demo')).toBeVisible()
  await expect(page.getByText('clients/frontend/.netlify/state.json')).toBeVisible()
  await expect(page.getByText(/only detected config with a monorepo filter/)).toBeVisible()
})

test('dashboard renders Review graph on narrow viewport', async ({ page }, testInfo) => {
  await openReview(page, { width: 390, height: 820 })
  await testInfo.attach('narrow', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})

test('dashboard submits a configured workflow instance', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot)
  const server = await startDashboardServer({
    projectRoot,
    initialWorkflow: 'review',
  })
  const requests = []
  await page.route('**/api/workflows/review/runs', async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        workflow: { id: 'review', title: 'Review', description: '', steps: [] },
        run: {
          id: runId,
          runId,
          flowId: 'review',
          flowTitle: 'Review',
          status: 'completed',
        },
      }),
    })
  })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })
    await page.getByRole('combobox', { name: 'Branch' }).fill('remote-only/review-candidate')
    const reviewNode = page.locator('.workflow-node').first()
    await reviewNode.getByRole('button', { name: /Configure Codex Auto/ }).click()
    await page.getByRole('combobox', { name: 'Model' }).click()
    await page.getByRole('option', { name: 'GPT 5.6 Sol' }).click()
    await page.getByRole('combobox', { name: 'Reasoning effort' }).click()
    await page.getByRole('option', { name: 'High' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const runDialog = page.getByRole('dialog', { name: 'Run Review' })
    await expect(runDialog).toBeVisible()
    await runDialog.getByRole('textbox', { name: 'Optional context' }).fill('Focus on authentication boundaries.')
    await runDialog.getByRole('button', { name: 'Run', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0].branch).toBe('remote-only/review-candidate')
    expect(requests[0].context).toBe('Focus on authentication boundaries.')
    expect(requests[0].stepAgents.review).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        id: 'codex:gpt-5.6-sol:high',
      }),
    ]))
  } finally {
    await server.close()
  }
})

test('dashboard adds an opencode instance and changes another instance provider from the canvas', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot)
  const server = await startDashboardServer({
    projectRoot,
    initialWorkflow: 'do-next',
  })
  const requests = []
  await page.route('**/api/workflows/do-next/runs', async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        workflow: { id: 'do-next', title: 'Do Next', description: '', steps: [] },
        run: { id: runId, runId, flowId: 'do-next', flowTitle: 'Do Next', status: 'completed' },
      }),
    })
  })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })

    const proposeNode = page.locator('.workflow-node').filter({ hasText: 'Propose Next Task' })
    await proposeNode.getByRole('button', { name: 'Add agent' }).click()
    await page.getByRole('combobox', { name: 'Provider' }).click()
    await page.getByRole('option', { name: 'OpenCode' }).click()
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    // Change Claude to a single explicitly configured Gemini instance via the chip caret popover.
    await proposeNode.getByRole('button', { name: /Configure Claude Auto/ }).click()
    const editProvider = page.getByRole('combobox', { name: 'Provider', exact: true })
    await expect(editProvider.locator('xpath=..').locator('.agent-provider-select-logo .agent-icon')).toBeVisible()
    await editProvider.click()
    await page.getByRole('option', { name: 'Gemini' }).click()
    await expect(page.getByText('Quick presets')).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Model', exact: true }).click()
    await page.getByRole('option', { name: 'Gemini 3.6 Flash' }).click()
    await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).click()
    await page.getByRole('option', { name: 'High' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const runDialog = page.getByRole('dialog', { name: 'Run Do Next' })
    await expect(runDialog).toBeVisible()
    await runDialog.getByRole('button', { name: 'Run', exact: true }).click()

    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0].stepAgents.propose).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent: 'opencode',
        model: 'moonshotai/kimi-k3',
        effort: 'max',
        id: 'opencode:moonshotai/kimi-k3:max',
      }),
      expect.objectContaining({
        agent: 'gemini',
        model: 'gemini-3.6-flash',
        effort: 'high',
        id: 'gemini:gemini-3.6-flash:high',
      }),
    ]))
  } finally {
    await server.close()
  }
})

test('dashboard marks exact existing model and effort configurations while adding agents', async ({ page }) => {
  await openReview(page, { width: 1360, height: 860 })

  const summarizeNode = page.locator('.workflow-node').filter({
    has: page.getByRole('heading', { name: 'Summarize Consensus', exact: true }),
  })
  await summarizeNode.getByRole('button', { name: /Configure Codex Auto/ }).click()
  await page.getByRole('combobox', { name: 'Provider', exact: true }).click()
  await page.getByRole('option', { name: 'Gemini', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(summarizeNode.locator('.agent-chip-config')).toHaveText(['Gemini 3.1 Pro'])
  await expect(summarizeNode.locator('.agent-chip-effort')).toHaveText(['High'])

  await summarizeNode.getByRole('button', { name: 'Add agent' }).click()
  await page.getByRole('combobox', { name: 'Provider', exact: true }).click()
  await page.getByRole('option', { name: 'Gemini', exact: true }).click()

  await expect(page.getByRole('radio', { name: 'Single agent' })).toBeChecked()
  await page.getByRole('combobox', { name: 'Model', exact: true }).click()
  const existingModelOption = page.getByRole('option', { name: /Gemini 3\.1 Pro.*High already selected/ })
  await expect(existingModelOption).toBeVisible()
  await expect(existingModelOption).toBeEnabled()
  await existingModelOption.click()

  const effortInput = page.getByRole('combobox', { name: 'Reasoning effort', exact: true })
  await expect(effortInput).toHaveValue('Medium')
  await effortInput.click()
  const existingEffortOption = page.getByRole('option', { name: /High.*Already selected/ })
  await expect(existingEffortOption).toHaveAttribute('data-combobox-disabled', 'true')
  await page.getByRole('option', { name: 'Low', exact: true }).click()
  await expect(effortInput).toHaveValue('Low')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await expect(summarizeNode.locator('.agent-chip-config')).toHaveText(['Gemini 3.1 Pro', 'Gemini 3.1 Pro'])
  await expect(summarizeNode.locator('.agent-chip-effort')).toHaveText(['High', 'Low'])
})

test('dashboard only exposes model fan-out in explicit multiple-agent mode', async ({ page }) => {
  await openReview(page, { width: 1360, height: 860 })

  const summarizeNode = page.locator('.workflow-node').filter({
    has: page.getByRole('heading', { name: 'Summarize Consensus', exact: true }),
  })
  await summarizeNode.getByRole('button', { name: 'Add agent' }).click()
  await expect(page.getByRole('heading', { name: 'Add new agent(s)', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Single agent' })).toBeChecked()
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Models', exact: true })).toHaveCount(0)

  await page.getByText('Multiple agents', { exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Models', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Reasoning efforts', exact: true })).toBeVisible()

  await page.getByText('Single agent', { exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Models', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'All Claude models' }).click()
  await expect(page.getByRole('radio', { name: 'Multiple agents' })).toBeChecked()
  await expect(page.getByRole('combobox', { name: 'Models', exact: true })).toBeVisible()
})

test('dashboard preserves one reasoning effort across multiple manually selected models', async ({ page }) => {
  await openReview(page, { width: 1360, height: 860 })

  const summarizeNode = page.locator('.workflow-node').filter({
    has: page.getByRole('heading', { name: 'Summarize Consensus', exact: true }),
  })
  await summarizeNode.getByRole('button', { name: 'Add agent' }).click()
  await expect(page.getByRole('radio', { name: 'Single agent' })).toBeChecked()
  await page.getByText('Multiple agents', { exact: true }).click()

  const modelsInput = page.getByRole('combobox', { name: 'Models', exact: true })
  await modelsInput.click()
  await page.getByRole('option', { name: 'Fable 5', exact: true }).click()
  await page.getByRole('option', { name: 'Opus 5', exact: true }).click()
  await page.getByRole('option', { name: 'Opus 4.8', exact: true }).click()
  await modelsInput.press('Tab')

  const effortsInput = page.getByRole('combobox', { name: 'Reasoning efforts', exact: true })
  await page.getByText('Reasoning efforts', { exact: true }).click()
  await page.getByRole('option', { name: 'Low', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Adds 2 instances.')).toBeVisible()
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await expect(summarizeNode.locator('.agent-chip-config')).toHaveText(['Auto', 'Opus 5', 'Opus 4.8'])
  await expect(summarizeNode.locator('.agent-chip-effort')).toHaveText(['Low', 'Low'])

  for (const model of ['claude-opus-5', 'claude-opus-4-8']) {
    const configureButton = summarizeNode.getByRole('button', { name: new RegExp(`Configure Claude ${model}`) })
    await configureButton.click()
    await expect(page.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveValue('Low')
    await configureButton.click()
  }
})

test('dashboard builds bake-off and effort-sweep lineups with arena presets', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot)
  const server = await startDashboardServer({ projectRoot, initialWorkflow: 'do-next' })
  const requests = []
  await page.route('**/api/workflows/do-next/runs', async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        workflow: { id: 'do-next', title: 'Do Next', description: '', steps: [] },
        run: { id: runId, runId, flowId: 'do-next', flowTitle: 'Do Next', status: 'completed' },
      }),
    })
  })
  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })
    const proposeNode = page.locator('.workflow-node').filter({ hasText: 'Propose Next Task' })
    await expect(proposeNode.locator('.agent-chip-config')).toHaveText(['Auto', 'Auto', 'Auto'])

    // Explicitly removing every default leaves the step empty until Add agent is used.
    for (const provider of ['Claude', 'Gemini', 'Codex']) {
      await proposeNode.getByRole('button', { name: `Configure ${provider} Auto for Propose Next Task` }).click()
      await page.getByRole('button', { name: `Remove ${provider} Auto from Propose Next Task` }).click()
      await expect(proposeNode.getByRole('button', { name: `Configure ${provider} Auto for Propose Next Task` })).toHaveCount(0)
    }
    await expect(proposeNode.locator('.agent-chip')).toHaveCount(0)
    await expect(proposeNode.getByRole('button', { name: 'Add agent' })).toBeVisible()

    // The all-model preset takes the four strongest Claude models and drops Haiku.
    await proposeNode.getByRole('button', { name: 'Add agent' }).click()
    const providerInput = page.getByRole('combobox', { name: 'Provider', exact: true })
    await expect(providerInput.locator('xpath=..').locator('.agent-provider-select-logo .agent-icon')).toBeVisible()
    await providerInput.click()
    const providerOptions = page.getByRole('listbox')
    for (const provider of ['Claude', 'Gemini', 'Codex', 'OpenCode']) {
      await expect(providerOptions.getByRole('option', { name: provider }).locator('.agent-icon')).toBeVisible()
    }
    await providerOptions.getByRole('option', { name: 'Claude' }).click()
    await expect(page.getByRole('radio', { name: 'Single agent' })).toBeChecked()
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('Fable 5')
    await expect(page.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveValue('High')
    await page.getByRole('button', { name: 'All Claude models' }).click()
    await expect(page.getByRole('radio', { name: 'Multiple agents' })).toBeChecked()
    await expect(page.getByText('Adds 4 instances.')).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(proposeNode.locator('.agent-chip-config')).toHaveText([
      'Fable 5',
      'Opus 5',
      'Opus 4.8',
      'Sonnet 5',
    ])
    await expect(proposeNode.getByRole('button', { name: /Configure Claude claude-haiku-4-5/ })).toHaveCount(0)
    const disabledAddAgent = proposeNode.getByRole('button', { name: 'Add agent' })
    await expect(disabledAddAgent).toBeDisabled()
    await expect(disabledAddAgent).toHaveAttribute('title', 'This step already has the maximum of 4 agent instances.')
    await expect(proposeNode.locator('.add-agent-slot')).toHaveCSS('align-self', 'center')
    await expect(proposeNode.getByRole('button', { name: /Configure Claude claude-opus-5/ })).toBeVisible()
    await expect(proposeNode.getByRole('button', { name: /Configure Claude claude-opus-4-8/ })).toBeVisible()
    await expect(proposeNode.getByRole('button', { name: /Configure Claude claude-fable-5/ })).toBeVisible()

    // Per-instance removal only removes the selected tuple.
    await proposeNode.getByRole('button', { name: /Configure Claude claude-opus-4-8/ }).click()
    await page.getByRole('button', { name: /Remove Claude claude-opus-4-8/ }).click()
    await expect(proposeNode.getByRole('button', { name: /Configure Claude claude-opus-4-8/ })).toHaveCount(0)

    // Clear the remaining bake-off before building an independent effort sweep.
    for (const model of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5']) {
      await proposeNode.getByRole('button', { name: new RegExp(`Configure Claude ${model}`) }).click()
      await page.getByRole('button', { name: new RegExp(`Remove Claude ${model}`) }).click()
    }
    await expect(proposeNode.locator('.agent-chip')).toHaveCount(0)

    // One model expanded across all efforts produces a three-instance sweep.
    await proposeNode.getByRole('button', { name: 'Add agent' }).click()
    await page.getByRole('combobox', { name: 'Provider', exact: true }).click()
    await page.getByRole('option', { name: 'Codex', exact: true }).click()
    await page.getByRole('button', { name: 'This model × all efforts' }).click()
    await expect(page.getByText('Adds 3 instances.')).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    // With one slot left, bulk presets are capped to one additional instance.
    await proposeNode.getByRole('button', { name: 'Add agent' }).click()
    await page.getByRole('button', { name: 'All Codex models' }).click()
    await expect(page.getByText('Adds 1 instance.')).toBeVisible()
    await page.getByRole('button', { name: 'Add flagship of every provider' }).click()
    await expect(proposeNode.locator('.agent-chip')).toHaveCount(4)

    await page.getByRole('button', { name: 'Run', exact: true }).click()
    const runDialog = page.getByRole('dialog', { name: 'Run Do Next' })
    await runDialog.getByRole('button', { name: 'Run', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    const instances = requests[0].stepAgents.propose
    const ids = instances.map((instance) => instance.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining([
      'claude:claude-fable-5:high',
      'codex:gpt-5.6-sol:low',
      'codex:gpt-5.6-sol:medium',
      'codex:gpt-5.6-sol:high',
    ]))
    expect(ids).toHaveLength(4)
  } finally {
    await server.close()
  }
})

test('dashboard visibly preserves partial failures per instance', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeCompletedRunFixture(projectRoot, { partialFailure: true })
  const server = await startDashboardServer({ projectRoot, initialWorkflow: 'review' })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })
    await page.locator('.run-item').filter({ hasText: runId }).click()
    const reviewNode = page.locator('.workflow-node').filter({ hasText: 'Review' })
    await expect(reviewNode.locator('.node-state-badge')).toHaveText('Completed with failures')
    await expect(reviewNode.locator('.agent-chip.codex.agent-completed + .agent-chip-terminal .lucide-check')).toBeVisible()
    await expect(reviewNode.locator('.agent-chip.claude.agent-failed + .agent-chip-terminal .lucide-circle-alert')).toBeVisible()
    await expect(reviewNode).toHaveClass(/status-completed_with_failures/)
  } finally {
    await server.close()
  }
})

test('dashboard runs one configured agent on a narrow dark layout', async ({ page }) => {
  const projectRoot = tmpRoot()
  writeCompletedRunFixture(projectRoot)
  const submissions = []
  const server = await startDashboardServer({
    projectRoot,
    initialWorkflow: 'review',
    followupSubmitRun: async ({ run, branch }) => {
      submissions.push({ ...run, branch })
      return {
        ...run,
        status: 'submitted',
        runnerId: 'runner-standalone',
        sessionId: 'session-standalone',
      }
    },
  })

  try {
    await page.setViewportSize({ width: 430, height: 900 })
    await page.goto(server.url, { waitUntil: 'networkidle' })
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark')
    await page.getByRole('button', { name: 'Toggle workflow navigation' }).click()
    await page.getByRole('button', { name: 'Run an individual agent' }).click()

    const runDialog = page.getByRole('dialog', { name: 'Run one agent' })
    await expect(runDialog).toBeVisible()
    await runDialog.getByRole('combobox', { name: 'Agent provider' }).click()
    await page.getByRole('option', { name: 'OpenCode' }).click()
    await runDialog.getByRole('button', { name: 'Configure OpenCode' }).click()

    const configDrawer = page.getByRole('dialog', { name: 'OpenCode configuration' })
    await expect(configDrawer).toBeVisible()
    await expect.poll(async () => {
      const drawerBox = await configDrawer.boundingBox()
      return {
        left: Math.round(drawerBox?.x || 0),
        right: Math.round((drawerBox?.x || 0) + (drawerBox?.width || 0)),
      }
    }).toEqual({ left: 0, right: 430 })
    await configDrawer.getByRole('combobox', { name: 'Model' }).click()
    await page.getByRole('option', { name: 'GLM 5.2' }).click()
    await configDrawer.getByRole('combobox', { name: 'Reasoning effort' }).click()
    await page.getByRole('option', { name: 'Max' }).click()
    await configDrawer.getByRole('button', { name: 'Save' }).click()
    await expect(configDrawer).toBeHidden()

    await runDialog.getByRole('textbox', { name: 'Instructions' }).fill('Audit the services directory.')
    await runDialog.getByRole('button', { name: 'Run agent' }).click()
    await expect.poll(() => submissions.length).toBe(1)
    expect(submissions[0]).toMatchObject({
      agent: 'opencode',
      model: 'z-ai/glm-5.2',
      effort: 'xhigh',
      branch: 'master',
    })
    await expect(page.locator('.workflow-node').getByRole('heading', {
      name: 'OpenCode agent run',
    })).toBeVisible()
  } finally {
    await server.close()
  }
})

test('dashboard dry-run simulation updates step, agent pill, and output without credits', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1360, height: 860 })
  await page.goto(instance.url, { waitUntil: 'networkidle' })

  await page.locator('.workflow-item').filter({ hasText: 'Local Smoke Test' }).click()
  await expect(page.locator('.workflow-node')).toHaveCount(1)
  const nodeFooter = page.locator('.workflow-node .node-footer')
  await expect(nodeFooter).toHaveCSS('min-height', '30px')
  await expect(page.getByRole('button', { name: 'Add agent' })).toBeVisible()

  await page.getByRole('button', { name: 'Dry run' }).click()

  await expect(page.locator('.workflow-node.status-running')).toHaveCount(1, { timeout: 2000 })
  await expect(page.getByRole('button', { name: 'Add agent' })).toHaveCount(0)
  await expect(nodeFooter).toBeEmpty()
  await expect(nodeFooter).toHaveCSS('min-height', '30px')
  await expect(page.locator('.workflow-node.status-running .agent-chip-activity .lucide-loader-circle')).toBeVisible()
  await expect(page.locator('.workflow-node.status-running .agent-chip')).toBeDisabled()
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
  const promptDialog = page.getByRole('dialog', { name: /"Review" workflow details/ })
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
    await expect(runItem.locator('.run-stalled')).toHaveText('Stalled')
    await runItem.getByRole('button', { name: 'View run details' }).click()

    await expect(page.getByRole('dialog', { name: /Workflow results for "Security Audit"/ })).toBeVisible()
    await expect(page.getByText(/produced no events since/)).toBeVisible()
    const timeline = page.locator('.run-details-timeline')
    await expect(timeline.locator('.run-details-timeline-card').filter({ hasText: 'Audit Security' })).toContainText('In progress')
    await expect(timeline.locator('.run-details-timeline-child-button')).toHaveCount(4)
    await expect(timeline.locator('.run-details-timeline-child-button').filter({ hasText: 'Claude Auto - In progress' })).toBeVisible()
    await expect(timeline.locator('.run-details-timeline-child-button').filter({ hasText: 'Gemini Auto - In progress' })).toBeVisible()
    await expect(timeline.locator('.run-details-timeline-child-button').filter({ hasText: 'Codex Auto - In progress' })).toBeVisible()
    await expect(timeline.locator('.run-details-timeline-card').filter({ hasText: 'Synthesize Security Findings' })).toContainText('Queued')
    await expect(timeline.locator('.run-details-timeline-child-button').filter({ hasText: 'Codex Auto - Queued' })).toBeVisible()
    await expect(timeline.locator('.run-details-timeline-card').filter({ hasText: '"Security Audit" Workflow Queued' })).toContainText('Queued')
    await expect(timeline.locator('.run-details-timeline-card').filter({ hasText: '"Security Audit" Workflow Queued' })).not.toContainText('click to view results')
  } finally {
    await server.close()
  }
})

test('workflow agent chip controls follow runner lifecycle and share the pill palette', async ({ page }) => {
  const projectRoot = tmpRoot()
  const runId = writeRunningRunFixture(projectRoot)
  const stopped = []
  const server = await startDashboardServer({
    projectRoot,
    initialWorkflow: 'security-audit',
    cancelStopRun: async ({ runnerId }) => {
      stopped.push(runnerId)
      return { stopped: true, error: '' }
    },
  })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })
    await page.locator('.run-item').filter({ hasText: runId }).click()

    const auditNode = page.locator('.workflow-node').filter({ has: page.getByRole('heading', { name: 'Audit Security', exact: true }) })
    const claudeChip = auditNode.locator('.agent-chip.claude')
    const cancelClaude = auditNode.getByRole('button', { name: 'Cancel Claude Auto for Audit Security' })
    await expect(cancelClaude).toBeVisible()
    await expect(auditNode.getByRole('button', { name: 'Configure Claude Auto for Audit Security' })).toHaveCount(0)

    const palettes = await Promise.all([claudeChip, cancelClaude].map(computedPalette))
    expect(palettes[1]).toEqual(palettes[0])

    page.once('dialog', (dialog) => dialog.accept())
    await cancelClaude.click()
    await expect(auditNode.getByRole('button', { name: 'Retry Claude Auto for Audit Security' })).toBeVisible()
    expect(stopped).toEqual(['runner-claude'])
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
    await expect(detailsDialog.getByRole('heading', { name: 'Step 1: Review' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review$`))

    await page.goto(dashboardRouteUrl(server.url, `/runs/${runId}/steps/review/agents/codex`), { waitUntil: 'networkidle' })
    await expect(detailsDialog).toBeVisible()
    await expect(detailsDialog.getByRole('heading', { name: 'Codex result' })).toBeVisible()
    await expect(detailsDialog.getByText('Final result text.')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review/agents/codex$`))

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review$`))
    await expect(detailsDialog.getByRole('heading', { name: 'Step 1: Review' })).toBeVisible()
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
    await expect(runItem.locator('.run-status')).toHaveText('Completed')
    await expect(runItem.locator('.run-usage')).toHaveText('7.5 cr')
    await runItem.getByRole('button', { name: 'View run details' }).click()

    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Review summary' })).toBeVisible()
    await expect(page.getByText('Final workflow summary.')).toBeVisible()
    await expect(page.getByText('7.5 credits · 2,150 tokens')).toBeVisible()
    await expect(page.locator('.run-details-timeline-card').filter({ hasText: '"Review" Workflow Completed' })).toBeVisible()
    await expect(page.locator('.run-details-timeline-card').filter({ hasText: '"Review" Workflow Running' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeHidden()

    await runItem.click()
    await expect(page.locator('.workflow-node.status-completed')).toHaveCount(1)

    const reviewNode = page.locator('.workflow-node').filter({ has: page.getByRole('heading', { name: 'Review', exact: true }) })
    await expect(reviewNode.getByRole('button', { name: 'Configure Codex Auto for Review' })).toHaveCount(0)
    await expect(reviewNode.locator('.agent-chip-terminal .lucide-check')).toBeVisible()
    await reviewNode.getByRole('button', { name: 'Codex' }).click()

    await expect(page.getByRole('dialog', { name: /Workflow results for "Review"/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Codex result' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review/agents/codex%3Aauto%3Aauto$`))
    await expect(page.getByText('Final result text.')).toBeVisible()
    const codexTimelineButton = page.locator('.run-details-timeline-child-button').filter({ hasText: 'Codex Auto - completed' })
    await expect(codexTimelineButton).toBeVisible()
    await page.locator('.run-details-timeline-button').filter({ hasText: '"Review" Workflow Completed' }).click()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/details$`))
    await codexTimelineButton.click()
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/steps/review/agents/codex%3Aauto%3Aauto$`))
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

test('dashboard recent runs loads older durable pages', async ({ page }) => {
  const projectRoot = tmpRoot()
  writeRecentRunPageFixtures(projectRoot, 52)
  const server = await startDashboardServer({
    projectRoot,
    initialWorkflow: 'review',
  })

  try {
    await page.setViewportSize({ width: 1360, height: 860 })
    await page.goto(server.url, { waitUntil: 'networkidle' })
    await expect(page.getByRole('heading', { name: 'Netlify Agent Executor' })).toBeVisible()
    await expect(page.getByText('Paged Run 52', { exact: true })).toBeVisible()
    await expect(page.getByText('Showing 50 of 52 saved runs')).toBeVisible()
    await expect(page.getByText('paged-run-01', { exact: true })).toHaveCount(0)

    const loadOlder = page.getByRole('button', { name: 'Load older' })
    await loadOlder.scrollIntoViewIfNeeded()
    await loadOlder.click()

    await expect(page.getByText('paged-run-01', { exact: true })).toHaveCount(1)
    await expect(page.getByText('Showing 52 of 52 saved runs')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Load older' })).toHaveCount(0)

    await page.getByRole('textbox', { name: 'Search runs' }).fill('paged-run-07')
    await expect(page.locator('.run-item')).toHaveCount(1)
    await expect(page.getByText('Paged Run 7', { exact: true })).toBeVisible()

    await page.getByRole('textbox', { name: 'Search runs' }).fill('')
    await page.getByRole('combobox', { name: 'Filter runs by status' }).click()
    await page.getByRole('option', { name: 'Failed' }).click()
    await expect(page.getByText('No matching runs — clear the filter to see all.')).toBeVisible()
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
    followupSyncRunner: async () => ({ sessions: [] }),
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
    await runItem.getByRole('button', { name: 'View run details' }).click()

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

    await page.locator('.run-followup-agent-chip').filter({ hasText: 'Gemini' }).click()
    await expect(page.getByText('Gemini: start fresh agent runner')).toBeVisible()
    await page.getByRole('button', { name: 'Configure' }).click()
    const configDrawer = page.getByRole('dialog', { name: 'Follow-up agent configuration' })
    await configDrawer.getByRole('tab', { name: 'Gemini' }).click()
    await configDrawer.getByRole('combobox', { name: 'Model' }).click()
    await page.getByRole('option', { name: 'Gemini 3.1 Pro' }).click()
    await configDrawer.getByRole('combobox', { name: 'Reasoning effort' }).click()
    await page.getByRole('option', { name: 'High' }).click()
    await configDrawer.getByRole('button', { name: 'Save' }).click()
    await expect(configDrawer).toBeHidden()
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
      agents: ['codex', 'gemini'],
      models: { gemini: 'gemini-3.1-pro-preview' },
      efforts: { gemini: 'high' },
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
