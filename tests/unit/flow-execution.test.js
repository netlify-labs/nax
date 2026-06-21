const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { _private } = require('../../bin/nax')
const {
  AD_HOC_RUN_CHOICE,
  formatFlowList,
  formatFlowListJson,
  workflowPickerHint,
  workflowPickerLabel,
} = require('../../src/cli/flow-list')
const {
  chooseNetlifyFilterOption,
  netlifyConfigChoiceHint,
  netlifyProjectChoiceLabel,
  resolveProjectRoot,
  sortNetlifyConfigChoices,
} = require('../../src/netlify/project-selection')
const {
  enforceGithubActionPromptBudget,
  githubActionTriggerTextMetrics,
} = require('../../src/github/prompt-budget')
const { buildPlan } = require('../../src/github/issue-plan')
const {
  AGENT_RUNNER_USE_CASES,
  agentStepCompletionSummary,
  clearRenderedProgressFrame,
  formatDidYouKnowLines,
  formatTtyProgressRow,
  localRetryCandidates,
  makeStepProgressReporter,
  nextLocalStepMessage,
  physicalRowCount,
  pickFlavor,
  shouldPollGithubRun,
} = require('../../src/workflow/progress')
const {
  findLatestResumableRun,
  formatDetailedRelativeTime,
  formatResumeRunDetails,
  isAutomaticResumeCandidate,
  resumeLastStepTitle,
  resumeRunDetailsTitle,
  resumeStatusColor,
  resumeStepDecorations,
  savedAgentStatus,
  stepResultsSummaryPath,
} = require('../../src/workflow/resume')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nax-flow-execution-'))
}

/**
 * @typedef {{ mode?: string, kind?: string, fallbackReason?: string, fallbackError?: string }} PromptDeliveryForTest
 */

/** @param {unknown} value @returns {PromptDeliveryForTest} */
function promptDeliveryForTest(value) {
  assert.ok(value && typeof value === 'object')
  return /** @type {PromptDeliveryForTest} */ (value)
}

/** @param {string} projectRoot @param {string} id @param {Record<string, string>} param2 */
function writeProjectFlow(projectRoot, id, { title = id, promptBody = 'Prompt body' } = {}) {
  const flowDir = path.join(projectRoot, '.github', 'nax-flows', id)
  fs.mkdirSync(path.join(flowDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(flowDir, 'flow.yml'), [
    `id: ${id}`,
    `title: ${title}`,
    'defaults:',
    '  agents: [codex]',
    'steps:',
    '  - id: one',
    '    title: One',
    '    prompt: prompts/one.md',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(flowDir, 'prompts', 'one.md'), `---\ntitle: One\n---\n\n${promptBody}\n`)
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '')
}

function writeRunState(projectRoot, runId, overrides = {}) {
  const dir = path.join(projectRoot, '.nax', 'workflows', runId)
  fs.mkdirSync(dir, { recursive: true })
  const state = {
    schemaVersion: 1,
    runId,
    flowId: 'do-next',
    flowTitle: 'Do Next',
    transport: 'netlify-api',
    projectRoot,
    createdAt: '2026-05-20T20:00:00.000Z',
    updatedAt: '2026-05-20T20:00:00.000Z',
    status: 'completed',
    steps: [{
      id: 'synthesize',
      title: 'Synthesize Next Task',
      status: 'completed',
      runs: [{
        agent: 'codex',
        status: 'completed',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        resultText: 'Final result',
        usage: { totalCreditsCost: 1.5, stepsCount: 2, totalTokens: 3000 },
      }],
    }],
    dir,
    ...overrides,
  }
  fs.writeFileSync(path.join(dir, 'workflow.json'), `${JSON.stringify(state, null, 2)}\n`)
  return state
}

test('sourceIssueNumbersForStep dedupes issue numbers across prior steps', () => {
  const completed = new Map([
    ['review', { runs: [{ issueNumber: 83 }, { issueNumber: 84 }, { issueNumber: 85 }] }],
    ['cross-review', { runs: [{ issueNumber: 83 }, { issueNumber: 84 }, { issueNumber: 85 }] }],
  ])
  const step = {
    input: [
      { step: 'review', results: 'all' },
      { step: 'cross-review', results: 'all' },
    ],
  }

  assert.deepEqual(_private.sourceIssueNumbersForStep(step, completed), [83, 84, 85])
})

test('sourceRunsForStep keeps follow-up results per input step even when runner id is reused', () => {
  const completed = new Map([
    ['review', { runs: [{ agent: 'codex', runnerId: 'runner-1', resultText: 'done' }] }],
    ['cross-review', { runs: [{ agent: 'codex', runnerId: 'runner-1', resultText: 'done again' }] }],
  ])
  const step = {
    input: [
      { step: 'review', results: 'all' },
      { step: 'cross-review', results: 'all' },
    ],
  }

  assert.deepEqual(_private.sourceRunsForStep(step, completed), [
    { agent: 'codex', runnerId: 'runner-1', resultText: 'done', sourceStep: 'review' },
    { agent: 'codex', runnerId: 'runner-1', resultText: 'done again', sourceStep: 'cross-review' },
  ])
})

test('sourceRunsForStep dedupes within a single input step', () => {
  const completed = new Map([
    ['review', { runs: [
      { agent: 'codex', runnerId: 'runner-1', resultText: 'a' },
      { agent: 'codex', runnerId: 'runner-1', resultText: 'b' },
    ] }],
  ])
  const step = { input: [{ step: 'review', results: 'all' }] }

  assert.deepEqual(_private.sourceRunsForStep(step, completed), [
    { agent: 'codex', runnerId: 'runner-1', resultText: 'a', sourceStep: 'review' },
  ])
})

test('prepareLocalPromptDelivery offloads unsafe fan-in prompts before first submit', () => {
  const projectRoot = tmpRoot()
  const sourceRuns = [
    { agent: 'codex', runnerId: 'r1', sourceStep: 'review', resultText: `Codex full prose ${'A'.repeat(9000)} codex-tail` },
    { agent: 'gemini', runnerId: 'r2', sourceStep: 'review', resultText: `Gemini full prose ${'B'.repeat(9000)} gemini-tail` },
  ]
  const runState = { runId: 'run-blob', projectRoot }
  const stepState = { id: 'synthesize' }
  const roundResults = _private.formatLocalRunResults(sourceRuns)

  const delivery = _private.prepareLocalPromptDelivery({
    agent: 'codex',
    prompt: { name: 'synthesize', instruction: 'Synthesize.', body: 'Use the prior work.' },
    step: { id: 'synthesize' },
    sourceRuns,
    roundResults,
    stepContext: '',
    runState,
    stepState,
    projectRoot,
    netlify: { siteId: 'site-1', env: { NETLIFY_AUTH_TOKEN: 'token-1' } },
    options: { safePromptBytes: 9000 },
    dryRun: true,
  })

  assert.equal(delivery.promptDelivery.mode, 'blob')
  assert.ok(Buffer.byteLength(delivery.promptText, 'utf8') <= 9000)
  assert.match(delivery.promptText, /\/opt\/buildhome\/node-deps\/node_modules\/\.bin\/netlify blobs:get nax-run-blob synthesize-prior-results/)
  assert.match(delivery.promptText, /NAX-CONTEXT-LOADED/)
  assert.equal(delivery.promptText.includes(delivery.blobRef.sentinel), false)
  assert.equal(delivery.promptText.includes(sourceRuns[0].resultText), false)
  assert.equal(runState.blobRefs.length, 1)
  assert.equal(stepState.promptBlobRef.key, 'synthesize-prior-results')
})

test('prepareLocalPromptDelivery falls back to compact prompt when blob offload is disabled', () => {
  const sourceRuns = [
    { agent: 'codex', runnerId: 'r1', sourceStep: 'review', resultText: `Codex full prose ${'A'.repeat(9000)} codex-tail` },
  ]
  const roundResults = _private.formatLocalRunResults(sourceRuns)

  const delivery = _private.prepareLocalPromptDelivery({
    agent: 'codex',
    prompt: { name: 'synthesize', instruction: 'Synthesize.', body: 'Use the prior work.' },
    step: { id: 'synthesize' },
    sourceRuns,
    roundResults,
    stepContext: '',
    runState: { runId: 'run-compact' },
    stepState: { id: 'synthesize' },
    projectRoot: tmpRoot(),
    netlify: { siteId: 'site-1', env: { NETLIFY_AUTH_TOKEN: 'token-1' } },
    options: { safePromptBytes: 9000, promptBlobDisable: true },
    dryRun: true,
  })

  assert.equal(delivery.promptDelivery.mode, 'compact')
  assert.equal(promptDeliveryForTest(delivery.promptDelivery).fallbackReason, 'blob-offload-disabled')
  assert.ok(Buffer.byteLength(delivery.promptText, 'utf8') <= 9000)
  assert.equal(delivery.promptText.includes(sourceRuns[0].resultText), false)
})

test('prepareLocalPromptDelivery falls back to compact prompt when blob auth context is missing', () => {
  const sourceRuns = [
    { agent: 'codex', runnerId: 'r1', sourceStep: 'review', resultText: `Codex full prose ${'A'.repeat(9000)} codex-tail` },
  ]
  const roundResults = _private.formatLocalRunResults(sourceRuns)

  const delivery = _private.prepareLocalPromptDelivery({
    agent: 'codex',
    prompt: { name: 'synthesize', instruction: 'Synthesize.', body: 'Use the prior work.' },
    step: { id: 'synthesize' },
    sourceRuns,
    roundResults,
    stepContext: '',
    runState: { runId: 'run-compact-missing-token' },
    stepState: { id: 'synthesize' },
    projectRoot: tmpRoot(),
    netlify: { siteId: 'site-1', env: {} },
    options: { safePromptBytes: 9000 },
    dryRun: false,
  })

  assert.equal(delivery.promptDelivery.mode, 'compact')
  assert.equal(promptDeliveryForTest(delivery.promptDelivery).fallbackReason, 'blob-context-missing')
  assert.match(promptDeliveryForTest(delivery.promptDelivery).fallbackError || '', /NETLIFY_AUTH_TOKEN/)
  assert.ok(Buffer.byteLength(delivery.promptText, 'utf8') <= 9000)
})

test('prepareLocalPromptDelivery offloads an oversized first-step prompt with no prior results', () => {
  const projectRoot = tmpRoot()
  const largeBody = `Generate ideas from this complete brief. ${'A'.repeat(12000)} brief-tail`
  const runState = { runId: 'run-full-prompt', projectRoot }
  const stepState = { id: 'ideate' }

  const delivery = _private.prepareLocalPromptDelivery({
    agent: 'claude',
    prompt: { name: 'ideate', instruction: 'Ideate.', body: largeBody },
    step: { id: 'ideate' },
    sourceRuns: [],
    roundResults: '',
    stepContext: '',
    runState,
    stepState,
    projectRoot,
    netlify: { siteId: 'site-1', env: { NETLIFY_AUTH_TOKEN: 'token-1' } },
    options: { safePromptBytes: 5000 },
    dryRun: true,
  })

  const promptDelivery = promptDeliveryForTest(delivery.promptDelivery)
  assert.equal(promptDelivery.mode, 'blob')
  assert.equal(promptDelivery.kind, 'full-prompt')
  assert.ok(Buffer.byteLength(delivery.promptText, 'utf8') <= 5000)
  assert.match(delivery.promptText, /\/opt\/buildhome\/node-deps\/node_modules\/\.bin\/netlify blobs:get nax-run-full-prompt ideate-claude-full-prompt/)
  assert.match(delivery.promptText, /Full prompt \(offloaded\)/)
  assert.equal(delivery.promptText.includes('brief-tail'), false)
  assert.equal(delivery.promptText.includes(delivery.blobRef.sentinel), false)
  assert.equal(runState.blobRefs.length, 1)
  assert.equal(stepState.promptBlobRef.key, 'ideate-claude-full-prompt')
})

test('applyContextFetchClassification records confidence without requiring rerun on missing marker', () => {
  const run = {
    resultText: `The blob-only conclusion was applied. ${'substantive '.repeat(200)}`,
    promptDelivery: {
      mode: 'blob',
      blobRef: { marker: 'ctx-123', sentinel: 'blob-456' },
    },
  }

  const classified = _private.applyContextFetchClassification(run)

  assert.equal(classified.contextFetchStatus, 'probable')
  assert.equal(classified.contextFetchConfirmed, true)
  assert.deepEqual(classified.contextFetchSignals, ['substantive-output'])
  assert.equal(classified.promptDelivery.contextFetchStatus, 'probable')
})

test('applyContextFetchClassification confirms transcript marker and ignores prose token mentions', () => {
  const run = {
    resultText: `I reviewed the blob feature and mention blobs:get plus NETLIFY_AUTH_TOKEN in prose. ${'substantive '.repeat(200)}`,
    rawResult: {
      transcript: 'NAX-CONTEXT-LOADED ctx-123\nNAX-BLOB-SENTINEL blob-456',
    },
    promptDelivery: {
      mode: 'blob',
      blobRef: { marker: 'ctx-123', sentinel: 'blob-456' },
    },
  }

  const classified = _private.applyContextFetchClassification(run)

  assert.equal(classified.contextFetchStatus, 'confirmed')
  assert.equal(classified.contextFetchConfirmed, true)
  assert.deepEqual(classified.contextFetchSignals, ['marker', 'sentinel'])
})

test('buildAndMaybeFallbackPlan offloads oversized GitHub issue prompts', () => {
  const projectRoot = tmpRoot()
  const largeReply = `Prior prose ${'A'.repeat(9000)} raw-tail`
  const runState = { runId: 'github-run', projectRoot }
  const stepState = { id: 'synthesize' }
  const plan = _private.buildAndMaybeFallbackPlan({
    promptName: 'synthesize',
    prompt: { name: 'synthesize', title: 'Synthesize', instruction: 'synthesize', body: 'Use prior work.' },
    options: {
      models: 'codex',
      repo: 'owner/repo',
      runner: '@netlify',
      date: '2026-06-20',
      safePromptBytes: 5000,
      dryRun: true,
    },
    context: '',
    roundResultsRaw: [{
      issueNumber: 29,
      issueTitle: '2026-06-20 Codex Review',
      issueUrl: 'https://github.com/owner/repo/issues/29',
      model: 'codex',
      replies: [{ body: largeReply, url: 'https://github.com/owner/repo/issues/29#issuecomment-1' }],
    }],
    runState,
    stepState,
    step: { id: 'synthesize' },
    projectRoot,
    netlify: { siteId: 'site-1', env: { NETLIFY_AUTH_TOKEN: 'token-1' } },
  }, buildPlan)

  const body = plan.issues[0].body
  assert.equal(plan.issues[0].promptDelivery.mode, 'blob')
  assert.match(body, /\/opt\/buildhome\/node-deps\/node_modules\/\.bin\/netlify blobs:get nax-github-run synthesize-prior-results/)
  assert.match(body, /NAX-CONTEXT-LOADED/)
  assert.equal(body.includes(stepState.promptBlobRef.sentinel), false)
  assert.equal(body.includes(largeReply), false)
  assert.ok(Buffer.byteLength(body, 'utf8') <= 5000)
  assert.equal(runState.blobRefs.length, 1)
})

test('ensureGithubPlanBlobOffload tolerates missing stepState for standalone issue path', () => {
  const ref = _private.ensureGithubPlanBlobOffload({
    results: [{
      issueNumber: 29,
      issueTitle: 'Prior',
      issueUrl: 'https://github.com/owner/repo/issues/29',
      model: 'codex',
      replies: [{ body: `Prior prose ${'A'.repeat(2000)}` }],
    }],
    fullRoundResults: `Prior prose ${'A'.repeat(2000)}`,
    runState: null,
    stepState: undefined,
    step: { id: 'standalone' },
    projectRoot: tmpRoot(),
    netlify: { siteId: 'site-1', env: { NETLIFY_AUTH_TOKEN: 'token-1' } },
    options: { safePromptBytes: 5000 },
    dryRun: true,
  })

  assert.equal(ref.key, 'standalone-prior-results')
  assert.match(ref.offloadedRoundResults, /blobs:get/)
})

test('cleanupLocalWorkflowBlobs defers GitHub refs without completed consumers', () => {
  const ref = { id: 'run:s:k', runId: 'run', store: 's', key: 'k', status: 'active' }
  const runState = {
    transport: 'github',
    blobRefs: [ref],
    steps: [{
      id: 'fan-in',
      runs: [{
        agent: 'codex',
        status: 'submitted',
        blobRef: ref,
        promptDelivery: { blobRef: ref },
      }],
    }],
  }

  const results = _private.cleanupLocalWorkflowBlobs({
    runState,
    projectRoot: tmpRoot(),
    netlify: { siteId: 'site-1', env: { NETLIFY_AUTH_TOKEN: 'token-1' } },
    reason: 'test',
  })

  assert.deepEqual(results, [])
  assert.equal(runState.blobRefs[0].status, 'active')
  assert.match(runState.blobCleanupWarning, /left for TTL cleanup/)
})

test('buildAndMaybeFallbackPlan offloads oversized GitHub comment-shaped prompts', () => {
  const projectRoot = tmpRoot()
  const largeReply = `Prior prose ${'B'.repeat(9000)} comment-tail`
  const runState = { runId: 'github-comment-run', projectRoot }
  const stepState = { id: 'cross-review' }
  const commentPlanBuilder = ({ prompt, options, roundResults }) => ({
    repo: options.repo,
    issues: [{
      issueNumber: '29',
      issueTitle: '2026-06-20 Codex Review',
      issueUrl: 'https://github.com/owner/repo/issues/29',
      targetRepo: 'owner/repo',
      targetKind: 'issue',
      targetNumber: 29,
      model: 'codex',
      promptName: prompt.name,
      body: `@netlify codex ${prompt.instruction}\n\n${roundResults}`,
    }],
  })

  const plan = _private.buildAndMaybeFallbackPlan({
    promptName: 'cross-review',
    prompt: { name: 'cross-review', title: 'Cross Review', instruction: 'cross review', body: 'Compare prior work.' },
    options: {
      models: 'codex',
      repo: 'owner/repo',
      runner: '@netlify',
      date: '2026-06-20',
      issues: '29',
      safePromptBytes: 5000,
      dryRun: true,
    },
    context: '',
    roundResultsRaw: [{
      issueNumber: 29,
      issueTitle: '2026-06-20 Codex Review',
      issueUrl: 'https://github.com/owner/repo/issues/29',
      model: 'codex',
      replies: [{ body: largeReply, url: 'https://github.com/owner/repo/issues/29#issuecomment-1' }],
    }],
    runState,
    stepState,
    step: { id: 'cross-review' },
    projectRoot,
    netlify: { siteId: 'site-1', env: { NETLIFY_AUTH_TOKEN: 'token-1' } },
  }, commentPlanBuilder)

  const body = plan.issues[0].body
  assert.equal(plan.issues[0].promptDelivery.mode, 'blob')
  assert.match(body, /\/opt\/buildhome\/node-deps\/node_modules\/\.bin\/netlify blobs:get nax-github-comment-run cross-review-prior-results/)
  assert.equal(body.includes(stepState.promptBlobRef.sentinel), false)
  assert.equal(body.includes(largeReply), false)
  assert.ok(Buffer.byteLength(body, 'utf8') <= 5000)
})

test('buildAndMaybeFallbackPlan offloads oversized GitHub first-step prompts with no prior results', () => {
  const projectRoot = tmpRoot()
  const largeBody = `Generate ideas from this complete brief. ${'C'.repeat(12000)} github-tail`
  const runState = { runId: 'github-first-run', projectRoot }
  const stepState = { id: 'ideate' }
  const plan = _private.buildAndMaybeFallbackPlan({
    promptName: 'ideate',
    prompt: { name: 'ideate', title: 'Ideate', instruction: 'ideate', body: largeBody },
    options: {
      models: 'codex',
      repo: 'owner/repo',
      runner: '@netlify',
      date: '2026-06-20',
      safePromptBytes: 5000,
      dryRun: true,
    },
    context: '',
    roundResultsRaw: [],
    runState,
    stepState,
    step: { id: 'ideate' },
    projectRoot,
    netlify: { siteId: 'site-1', env: { NETLIFY_AUTH_TOKEN: 'token-1' } },
  }, buildPlan)

  const body = plan.issues[0].body
  const promptDelivery = promptDeliveryForTest(plan.issues[0].promptDelivery)
  assert.equal(promptDelivery.mode, 'blob')
  assert.equal(promptDelivery.kind, 'full-prompt')
  assert.match(body, /^@netlify codex fetch and follow the complete offloaded prompt/)
  assert.match(body, /\/opt\/buildhome\/node-deps\/node_modules\/\.bin\/netlify blobs:get nax-github-first-run ideate-codex-full-prompt/)
  assert.equal(body.includes('github-tail'), false)
  assert.equal(body.includes(stepState.promptBlobRef.sentinel), false)
  assert.ok(Buffer.byteLength(body, 'utf8') <= 5000)
  assert.equal(runState.blobRefs.length, 1)
})

test('chooseNetlifyFilterOption does not require filters for non-workspace multi-app repos', async () => {
  const projectRoot = tmpRoot()
  fs.mkdirSync(path.join(projectRoot, 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'sanity'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'frontend', 'netlify.toml'), '[build]\n  command = "npm run build"\n')
  fs.writeFileSync(path.join(projectRoot, 'sanity', 'netlify.toml'), '[build]\n  command = "npm run build"\n')

  const options = { yes: true }
  const resolved = await chooseNetlifyFilterOption({
    projectRoot,
    options,
    detectWorkspace: async () => ({ isWorkspace: false, workspace: null, packageManager: null, error: '' }),
  })

  assert.equal(resolved, options)
})

test('chooseNetlifyFilterOption still requires filters for JavaScript workspaces', async () => {
  const projectRoot = tmpRoot()
  fs.mkdirSync(path.join(projectRoot, 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'frontend', 'netlify.toml'), '[build]\n  command = "npm run build"\n')
  fs.writeFileSync(path.join(projectRoot, 'docs', 'netlify.toml'), '[build]\n  command = "npm run build"\n')

  await assert.rejects(
    chooseNetlifyFilterOption({
      projectRoot,
      options: { yes: true },
      detectWorkspace: async () => ({ isWorkspace: true, workspace: { packages: [] }, packageManager: { name: 'pnpm' }, error: '' }),
    }),
    /Multiple netlify\.toml files were found/,
  )
})

test('workflow dry run previews without writing .nax artifacts', () => {
  const projectRoot = tmpRoot()
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'bin', 'nax.js'),
    'review',
    '--dry',
    '--force',
    '--branch',
    'dry-run-branch',
    '--transport',
    'netlify-api',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /Multi step agent workflow: "Review"/)
  assert.match(result.stdout, /Dry run only/)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax')), false)
})

test('workflow dry run can execute a project-local workflow', () => {
  const projectRoot = tmpRoot()
  writeProjectFlow(projectRoot, 'conversion-audit', { title: 'Conversion Audit' })
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'bin', 'nax.js'),
    'conversion-audit',
    '--dry',
    '--force',
    '--branch',
    'dry-run-branch',
    '--transport',
    'netlify-api',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(stripAnsi(result.stdout), /Multi step agent workflow:/)
  assert.match(stripAnsi(result.stdout), /"Conversion Audit"/)
  assert.equal(fs.existsSync(path.join(projectRoot, '.nax')), false)
})

test('futureFollowUpReferencesStep detects deferred archive dependencies', () => {
  const steps = [
    { id: 'review' },
    { id: 'cross-review', submit: 'follow-up', input: [{ step: 'review', results: 'all' }] },
    { id: 'synthesize', submit: 'new-run', input: [{ step: 'review', results: 'all' }] },
  ]

  assert.equal(_private.futureFollowUpReferencesStep(steps, 0, 'review'), true)
  assert.equal(_private.futureFollowUpReferencesStep(steps, 1, 'review'), false)
})

test('shouldArchiveCompletedStep archives intermediate steps only when requested', () => {
  const steps = [
    { id: 'review', isArchivable: true },
    { id: 'cross-review', isArchivable: true },
    { id: 'synthesize', isArchivable: true },
  ]

  assert.equal(_private.shouldArchiveCompletedStep({
    step: steps[0],
    options: { archive: true },
    flowSteps: steps,
    currentStepIndex: 0,
  }), true)
  assert.equal(_private.shouldArchiveCompletedStep({
    step: steps[2],
    options: { archive: true },
    flowSteps: steps,
    currentStepIndex: 2,
  }), false)
  assert.equal(_private.shouldArchiveCompletedStep({
    step: steps[0],
    options: {},
    flowSteps: steps,
    currentStepIndex: 0,
  }), false)
  assert.equal(_private.shouldArchiveCompletedStep({
    step: { id: 'review', isArchivable: false },
    options: { archive: true },
    flowSteps: steps,
    currentStepIndex: 0,
  }), false)
  assert.equal(_private.shouldArchiveCompletedStep({
    step: { id: 'synthesize', autoArchive: true },
    options: {},
    flowSteps: steps,
    currentStepIndex: 2,
  }), true)
  assert.equal(_private.shouldArchiveCompletedStep({
    step: { id: 'review', autoArchive: false },
    options: { archive: true },
    flowSteps: steps,
    currentStepIndex: 0,
  }), false)
})

test('archiveEligibleCompletedLocalRuns defers runs needed by follow-up steps and dedupes runner archive calls', () => {
  const projectRoot = tmpRoot()
  const runState = writeRunState(projectRoot, 'archive-test', {
    flowId: 'review',
    steps: [{
      id: 'review',
      title: 'Review',
      status: 'completed',
      runs: [{
        agent: 'codex',
        status: 'completed',
        runnerId: 'runner-1',
        resultText: 'first result',
      }],
    }],
  })
  const flowSteps = [
    { id: 'review', isArchivable: true },
    { id: 'cross-review', isArchivable: true, submit: 'follow-up', input: [{ step: 'review', results: 'all' }] },
    { id: 'synthesize', isArchivable: true, submit: 'new-run', input: [{ step: 'review', results: 'all' }] },
  ]
  const archiveCalls = []
  const archiveRun = ({ runnerId }) => {
    archiveCalls.push(runnerId)
    return { archived: true, error: '' }
  }

  _private.archiveEligibleCompletedLocalRuns({
    runState,
    flowSteps,
    currentStepIndex: 0,
    options: { archive: true },
    projectRoot,
    netlify: { env: {} },
    archiveRun,
  })
  assert.deepEqual(archiveCalls, [])
  assert.equal(runState.steps[0].runs[0].archived, undefined)

  runState.steps.push({
    id: 'cross-review',
    title: 'Cross Review',
    status: 'completed',
    runs: [{
      agent: 'codex',
      status: 'completed',
      runnerId: 'runner-1',
      sessionId: 'session-1',
      resultText: 'follow-up result',
      usage: { totalCreditsCost: 0, stepsCount: 0, totalTokens: 0 },
    }],
  })

  _private.archiveEligibleCompletedLocalRuns({
    runState,
    flowSteps,
    currentStepIndex: 1,
    options: { archive: true },
    projectRoot,
    netlify: { env: {} },
    archiveRun,
  })

  assert.deepEqual(archiveCalls, ['runner-1'])
  assert.equal(runState.steps[0].runs[0].archived, true)
  assert.equal(runState.steps[1].runs[0].archived, true)
})

test('formatCompactLocalRunResults truncates prior local outputs for retry prompts', () => {
  const longResult = `${'A'.repeat(800)}\nimportant tail`
  const formatted = _private.formatCompactLocalRunResults([
    {
      agent: 'claude',
      sourceStep: 'ideate',
      resultText: longResult,
    },
  ], {
    perRunLimit: 300,
    totalLimit: 1000,
  })

  assert.match(formatted, /## Prior Agent Results/)
  assert.match(formatted, /Claude from ideate/)
  assert.match(formatted, /compacted from/)
  assert.match(formatted, /important tail/)
  assert.ok(formatted.length < longResult.length)
})

test('usageSummariesForRunState aggregates usage by step and total', () => {
  const summary = _private.usageSummariesForRunState({
    steps: [
      {
        id: 'review',
        title: 'Review',
        runs: [
          {
            agent: 'claude',
            usage: {
              totalTokens: 420,
              totalCreditsCost: 1.25,
              stepsCount: 10,
            },
          },
          {
            agent: 'codex',
            rawResult: {
              latestSession: {
                usage: {
                  total_tokens: 650,
                  total_credits_cost: 2.5,
                },
                steps_count: 46,
              },
            },
          },
        ],
      },
      {
        id: 'synthesize',
        title: 'Summarize Consensus',
        runs: [
          {
            agent: 'codex',
            usage: {
              totalTokens: 15,
              totalCreditsCost: 0.1,
              stepsCount: 1,
            },
          },
        ],
      },
    ],
  })

  assert.equal(summary.steps.length, 2)
  assert.equal(summary.steps[0].title, 'Review')
  assert.equal(summary.steps[0].usage.totalTokens, 1070)
  assert.equal(summary.steps[0].usage.stepsCount, 56)
  assert.equal(summary.total.totalTokens, 1085)
  assert.equal(summary.total.totalCreditsCost, 3.85)
  assert.equal(summary.total.stepsCount, 57)
  assert.match(summary.totalSummary, /1,085 tokens/)
  assert.match(summary.totalSummary, /57 steps/)
  assert.match(summary.totalSummary, /3.85 credits/)
})

test('TTY progress rows show a green complete status', () => {
  const line = formatTtyProgressRow({
    agent: 'codex',
    status: 'completed',
    url: 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/runner-1?session=session-1',
  }, {
    nameWidth: 6,
    frame: 0,
  })

  assert.equal(line, '✓ Codex  · 🟢 complete - https://app.netlify.com/projects/netlify-agent-executor/agent-runs/runner-1?session=session-1')
})

test('TTY progress rows show compact current task details while running', () => {
  const line = formatTtyProgressRow({
    agent: 'gemini',
    status: 'running',
    emoji: '🎨',
    phrase: 'is painting a masterpiece...',
    currentTask: 'reading file src/components/VeryLongComponentNameThatShouldBeTrimmedBecauseItIsTooVerbose.jsx and comparing it against docs/reference/current-task-display-guidelines.md before writing changes',
  }, {
    nameWidth: 6,
    frame: 0,
    orchestrator: 'Netlify Agent runner',
  })

  assert.match(line, /^◐ Gemini · 🎨 Netlify Agent runner is painting a masterpiece\.\.\. - "reading file /)
  assert.match(line, /…"$/)
  assert.ok(line.length < 180)
})

test('TTY progress rows show discovered Netlify run URLs while running', () => {
  const line = formatTtyProgressRow({
    agent: 'claude',
    status: 'running',
    emoji: '🌀',
    phrase: 'is hyperspacing...',
    url: 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/runner-1',
  }, {
    nameWidth: 6,
    frame: 0,
    orchestrator: 'Netlify Agent runner',
  })

  assert.equal(
    line,
    '◐ Claude · 🌀 Netlify Agent runner is hyperspacing... - https://app.netlify.com/projects/netlify-agent-executor/agent-runs/runner-1',
  )
})

test('GitHub status comments attach Netlify run links before result comments complete', () => {
  const run = {
    issueNumber: 23,
    commentUrl: 'https://github.com/netlify-labs/nax/issues/23#issuecomment-prompt',
    agent: 'claude',
    status: 'submitted',
  }
  const update = _private.applyGithubStatusCommentToRun({
    issueNumber: 23,
    comments: [
      {
        url: run.commentUrl,
        body: '@netlify claude run\n<!-- netlify-workflow-prompt:ideas:claude:2026-06-03 -->',
      },
      {
        url: 'https://github.com/netlify-labs/nax/issues/23#issuecomment-status',
        body: [
          '### [Netlify Agent Run Status](https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a20cf287aa08964d358f444)',
          '',
          'Netlify Agent Runners is wibbling... 🫠',
          '',
          '<!-- netlify-agent-runner-id:6a20cf287aa08964d358f444 -->',
          '<!-- netlify-agent-run-status -->',
        ].join('\n'),
      },
    ],
  }, run)

  assert.equal(update.agentRunUrl, 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a20cf287aa08964d358f444')
  assert.equal(update.run.links.agentRunUrl, 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a20cf287aa08964d358f444')
  assert.equal(run.links.agentRunUrl, 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a20cf287aa08964d358f444')
  assert.equal(run.status, 'running')
})

test('GitHub completed status comments mark progress rows complete', () => {
  const run = {
    issueNumber: 24,
    commentUrl: '',
    agent: 'gemini',
    status: 'submitted',
  }
  const update = _private.applyGithubStatusCommentToRun({
    issueNumber: 24,
    comments: [
      {
        url: 'https://github.com/netlify-labs/nax/issues/24#issuecomment-status',
        body: [
          '### [Netlify Agent Run Status](https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a20cf28b319d6230a402ea5?session=6a20cf28b319d6230a402ea7) ✅',
          '',
          'Netlify Agent Run completed.',
          '',
          '<!-- netlify-agent-run-status -->',
        ].join('\n'),
      },
    ],
  }, run)

  assert.equal(update.run.status, 'completed')
  assert.equal(run.status, 'completed')
  assert.equal(update.run.links.sessionUrl, 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a20cf28b319d6230a402ea5?session=6a20cf28b319d6230a402ea7')
})

test('pickFlavor avoids active phrases already in use', () => {
  const first = pickFlavor({ random: () => 0 })
  const second = pickFlavor({ used: new Set([first[0]]), random: () => 0 })

  assert.notEqual(second[0], first[0])
})

test('Did you know progress tip formats a rotating Agent Runner use case', () => {
  const lines = formatDidYouKnowLines([
    '👀 Code reviews',
    'Bring in a fresh reviewer that can inspect architecture, tests, and edge cases.',
    'Audit the code with fresh eyes and identify areas for improvement.',
  ], { width: 72, color: '#00ad9f' })
  const text = lines.join('\n')

  assert.match(lines[0], /While agent runners are doing their magic/)
  assert.match(text, /While agent runners are doing their magic/)
  assert.match(text, /for Netlify Agent runners/)
  assert.match(text, /👀 Use Agent Runs for Code reviews/)
  assert.match(text, /Bring in a fresh reviewer/)
  assert.match(text, /Prompt Examples:/)
  assert.match(text, /- "Audit the code with fresh eyes/)
  assert.match(text, /use\s+cases/)
  assert.match(text, /╭|┌/)
  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 72, `line exceeded requested width: ${stripAnsi(line).length}`)
  }
})

test('Did you know progress tip reserves terminal edge space', () => {
  const lines = formatDidYouKnowLines([
    '🚦 Error handling',
    'Improve user-facing failures, logging, empty states, and recovery paths.',
    'Add proper error boundaries, logging, and user-friendly error states throughout the app.',
  ], { width: 48, marginRight: 3 })

  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 45, `line exceeded terminal-safe width: ${stripAnsi(line).length}`)
  }
})

test('physicalRowCount counts wrapped rows for lines wider than the terminal', () => {
  // 200-char line in an 80-col terminal wraps to ceil(200/80) = 3 rows.
  assert.equal(physicalRowCount(['x'.repeat(200)], 80), 3)
  // Empty line still occupies 1 row.
  assert.equal(physicalRowCount(['short', '', 'short'], 80), 3)
  // Falls back to logical count when columns is unknown.
  assert.equal(physicalRowCount(['x'.repeat(200)], 0), 1)
  // ANSI escapes don't count toward visible width.
  const ansi = `\x1b[31m${'x'.repeat(80)}\x1b[0m`
  assert.equal(physicalRowCount([ansi], 80), 1)
})

test('progress frame clearing accounts for terminal width changes', () => {
  /** @type {Array<[string, ...number[]]>} */
  const calls = []
  const output = /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ ({ columns: 60 }))
  const lines = ['x'.repeat(119), 'short']
  /** @type {Pick<typeof import('readline'), 'moveCursor' | 'cursorTo' | 'clearScreenDown'>} */
  const controls = {
    moveCursor: (_output, dx, dy) => {
      calls.push(['moveCursor', dx, dy])
      return true
    },
    cursorTo: (_output, x) => {
      calls.push(['cursorTo', x])
      return true
    },
    clearScreenDown: () => {
      calls.push(['clearScreenDown'])
      return true
    },
  }

  const cleared = clearRenderedProgressFrame({
    rows: 2,
    lines,
    columns: 120,
    output,
    controls,
  })

  assert.equal(cleared, 3)
  assert.deepEqual(calls, [
    ['moveCursor', 0, -3],
    ['cursorTo', 0],
    ['clearScreenDown'],
  ])
})

test('Did you know progress tip wraps its header instead of overflowing one logical line', () => {
  const lines = formatDidYouKnowLines([
    '♿ Accessibility',
    'Review keyboard flows, labels, contrast, landmarks, and WCAG gaps.',
    'Run an accessibility audit and fix all WCAG 2.1 AA violations.',
  ], { width: 70, marginRight: 2 })

  const headerLines = []
  for (const line of lines) {
    if (/^[╭┌╰└│├┤─]/.test(stripAnsi(line))) break
    headerLines.push(line)
  }
  // Header should wrap onto multiple lines, none exceeding the viewport width.
  assert.ok(headerLines.length >= 2, `expected wrapped header rows, got ${headerLines.length}`)
  for (const line of headerLines) {
    assert.ok(stripAnsi(line).length <= 70, `header row exceeded width: ${stripAnsi(line).length}`)
  }
})

test('Did you know progress tip does not force full terminal width by default', () => {
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 200 })
  try {
    const lines = formatDidYouKnowLines([
      '👀 Code reviews',
      'Bring in a fresh reviewer that can inspect architecture, tests, and edge cases.',
      'Audit the code with fresh eyes and identify areas for improvement.',
    ])
    const boxLines = lines.slice(1).map(stripAnsi)
    assert.ok(Math.max(...boxLines.map((line) => line.length)) < 120)
  } finally {
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns)
    } else {
      delete process.stdout.columns
    }
  }
})

test('TTY progress reporter clears the Agent Runner use case tip after all runs complete', () => {
  const originalWrite = process.stdout.write
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const writes = []
  process.stdout.write = (chunk, ...args) => {
    writes.push(String(chunk))
    const callback = args.find((arg) => typeof arg === 'function')
    if (callback) callback()
    return true
  }
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  try {
    const reporter = makeStepProgressReporter({
      stepTitle: 'Cross Review',
      total: 2,
      agents: ['claude', 'gemini'],
    })
    reporter.updateRun({
      run: {
        agent: 'claude',
        status: 'completed',
        links: { sessionUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-1?session=session-1' },
      },
      state: 'completed',
      terminal: true,
      terminalSuccess: true,
    })
    reporter.updateRun({
      run: {
        agent: 'gemini',
        status: 'completed',
        links: { sessionUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-2?session=session-2' },
      },
      state: 'completed',
      terminal: true,
      terminalSuccess: true,
    })
    reporter.done()
  } finally {
    process.stdout.write = originalWrite
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  const progressChunks = writes.filter((chunk) => chunk.includes('Waiting for Cross Review'))
  const finalProgress = progressChunks.at(-1) || ''
  assert.match(writes.join(''), /While agent runners are doing their magic/)
  assert.match(finalProgress, /Waiting for Cross Review: 2\/2 complete/)
  assert.match(finalProgress, /✓ Claude/)
  assert.match(finalProgress, /✓ Gemini/)
  assert.doesNotMatch(finalProgress, /While agent runners are doing their magic/)
  assert.doesNotMatch(finalProgress, /Use Agent Runs for/)
})

test('nextLocalStepMessage describes the immediate transition after a local step', () => {
  const steps = [
    { title: 'Propose Next Task' },
    { title: 'Synthesize Next Task' },
  ]

  assert.equal(nextLocalStepMessage(steps, 0), 'Preparing next step: Synthesize Next Task...')
  assert.equal(nextLocalStepMessage(steps, 1), 'Finalizing workflow outputs...')
})

test('handoff helpers default to the latest run summary', () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'older', { updatedAt: '2026-05-20T20:00:00.000Z' })
  writeRunState(projectRoot, 'newer', { updatedAt: '2026-05-20T21:00:00.000Z' })

  const latest = _private.findRunStateForHandoff(projectRoot)
  assert.equal(latest.runId, 'newer')

  const handoff = _private.readHandoffSummary({ projectRoot })
  assert.equal(handoff.id, 'newer')
  assert.equal(handoff.kind, 'workflow')
  assert.equal(handoff.displayPath, '.nax/workflows/newer/artifacts/summary.md')
  assert.match(handoff.summaryText, /# Do Next/)
  assert.match(handoff.summaryText, /Final result/)
})

test('buildHandoffPrompt inlines instructions and summary contents', () => {
  const prompt = _private.buildHandoffPrompt({
    instructions: 'Focus on the next smallest task.',
    summaryPath: '.nax/workflows/latest/artifacts/summary.md',
    summaryText: '# Summary\n\nDone.',
  })

  assert.match(prompt, /# Additional Instructions/)
  assert.match(prompt, /Focus on the next smallest task\./)
  assert.match(prompt, /Source: \.nax\/workflows\/latest\/artifacts\/summary\.md/)
  assert.match(prompt, /# Summary\n\nDone\./)
})

test('success handoff hint is TTY-only and points at the summary file', () => {
  const projectRoot = tmpRoot()
  const state = writeRunState(projectRoot, 'newer')
  _private.readHandoffSummary({ projectRoot, runId: 'newer' })
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  console.log = (line = '') => lines.push(line)
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  try {
    _private.printPostSuccessHandoffHint(state, projectRoot)
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.match(lines.join('\n'), /\.nax\/workflows\/newer\/artifacts\/summary\.md/)
  assert.match(lines.join('\n'), /nax handoff/)
})

test('copyToClipboard uses the platform clipboard command', () => {
  const calls = []
  const command = _private.copyToClipboard('summary', {
    platform: 'darwin',
    runCommand: (cmd, args, options) => {
      calls.push({ cmd, args, input: options.input })
      return { status: 0 }
    },
  })

  assert.equal(command, 'pbcopy')
  assert.deepEqual(calls, [{ cmd: 'pbcopy', args: [], input: 'summary' }])
})

test('openHandoffSource opens the absolute summary path', async () => {
  const projectRoot = tmpRoot()
  const summaryPath = path.join(projectRoot, '.nax/agent-runners/runner-1/summary.md')
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.writeFileSync(summaryPath, '# Summary\n')
  const calls = []

  const opened = await _private.openHandoffSource({
    displayPath: '.nax/agent-runners/runner-1/summary.md',
  }, {
    projectRoot,
    opener: async (target) => calls.push(target),
  })

  assert.equal(opened, summaryPath)
  assert.deepEqual(calls, [summaryPath])
})

test('handoff source flags map to explicit artifact queries', () => {
  assert.deepEqual(_private.handoffSourceQuery({ runId: 'workflow-1', options: {} }), {
    kind: 'workflow',
    id: 'workflow-1',
  })
  assert.deepEqual(_private.handoffSourceQuery({ options: { session: 'session-1' } }), {
    kind: 'agent-session',
    id: 'session-1',
  })
  assert.deepEqual(_private.handoffSourceQuery({ options: { runner: 'runner-1' } }), {
    kind: 'agent-runner',
    id: 'runner-1',
  })
  assert.deepEqual(_private.handoffSourceQuery({ options: { sourceType: 'sessions', source: 'session-2' } }), {
    kind: 'agent-session',
    id: 'session-2',
  })
})

test('handoff source labels render source kind and relative path', () => {
  const source = {
    kind: 'agent-session',
    title: 'Codex session session-1',
    updatedAt: '2026-05-21T01:01:12.173Z',
    displayPath: '.nax/agent-sessions/session-1/summary.md',
  }

  assert.match(_private.formatHandoffSourceLabel(source), /Codex session session-1/)
  assert.equal(_private.formatHandoffSourceHint(source, process.cwd()), 'agent session · .nax/agent-sessions/session-1/summary.md')
})

test('handoff source details summarize latest workflow content', () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'workflow-1', {
    updatedAt: '2026-05-21T01:01:12.173Z',
    steps: [{
      id: 'synthesize',
      title: 'Synthesize Next Task',
      status: 'completed',
      runs: [{
        agent: 'codex',
        status: 'completed',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        resultText: '**Recommended Next Task:** Add focused artifact tests before more persistence work. This preview should include enough text to explain why the latest result is useful before the user opens the full summary.',
        usage: { totalCreditsCost: 1.5, stepsCount: 2, totalTokens: 3000 },
      }],
    }],
  })
  const source = _private.readHandoffSummary({ projectRoot, runId: 'workflow-1' })

  const lines = _private.handoffSourceDetailLines(source, projectRoot)

  assert.match(lines[0], /^Date:\s+May/)
  assert.match(lines[1], /Summary:\s+\.nax\/workflows\/workflow-1\/artifacts\/summary\.md/)
  assert.equal(lines[2], 'Preview:')
  assert.match(lines[3], /^\*\*Recommended Next Task:\*\* Add focused artifact tests/)

  const box = _private.formatHandoffSourceDetailBox(source, projectRoot)
  assert.match(box, /Latest result from "Do Next" workflow "Synthesize Next Task" step using Codex/)
  assert.match(box, /Summary: \.nax\/workflows\/workflow-1\/artifacts\/summary\.md/)
  assert.match(box, /Preview:/)
  assert.match(box, /This preview should/)
})

test('handoff source menu exposes latest actions before previous-source pickers', () => {
  const latestSource = {
    kind: 'agent-runner',
    id: '6a20be9c14c516253be5fe14',
    title: 'codex runner 6a20be9c14c516253be5fe14',
    displayPath: '.nax/agent-runners/6a20be9c14c516253be5fe14/summary.md',
    source: { agent: 'codex' },
  }
  const options = _private.handoffSourceMenuOptions({
    latestSource,
    sources: [
      { kind: 'workflow' },
      { kind: 'agent-session' },
      { kind: 'agent-runner' },
    ],
    projectRoot: process.cwd(),
  })

  assert.deepEqual(options.map((option) => option.label), [
    'Copy latest results markdown to clipboard',
    'Copy latest results filePath to clipboard',
    'Open latest results in code editor',
    'Run followup prompt with previous results',
    'Pick previous workflow',
    'Pick previous agent session',
    'Pick previous agent runner',
    'Cancel',
  ])
  assert.equal(options[0].hint, 'from codex .nax/agent-runners/6a20be9c14c516253be5fe14/summary.md')
  assert.equal(options[1].hint, '.nax/agent-runners/6a20be9c14c516253be5fe14/summary.md')
  assert.equal(options[2].hint, '.nax/agent-runners/6a20be9c14c516253be5fe14/summary.md')
  assert.equal(options[3].hint, 'codex .nax/agent-runners/6a20be9c14c516253be5fe14/summary.md')
})

test('non-TTY progress reporter repeats unchanged run status after heartbeat interval', () => {
  const originalLog = console.log
  const originalNow = Date.now
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  let now = 1000
  console.log = (line) => lines.push(line)
  Date.now = () => now
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = makeStepProgressReporter({
      stepTitle: 'Review',
      total: 1,
      agents: ['codex'],
      nonTtyHeartbeatMs: 1000,
    })
    const event = {
      run: { agent: 'codex', runnerId: 'runner-1' },
      state: 'running',
    }
    reporter.updateRun(event)
    now += 500
    reporter.updateRun(event)
    now += 500
    reporter.updateRun(event)
  } finally {
    console.log = originalLog
    Date.now = originalNow
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'codex runner-1: running (check #1)',
    'codex runner-1: running (check #3)',
  ])
})

test('formatSubmittedLocalRunBoxes renders submitted local run details', () => {
  const output = _private.formatSubmittedLocalRunBoxes({
    prompt: { title: 'Review' },
    runs: [
      {
        agent: 'claude',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        status: 'submitted',
        submittedAfterSeconds: 6,
      },
    ],
  })

  assert.match(output, /Claude Review/)
  assert.match(output, /Status: submitted/)
  assert.match(output, /Runner ID: runner-1/)
  assert.match(output, /Session ID: session-1/)
  assert.match(output, /Submitted after: 6s/)
})

test('submitted local run boxes keep non-TTY run links on one line', () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  const longUrl = 'https://app.netlify.com/projects/revenue-engine-dev/agent-runs/6a212d2178e44c51e0ec5cc9?session=6a21320a88a8244624caad44'
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 })
  try {
    const output = stripAnsi(_private.formatSubmittedLocalRunBoxes({
      prompt: { title: 'Cross Review' },
      runs: [
        {
          agent: 'gemini',
          runnerId: '6a212d2178e44c51e0ec5cc9',
          sessionId: '6a21320a88a8244624caad44',
          status: 'submitted',
          submittedAfterSeconds: 6,
          links: { sessionUrl: longUrl },
        },
      ],
    }))
    const urlLines = output.split('\n').filter((line) => line.includes('https://app.netlify.com/'))
    assert.equal(urlLines.length, 1)
    assert.ok(urlLines[0].includes(longUrl), urlLines[0])
  } finally {
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns)
    } else {
      delete process.stdout.columns
    }
  }
})

test('localAgentRunUrl uses nested Netlify config directory and rejects root site mismatch', () => {
  const projectRoot = tmpRoot()
  const appDir = path.join(projectRoot, 'clients', 'frontend')
  const binDir = path.join(projectRoot, 'bin')
  fs.mkdirSync(appDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'netlify.toml'), '[build]\n')
  const fakeNetlify = path.join(binDir, 'netlify')
  fs.writeFileSync(fakeNetlify, [
    '#!/usr/bin/env node',
    'const path = require("path")',
    'const cwd = process.cwd()',
    'const isFrontend = cwd.endsWith(path.join("clients", "frontend"))',
    'const siteName = isFrontend ? "revenue-engine-frontend" : "deprecated-gmail-emailer"',
    'const siteId = isFrontend ? "frontend-site" : "root-site"',
    'console.log(JSON.stringify({ siteData: { "site-id": siteId, "site-name": siteName, "admin-url": `https://app.netlify.com/projects/${siteName}` } }))',
    '',
  ].join('\n'))
  fs.chmodSync(fakeNetlify, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${binDir}${path.delimiter}${originalPath || ''}`
  try {
    const nestedUrl = _private.localAgentRunUrl({
      projectRoot,
      runnerId: 'runner-1',
      options: {
        netlifyConfig: 'clients/frontend/netlify.toml',
        netlifySiteId: 'frontend-site',
      },
    })
    assert.equal(nestedUrl, 'https://app.netlify.com/projects/revenue-engine-frontend/agent-runs/runner-1')

    const mismatchedRootUrl = _private.localAgentRunUrl({
      projectRoot,
      runnerId: 'runner-1',
      options: { netlifySiteId: 'frontend-site' },
    })
    assert.equal(mismatchedRootUrl, '')
  } finally {
    process.env.PATH = originalPath
  }
})

test('cancelLocalWorkflowRunnersForInterrupt stops active fresh Netlify runners and records state', () => {
  const projectRoot = tmpRoot()
  const calls = []
  const runState = {
    transport: 'netlify-api',
    options: { netlifySiteId: 'site-123' },
    steps: [{
      id: 'review',
      status: 'running',
      runs: [
        { runnerId: 'runner-1', status: 'submitted' },
        { runnerId: 'runner-2', status: 'completed' },
        { runnerId: 'runner-3', status: 'running', existingRunnerId: 'source-runner' },
      ],
    }],
  }

  const result = _private.cancelLocalWorkflowRunnersForInterrupt({
    runState,
    projectRoot,
    options: { netlifySiteId: 'site-123' },
    reason: 'test interrupt',
    stopRun({ runnerId }) {
      calls.push(runnerId)
      return { stopped: true, accepted: true, error: '', commandError: false }
    },
  })

  assert.deepEqual(calls, ['runner-1'])
  assert.deepEqual(result.stopped, ['runner-1'])
  assert.equal(runState.steps[0].runs[0].status, 'cancelled')
  assert.equal(runState.steps[0].runs[1].status, 'completed')
  assert.equal(runState.steps[0].runs[2].status, 'running')
  assert.deepEqual(runState.remoteCancel.runnerIds, ['runner-1'])
  assert.deepEqual(runState.remoteCancel.stopped, ['runner-1'])
})

test('non-TTY progress reporter aligns agent and state columns', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  console.log = (line) => lines.push(line)
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = makeStepProgressReporter({
      stepTitle: 'Review',
      total: 3,
      agents: ['claude', 'gemini', 'codex'],
    })
    reporter.updateRun({
      run: { agent: 'claude', runnerId: '6a0e1befb595e97af9a2c165' },
      state: 'running',
      message: 'claude 6a0e1befb595e97af9a2c165: running',
    })
    reporter.updateRun({
      run: { agent: 'gemini', runnerId: '6a0e1bee848af0ba500f3c89' },
      state: 'running',
      message: 'gemini 6a0e1bee848af0ba500f3c89: running',
    })
    reporter.updateRun({
      run: { agent: 'codex', runnerId: '6a0e1bf1c1a717707743f5c5' },
      state: 'running',
      message: 'codex 6a0e1bf1c1a717707743f5c5: running',
    })
    reporter.updateRun({
      run: { agent: 'codex', runnerId: '6a0e1bf1c1a717707743f5c5' },
      state: 'done',
      message: 'codex 6a0e1bf1c1a717707743f5c5: done',
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'claude 6a0e1befb595e97af9a2c165: running (check #1)',
    'gemini 6a0e1bee848af0ba500f3c89: running (check #1)',
    'codex  6a0e1bf1c1a717707743f5c5: running (check #1)',
    'codex  6a0e1bf1c1a717707743f5c5: done    (check #2)',
  ])
})

test('non-TTY progress reporter prints usage when a local run completes', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  console.log = (line) => lines.push(line)
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = makeStepProgressReporter({
      stepTitle: 'Review',
      total: 1,
      agents: ['codex'],
    })
    reporter.updateRun({
      run: {
        agent: 'codex',
        runnerId: 'runner-1',
        status: 'completed',
        usage: {
          totalTokens: 85131,
          stepsCount: 10,
          totalCreditsCost: 18.06858,
        },
      },
      state: 'completed',
      terminal: true,
      terminalSuccess: true,
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'codex runner-1: completed (check #1)\n**Usage:** 18.07 credits · 10 steps · 85,131 tokens',
  ])
})

test('agentStepCompletionSummary formats aligned duration and usage rows', () => {
  const summary = agentStepCompletionSummary({
    stepTitle: 'Review',
    runs: [
      {
        agent: 'claude',
        status: 'completed',
        usage: { totalCreditsCost: 46.66, stepsCount: 14, totalTokens: 1014414 },
        rawResult: {
          latestSession: {
            created_at: '2026-05-20T20:00:00.000Z',
            updated_at: '2026-05-20T20:07:46.000Z',
          },
        },
      },
      {
        agent: 'gemini',
        status: 'completed',
        usage: { totalCreditsCost: 117.28, stepsCount: 40, totalTokens: 1363374 },
        rawResult: {
          latestSession: {
            created_at: '2026-05-20T20:00:13.000Z',
            updated_at: '2026-05-20T20:12:30.000Z',
          },
        },
      },
      {
        agent: 'codex',
        status: 'completed',
        usage: { totalCreditsCost: 120.52, stepsCount: 40, totalTokens: 501436 },
        rawResult: {
          latestSession: {
            created_at: '2026-05-20T20:00:10.000Z',
            updated_at: '2026-05-20T20:12:30.000Z',
          },
        },
      },
    ],
  })

  assert.equal(summary, [
    'Review: 3/3 complete - 12min 30s',
    'Claude:  complete  7min 46s    46.66 credits  14 steps  1,014,414 tokens',
    'Gemini:  complete  12min 17s  117.28 credits  40 steps  1,363,374 tokens',
    'Codex:   complete  12min 20s  120.52 credits  40 steps    501,436 tokens',
    'Total:   284.46 credits  94 steps  2,879,224 tokens',
  ].join('\n'))
})

test('agentStepCompletionSummary includes USD cost when requested', () => {
  const original = process.env.NAX_INCLUDE_COST
  process.env.NAX_INCLUDE_COST = '1'
  try {
    const summary = agentStepCompletionSummary({
      stepTitle: 'Review',
      runs: [
        {
          agent: 'claude',
          status: 'completed',
          usage: { totalCreditsCost: 46.66, stepsCount: 14, totalTokens: 1014414 },
        },
      ],
    })

    assert.match(summary, /46\.66 credits \(\$0\.26\)/)
    assert.match(summary, /Total:\s+46\.66 credits \(\$0\.26\)/)
  } finally {
    if (original === undefined) {
      delete process.env.NAX_INCLUDE_COST
    } else {
      process.env.NAX_INCLUDE_COST = original
    }
  }
})

test('isAdHocRunTarget recognizes one-off agent run aliases', () => {
  assert.equal(_private.isAdHocRunTarget('ad-hoc'), true)
  assert.equal(_private.isAdHocRunTarget('adhoc'), true)
  assert.equal(_private.isAdHocRunTarget('agent-run'), true)
  assert.equal(_private.isAdHocRunTarget('review'), false)
})

test('orderSingleRunTransports puts Netlify API first', () => {
  const ordered = _private.orderSingleRunTransports([
    { id: 'github', title: 'GitHub Actions' },
    { id: 'netlify-api', title: 'Netlify API' },
  ])
  assert.deepEqual(ordered.map((transport) => transport.id), ['netlify-api', 'github'])
})

test('chooseNetlifyFilterOption auto-selects a single nested filter in non-TTY mode', async () => {
  const projectRoot = tmpRoot()
  const appDir = path.join(projectRoot, 'clients', 'frontend')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'netlify.toml'), [
    '[build]',
    '  command = "pnpm --filter revenue-engine-frontend build:netlify"',
    '',
  ].join('\n'))
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'docs', 'netlify.toml'), [
    '[build]',
    '  command = "npm run build"',
    '',
  ].join('\n'))
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
  try {
    assert.deepEqual(await chooseNetlifyFilterOption({ projectRoot, options: {} }), {
      filter: 'revenue-engine-frontend',
      netlifyConfig: path.join('clients', 'frontend', 'netlify.toml'),
    })
  } finally {
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
    } else {
      delete process.stdin.isTTY
    }
  }
})

test('chooseNetlifyFilterOption rejects ambiguous configs in non-TTY mode', async () => {
  const projectRoot = tmpRoot()
  for (const [dir, filter] of [['frontend', 'web'], ['docs', 'docs']]) {
    const appDir = path.join(projectRoot, 'clients', dir)
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'netlify.toml'), [
      '[build]',
      `  command = "pnpm --filter ${filter} build"`,
      '',
    ].join('\n'))
  }
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
  try {
    await assert.rejects(
      chooseNetlifyFilterOption({
        projectRoot,
        options: {},
        detectWorkspace: async () => ({ isWorkspace: true, workspace: { packages: [] }, packageManager: { name: 'pnpm' }, error: '' }),
      }),
      /Multiple netlify\.toml files were found/,
    )
  } finally {
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
    } else {
      delete process.stdin.isTTY
    }
  }
})

test('sortNetlifyConfigChoices puts configs with inferred filters first', () => {
  assert.deepEqual(sortNetlifyConfigChoices([
    { source: '_misc/netlify.toml', filter: '' },
    { source: 'clients/frontend/netlify.toml', filter: 'revenue-engine-frontend' },
  ]), [
    { source: 'clients/frontend/netlify.toml', filter: 'revenue-engine-frontend' },
    { source: '_misc/netlify.toml', filter: '' },
  ])
})

test('sortNetlifyConfigChoices prefers the config closest to the invocation directory', () => {
  const projectRoot = tmpRoot()
  const frontendDir = path.join(projectRoot, 'frontend')
  const sanityDir = path.join(projectRoot, 'sanity')
  const legacyDir = path.join(projectRoot, 'sanity-legacy')
  assert.deepEqual(sortNetlifyConfigChoices([
    { source: 'sanity/netlify.toml', configDir: sanityDir, filter: '' },
    { source: 'frontend/netlify.toml', configDir: frontendDir, filter: '' },
    { source: 'sanity-legacy/netlify.toml', configDir: legacyDir, filter: '' },
  ], {
    projectRoot,
    invocationDir: legacyDir,
  }).map((candidate) => candidate.source), [
    'sanity-legacy/netlify.toml',
    'frontend/netlify.toml',
    'sanity/netlify.toml',
  ])
})

test('resolveProjectRoot finds the git root when invoked from a subdirectory', () => {
  const projectRoot = tmpRoot()
  const childDir = path.join(projectRoot, 'frontend')
  fs.mkdirSync(childDir, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: projectRoot })

  assert.equal(resolveProjectRoot('', { cwd: childDir }), fs.realpathSync(projectRoot))
  assert.equal(resolveProjectRoot(childDir, { cwd: projectRoot }), childDir)
})

test('netlifyConfigChoiceHint explains non-workspace configs without asking for filters', () => {
  assert.equal(
    netlifyConfigChoiceHint({ source: 'frontend/netlify.toml', filter: '', siteId: '', stateSource: '' }, { isWorkspace: false }),
    'config frontend/netlify.toml',
  )
})

test('netlifyProjectChoiceLabel prefers linked site ids and otherwise shows directory', () => {
  assert.equal(
    netlifyProjectChoiceLabel({ dir: 'frontend', siteId: '1963fff0-bb0c-4f91-8601-f7acd91cd76e' }),
    'frontend (1963fff0-bb0c-4f91-8601-f7acd91cd76e)',
  )
  assert.equal(netlifyProjectChoiceLabel({ dir: 'sanity', siteId: '' }), 'sanity')
})

test('success box keeps non-TTY links on one line', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  const lines = []
  const longUrl = 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a0e1ce1f8fc93c4132a27de?session=6a0e1ce1f8fc93c4132a27e0'
  console.log = (line = '') => lines.push(String(line))
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 })
  try {
    _private.printSuccessBox({
      flow: { title: 'Do Next' },
      transport: 'netlify-api',
      projectRoot: process.cwd(),
      runState: {
        steps: [
          {
            id: 'synthesize',
            title: 'Synthesize Next Task',
            status: 'completed',
            runs: [
              {
                agent: 'codex',
                status: 'completed',
                runnerId: '6a0e1ce1f8fc93c4132a27de',
                sessionId: '6a0e1ce1f8fc93c4132a27e0',
                links: { sessionUrl: longUrl },
              },
            ],
          },
        ],
      },
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns)
    } else {
      delete process.stdout.columns
    }
  }

  const output = lines.join('\n')
  assert.match(output, /Final agent run:/)
  assert.ok(output.includes(longUrl))
})

test('localRetryCandidates finds failed local runs by step and agent', () => {
  const runState = {
    steps: [
      {
        id: 'ideate',
        runs: [{ agent: 'claude', runnerId: 'runner-1', status: 'completed', resultText: 'done' }],
      },
      {
        id: 'react',
        runs: [
          { agent: 'claude', runnerId: 'runner-2', status: 'failed', resultText: 'argument list too long' },
          { agent: 'gemini', runnerId: 'runner-3', status: 'completed', resultText: 'done' },
        ],
      },
    ],
  }

  const candidates = localRetryCandidates(runState, { stepId: 'react', agent: 'claude' })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].step.id, 'react')
  assert.equal(candidates[0].run.runnerId, 'runner-2')
  assert.equal(candidates[0].runIndex, 0)
})

test('firstRunnableStepIndex finds incomplete saved local step', () => {
  const flow = {
    steps: [
      { id: 'review' },
      { id: 'cross-review' },
      { id: 'synthesize' },
    ],
  }
  const runState = {
    steps: [
      { id: 'review', status: 'completed' },
      { id: 'cross-review', status: 'running' },
    ],
  }

  assert.equal(_private.firstRunnableStepIndex(flow, runState), 1)
})

test('findGithubRunnerFailures extracts failed Netlify status comments', () => {
  const failures = _private.findGithubRunnerFailures([
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      issueUrl: 'https://github.com/example/repo/issues/91',
      comments: [
        {
          url: 'https://github.com/example/repo/issues/91#issuecomment-1',
          body: [
            '### [Netlify Agent Run Status](https://app.netlify.com/projects/example/agent-runs/abc) ❌',
            '',
            'Netlify Agent Run failed.',
            '',
            '**Failure summary:** Agent timed out before completion',
            '',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
      ],
    },
    {
      issueNumber: 92,
      issueTitle: '2026-05-14 Gemini Generate Ideas',
      issueUrl: 'https://github.com/example/repo/issues/92',
      comments: [
        {
          url: 'https://github.com/example/repo/issues/92#issuecomment-1',
          body: [
            '### [Netlify Agent Run Status](https://app.netlify.com/projects/example/agent-runs/def) ✅',
            '',
            'Netlify Agent Run completed.',
            '',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
      ],
    },
  ])

  assert.deepEqual(failures, [
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      url: 'https://github.com/example/repo/issues/91#issuecomment-1',
      summary: 'Agent timed out before completion',
    },
  ])
})

test('resultsScopedToGithubRuns only counts result comments after the submitted prompt comment', () => {
  const scoped = _private.resultsScopedToGithubRuns([
    {
      issueNumber: 91,
      replies: [],
      comments: [
        { url: 'https://x/issues/91#old', body: 'old result\n<!-- netlify-agent-run-result:old:session -->' },
        { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score\n<!-- netlify-workflow-prompt:cross-score:claude:2026-05-14 -->' },
        { url: 'https://x/issues/91#status', body: '### status\n<!-- netlify-agent-run-status -->' },
        { url: 'https://x/issues/91#new', body: 'new result\n<!-- netlify-agent-run-result:new:session -->' },
      ],
    },
  ], [
    { issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' },
  ])

  assert.deepEqual(scoped[0].replies.map((comment) => comment.url), ['https://x/issues/91#new'])
})

test('GitHub result comments marked failed are failures, not completed replies', () => {
  const result = {
    issueNumber: 91,
    issueTitle: '2026-05-14 Claude Generate Ideas',
    comments: [
      { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score' },
      {
        url: 'https://x/issues/91#failed-result',
        body: [
          '### [Run #2 | claude | Agent Run failed](https://app.netlify.com/projects/site/agent-runs/runner) ❌',
          '',
          '**Error excerpt:**',
          '',
          '```text',
          'Encountered a temporary issue — the agent will attempt to continue.',
          '```',
          '',
          '<!-- netlify-agent-run-result:runner:session -->',
        ].join('\n'),
      },
    ],
  }
  const runs = [{ issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' }]

  assert.deepEqual(_private.resultsScopedToGithubRuns([result], runs)[0].replies, [])
  assert.deepEqual(_private.findGithubRunnerFailures([result], runs), [
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      url: 'https://x/issues/91#failed-result',
      summary: 'Agent run failed',
    },
  ])
})

test('findGithubRunnerFailures ignores old failures before the submitted prompt comment', () => {
  const failures = _private.findGithubRunnerFailures([
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      comments: [
        {
          url: 'https://x/issues/91#old-failure',
          body: [
            'Netlify Agent Run failed.',
            '**Failure summary:** old timeout',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
        { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score' },
      ],
    },
  ], [
    { issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' },
  ])

  assert.deepEqual(failures, [])
})

test('githubActionTriggerTextMetrics measures the environment string that GitHub Actions must launch', () => {
  const metrics = githubActionTriggerTextMetrics('x'.repeat(134626))
  assert.equal(metrics.bodyChars, 134626)
  assert.equal(metrics.bodyBytes, 134626)
  assert.equal(metrics.envBytes, 134639)
})

test('enforceGithubActionPromptBudget rejects prompts that would exceed the GitHub Actions env string limit', () => {
  const plan = {
    issues: [{
      model: 'claude',
      promptName: 'react',
      issueTitle: '2026-06-03 Claude Generate Ideas',
      body: 'x'.repeat(134626),
    }],
  }

  assert.throws(
    () => enforceGithubActionPromptBudget(plan),
    /Prompt too large for GitHub Actions Agent Runner[\s\S]*Estimated TRIGGER_TEXT= env string: 134,639 bytes[\s\S]*Argument list too long/,
  )
})

test('shouldPollGithubRun repairs timed out GitHub runs without saved result text', () => {
  assert.equal(shouldPollGithubRun({ issueNumber: 97, status: 'timeout', resultText: '' }), true)
  assert.equal(shouldPollGithubRun({ issueNumber: 97, status: 'timeout', resultText: 'saved result' }), false)
  assert.equal(shouldPollGithubRun({ issueNumber: 97, status: 'completed', resultText: 'saved result' }), false)
  assert.equal(shouldPollGithubRun({ issueNumber: 97, status: 'failed', resultText: '' }), false)
})

test('githubStepStatus derives completion from completed runs even when saved step status is stale', () => {
  assert.equal(_private.githubStepStatus({
    status: 'running',
    runs: [
      { agent: 'claude', status: 'completed', resultText: 'claude result' },
      { agent: 'gemini', status: 'completed', resultText: 'gemini result' },
      { agent: 'codex', status: 'completed', resultText: 'codex result' },
    ],
  }), 'completed')
})

test('resumeStepDecorations marks completed, resume, and pending steps for resume previews', () => {
  const decorations = resumeStepDecorations({
    steps: [
      { id: 'ideate' },
      { id: 'cross-score' },
      { id: 'react' },
      { id: 'synthesize' },
    ],
    runState: {
      steps: [
        { id: 'ideate', status: 'completed', runs: [] },
        {
          id: 'cross-score',
          status: 'running',
          runs: [
            { status: 'completed', resultText: 'claude' },
            { status: 'completed', resultText: 'gemini' },
            { status: 'completed', resultText: 'codex' },
          ],
        },
        { id: 'react', status: 'running', runs: [{ status: 'submitted' }] },
      ],
    },
  })

  assert.deepEqual([...decorations].map(([id, decoration]) => [id, decoration.label]), [
    ['ideate', 'completed'],
    ['cross-score', 'completed'],
    ['react', 'resume here'],
    ['synthesize', 'pending'],
  ])
})

test('savedAgentStatus drives resume model chip success and error colors', () => {
  const savedStep = {
    status: 'running',
    runs: [
      { agent: 'claude', status: 'completed' },
      { agent: 'gemini', status: 'failed' },
      { agent: 'codex', status: 'timeout' },
    ],
  }

  assert.equal(resumeStatusColor(savedAgentStatus(savedStep, 'claude')), '#22c55e')
  assert.equal(resumeStatusColor(savedAgentStatus(savedStep, 'gemini')), '#ef4444')
  assert.equal(resumeStatusColor(savedAgentStatus(savedStep, 'codex')), '#ef4444')
  assert.equal(resumeStatusColor(savedAgentStatus(savedStep, 'unknown')), '')
  assert.equal(resumeStatusColor(savedAgentStatus({ status: 'completed', runs: [] }, 'claude')), '#22c55e')
})

test('stepResultsSummaryPath returns existing finished step summary path for resume previews', () => {
  const projectRoot = tmpRoot()
  const savedStep = { id: 'cross-score', title: 'Cross Score Ideas', status: 'completed', runs: [] }
  const runState = {
    projectRoot,
    dir: path.join(projectRoot, '.nax', 'workflows', '2026-06-04T01-03-58-737Z-ideas'),
    steps: [
      { id: 'ideate', title: 'Generate Ideas', status: 'completed', runs: [] },
      savedStep,
    ],
  }
  const summaryPath = path.join(runState.dir, 'artifacts', 'steps', '02-cross-score', 'summary.md')
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.writeFileSync(summaryPath, '# Cross Score Ideas\n')

  assert.equal(
    stepResultsSummaryPath({ runState, savedStep, projectRoot }),
    './.nax/workflows/2026-06-04T01-03-58-737Z-ideas/artifacts/steps/02-cross-score/summary.md',
  )
  assert.equal(
    stepResultsSummaryPath({
      runState,
      savedStep: { id: 'react', title: 'React To Scores', status: 'running', runs: [] },
      projectRoot,
    }),
    '',
  )
})

test('formatDetailedRelativeTime includes two useful time units', () => {
  const now = new Date('2026-06-04T12:00:00').getTime()
  assert.equal(
    formatDetailedRelativeTime('2026-06-02T06:30:00', now),
    '2 days and 5 hours ago',
  )
  assert.equal(
    formatDetailedRelativeTime('2026-06-04T12:00:30', now),
    'in 30 seconds',
  )
})

test('formatResumeRunDetails shows timestamps and artifact summary path', () => {
  const projectRoot = tmpRoot()
  const runState = {
    projectRoot,
    runId: '2026-06-04T01-03-58-737Z-ideas',
    flowId: 'ideas',
    flowTitle: 'Ideas',
    transport: 'github',
    createdAt: '2026-06-02T06:30:00',
    updatedAt: '2026-06-02T07:45:00',
    steps: [
      { id: 'ideate', title: 'Generate Ideas', status: 'completed' },
      { id: 'cross-score', title: 'Cross Score Ideas', status: 'running' },
    ],
    dir: path.join(projectRoot, '.nax', 'workflows', '2026-06-04T01-03-58-737Z-ideas'),
  }
  const summaryPath = path.join(runState.dir, 'artifacts', 'summary.md')
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.writeFileSync(summaryPath, '# Ideas\n')

  const lines = formatResumeRunDetails(runState, {
    projectRoot,
    now: new Date('2026-06-04T12:00:00').getTime(),
  })

  assert.equal(resumeRunDetailsTitle(runState), 'Unfinished "Ideas" workflow run found')
  assert.equal(resumeLastStepTitle(runState), 'Cross Score Ideas')
  assert.equal(lines[0], 'Last Step: Cross Score Ideas')
  assert.equal(lines[1], 'Run ID: 2026-06-04T01-03-58-737Z-ideas')
  assert.equal(lines[2], 'Transport: github')
  assert.match(lines[3], /^Started: .+ \(2 days and 5 hours ago\)$/)
  assert.match(lines[4], /^Updated: .+ \(2 days and 4 hours ago\)$/)
  assert.equal(lines[5], 'State: .nax/workflows/2026-06-04T01-03-58-737Z-ideas/workflow.json')
  assert.equal(lines[6], 'Summary: ./.nax/workflows/2026-06-04T01-03-58-737Z-ideas/artifacts/summary.md')
})

test('findLatestResumableRun skips stale unfinished runs with unavailable flows', async () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'stale-review-cycle', {
    flowId: 'review-cycle',
    flowTitle: 'Review Cycle',
    status: undefined,
    createdAt: '2026-06-04T12:00:00',
    updatedAt: '2026-06-04T12:00:00',
    steps: [{ id: 'review', title: 'Review', status: 'running', runs: [] }],
  })
  const validFlow = {
    id: 'ideas',
    title: 'Ideas',
    description: 'Generate ideas.',
    defaults: { agents: ['codex'] },
    steps: [{ id: 'ideate', title: 'Generate Ideas', agents: ['codex'] }],
  }
  writeRunState(projectRoot, 'valid-ideas', {
    flowId: 'ideas',
    flowTitle: 'Ideas',
    flow: validFlow,
    status: undefined,
    createdAt: '2026-06-04T11:00:00',
    updatedAt: '2026-06-04T11:00:00',
    steps: [{ id: 'ideate', title: 'Generate Ideas', status: 'running', runs: [] }],
  })

  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => warnings.push(message)
  try {
    const resumable = await findLatestResumableRun({
      projectRoot,
      now: new Date('2026-06-04T12:30:00').getTime(),
    })
    assert.equal(resumable.runState.runId, 'valid-ideas')
    assert.equal(resumable.flow.title, 'Ideas')
  } finally {
    console.warn = originalWarn
  }

  const stale = JSON.parse(fs.readFileSync(path.join(projectRoot, '.nax', 'workflows', 'stale-review-cycle', 'workflow.json'), 'utf8'))
  assert.equal(stale.status, 'dismissed')
  assert.equal(stale.dismissReason, 'flow-unavailable')
  assert.match(warnings[0], /Skipped stale unfinished run stale-review-cycle/)
})

test('findLatestResumableRun ignores old unfinished runs that are not the latest workflow', async () => {
  const projectRoot = tmpRoot()
  writeRunState(projectRoot, 'newer-completed', {
    flowId: 'review',
    flowTitle: 'Review',
    status: 'completed',
    createdAt: '2026-06-04T12:00:00',
    updatedAt: '2026-06-04T12:00:00',
  })
  const oldFlow = {
    id: 'ideas',
    title: 'Ideas',
    defaults: { agents: ['codex'] },
    steps: [{ id: 'ideate', title: 'Generate Ideas', agents: ['codex'] }],
  }
  writeRunState(projectRoot, 'old-ideas', {
    flowId: 'ideas',
    flowTitle: 'Ideas',
    flow: oldFlow,
    status: undefined,
    createdAt: '2026-06-02T11:00:00',
    updatedAt: '2026-06-02T11:00:00',
    steps: [{ id: 'ideate', title: 'Generate Ideas', status: 'running', runs: [] }],
  })

  const resumable = await findLatestResumableRun({
    projectRoot,
    now: new Date('2026-06-04T12:00:00').getTime(),
  })
  assert.equal(resumable, null)

  const old = JSON.parse(fs.readFileSync(path.join(projectRoot, '.nax', 'workflows', 'old-ideas', 'workflow.json'), 'utf8'))
  assert.equal(old.status, undefined)
})

test('isAutomaticResumeCandidate accepts the latest workflow even when older than 24 hours', () => {
  const runState = {
    runId: 'old-latest',
    updatedAt: '2026-06-01T12:00:00',
    steps: [{ id: 'ideate', status: 'running', runs: [] }],
  }
  assert.equal(isAutomaticResumeCandidate(runState, {
    allStates: [runState],
    now: new Date('2026-06-04T12:00:00').getTime(),
  }), true)
})

test('waitForGithubStep does a final GitHub reconciliation before timing out', async () => {
  const promptUrl = 'https://x/issues/97#prompt'
  const resultUrl = 'https://x/issues/97#result'
  const issue = {
    number: 97,
    title: '2026-05-17 Codex Review',
    url: 'https://x/issues/97',
    comments: [
      { url: promptUrl, body: '@netlify codex review\n<!-- netlify-workflow-prompt:review:codex:2026-05-17 -->' },
      { url: resultUrl, body: 'codex result body\n<!-- netlify-agent-run-result:runner-97:session-97 -->' },
    ],
  }
  const terminalResults = []
  const results = await _private.waitForGithubStep({
    repo: 'example/repo',
    issueNumbers: [97],
    runs: [{ issueNumber: 97, commentUrl: promptUrl, agent: 'codex' }],
    step: { id: 'review', title: 'Review', agents: ['codex'] },
    timeoutMinutes: 0,
    pollMs: 1,
    loader: () => issue,
    onRunResult(event) {
      terminalResults.push(event)
    },
  })

  assert.equal(terminalResults.length, 1)
  assert.equal(terminalResults[0].status, 'completed')
  assert.equal(results.length, 1)
  assert.equal(results[0].replies[0].url, resultUrl)
})

test('waitForGithubStep retries transient loader errors and still completes', async () => {
  const promptUrl = 'https://x/issues/97#prompt'
  const resultUrl = 'https://x/issues/97#result'
  const issue = {
    number: 97,
    title: '2026-05-17 Codex Review',
    url: 'https://x/issues/97',
    comments: [
      { url: promptUrl, body: '@netlify codex review\n<!-- netlify-workflow-prompt:review:codex:2026-05-17 -->' },
      { url: resultUrl, body: 'codex result body\n<!-- netlify-agent-run-result:runner-97:session-97 -->' },
    ],
  }
  let calls = 0
  const terminalResults = []
  const loader = () => {
    calls += 1
    if (calls === 1) {
      throw new Error('HTTP 401: Bad credentials (https://api.github.com/graphql)')
    }
    return issue
  }

  const results = await _private.waitForGithubStep({
    repo: 'example/repo',
    issueNumbers: [97],
    runs: [{ issueNumber: 97, commentUrl: promptUrl, agent: 'codex' }],
    step: { id: 'review', title: 'Review', agents: ['codex'] },
    timeoutMinutes: 1,
    pollMs: 5,
    loader,
    onRunResult(event) {
      terminalResults.push(event)
    },
  })

  assert.equal(calls, 2)
  assert.equal(terminalResults.length, 1)
  assert.equal(terminalResults[0].status, 'completed')
  assert.equal(terminalResults[0].reply.url, resultUrl)
  assert.equal(results.length, 1)
  assert.equal(results[0].issueNumber, 97)
  assert.equal(results[0].replies.length, 1)
  assert.equal(results[0].replies[0].url, resultUrl)
})

test('waitForGithubStep waits for remaining runs after one agent fails', async () => {
  const claudePromptUrl = 'https://x/issues/23#prompt'
  const geminiPromptUrl = 'https://x/issues/24#prompt'
  const codexPromptUrl = 'https://x/issues/25#prompt'
  const claudeFailureUrl = 'https://x/issues/23#failure'
  const geminiResultUrl = 'https://x/issues/24#result'
  const codexResultUrl = 'https://x/issues/25#result'
  let calls = 0
  const issueFor = (issueNumber) => {
    if (issueNumber === 23) {
      return {
        number: 23,
        title: '2026-06-03 Claude Generate Ideas',
        url: 'https://x/issues/23',
        comments: [
          { url: claudePromptUrl, body: '@netlify claude react\n<!-- netlify-workflow-prompt:react:claude:2026-06-03 -->' },
          { url: claudeFailureUrl, body: '### Agent Run failed\n\nfork/exec /opt/build-bin/agent-runner: argument list too long\n<!-- netlify-agent-run-result:runner-23:session-23 -->' },
        ],
      }
    }
    if (issueNumber === 24) {
      return {
        number: 24,
        title: '2026-06-03 Gemini Generate Ideas',
        url: 'https://x/issues/24',
        comments: [
          { url: geminiPromptUrl, body: '@netlify gemini react\n<!-- netlify-workflow-prompt:react:gemini:2026-06-03 -->' },
          ...(calls > 1 ? [{ url: geminiResultUrl, body: 'gemini done\n<!-- netlify-agent-run-result:runner-24:session-24 -->' }] : []),
        ],
      }
    }
    return {
      number: 25,
      title: '2026-06-03 Codex Generate Ideas',
      url: 'https://x/issues/25',
      comments: [
        { url: codexPromptUrl, body: '@netlify codex react\n<!-- netlify-workflow-prompt:react:codex:2026-06-03 -->' },
        ...(calls > 1 ? [{ url: codexResultUrl, body: 'codex done\n<!-- netlify-agent-run-result:runner-25:session-25 -->' }] : []),
      ],
    }
  }
  const runs = [
    { issueNumber: 23, commentUrl: claudePromptUrl, agent: 'claude' },
    { issueNumber: 24, commentUrl: geminiPromptUrl, agent: 'gemini' },
    { issueNumber: 25, commentUrl: codexPromptUrl, agent: 'codex' },
  ]
  const terminalResults = []

  await assert.rejects(
    _private.waitForGithubStep({
      repo: 'example/repo',
      issueNumbers: [23, 24, 25],
      runs,
      step: { id: 'react', title: 'React To Scores', agents: ['claude', 'gemini', 'codex'] },
      timeoutMinutes: 1,
      pollMs: 1,
      loader: ({ issueNumber }) => {
        if (issueNumber === 23) calls += 1
        return issueFor(issueNumber)
      },
      onRunResult(event) {
        terminalResults.push(event)
      },
    }),
    /Step "react" has failed agent runs[\s\S]*#23 2026-06-03 Claude Generate Ideas/,
  )

  assert.equal(calls, 2)
  assert.deepEqual(terminalResults.map((event) => `${event.run.agent}:${event.status}`).sort(), [
    'claude:failed',
    'codex:completed',
    'gemini:completed',
  ])
})

test('waitForGithubStep reports already saved failed runs after remaining runs complete', async () => {
  const claudeFailureUrl = 'https://x/issues/23#failure'
  const geminiPromptUrl = 'https://x/issues/24#prompt'
  const codexPromptUrl = 'https://x/issues/25#prompt'
  const geminiResultUrl = 'https://x/issues/24#result'
  const codexResultUrl = 'https://x/issues/25#result'
  const runs = [
    {
      issueNumber: 23,
      commentUrl: claudeFailureUrl,
      agent: 'claude',
      status: 'failed',
      resultText: 'fork/exec /opt/build-bin/agent-runner: argument list too long',
    },
    { issueNumber: 24, commentUrl: geminiPromptUrl, agent: 'gemini' },
    { issueNumber: 25, commentUrl: codexPromptUrl, agent: 'codex' },
  ]

  await assert.rejects(
    _private.waitForGithubStep({
      repo: 'example/repo',
      issueNumbers: [23, 24, 25],
      runs,
      step: { id: 'react', title: 'React To Scores', agents: ['claude', 'gemini', 'codex'] },
      timeoutMinutes: 1,
      pollMs: 1,
      loader: ({ issueNumber }) => {
        if (issueNumber === 23) {
          return {
            number: 23,
            title: '2026-06-03 Claude Generate Ideas',
            url: 'https://x/issues/23',
            comments: [{ url: claudeFailureUrl, body: '### Agent Run failed\n<!-- netlify-agent-run-result:runner-23:session-23 -->' }],
          }
        }
        if (issueNumber === 24) {
          return {
            number: 24,
            title: '2026-06-03 Gemini Generate Ideas',
            url: 'https://x/issues/24',
            comments: [
              { url: geminiPromptUrl, body: '@netlify gemini react\n<!-- netlify-workflow-prompt:react:gemini:2026-06-03 -->' },
              { url: geminiResultUrl, body: 'gemini done\n<!-- netlify-agent-run-result:runner-24:session-24 -->' },
            ],
          }
        }
        return {
          number: 25,
          title: '2026-06-03 Codex Generate Ideas',
          url: 'https://x/issues/25',
          comments: [
            { url: codexPromptUrl, body: '@netlify codex react\n<!-- netlify-workflow-prompt:react:codex:2026-06-03 -->' },
            { url: codexResultUrl, body: 'codex done\n<!-- netlify-agent-run-result:runner-25:session-25 -->' },
          ],
        }
      },
    }),
    /#23 2026-06-03 Claude Generate Ideas[\s\S]*argument list too long/,
  )
})

test('waitForGithubStep aborts after maxConsecutiveFailures poll errors', async () => {
  const loader = () => {
    throw new Error('HTTP 500: gateway')
  }
  await assert.rejects(
    _private.waitForGithubStep({
      repo: 'example/repo',
      issueNumbers: [42],
      runs: [{ issueNumber: 42, commentUrl: 'https://x/issues/42#prompt', agent: 'claude' }],
      step: { id: 'review', title: 'Review', agents: ['claude'] },
      timeoutMinutes: 1,
      pollMs: 1,
      loader,
      maxConsecutiveFailures: 3,
    }),
    /aborted after 3 consecutive poll failures/,
  )
})

test('waitForGithubStep surfaces failed GitHub Actions runs before status comments are posted', async () => {
  const promptUrl = 'https://github.com/example/repo/issues/97#issuecomment-prompt'
  const promptBody = 'x'.repeat(134626)
  const issue = {
    number: 97,
    title: '2026-06-03 Claude Generate Ideas',
    url: 'https://github.com/example/repo/issues/97',
    comments: [
      {
        url: promptUrl,
        createdAt: '2026-06-04T03:12:56Z',
        body: `${promptBody}\n<!-- netlify-workflow-prompt:react:claude:2026-06-03 -->`,
      },
    ],
  }
  const run = {
    issueNumber: 97,
    commentUrl: promptUrl,
    agent: 'claude',
    promptText: promptBody,
  }
  const terminalResults = []

  await assert.rejects(
    _private.waitForGithubStep({
      repo: 'example/repo',
      issueNumbers: [97],
      runs: [run],
      step: { id: 'react', title: 'React To Scores', agents: ['claude'] },
      timeoutMinutes: 1,
      pollMs: 1,
      loader: () => issue,
      actionRunFailureGraceMs: 0,
      actionRunLoader: () => [{
        databaseId: 26928003297,
        displayTitle: '2026-06-03 Claude Generate Ideas',
        createdAt: '2026-06-04T03:12:59Z',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://github.com/example/repo/actions/runs/26928003297',
      }],
      actionRunLogLoader: () => "An error occurred trying to start process '/node' with working directory '/repo'. Argument list too long",
      onRunResult(event) {
        terminalResults.push(event)
      },
    }),
    /failed agent runs[\s\S]*GitHub Action failed before the Netlify Agent Runner could post status comments[\s\S]*argument list too long/,
  )

  assert.equal(terminalResults.length, 1)
  assert.equal(terminalResults[0].status, 'failed')
  assert.equal(run.status, 'failed')
  assert.equal(run.failureKind, 'github-action-launch-failed')
  assert.equal(run.failureReason, 'argument-list-too-long')
  assert.equal(run.actionRunUrl, 'https://github.com/example/repo/actions/runs/26928003297')
  assert.equal(run.promptBytes, 134626)
  assert.equal(run.promptEnvBytes, 134639)
})

test('withSelectedAgents filters each workflow step and runnableSteps drops empty steps', () => {
  const flow = {
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [
      { id: 'review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'synthesize', agents: ['codex'] },
    ],
  }

  assert.deepEqual(_private.flowAgents(flow), ['claude', 'gemini', 'codex'])

  const filtered = _private.withSelectedAgents(flow, ['claude', 'gemini'])
  assert.deepEqual(filtered.steps[0].agents, ['claude', 'gemini'])
  assert.deepEqual(filtered.steps[1].agents, [])
  assert.deepEqual(_private.runnableSteps(filtered, {}).map((step) => step.id), ['review'])
})

test('withSelectedStepModels applies step-specific agent overrides', () => {
  const flow = {
    id: 'review',
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [
      { id: 'review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'summarize', agents: ['codex'] },
    ],
  }

  const configured = _private.withSelectedStepModels(flow, {
    models: 'claude',
    stepModels: ['review=gemini,codex', 'summarize='],
  })

  assert.deepEqual(configured.stepModels, {
    review: ['gemini', 'codex'],
    summarize: [],
  })
  assert.deepEqual(configured.flow.steps[0].agents, ['gemini', 'codex'])
  assert.deepEqual(configured.flow.steps[1].agents, [])
  assert.deepEqual(_private.runnableSteps(configured.flow, {}).map((step) => step.id), ['review'])
})

test('workflowPickerHint uses compact bundled flow descriptions without source labels', () => {
  assert.equal(workflowPickerHint({
    id: 'performance-audit',
    source: 'bundled',
    sourceLabel: 'bundled',
    description: 'Find likely bottlenecks, measurement gaps, and safe optimization opportunities.',
  }), 'Find bottlenecks and measurement gaps')
})

test('formatFlowList renders workflows as stacked boxes', () => {
  const output = stripAnsi(formatFlowList([
    {
      id: 'local-smoke-test',
      title: 'Local Smoke Test',
      description: 'Minimal project-local workflow for verifying nax discovers project flow directories.',
      source: 'project',
      sourceLabel: 'project .github/nax-flows',
      dir: path.join('/repo', '.github', 'nax-flows', 'local-smoke-test'),
      steps: [{ agents: ['codex'] }],
    },
    {
      id: 'review',
      title: 'Review',
      description: 'Review, cross-review, and synthesize findings with multiple Netlify agents.',
      source: 'bundled',
      sourceLabel: 'bundled',
      dir: path.join('/repo', 'flows', 'review'),
      steps: [{ agents: ['claude', 'gemini', 'codex'] }],
    },
  ], { columns: 84, baseDir: '/repo' }))

  assert.match(output, /local-smoke-test/)
  assert.match(output, /Local Smoke Test/)
  assert.match(output, /project \.github\/nax-flows/)
  assert.match(output, /review/)
  assert.match(output, /Review/)
  assert.match(output, /bundled/)
  assert.doesNotMatch(output, /Steps:/)
  assert.doesNotMatch(output, /Models:/)
  assert.doesNotMatch(output, /Location:/)
  assert.equal(output.split('\n').filter((line) => line.startsWith('╭')).length, 1)
  assert.equal(output.split('\n').filter((line) => line.startsWith('╰')).length, 1)
  assert.doesNotMatch(output, /\t/)
  assert.doesNotMatch(output, /\n\n/)
  for (const line of output.split('\n')) {
    assert.ok(line.length <= 80, `line exceeded requested width: ${line}`)
  }
})

test('formatFlowList verbose output includes workflow metadata', () => {
  const output = stripAnsi(formatFlowList([
    {
      id: 'review',
      title: 'Review',
      description: 'Review, cross-review, and synthesize findings with multiple Netlify agents.',
      source: 'bundled',
      sourceLabel: 'bundled',
      dir: path.join('/repo', 'flows', 'review'),
      steps: [
        { agents: ['claude', 'gemini', 'codex'] },
        { agents: ['codex'] },
      ],
    },
  ], { columns: 100, verbose: true, baseDir: '/repo' }))

  assert.match(output, /Location:\s+\.\/flows\/review/)
  assert.match(output, /Steps:\s+2/)
  assert.match(output, /Models:\s+Claude, Gemini, Codex/)
  assert.match(output, /agents\.\s+│\n│\s+│\n│\s+Steps:/)
  assert.match(output, /Steps:\s+2\s+│\n│\s+Models:\s+Claude, Gemini, Codex\s+│\n│\s+Location:/)
})

test('formatFlowList verbose output keeps external workflow directories absolute', () => {
  const output = stripAnsi(formatFlowList([
    {
      id: 'review',
      title: 'Review',
      description: 'Review the project.',
      source: 'bundled',
      sourceLabel: 'bundled',
      dir: path.join('/usr', 'local', 'lib', 'node_modules', 'nax', 'src', 'flows', 'review'),
      steps: [{ agents: ['codex'] }],
    },
  ], { columns: 120, verbose: true, baseDir: '/repo/site' }))

  assert.match(output, /Location:\s+\/usr\/local\/lib\/node_modules\/nax\/src\/flows\/review/)
})

test('formatFlowListJson returns workflow items and metadata', () => {
  const flowDir = path.join('/repo', 'flows', 'review')
  const output = formatFlowListJson([
    {
      id: 'review',
      title: 'Review',
      description: 'Review and synthesize.',
      source: 'bundled',
      sourceLabel: 'bundled',
      sourceDir: path.join('/repo', 'flows'),
      sourcePriority: 1,
      dir: flowDir,
      file: path.join(flowDir, 'flow.yml'),
      defaults: { transport: 'auto', notify: false, agents: ['codex'] },
      options: { reviewDepth: 'deep' },
      steps: [{
        id: 'review',
        title: 'Review',
        description: 'Read the code.',
        prompt: 'prompts/1_review.md',
        action: 'issue',
        submit: 'new-run',
        agents: ['codex'],
        input: [],
        waitFor: 'agent-results',
        autoArchive: null,
        isArchivable: true,
      }],
    },
  ])
  const parsed = JSON.parse(output)

  assert.equal(parsed.count, 1)
  assert.equal(parsed.items[0].id, 'review')
  assert.equal(parsed.items[0].sourceLabel, 'bundled')
  assert.equal(parsed.items[0].sourceDir, path.join('/repo', 'flows'))
  assert.equal(parsed.items[0].dir, flowDir)
  assert.equal(parsed.items[0].file, path.join(flowDir, 'flow.yml'))
  assert.equal(parsed.items[0].defaults.agents[0], 'codex')
  assert.equal(parsed.items[0].options.reviewDepth, 'deep')
  assert.equal(parsed.items[0].steps[0].prompt, path.join(flowDir, 'prompts', '1_review.md'))
  assert.equal(parsed.items[0].steps[0].isArchivable, true)
})

test('workflowPickerLabel names project workflows in the main run menu', () => {
  assert.equal(workflowPickerLabel({
    source: 'project',
    title: 'Local Smoke Test',
  }, { includeAdHoc: true }), 'Workflow - Local Smoke Test')
})

test('workflowPickerLabel keeps bundled workflows generic in the main run menu', () => {
  assert.equal(workflowPickerLabel({
    source: 'bundled',
    title: 'Performance Audit',
  }, { includeAdHoc: true }), 'NAX Workflow - Performance Audit')
})

test('ad hoc run picker choice uses one-line no-hint wording', () => {
  assert.equal(AD_HOC_RUN_CHOICE.label, 'Start a single Netlify agent with a custom prompt')
  assert.equal(Object.hasOwn(AD_HOC_RUN_CHOICE, 'hint'), false)
})

test('workflowPickerHint compacts project flow descriptions without source prefixes', () => {
  const hint = workflowPickerHint({
    id: 'custom-audit',
    source: 'project',
    sourceLabel: 'project .github/nax-flows',
    description: 'This custom workflow has a very long description that would otherwise wrap badly in the picker.',
  })

  assert.equal(hint, 'This custom workflow has a very long description...')
  assert.equal(hint.includes('project'), false)
})

test('contextWithOutputBudget does not append chained-output guidance by default', () => {
  const context = _private.contextWithOutputBudget('Base context', {}, { hasFutureSteps: true })

  assert.equal(context, 'Base context')
})

test('contextWithOutputBudget appends opt-in chained-output guidance', () => {
  const context = _private.contextWithOutputBudget('Base context', { outputBudget: true }, { hasFutureSteps: true })

  assert.match(context, /Base context/)
  assert.match(context, /## Output Budget/)
  assert.match(context, /64,000 bytes/)
  assert.match(context, /reused as input to later workflow steps/)
  assert.match(context, /Omit:/)
})

test('contextWithOutputBudget is configurable and can be disabled', () => {
  const tuned = _private.contextWithOutputBudget('', { outputBudgetBytes: '8000' }, { hasPriorResults: true })
  assert.match(tuned, /8,000 bytes/)

  const disabled = _private.contextWithOutputBudget('Base context', { outputBudget: false }, { hasFutureSteps: true })
  assert.equal(disabled, 'Base context')

  const notChained = _private.contextWithOutputBudget('Base context', {}, {})
  assert.equal(notChained, 'Base context')
})
