#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { makeBox, makeHorizontalBoxes } = require('@davidwells/box-logger')
const { buildNaxProgram } = require('../src/commands/nax')
const {
  actionOptions,
  collectOption,
  mergeCommandOptions,
} = require('../src/commands/options')
const { DEFAULT_MODELS } = require('../src/constants')
const {
  buildIssueBody,
  buildIssueTitle,
  getLocalDate,
  listPrompts,
  loadPrompt,
  resolveRepo,
  titleCase,
} = require('../src/prompts')
const { buildAutomaticContext, resolveRemoteBranchSha } = require('../src/review-context')
const { legacyTargetFromRunState, resolveTarget, targetBranch, targetSummary } = require('../src/target')
const {
  chooseNetlifyFilterOption,
  configDirForNetlifyOptions,
  formatNetlifyConfigAmbiguity,
  maybeReportNetlifyFilter,
  maybeReportNetlifySite,
  netlifyConfigChoiceHint,
  netlifyOptionsFromTarget,
  netlifyProjectChoiceLabel,
  resolveProjectRoot,
  sortNetlifyConfigChoices,
} = require('../src/netlify/project-selection')
const {
  assertCrossReviewComplete,
  extractStructuredSection,
  fetchRoundResults,
  formatRoundResults,
  rawIssuesFromResults,
} = require('../src/round-results')
const { formatGroupHint, listRecentIssueGroups } = require('../src/issue-groups')
const { bodyHasRunnerResultMarker, bodyHasRunnerStatusMarker, parseRunnerResultMarker } = require('../src/comment-markers')
const {
  formatAgentRunUrl,
  formatAgentRunUrlFromAdminUrl,
  formatUsageSummary,
  netlifyAgentRunUrlFromBody,
  normalizeGithubRunResult,
  usageSummariesForRunState,
} = require('../src/agent-run-results')
const { runGh } = require('../src/gh-cli')
const { multiline } = require('../src/utils/multiline')
const { WAIT_FOR_AGENT_RESULTS, isHumanReviewStep, listFlows, loadFlow, loadStepPrompt } = requireWithoutArgvFlag('--verbose', () => require('../src/flows'))
const { createRunState, dismissRunState, isUnfinishedRun, listRunStates, saveRunState, workflowStatePath } = require('../src/run-state')
const { AWAITING_REVIEW, approveHumanReviewGate, createHumanReviewStepState } = require('../src/human-review')
const {
  artifactsRootForRunState,
  persistRunArtifact,
  persistStepArtifacts,
  persistWorkflowArtifacts,
  safeArtifactName,
  stepArtifactsDir,
  writeGithubStepSummary,
} = require('../src/workflow-artifacts')
const { clearTrackedRunState, trackRunState } = require('../src/graceful-run-state')
const { persistAgentRunnerArtifact } = require('../src/agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('../src/agent-session-artifacts')
const { listHandoffSources, readHandoffSource, relativeDisplayPath } = require('../src/handoff-sources')
const { handleCi } = require('../src/cli/ci')
const {
  AD_HOC_RUN_CHOICE,
  formatFlowList,
  formatFlowListBox,
  formatFlowListJson,
  workflowPickerHint,
  workflowPickerLabel,
} = require('../src/cli/flow-list')
const { handleInit } = require('../src/cli/init')
const { handleSync } = require('../src/cli/sync')
const {
  PROVIDER_DIRS,
  checkSkills,
  installSkills,
  listBundledSkills,
  updateSkills,
} = require('../src/skills')
const { NETLIFY_API_TRANSPORT, detectTransports, formatTransportSetupHelp, isNetlifyApiTransport, resolveTransport } = require('../src/transports')
const { readNetlifyProject } = require('../src/init')
const { startVisualizeServer } = require('../src/visualize-server')
const { runWorkflow } = require('../src/workflow-runner')
const { createWorkflowEventContext } = require('../src/workflow-events')
const {
  AGENT_RUNNER_USE_CASES,
  DEFAULT_ORCHESTRATOR,
  DID_YOU_KNOW_BORDER_COLORS,
  agentStepCompletionSummary,
  clearRenderedProgressFrame,
  compactCurrentTask,
  conciseErrorMessage,
  formatDidYouKnowLines,
  formatTtyProgressRow,
  localRetryCandidates,
  makeProgressReporter,
  makeStepProgressReporter,
  nextLocalStepMessage,
  parseIssueNumberFromUrl,
  physicalRowCount,
  pickFlavor,
  shouldPollGithubRun,
  shouldPollLocalRun,
  startSubmissionHeartbeat,
  submissionFailureSummary,
  visibleLength,
} = require('../src/workflow/progress')
const {
  MUTED_COLOR,
  SUCCESS_COLOR,
  TEAL_COLOR,
  colorText,
  findLatestResumableRun,
  formatDetailedRelativeTime,
  formatResumeRunDetails,
  isAutomaticResumeCandidate,
  printResumeRunDetails,
  resumeLastStepTitle,
  resumeRunDetailsTitle,
  resumeStatusColor,
  resumeStepDecorations,
  savedAgentStatus,
  savedStepStatus,
  stepResultsSummaryPath,
  workflowSummaryDisplayPath,
} = require('../src/workflow/resume')
const { setBlob, deleteBlob } = require('../src/netlify-blobs')
const {
  addRunBlobRef,
  compactBlobRefs,
  cleanupRunBlobRefs,
  sweepBlobRefs,
} = require('../src/blob-ref-registry')
const { writeLocalBlobDebugPayload } = require('../src/blob-debug-cache')
const {
  blobRefForStep,
  buildBlobPayload,
  buildFetchInstruction,
  buildInlineEssentials,
  classifyContextFetch,
  compactTextByBytes,
  safePromptBytes,
} = require('../src/prompt-offload')
const {
  applyAgentSelection,
  assertValidAgentSelection,
  parseStepModelsEntries,
} = require('../src/agent-selection')
const {
  archiveAgentRun,
  buildNetlifyEnv,
  currentGitBranch,
  stopAgentRun,
  resolveNetlifyFilter,
  resolveNetlifyProjectTarget,
  submitLocalAgentRun,
  waitForLocalAgentRuns,
} = require('../src/local-runner')
const {
  BODY_FALLBACK_THRESHOLD,
  GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX,
  enforceGithubActionPromptBudget,
  formatGithubActionPromptBudgetError,
  githubActionPromptBudgetLabel,
  githubActionPromptBudgetViolations,
  githubActionPromptBudgetWarnings,
  githubActionTriggerTextMetrics,
  githubSafePromptBytes: githubSafePromptBytesWithLocalBudget,
  utf8ByteLength,
} = require('../src/github/prompt-budget')
const {
  ROUND_LABEL_BY_PROMPT,
  buildCommentPlan,
  buildPlan,
  createComment,
  createDiscussionComment,
  createIssue,
  createPullRequestComment,
  extractLinkedPullRequest,
  fetchRoundResultsForOptions,
  githubResultsToSourceRuns,
  inferModelFromIssueTitle,
  joinContext,
  loadIssueMeta,
  loadPullRequestMeta,
  parseCsv,
  parseGitHubPullRequestUrl,
  printCommentPlan,
  printPlan,
  readAutoContext,
  readContext,
  readManualContext,
  resolveCommentTarget,
  shouldEmbedAllReplies,
  shouldFetchResults,
} = require('../src/github/issue-plan')

function requireWithoutArgvFlag(flag, load) {
  if (!process.argv.includes(flag)) return load()
  const originalArgv = process.argv
  process.argv = process.argv.filter((arg) => arg !== flag)
  try {
    return load()
  } finally {
    process.argv = originalArgv
  }
}

const DEFAULT_OUTPUT_BUDGET_BYTES = 64000
const COMPACT_LOCAL_RESULT_CHAR_LIMIT = 6000
const COMPACT_LOCAL_RESULTS_TOTAL_LIMIT = 36000
const COMPACT_LOCAL_CONTEXT_CHAR_LIMIT = 12000
const DEFAULT_LOCAL_SAFE_PROMPT_BYTES = 16384
const AD_HOC_RUN_TARGET = '__ad_hoc_agent_run__'

/**
 * @typedef {import('../src/commands/options').CliOptions} CliOptions
 */

let clackModulePromise
async function loadClack() {
  clackModulePromise = clackModulePromise || import('@clack/prompts')
  return clackModulePromise
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function outputBudgetEnabled(options = {}) {
  if (options.outputBudget === true) return true
  if (options.outputBudget === false) return false
  const raw = String(process.env.NAX_OUTPUT_BUDGET || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  if (options.outputBudgetBytes || process.env.NAX_OUTPUT_BUDGET_BYTES) return true
  return false
}

function outputBudgetBytes(options = {}) {
  return parsePositiveInteger(
    options.outputBudgetBytes || process.env.NAX_OUTPUT_BUDGET_BYTES,
    DEFAULT_OUTPUT_BUDGET_BYTES,
  )
}

function buildOutputBudgetContext({ bytes = DEFAULT_OUTPUT_BUDGET_BYTES } = {}) {
  return [
    '## Output Budget',
    '',
    `Your response will be reused as input to later workflow steps. Keep the final answer concise and aim to stay under ${bytes.toLocaleString()} bytes.`,
    '',
    'Prioritize:',
    '',
    '1. Required structured JSON blocks, scores, rankings, and final recommendations.',
    '2. Concise evidence that changes downstream decisions.',
    '3. Links or references instead of repeated long prose when possible.',
    '',
    'Omit:',
    '',
    '- repeated repository state, git status, and architecture inventories',
    '- prompt recaps, methodology narration, and generic preamble',
    '- long file lists unless they directly affect the result',
    '- duplicate rationale already captured in structured output',
  ].join('\n')
}

function shouldApplyOutputBudget({ options = {}, hasPriorResults = false, hasFutureSteps = false } = {}) {
  return outputBudgetEnabled(options) && (hasPriorResults || hasFutureSteps)
}

function contextWithOutputBudget(context, options = {}, details = {}) {
  if (!shouldApplyOutputBudget({ options, ...details })) return context || ''
  return joinContext(context, buildOutputBudgetContext({ bytes: outputBudgetBytes(options) }))
}

/** @param {Record<string, any>} param0 */
function resolveDryRunTransport({ requestedTransport, projectRoot }) {
  const requested = requestedTransport || 'auto'
  if (requested && requested !== 'auto') return resolveTransport(requested, [])
  const detections = detectTransports({ projectRoot })
  return detections.find((candidate) => candidate.available)?.id || NETLIFY_API_TRANSPORT
}

/** @param {Record<string, any>} param0 */
function remotePinnedOptions({ options, projectRoot, transport, target }) {
  if (options.autoContext === false || options.sha || options.pinnedSha) return options
  if (target) {
    return {
      ...options,
      target,
      branch: target.branch || options.branch,
      branchSource: target.sourceType || options.branchSource,
      ...(target.verified && target.sha ? { pinnedSha: target.sha, pinnedSource: target.ref || target.sourceType } : {}),
    }
  }
  if (!isNetlifyApiTransport(transport) && transport !== 'github') return options
  const branch = options.branch || currentGitBranch(projectRoot)
  const pinned = resolveRemoteBranchSha({ repoRoot: projectRoot, branch })
  return {
    ...options,
    pinnedSha: pinned.sha,
    pinnedSource: pinned.ref,
  }
}

/** @param {Record<string, any>} param0 */
function buildFlowRunContext({ options, projectRoot, transport, target }) {
  const contextOptions = remotePinnedOptions({ options, projectRoot, transport, target: target || options.target })
  const automatic = readAutoContext(contextOptions)
  const manual = readManualContext(options)
  return {
    automatic,
    manual,
    combined: joinContext(automatic, manual),
    pinnedSha: contextOptions.pinnedSha || contextOptions.sha || '',
    pinnedSource: contextOptions.pinnedSource || (contextOptions.sha ? 'explicit --sha' : ''),
  }
}

function extractSavedContextFromPrompt(promptText) {
  const marker = '\n## Additional Context\n\n'
  const index = String(promptText || '').lastIndexOf(marker)
  if (index === -1) return ''
  return String(promptText).slice(index + marker.length).trim()
}

function contextForRunState(runState, options) {
  if (runState.context?.combined) return runState.context.combined
  for (const step of runState.steps || []) {
    for (const run of step.runs || []) {
      const saved = extractSavedContextFromPrompt(run.promptText)
      if (saved) return saved
    }
  }
  return joinContext(readAutoContext(options), readManualContext(options))
}

function readRemoteInvisibleGitState(projectRoot) {
  const result = spawnSync('git', ['status', '--short', '--branch'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) return { dirty: false, lines: [] }

  const lines = (result.stdout || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
  const branchLine = lines.find((line) => line.startsWith('##')) || ''
  const fileLines = lines.filter((line) => !line.startsWith('##'))
  const hasUnpushedCommits = /\[(?:ahead|gone)\b/.test(branchLine)
  const displayLines = [
    ...(hasUnpushedCommits ? [branchLine] : []),
    ...fileLines,
  ]

  return {
    dirty: hasUnpushedCommits || fileLines.length > 0,
    lines: displayLines,
  }
}

/** @param {Record<string, any>} param0 */
async function confirmRemoteRunnerCanMissLocalChanges({ projectRoot, branch, options }) {
  if (!process.stdin.isTTY || options.yes || options.dryRun) return

  const state = readRemoteInvisibleGitState(projectRoot)
  if (!state.dirty) return

  const clack = await loadClack()
  console.log('')
  console.log('Local git state not visible to remote Netlify agent runners:')
  for (const line of state.lines) {
    console.log(`  ${line}`)
  }
  const confirmed = await clack.confirm({
    message: `You have uncommitted or unpushed changes on '${branch}' branch that remote Netlify agent runners will not know about.`,
    active: 'Yes, continue',
    inactive: 'No, cancel',
    initialValue: true,
  })
  if (clack.isCancel(confirmed) || !confirmed) {
    console.log('Cancelled')
    process.exit(0)
  }
}

function flowLoadOptions(options = {}, projectRoot = options.projectRoot || process.cwd()) {
  return {
    projectRoot,
    flowsDir: options.flowsDir,
    flowsDirs: options.flowsDirs,
  }
}

function flowFromRunState(runState = {}) {
  if (runState.flow && typeof runState.flow === 'object' && Array.isArray(runState.flow.steps)) {
    return runState.flow
  }
  return null
}

function githubSafePromptBytes(options = {}) {
  return githubSafePromptBytesWithLocalBudget(options, { localSafePromptBytes })
}

function githubIssueDeliveryKey(issue = {}) {
  return [
    issue.model || '',
    issue.promptName || '',
    issue.targetKind || '',
    issue.targetNumber || issue.issueNumber || '',
    issue.title || issue.issueTitle || '',
  ].join(':')
}

function buildGithubFullPromptWrapper({ runner = '@netlify', model, blobRef }) {
  return [
    `${runner} ${model || 'agent'} fetch and follow the complete offloaded prompt before doing any other work.`,
    '',
    buildFullPromptWrapper({ blobRef }),
  ].join('\n')
}

/** @param {Record<string, any>} param0 */
function optionalNetlifyForBlobOffload({ projectRoot, options = {} } = {}) {
  try {
    return resolveNetlifyProjectTarget({
      projectRoot,
      siteId: options.netlifySiteId,
      filter: options.filter,
      netlifyConfig: options.netlifyConfig,
    })
  } catch {
    return null
  }
}

function blobOffloadContextError(netlify) {
  if (!netlify?.siteId) return 'Netlify site context is required for prompt blob offload. Run nax init or set NETLIFY_SITE_ID.'
  if (!netlify?.env?.NETLIFY_AUTH_TOKEN) return 'NETLIFY_AUTH_TOKEN is required for prompt blob offload. Run netlify login or set NETLIFY_AUTH_TOKEN.'
  return ''
}

/** @param {Record<string, any>} param0 */
function ensureGithubIssueFullPromptBlobOffload({
  issue,
  promptBody,
  runState,
  stepState,
  step,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
} = {}) {
  if (!netlify?.siteId) throw new Error('Netlify site context is required for GitHub full-prompt blob offload.')
  const effectiveRunState = runState || { runId: `github-${Date.now()}`, blobRefs: [] }
  const effectiveStepState = stepState || { id: step?.id || issue?.promptName || 'github' }
  return ensureStepBlobOffload({
    sourceRuns: [],
    roundResults: '',
    payloadText: promptBody,
    refKind: 'full-prompt',
    refStepId: [step?.id || issue?.promptName || 'github', issue?.model || 'agent'].join('-'),
    runState: effectiveRunState,
    stepState: effectiveStepState,
    step: step || { id: issue?.promptName || 'github' },
    projectRoot,
    netlify,
    options,
    dryRun,
    onRetry: ({ nextAttempt, attempts, delayMs, error, store, key }) => {
      const delaySeconds = Math.round(delayMs / 1000)
      console.log(`  Blob ${store}/${key}: retrying upload ${nextAttempt}/${attempts} in ${delaySeconds}s - ${error.message}`)
    },
  })
}

/** @param {Record<string, any>} param0 */
function ensureGithubPlanBlobOffload({
  results,
  fullRoundResults,
  runState,
  stepState,
  step,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
} = {}) {
  if (stepState?.promptBlobRef) return stepState.promptBlobRef
  if (!netlify?.siteId) throw new Error('Netlify site context is required for GitHub prompt blob offload.')
  const sourceRuns = githubResultsToSourceRuns(results)
  const seed = fullRoundResults || formatRoundResults({ heading: 'Prior Round Outputs', results })
  const ref = blobRefForStep({
    runId: runState?.runId || `github-${Date.now()}`,
    stepId: step?.id || 'github',
    payloadSeed: seed,
  })
  const blobPayload = buildBlobPayload({ fullResults: seed, sentinel: ref.sentinel })
  const localDebug = dryRun || !runState || !stepState
    ? {}
    : writeLocalBlobDebugPayload({
      runState,
      stepState,
      ref: { ...ref, kind: 'prior-results' },
      payload: blobPayload,
      kind: 'prior-results',
      projectRoot,
    })
  const refInput = {
    runId: runState?.runId || '',
    stepId: stepState?.id || step?.id || '',
    store: ref.store,
    key: ref.key,
    marker: ref.marker,
    sentinel: ref.sentinel,
    kind: 'prior-results',
    ...localDebug,
    status: 'active',
  }
  const entry = dryRun || !runState || !stepState
    ? {
        id: `${refInput.runId || ''}:${refInput.store}:${refInput.key}`,
        ...refInput,
        createdAt: new Date().toISOString(),
        cleanupAttempts: 0,
        lastCleanupError: '',
      }
    : addRunBlobRef(runState, stepState, refInput)
  if (dryRun && runState && stepState) {
    runState.blobRefs = [...(Array.isArray(runState.blobRefs) ? runState.blobRefs : []), entry]
    stepState.blobRefs = [...(Array.isArray(stepState.blobRefs) ? stepState.blobRefs : []), entry]
  }
  if (stepState) stepState.promptBlobRef = entry
  if (!dryRun) {
    setBlob({
      store: ref.store,
      key: ref.key,
      value: blobPayload,
      siteId: netlify.siteId,
      token: netlify.env?.NETLIFY_AUTH_TOKEN,
      cwd: projectRoot,
      env: netlify.env,
      onRetry: ({ nextAttempt, attempts, delayMs, error, store, key }) => {
        const delaySeconds = Math.round(delayMs / 1000)
        console.log(`  Blob ${store}/${key}: retrying upload ${nextAttempt}/${attempts} in ${delaySeconds}s - ${error.message}`)
      },
    })
  }
  const safeBytes = githubSafePromptBytes(options)
  return {
    ...entry,
    sourceRuns,
    offloadedRoundResults: buildOffloadedRoundResults({ sourceRuns, blobRef: entry, safeBytes }),
  }
}

async function pickPromptInteractively() {
  const clack = await loadClack()
  const prompts = listPrompts()
  const selected = await clack.select({
    message: 'Choose workflow prompt',
    options: prompts.map((prompt, i) => ({
      value: prompt.name,
      label: `${i + 1}. ${prompt.title}`,
      hint: prompt.description,
    })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

/** @param {Record<string, any>} param0 */
async function selectIssueGroup({ clack, options, message, allowSkip = false }) {
  let groups
  try {
    groups = listRecentIssueGroups({ repo: resolveRepo(options.repo) })
  } catch (error) {
    console.error(`Could not load recent issues for auto-discovery: ${error.message}`)
    return null
  }

  const groupOptions = groups.slice(0, 12).map((group) => ({
    value: group.issueNumbers.join(','),
    label: `${group.date} ${group.promptTitle}`,
    hint: formatGroupHint(group),
  }))

  groupOptions.push({ value: '__manual__', label: 'Enter issue numbers manually', hint: '' })
  if (allowSkip) groupOptions.push({ value: '__skip__', label: 'Skip — no prior round results', hint: '' })

  const selected = await clack.select({ message, options: groupOptions })
  if (clack.isCancel(selected)) process.exit(0)

  if (selected === '__skip__') return ''
  if (selected === '__manual__') {
    const text = await clack.text({
      message: 'Issue numbers (comma-separated)',
      placeholder: '29,30,31',
      validate: (value) => (value && value.trim() ? undefined : 'Enter at least one issue number'),
    })
    if (clack.isCancel(text)) process.exit(0)
    return text.trim()
  }
  return selected
}

async function chooseInteractively(initialPromptName, options) {
  const clack = await loadClack()

  const promptName = initialPromptName || (await pickPromptInteractively())

  let fromIssues = options.fromIssues || options.fromIssue || ''
  if (!fromIssues && shouldFetchResults(promptName) && options.fetchResults !== false) {
    const message = promptName === 'summarize-consensus'
      ? 'Choose prior round to summarize'
      : 'Choose source round to embed'
    fromIssues = await selectIssueGroup({
      clack,
      options,
      message,
      allowSkip: true,
    }) || ''
  }

  const isSummarize = promptName === 'summarize-consensus'
  const modelOrder = isSummarize
    ? ['codex', ...DEFAULT_MODELS.filter((m) => m !== 'codex')]
    : DEFAULT_MODELS
  const defaultModelInitialValues = isSummarize ? ['codex'] : DEFAULT_MODELS

  let models = parseCsv(options.models)
  if (models.length === 0) {
    const selectedModels = await clack.multiselect({
      message: 'Choose Netlify agent models',
      options: modelOrder.map((model) => ({
        value: model,
        label: titleCase(model),
      })),
      initialValues: defaultModelInitialValues,
      required: true,
    })
    if (clack.isCancel(selectedModels)) process.exit(0)
    models = selectedModels
  }

  const optionsWithFrom = { ...options, fromIssues }
  const roundResultsRaw = fetchRoundResultsForOptions(optionsWithFrom, {
    embedAll: shouldEmbedAllReplies(promptName),
  })

  let manualContext = readManualContext(options)
  if (!manualContext && options.contextPrompt !== false) {
    manualContext = await multiline({
      message: 'Additional context/instructions (optional)',
      placeholder: 'Hit enter to proceed. Ok if this is empty.',
    })
  }
  const context = joinContext(readAutoContext(options), manualContext)

  return {
    promptName,
    options: {
      ...optionsWithFrom,
      models: models.join(','),
    },
    context,
    roundResultsRaw,
  }
}

async function chooseCommentInteractively(initialPromptName, options) {
  const clack = await loadClack()

  const promptName = initialPromptName || (await pickPromptInteractively())

  let issues = options.issues || options.issue
  if (!issues) {
    if (promptName === 'cross-review') {
      issues = await selectIssueGroup({
        clack,
        options,
        message: 'Choose round to comment on',
      })
    } else {
      const selectedIssues = await clack.text({
        message: 'Issue numbers (comma-separated)',
        placeholder: '29,30,31',
        validate: (value) => (value && value.trim() ? undefined : 'Enter at least one issue number'),
      })
      if (clack.isCancel(selectedIssues)) process.exit(0)
      issues = selectedIssues.trim()
    }
  }

  let fromIssues = options.fromIssues || options.fromIssue || ''
  if (!fromIssues && shouldFetchResults(promptName) && options.fetchResults !== false) {
    fromIssues = issues
  }

  const optionsWithFrom = { ...options, fromIssues }
  const roundResultsRaw = fetchRoundResultsForOptions(optionsWithFrom, {
    embedAll: shouldEmbedAllReplies(promptName),
  })

  let manualContext = readManualContext(options)
  if (!manualContext && options.contextPrompt !== false) {
    manualContext = await multiline({
      message: 'Additional context/instructions (optional)',
      placeholder: 'Hit enter to proceed. Ok if this is empty.',
    })
  }
  const context = joinContext(readAutoContext(options), manualContext)

  return {
    promptName,
    options: {
      ...optionsWithFrom,
      issues,
    },
    context,
    roundResultsRaw,
  }
}

function buildAndMaybeFallbackPlan(input, planBuilder) {
  const heading = input.options.fromIssuesHeading || ROUND_LABEL_BY_PROMPT[input.promptName] || 'Prior Round Outputs'
  const results = Array.isArray(input.roundResultsRaw) ? input.roundResultsRaw : []
  const context = contextWithOutputBudget(input.context, input.options, {
    hasPriorResults: results.length > 0,
    hasFutureSteps: input.hasFutureSteps === true,
  })

  const formatFor = (structuredOnly) =>
    results.length === 0 ? '' : formatRoundResults({ heading, results, structuredOnly })

  const fullRoundResults = formatFor(false)
  let plan = planBuilder({ ...input, context, roundResults: fullRoundResults })
  const originalIssueBodies = new Map((plan.issues || []).map((issue) => [githubIssueDeliveryKey(issue), issue.body]))
  const safeBytes = githubSafePromptBytes(input.options)
  const promptUnsafe = plan.issues.some((issue) => utf8ByteLength(issue.body) > safeBytes)

  if (promptUnsafe && results.length > 0 && !blobOffloadDisabled(input.options)) {
	    const netlify = input.netlify || optionalNetlifyForBlobOffload(/** @type {any} */ ({ projectRoot: input.projectRoot, options: input.options }))
    if (netlify) {
      try {
        const ref = ensureGithubPlanBlobOffload({
          results,
          fullRoundResults,
          runState: input.runState,
          stepState: input.stepState,
          step: input.step,
          projectRoot: input.projectRoot,
          netlify,
          options: input.options,
          dryRun: input.options.dryRun === true,
        })
        plan = planBuilder({ ...input, context, roundResults: ref.offloadedRoundResults })
        for (const issue of plan.issues) {
          issue.promptDelivery = {
            mode: 'blob',
            promptBytes: utf8ByteLength(issue.body),
            safePromptBytes: safeBytes,
            blobRef: {
              id: ref.id,
              store: ref.store,
              key: ref.key,
              marker: ref.marker,
              sentinel: ref.sentinel,
            },
            contextFetchPolicy: input.options.contextFetchPolicy || input.step?.contextFetchPolicy || 'optional',
          }
        }
      } catch (error) {
        console.error(`Warning: GitHub prompt blob offload failed; trying compact fallback. ${error?.message || String(error)}`)
      }
    } else {
      console.error('Warning: GitHub prompt blob offload skipped because Netlify site/token context is unavailable; trying compact fallback.')
    }
  }

  const oversized = plan.issues.some((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD || utf8ByteLength(issue.body) > safeBytes)
  if (oversized && results.length > 0 && !plan.issues.every((issue) => issue.promptDelivery?.mode === 'blob')) {
    const offending = plan.issues.find((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD)
    console.error(
      `Issue body is ${(offending || plan.issues[0]).body.length} chars; ` +
        'falling back to structured-findings JSON only for embedded round outputs.',
    )
    const structuredRoundResults = formatFor(true)
    plan = planBuilder({ ...input, context, roundResults: structuredRoundResults })
    const stillOversized = plan.issues.find((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD)
    if (stillOversized) {
      console.error(
        `Warning: structured-only body is still ${stillOversized.body.length} chars (over ${BODY_FALLBACK_THRESHOLD}); ` +
          'gh issue create may fail. Consider --no-auto-context or fewer source issues.',
      )
    }
  }

  const stillUnsafe = (plan.issues || []).filter((issue) => utf8ByteLength(issue.body) > safeBytes)
  if (stillUnsafe.length > 0 && !blobOffloadDisabled(input.options)) {
    const netlify = input.netlify || optionalNetlifyForBlobOffload(/** @type {any} */ ({ projectRoot: input.projectRoot, options: input.options }))
    if (netlify) {
      for (const issue of stillUnsafe) {
        const originalBody = originalIssueBodies.get(githubIssueDeliveryKey(issue)) || issue.body
        const ref = ensureGithubIssueFullPromptBlobOffload({
          issue,
          promptBody: originalBody,
          runState: input.runState,
          stepState: input.stepState,
          step: input.step,
          projectRoot: input.projectRoot,
          netlify,
          options: input.options,
          dryRun: input.options.dryRun === true,
        })
        const wrapper = buildGithubFullPromptWrapper({
          runner: input.options.runner || '@netlify',
          model: issue.model,
          blobRef: ref,
        })
        const wrapperBytes = utf8ByteLength(wrapper)
        if (wrapperBytes > safeBytes) {
          throw new Error([
            `GitHub full-prompt wrapper for ${githubActionPromptBudgetLabel(issue)} still exceeds the safe prompt budget.`,
            `Wrapper prompt: ${wrapperBytes.toLocaleString()} bytes.`,
            `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
            `Blob: ${ref.store}/${ref.key}.`,
          ].join(' '))
        }
        issue.body = wrapper
        issue.promptDelivery = {
          mode: 'blob',
          kind: 'full-prompt',
          promptBytes: utf8ByteLength(originalBody),
          safePromptBytes: safeBytes,
          offloadedPromptBytes: wrapperBytes,
          blobRef: {
            id: ref.id,
            store: ref.store,
            key: ref.key,
            marker: ref.marker,
            sentinel: ref.sentinel,
          },
          contextFetchPolicy: input.options.contextFetchPolicy || input.step?.contextFetchPolicy || 'optional',
        }
      }
    } else {
      console.error('Warning: GitHub full-prompt blob offload skipped because Netlify site/token context is unavailable.')
    }
  }

  return plan
}

async function handleIssue(promptName, options) {
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: process.cwd() })
  const wantsInteractive = process.stdin.isTTY && (!promptName || !options.yes)

  let resolvedPromptName = promptName
  if (wantsInteractive && !resolvedPromptName) {
    resolvedPromptName = await pickPromptInteractively()
  }
  resolvedPromptName = resolvedPromptName || 'review'

  if (wantsInteractive && resolvedPromptName === 'cross-review') {
    return handleComment(resolvedPromptName, options)
  }

  const input = wantsInteractive
    ? await chooseInteractively(resolvedPromptName, options)
    : {
        promptName: resolvedPromptName,
        options,
        context: readContext(options),
        roundResultsRaw: fetchRoundResultsForOptions(options, {
          embedAll: shouldEmbedAllReplies(resolvedPromptName),
        }),
      }
  const stepState = input.stepState || { id: input.promptName || resolvedPromptName || 'github' }
  const runState = input.runState || {
    runId: `github-${Date.now()}`,
    projectRoot,
    blobRefs: [],
    steps: [stepState],
    transport: 'github',
  }
  const enrichedInput = {
    ...input,
    projectRoot,
    runState,
    stepState,
    step: input.step || { id: stepState.id },
  }

  if (
    input.promptName === 'summarize-consensus' &&
    options.skipRoundCheck !== true &&
    Array.isArray(enrichedInput.roundResultsRaw) &&
    enrichedInput.roundResultsRaw.length > 0
  ) {
    assertCrossReviewComplete(rawIssuesFromResults(enrichedInput.roundResultsRaw))
  }

  const plan = buildAndMaybeFallbackPlan(enrichedInput, buildPlan)
  printPlan(plan, { dryRun: options.dryRun })

  if (options.dryRun) {
    for (const issue of plan.issues) {
      console.log(`\n--- ${issue.title} ---\n${issue.body}`)
    }
    return
  }

  if (!options.yes && process.stdin.isTTY) {
    const clack = await loadClack()
    const titleList = plan.issues.map((issue) => `  • ${issue.title}`).join('\n')
    const noun = plan.issues.length === 1 ? 'issue' : 'issues'
    const confirmed = await clack.confirm({
      message: `Create ${plan.issues.length} GitHub ${noun} in ${plan.repo}?\n${titleList}`,
      initialValue: true,
    })
    if (clack.isCancel(confirmed) || !confirmed) {
      console.log('Cancelled')
      return
    }
  }

  for (const issue of plan.issues) {
    const url = createIssue({
      repo: plan.repo,
      title: issue.title,
      body: issue.body,
      labels: plan.labels,
    })
    console.log(`${issue.title}: ${url}`)
  }
}

async function handleComment(promptName, options) {
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: process.cwd() })
  const wantsInteractive = process.stdin.isTTY && (!promptName || !options.yes || !(options.issues || options.issue))
  const resolvedPromptName = promptName || 'cross-review'

  let nonInteractiveOptions = options
  if (!wantsInteractive) {
    const fromIssues =
      options.fromIssues ||
      options.fromIssue ||
      (shouldFetchResults(resolvedPromptName) && options.fetchResults !== false
        ? options.issues || options.issue || ''
        : '')
    nonInteractiveOptions = { ...options, fromIssues }
  }

  const input = wantsInteractive
    ? await chooseCommentInteractively(promptName, options)
    : {
        promptName: resolvedPromptName,
        options: nonInteractiveOptions,
        context: readContext(nonInteractiveOptions),
        roundResultsRaw: fetchRoundResultsForOptions(nonInteractiveOptions, {
          embedAll: shouldEmbedAllReplies(resolvedPromptName),
        }),
      }
  const stepState = input.stepState || { id: input.promptName || resolvedPromptName || 'github-comment' }
  const runState = input.runState || {
    runId: `github-${Date.now()}`,
    projectRoot,
    blobRefs: [],
    steps: [stepState],
    transport: 'github',
  }
  const enrichedInput = {
    ...input,
    projectRoot,
    runState,
    stepState,
    step: input.step || { id: stepState.id },
  }

  const plan = buildAndMaybeFallbackPlan(enrichedInput, buildCommentPlan)
  printCommentPlan(plan, { dryRun: options.dryRun })

  if (options.dryRun) {
    for (const issue of plan.issues) {
      const label = issue.redirected
        ? `#${issue.issueNumber} ${issue.issueTitle} -> PR #${issue.targetNumber} ${issue.targetTitle}`
        : `#${issue.issueNumber} ${issue.issueTitle}`
      console.log(`\n--- ${label} ---\n${issue.body}`)
    }
    return
  }

  if (!options.yes && process.stdin.isTTY) {
    const clack = await loadClack()
    const targetList = plan.issues
      .map((issue) => {
        const target = issue.targetKind === 'pr'
          ? `PR #${issue.targetNumber} ${issue.targetTitle}`
          : `issue #${issue.targetNumber}`
        return `  • ${issue.model} → ${target}`
      })
      .join('\n')
    const noun = plan.issues.length === 1 ? 'comment' : 'comments'
    const confirmed = await clack.confirm({
      message: `Create ${plan.issues.length} GitHub ${noun} in ${plan.repo}?\n${targetList}`,
      initialValue: true,
    })
    if (clack.isCancel(confirmed) || !confirmed) {
      console.log('Cancelled')
      return
    }
  }

  for (const issue of plan.issues) {
    const url = createDiscussionComment({
      repo: issue.targetRepo,
      targetKind: issue.targetKind,
      targetNumber: issue.targetNumber,
      body: issue.body,
    })
    const targetLabel = issue.targetKind === 'pr' ? `PR #${issue.targetNumber}` : `#${issue.targetNumber}`
    console.log(`#${issue.issueNumber} ${issue.issueTitle} -> ${targetLabel}: ${url}`)
  }
}

async function handleList(options = {}) {
  const invocationDir = process.cwd()
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: invocationDir })
  const flows = await listFlows(flowLoadOptions(options, projectRoot))
  if (options.json) {
    console.log(formatFlowListJson(flows))
    return
  }
  console.log(formatFlowList(flows, { verbose: options.verbose, baseDir: invocationDir }))
}

async function handleVisualize(flowId, options = {}) {
  const invocationDir = process.cwd()
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: invocationDir })
  if (flowId) {
    await loadFlow(flowId, flowLoadOptions(options, projectRoot))
  }

  const instance = await startVisualizeServer({
    projectRoot,
    flowsDir: options.flowsDir,
    flowsDirs: options.flowsDirs,
    host: options.host || '127.0.0.1',
    port: options.port,
    initialWorkflow: flowId || '',
    dev: options.dev === true,
    tail: options.tail === true,
  })

  console.log(`Nax visualize: ${instance.url}`)
  console.log(`Project root:  ${instance.projectRoot}`)
  if (options.tail === true) console.log('Tail output:   on')

  if (options.open !== false) {
    const openBrowser = (await import('open')).default
    await openBrowser(instance.url)
  }

  const close = async () => {
    try {
      await instance.close()
    } catch (_err) {
      /* ignore close races during process shutdown */
    }
  }
  process.once('SIGINT', () => {
    close().finally(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    close().finally(() => process.exit(0))
  })
}

function formatRunTimestamp(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function normalizeHandoffSourceKind(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized === 'all') return ''
  if (normalized === 'workflow' || normalized === 'workflows') return 'workflow'
  if (normalized === 'runner' || normalized === 'runners' || normalized === 'agent-runner' || normalized === 'agent-runners') return 'agent-runner'
  if (normalized === 'session' || normalized === 'sessions' || normalized === 'agent-session' || normalized === 'agent-sessions') return 'agent-session'
  throw new Error(`Unknown handoff source type "${value}". Expected workflow, agent-runner, or agent-session.`)
}

/** @param {Record<string, any>} param0 */
function handoffSourceQuery({ runId = '', options = {} } = {}) {
  if (options.workflow) return { kind: 'workflow', id: options.workflow }
  if (options.runner) return { kind: 'agent-runner', id: options.runner }
  if (options.session) return { kind: 'agent-session', id: options.session }
  if (runId || options.runId) return { kind: 'workflow', id: runId || options.runId }
  return {
    kind: normalizeHandoffSourceKind(options.sourceType || options.type || ''),
    id: options.source || '',
  }
}

function formatHandoffSourceKind(kind) {
  if (kind === 'workflow') return 'workflow'
  if (kind === 'agent-runner') return 'agent runner'
  if (kind === 'agent-session') return 'agent session'
  return kind || 'artifact'
}

function isAdHocRunTarget(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === AD_HOC_RUN_TARGET ||
    normalized === 'ad-hoc' ||
    normalized === 'adhoc' ||
    normalized === 'agent' ||
    normalized === 'agent-run'
}

function formatHandoffSourceLabel(source = {}) {
  const stamp = formatRunTimestamp(source.updatedAt)
  return [stamp, source.title || source.id || 'Untitled'].filter(Boolean).join('  ')
}

function formatHandoffSourceHint(source = {}, projectRoot = process.cwd()) {
  const displayPath = source.displayPath || relativeDisplayPath(projectRoot, source.summaryPath || '')
  return `${formatHandoffSourceKind(source.kind)} · ${displayPath}`
}

function formatLatestHandoffSourceHint(source = {}, projectRoot = process.cwd()) {
  const displayPath = source.displayPath || relativeDisplayPath(projectRoot, source.summaryPath || '')
  const payload = handoffSourcePayload(source)
  const agent = String(payload.agent || source.agent || '').trim().toLowerCase()
  const origin = agent || String(source.title || source.id || 'latest').trim()
  return ['from', origin, displayPath].filter(Boolean).join(' ')
}

function formatCompactHandoffSourceHint(source = {}, projectRoot = process.cwd()) {
  return formatLatestHandoffSourceHint(source, projectRoot).replace(/^from\s+/, '')
}

function truncateOneLine(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function formatRelativeTime(value, now = Date.now()) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = date.getTime() - now
  const absMs = Math.abs(diffMs)
  /** @type {Array<[string, number]>} */
  const units = [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ]
  const [unit, unitMs] = units.find(([, ms]) => absMs >= ms) || units[units.length - 1]
  const count = Math.max(1, Math.round(absMs / unitMs))
  const label = `${count} ${unit}${count === 1 ? '' : 's'}`
  return diffMs > 0 ? `in ${label}` : `${label} ago`
}

function formatHumanRunDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function handoffSourcePayload(source = {}) {
  return source.source || source.runState || {}
}

function sourceDisplayTitle(source = {}) {
  if (source.kind === 'workflow') return source.title || source.id || 'Workflow'
  const artifact = handoffSourcePayload(source)
  const agent = artifact.agent ? titleCase(artifact.agent) : ''
  const sourceTitle = artifact.source?.stepTitle || artifact.source?.stepId || ''
  if (agent && sourceTitle) return `${agent} · ${sourceTitle}`
  if (agent) return agent
  return source.title || source.id || 'Artifact'
}

function finalWorkflowRun(source = {}) {
  if (source.kind !== 'workflow') return null
  const payload = handoffSourcePayload(source)
  const steps = Array.isArray(payload.steps) ? payload.steps : []
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    const runs = Array.isArray(step.runs) ? step.runs : []
    for (let j = runs.length - 1; j >= 0; j -= 1) {
      const run = runs[j]
      if (run?.status === 'completed' && String(run.resultText || '').trim()) {
        return { step, run }
      }
    }
  }
  return null
}

function previewTextForHandoffSource(source = {}, max = 260) {
  const final = finalWorkflowRun(source)
  if (final?.run?.resultText) return truncateOneLine(final.run.resultText, max)
  const resultText = handoffSourcePayload(source).resultText || ''
  if (resultText) return truncateOneLine(resultText, max)
  const summaryText = String(source.summaryText || '')
  const lines = summaryText.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (/^[-*]\s+(Run ID|Flow|Transport|Status|Usage|Files|Runner ID|Session ID|Metadata|Result):/i.test(line)) return false
      if (/^[-*]\s*$/.test(line)) return false
      return !/^```/.test(line)
    })
  return truncateOneLine(lines.find((line) => !/^#\s/.test(line)) || lines[0] || '', max)
}

function usageSummaryForHandoffSource(source = {}) {
  const payload = handoffSourcePayload(source)
  if (source.kind === 'workflow') return usageSummariesForRunState(payload).totalSummary || ''
  return formatUsageSummary(payload.usage || {})
}

function handoffSourceUpdatedAt(source = {}) {
  const payload = handoffSourcePayload(source)
  return source.updatedAt || payload.updatedAt || source.createdAt || payload.createdAt || ''
}

function handoffSourceDetailTitle(source = {}) {
  const final = finalWorkflowRun(source)
  if (source.kind === 'workflow' && final) {
    return `Latest result from "${sourceDisplayTitle(source)}" workflow "${final.step.title || final.step.id || 'Final step'}" step using ${titleCase(final.run.agent || 'agent')}`
  }
  const payload = handoffSourcePayload(source)
  if (source.kind === 'agent-session') {
    return `Latest result from ${titleCase(payload.agent || 'agent')} agent session`
  }
  if (source.kind === 'agent-runner') {
    return `Latest result from ${titleCase(payload.agent || 'agent')} agent runner`
  }
  return `Latest result from ${sourceDisplayTitle(source)}`
}

const HANDOFF_DETAIL_LABEL_WIDTH = 9

/** @param {any} label @param {any} value @param {any} width @param {Record<string, any>} param3 */
function formatHandoffDetailField(label, value, width, { block = false } = {}) {
  const text = String(value || '').trim()
  if (!text) return []
  const labelText = `${label}:`
  const indent = ' '.repeat(HANDOFF_DETAIL_LABEL_WIDTH)
  const valueWidth = Math.max(24, width - HANDOFF_DETAIL_LABEL_WIDTH)
  if (block) {
    return [labelText, ...wordWrap(text, width).split('\n')]
  }
  const wrapped = wordWrap(text, valueWidth).split('\n')
  return wrapped.map((line, index) => (
    index === 0 ? `${labelText.padEnd(HANDOFF_DETAIL_LABEL_WIDTH)}${line}` : `${indent}${line}`
  ))
}

/** @param {any} source @param {any} projectRoot @param {Record<string, any>} param2 */
function handoffSourceDetailLines(source = {}, projectRoot = process.cwd(), { width = 100 } = {}) {
  const updatedAt = handoffSourceUpdatedAt(source)
  const date = formatHumanRunDate(updatedAt)
  const relative = formatRelativeTime(updatedAt)
  const lines = []
  if (date) {
    lines.push(...formatHandoffDetailField('Date', `${date}${relative ? ` (${relative})` : ''}`, width))
  }
  lines.push(...formatHandoffDetailField(
    'Summary',
    source.displayPath || relativeDisplayPath(projectRoot, source.summaryPath || ''),
    width,
  ))
  const preview = previewTextForHandoffSource(source)
  if (preview) lines.push(...formatHandoffDetailField('Preview', preview, width, { block: true }))
  return lines
}

function formatHandoffSourceDetailBox(source = {}, projectRoot = process.cwd()) {
  const teal = '#0d9488'
  const terminalWidth = process.stdout.columns || 120
  const width = Math.min(120, Math.max(76, Math.floor(terminalWidth * 0.95)))
  const lines = handoffSourceDetailLines(source, projectRoot, { width: width - 6 })
  return makeBox({
    title: handoffSourceDetailTitle(source),
    content: lines.join('\n'),
    borderStyle: 'rounded',
    borderColor: teal,
    width,
  })
}

/** @param {Record<string, any>} param0 */
function handoffSourceMenuOptions({ sources = [], latestSource = {}, projectRoot = process.cwd() } = {}) {
  const options = [
    {
      value: 'copy-latest',
      label: 'Copy latest results markdown to clipboard',
      hint: formatLatestHandoffSourceHint(latestSource, projectRoot),
    },
    {
      value: 'copy-latest-path',
      label: 'Copy latest results filePath to clipboard',
      hint: latestSource.displayPath || relativeDisplayPath(projectRoot, latestSource.summaryPath || ''),
    },
    {
      value: 'open-latest',
      label: 'Open latest results in code editor',
      hint: latestSource.displayPath || relativeDisplayPath(projectRoot, latestSource.summaryPath || ''),
    },
    {
      value: 'workflow-latest',
      label: 'Run followup prompt with previous results',
      hint: formatCompactHandoffSourceHint(latestSource, projectRoot),
    },
  ]
  const hasKind = (kind) => sources.some((source) => source.kind === kind)
  if (hasKind('workflow')) options.push({ value: 'pick:workflow', label: 'Pick previous workflow', hint: '' })
  if (hasKind('agent-session')) options.push({ value: 'pick:agent-session', label: 'Pick previous agent session', hint: '' })
  if (hasKind('agent-runner')) options.push({ value: 'pick:agent-runner', label: 'Pick previous agent runner', hint: '' })
  options.push({ value: 'cancel', label: 'Cancel', hint: '' })
  return options
}

async function handleRecent(options) {
  const projectRoot = options.projectRoot || process.cwd()
  const requestedType = options.type || 'all'
  const sources = listHandoffSources(projectRoot)
    .filter((source) => requestedType === 'all' || source.kind === requestedType)
  if (sources.length === 0) {
    console.log(`No completed nax artifacts found under ${path.join(projectRoot, '.nax')}.`)
    return
  }
  const limit = Number.parseInt(options.limit || '25', 10)
  const choices = sources.slice(0, limit)

  let selected
  if (options.runId) {
    selected = choices.find((source) => source.id === options.runId) || null
    if (!selected) {
      throw new Error(`No artifact source found with id "${options.runId}"`)
    }
  } else {
    const clack = await loadClack()
    const picked = await clack.select({
      message: 'Pick a recent artifact',
      options: choices.map((source) => ({
        value: `${source.kind}:${source.id}`,
        label: formatHandoffSourceLabel(source),
        hint: `${formatHandoffSourceKind(source.kind)} · ${source.id}`,
      })),
    })
    if (clack.isCancel(picked)) return
    const [kind, ...idParts] = String(picked).split(':')
    const id = idParts.join(':')
    selected = choices.find((source) => source.kind === kind && source.id === id)
    if (!selected) return
  }

  if (selected.kind === 'workflow') {
    printSuccessBox({
      flow: { title: selected.source.flowTitle || selected.source.flowId },
      runState: selected.source,
      transport: selected.source.transport,
      projectRoot: selected.source.projectRoot || projectRoot,
    })
    return
  }
  console.log(`${selected.kind}: ${selected.id}`)
  console.log(`Summary: ${relativeDisplayPath(projectRoot, selected.summaryPath)}`)
}

async function handlePreviewSpinner(options) {
  const total = Number.parseInt(options.count || '3', 10)
  const tickMs = Number.parseInt(options.tickMs || '10000', 10)
  const stepTitle = options.label || 'Review'
  const parsed = parseCsv(options.agents)
  const agents = parsed.length > 0 ? parsed : DEFAULT_MODELS
  const flavorMinMs = Number.parseInt(options.flavorMinMs || '10000', 10)
  const flavorMaxMs = Number.parseInt(options.flavorMaxMs || '15000', 10)
  console.log(`TTY: ${process.stdout.isTTY ? 'yes (spinner + flavor)' : 'no (plain logs)'}`)
  const reporter = makeStepProgressReporter({
    stepTitle,
    total,
    agents,
    orchestrator: options.orchestrator || DEFAULT_ORCHESTRATOR,
    flavorMinMs,
    flavorMaxMs,
  })
  let settled = false
  try {
    for (let i = 1; i <= total; i++) {
      await new Promise((resolve) => setTimeout(resolve, tickMs))
      reporter.setCount(i)
    }
    reporter.done(`${stepTitle}: ${total}/${total} complete`)
    settled = true
  } finally {
    if (!settled) reporter.fail(`${stepTitle} failed`)
  }
}

async function promptForOptionalHandoffInstructions() {
  const value = await multiline({
    message: 'Additional instructions for the next agent run',
    placeholder: 'Hit enter to just pass the workflow summary.',
  })
  return String(value || '').trim()
}

/** @param {Record<string, any>} param0 */
async function runSingleNetlifyAgent({
  projectRoot,
  agent,
  promptText,
  title,
  source,
  raw = {},
  options = {},
  beforeSubmit,
  startLabel,
} = {}) {
  const branch = options.branch || currentGitBranch(projectRoot)
  const netlify = resolveNetlifyProjectTarget({
    projectRoot,
    siteId: options.netlifySiteId,
    filter: options.filter,
    netlifyConfig: options.netlifyConfig,
  })
  const netlifyFilter = netlify.netlifyFilter
  const runTitle = title || 'Agent Run'
  const run = {
    transport: NETLIFY_API_TRANSPORT,
    agent,
    status: 'pending',
    promptText,
    compactPromptText: '',
    resultText: '',
    runnerId: '',
    issueUrl: '',
    commentUrl: '',
    prUrl: '',
    deployUrl: '',
    raw: {
      stepId: safeArtifactName(runTitle).toLowerCase(),
      promptName: safeArtifactName(runTitle).toLowerCase(),
      ...raw,
    },
  }

  if (typeof beforeSubmit === 'function') beforeSubmit()
  maybeReportNetlifySite(netlifyOptionsFromTarget(options, netlify))
  maybeReportNetlifyFilter(netlifyFilter)
  console.log(`\nStarting ${titleCase(agent)} ${startLabel || runTitle.toLowerCase()}...`)
  const startedAt = Date.now()
  const submitted = await submitLocalAgentRun({
    run,
    projectRoot,
    branch,
    siteId: netlify.siteId,
    netlifyFilter: netlifyFilter.filter,
    env: netlify.env,
    onRetry: ({ error, nextAttempt, attempts, delayMs }) => {
      const delaySeconds = Math.round(delayMs / 1000)
      console.log(`Submission failed, retrying ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
    },
  })
  submitted.submittedAfterSeconds = Math.round((Date.now() - startedAt) / 1000)
  addLocalRunLinks(submitted, projectRoot, options)
  const boxes = formatSubmittedLocalRunBoxes({
    runs: [submitted],
    prompt: { title: runTitle },
    projectRoot,
  })
  if (boxes) {
    console.log('\nSubmitted Netlify agent run:')
    console.log(boxes)
  }

  const reporter = makeStepProgressReporter({
    stepTitle: runTitle,
    total: 1,
    agents: [agent],
  })
  let settled = false
  try {
    const [completed] = await waitForLocalAgentRuns({
      projectRoot,
      runs: [submitted],
      siteId: netlify.siteId,
      netlifyFilter: netlifyFilter.filter,
      env: netlify.env,
      timeoutMinutes: Number.parseInt(options.timeoutMinutes || '25', 10),
      initialDelayMs: 0,
      onProgress: (event) => {
        if (!event.run?.runnerId) return
        reporter.updateRun(event)
      },
      onTerminalRun: (terminalRun) => {
        addLocalRunLinks(terminalRun, projectRoot, options)
        reportTerminalLocalRun(reporter, terminalRun, projectRoot)
      },
    })
    addLocalRunLinks(completed, projectRoot, options)
    const artifactSource = source || { type: 'ad-hoc' }
    const sessionArtifact = persistAgentSessionArtifact({
      projectRoot,
      run: completed,
      source: artifactSource,
      createdAt: completed.createdAt || new Date().toISOString(),
      updatedAt: completed.updatedAt || new Date().toISOString(),
    })
    const runnerArtifact = persistAgentRunnerArtifact({
      projectRoot,
      runnerId: completed.runnerId,
      agent: completed.agent,
      status: completed.status,
      session: sessionArtifact?.session || null,
      source: artifactSource,
      links: completed.links || {},
      createdAt: completed.createdAt || new Date().toISOString(),
      updatedAt: completed.updatedAt || new Date().toISOString(),
    })
    reporter.updateRun({
      run: completed,
      state: completed.status,
      terminal: true,
      terminalSuccess: completed.status === 'completed',
      terminalFailure: completed.status !== 'completed',
    })
    if (completed.status === 'completed') {
      reporter.done(`${runTitle}: ${titleCase(agent)} complete`)
    } else {
      reporter.fail(`${runTitle}: ${titleCase(agent)} ${completed.status}`)
      throw new Error(`${runTitle} did not complete successfully.`)
    }
    settled = true
    const url = completed.links?.sessionUrl || completed.links?.agentRunUrl || ''
    if (url) console.log(`Result: ${url}`)
    if (sessionArtifact?.dir || runnerArtifact?.dir) {
      console.log('')
      if (sessionArtifact?.dir) console.log(`Session artifacts: ${sessionArtifact.dir}`)
      if (runnerArtifact?.dir) console.log(`Runner artifacts:  ${runnerArtifact.dir}`)
      if (sessionArtifact?.dir && process.stdout.isTTY) {
        const summaryPath = path.join(sessionArtifact.dir, 'summary.md')
        console.log('')
        console.log(`The result from this agent session is in ${relativeDisplayPath(projectRoot, summaryPath)}`)
        console.log('')
        console.log('Hand it off again with:')
        console.log('')
        console.log('nax handoff')
        console.log('')
      }
    }
  } finally {
    if (!settled) reporter.fail(`${runTitle} failed`)
  }
}

/** @param {Record<string, any>} param0 */
async function runFreshHandoffAgent({ projectRoot, agent, promptText, summaryDisplayPath, source, options = {} }) {
  await runSingleNetlifyAgent({
    projectRoot,
    agent,
    promptText,
    title: 'Handoff',
    source: {
      type: 'handoff',
      priorSourceKind: source?.kind || 'workflow',
      priorSourceId: source?.id || '',
      priorSummaryPath: summaryDisplayPath,
    },
    raw: {
      stepId: 'handoff',
      promptName: 'handoff',
      summaryPath: summaryDisplayPath,
    },
    options,
    startLabel: 'handoff run',
    beforeSubmit: () => {
      console.log(`Including prior workflow summary:\n${summaryDisplayPath}`)
    },
  })
}

/** @param {Record<string, any>} param0 */
async function runSingleGithubAgent({ projectRoot, agent, promptText, source, options = {} } = {}) {
  const repo = resolveRepo(options.repo)
  const date = options.date || getLocalDate()
  const runner = options.runner || '@netlify'
  const labels = parseCsv(options.labels || options.label)
  const prompt = {
    name: 'netlify-agent-run',
    title: 'Netlify Agent Run',
    description: 'Run one Netlify agent with a custom prompt.',
    instruction: 'please handle this request',
    body: promptText,
  }
  const title = `${date} ${titleCase(agent)} Netlify Agent Run`
  const body = buildIssueBody({
    runner,
    model: agent,
    prompt,
    context: '',
    roundResults: '',
    date,
  })

  console.log(`\nCreating GitHub issue for ${titleCase(agent)} Netlify agent run...`)
  const issueUrl = createIssue({ repo, title, body, labels })
  const issueNumber = parseIssueNumberFromUrl(issueUrl)
  if (!Number.isFinite(issueNumber)) throw new Error(`Could not parse issue number from ${issueUrl}`)
  console.log(`${title}: ${issueUrl}`)

  const run = {
    transport: 'github',
    agent,
    status: 'submitted',
    promptText: body,
    resultText: '',
    issueNumber,
    issueUrl,
    commentUrl: '',
    prUrl: '',
    deployUrl: '',
    raw: {
      title,
      promptName: prompt.name,
    },
  }
  const step = {
    id: 'netlify-agent-run',
    title: 'Netlify Agent Run',
    agents: [agent],
    waitFor: WAIT_FOR_AGENT_RESULTS,
  }
  const runs = [run]
  const timeoutMinutes = Number.parseInt(options.timeoutMinutes || '25', 10)
  const results = await waitForGithubStep({
    repo,
    issueNumbers: [issueNumber],
    runs,
    step,
    timeoutMinutes,
    onRunResult: ({ result, reply, run: submittedRun, status }) => {
      const normalized = normalizeGithubRunResult({
        run: submittedRun,
        result,
        reply,
        status,
        marker: parseRunnerResultMarker(reply?.body || ''),
      })
      if (reply?.createdAt && !normalized.createdAt) normalized.createdAt = reply.createdAt
      if (reply?.createdAt && !normalized.updatedAt) normalized.updatedAt = reply.createdAt
      Object.assign(submittedRun, normalized)
    },
  })
  const result = results[0]
  const latest = (result?.replies || [])[(result?.replies || []).length - 1]
  const completed = normalizeGithubRunResult({
    run,
    result,
    reply: latest,
    status: latest ? 'completed' : 'timeout',
    marker: parseRunnerResultMarker(latest?.body || ''),
  })
  if (latest?.createdAt && !completed.createdAt) completed.createdAt = latest.createdAt
  if (latest?.createdAt && !completed.updatedAt) completed.updatedAt = latest.createdAt

  const artifactSource = source || {
    type: 'single-run',
    transport: 'github',
    issueNumber,
    issueUrl,
    promptLength: promptText.length,
  }
  const sessionArtifact = persistAgentSessionArtifact({
    projectRoot,
    run: completed,
    source: artifactSource,
    createdAt: completed.createdAt || new Date().toISOString(),
    updatedAt: completed.updatedAt || new Date().toISOString(),
  })
  const runnerArtifact = completed.runnerId ? persistAgentRunnerArtifact({
    projectRoot,
    runnerId: completed.runnerId,
    agent: completed.agent,
    status: completed.status,
    session: sessionArtifact?.session || null,
    source: artifactSource,
    links: completed.links || {},
    createdAt: completed.createdAt || new Date().toISOString(),
    updatedAt: completed.updatedAt || new Date().toISOString(),
  }) : null

  const url = completed.links?.sessionUrl || completed.links?.agentRunUrl || completed.commentUrl || issueUrl
  if (url) console.log(`Result: ${url}`)
  if (sessionArtifact?.dir || runnerArtifact?.dir) {
    console.log('')
    if (sessionArtifact?.dir) console.log(`Session artifacts: ${sessionArtifact.dir}`)
    if (runnerArtifact?.dir) console.log(`Runner artifacts:  ${runnerArtifact.dir}`)
  }
}

/** @param {Record<string, any>} param0 */
async function chooseHandoffSourceInteractively({ projectRoot, latestSource }) {
  const clack = await loadClack()
  const sources = listHandoffSources(projectRoot).map((source) => ({
    ...source,
    displayPath: relativeDisplayPath(projectRoot, source.summaryPath),
  }))
  const options = handoffSourceMenuOptions({ sources, latestSource, projectRoot })
  console.log(formatHandoffSourceDetailBox(latestSource, projectRoot))
  console.log('')

  const selected = await clack.select({
    message: 'Hand off previous results',
    options,
  })
  if (clack.isCancel(selected) || selected === 'cancel') return { action: 'cancel' }
  if (selected === 'copy-latest') return { source: latestSource, action: 'copy' }
  if (selected === 'copy-latest-path') return { source: latestSource, action: 'copy-path' }
  if (selected === 'open-latest') return { source: latestSource, action: 'open' }
  if (selected === 'workflow-latest') return { source: latestSource, action: 'workflow' }

  const [, kind] = String(selected).split(':')
  const choices = sources.filter((source) => source.kind === kind)
  const picked = await clack.select({
    message: `Choose ${formatHandoffSourceKind(kind)}`,
    options: choices.map((source) => ({
      value: source.id,
      label: formatHandoffSourceLabel(source),
      hint: formatHandoffSourceHint(source, projectRoot),
    })),
  })
  if (clack.isCancel(picked)) return { action: 'cancel' }
  return { source: choices.find((source) => source.id === picked) || latestSource }
}

async function chooseHandoffActionInteractively(source) {
  const clack = await loadClack()
  const selected = await clack.select({
    message: 'What should happen next?',
    options: [
      { value: 'copy', label: 'Copy selected result to clipboard', hint: source.displayPath },
      { value: 'fresh', label: 'Start a new agent session with selected result', hint: formatHandoffSourceKind(source.kind) },
      { value: 'workflow', label: 'Run another workflow with selected result', hint: formatHandoffSourceKind(source.kind) },
      { value: 'cancel', label: 'Cancel' },
    ],
  })
  if (clack.isCancel(selected)) return 'cancel'
  return selected
}

async function handleHandoff(runId, options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  let handoff = readSelectedHandoffSource({ projectRoot, runId, options })

  if (options.copy) {
    const command = copyToClipboard(handoff.summaryText)
    console.log(`\nCopied ${handoff.displayPath} to clipboard with ${command}.`)
    return
  }

  if (options.agent || options.flow) {
    const promptText = buildHandoffPrompt({
      instructions: options.context || '',
      summaryPath: handoff.displayPath,
      summaryText: handoff.summaryText,
    })
    if (options.agent) {
      await runFreshHandoffAgent({
        projectRoot,
        agent: options.agent,
        promptText,
        summaryDisplayPath: handoff.displayPath,
        source: handoff,
        options,
      })
      return
    }
    console.log(`Including prior results summary:\n${handoff.displayPath}`)
    await handleRun(options.flow, {
      ...options,
      projectRoot,
      context: promptText,
    })
    return
  }

  if (!process.stdin.isTTY) {
    console.log(`Source: ${handoff.kind || 'workflow'}`)
    console.log(`Summary: ${handoff.displayPath}`)
    console.log('Run `nax handoff` in a TTY to copy it or start another agent run.')
    return
  }

  const selectedSource = await chooseHandoffSourceInteractively({ projectRoot, latestSource: handoff })
  if (selectedSource.action === 'cancel') return
  handoff = selectedSource.source || handoff
  const action = selectedSource.action || await chooseHandoffActionInteractively(handoff)
  if (action === 'cancel') return
  if (action === 'copy') {
    const command = copyToClipboard(handoff.summaryText)
    console.log(`\nCopied ${handoff.displayPath} to clipboard with ${command}.`)
    return
  }
  if (action === 'copy-path') {
    const command = copyToClipboard(handoff.displayPath)
    console.log(`\nCopied ${handoff.displayPath} path to clipboard with ${command}.`)
    return
  }
  if (action === 'open') {
    await openHandoffSource(handoff, { projectRoot })
    console.log(`\nOpened ${handoff.displayPath}.`)
    return
  }

  const clack = await loadClack()
  const instructions = await promptForOptionalHandoffInstructions()
  const promptText = buildHandoffPrompt({
    instructions,
    summaryPath: handoff.displayPath,
    summaryText: handoff.summaryText,
  })

  if (action === 'fresh') {
    const agent = options.agent || await clack.select({
      message: 'Choose agent',
      options: DEFAULT_MODELS.map((model) => ({ value: model, label: titleCase(model) })),
    })
    if (clack.isCancel(agent)) return
    await runFreshHandoffAgent({
      projectRoot,
      agent,
      promptText,
      summaryDisplayPath: handoff.displayPath,
      source: handoff,
      options,
    })
    return
  }

  const flowId = options.flow || await pickFlowInteractively({ includeAdHoc: false, projectRoot, options })
  if (clack.isCancel(flowId)) return
  console.log(`Including prior results summary:\n${handoff.displayPath}`)
  await handleRun(flowId, {
    ...options,
    projectRoot,
    context: joinContext(options.context, promptText),
  })
}

async function handlePreviewBoxes(flowId, options) {
  const projectRoot = options.projectRoot || process.cwd()
  const id = flowId || (await pickFlowInteractively({ includeAdHoc: false, projectRoot, options }))
  if (isAdHocRunTarget(id)) {
    throw new Error('Preview boxes are only available for workflows.')
  }
  const flow = await loadFlow(id, flowLoadOptions(options, projectRoot))
  const steps = flow.steps.filter((step) => (step.agents || []).length > 0)
  const transport = isNetlifyApiTransport(options.transport) ? NETLIFY_API_TRANSPORT : 'github'
  printFlowPlan({
    flow,
    steps,
    transport,
    branch: options.branch || 'master',
    context: options.context || '',
  })
  const lastStep = steps[steps.length - 1]
  const fakeRunState = {
    steps: steps.map((step, i) => ({
      ...step,
      status: 'completed',
      runs: step.agents.map((agent) => ({
        agent,
        status: 'completed',
        runnerId: `preview-runner-${i}-${agent}`,
        issueUrl: `https://github.com/example/repo/issues/${100 + i}`,
        commentUrl: i === steps.length - 1
          ? `https://github.com/example/repo/issues/${100 + i}#issuecomment-9999999`
          : '',
        deployUrl: '',
        prUrl: '',
      })),
    })),
  }
  printSuccessBox({ flow, runState: fakeRunState, transport, projectRoot })
}

/** @param {Record<string, any>} param0 */
async function selectSearchableOption({
  clack,
  message,
  options,
  placeholder = 'Type to filter...',
  maxItems = 10,
}) {
  if (typeof clack.autocomplete === 'function') {
    return clack.autocomplete({
      message,
      placeholder,
      options,
      maxItems,
    })
  }

  return clack.select({ message, options, maxItems })
}

function ansiColor(code, value) {
  if (process.env.NO_COLOR && !process.env.FORCE_COLOR) return value
  return `\x1b[${code}m${value}\x1b[39m`
}

function terminalTrafficLights() {
  return [
    ansiColor(31, '●'),
    ansiColor(33, '●'),
    ansiColor(32, '●'),
  ].join(' ')
}

function printInteractiveIntroBox() {
  const teal = '#0d9488'
  console.log(makeBox({
    title: {
      left: 'Netlify Agent Runner Executor',
      right: terminalTrafficLights(),
    },
    content: {
      left: "Run a single agent or orchestrate a multi-step agentic workflow using\nthe world's leading AI coding tools: Claude Code, Codex, and Gemini",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 0,
      paddingBottom: 0,
    },
    borderStyle: 'rounded',
    borderColor: teal,
    maxWidth: 88,
    wrapText: true,
  }))
}

/** @param {Record<string, any>} param0 */
async function pickFlowInteractively({ includeAdHoc = true, projectRoot = process.cwd(), options = {} } = {}) {
  const clack = await loadClack()
  const flows = await listFlows(flowLoadOptions(options, projectRoot))
  if (includeAdHoc) {
    printInteractiveIntroBox()
  }
  const choices = [
    ...(includeAdHoc ? [AD_HOC_RUN_CHOICE] : []),
    ...flows.map((flow) => ({
      value: flow.id,
      label: workflowPickerLabel(flow, { includeAdHoc }),
      hint: workflowPickerHint(flow),
    })),
    ...(includeAdHoc ? [{ value: 'cancel', label: 'Cancel' }] : []),
  ]
  const selected = await selectSearchableOption({
    clack,
    message: includeAdHoc ? 'What do you want to run?' : 'Choose workflow',
    options: choices,
    placeholder: 'Type to filter workflows...',
  })
  if (clack.isCancel(selected) || selected === 'cancel') process.exit(0)
  return selected
}

async function chooseAdHocAgentInteractively(initialAgent) {
  if (initialAgent) return initialAgent
  const clack = await loadClack()
  const selected = await clack.select({
    message: 'Choose agent',
    options: DEFAULT_MODELS.map((model) => ({ value: model, label: titleCase(model) })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

async function promptForAdHocAgentPrompt(initialPrompt) {
  const prompt = String(initialPrompt || '').trim()
  if (prompt) return prompt
  if (!process.stdin.isTTY) {
    throw new Error('Netlify agent run prompt is required in non-TTY mode. Pass --prompt "..." or --context "...".')
  }
  const value = await multiline({
    message: 'Prompt for the Netlify agent run',
    placeholder: 'Describe what you want this agent to do.',
  })
  const text = String(value || '').trim()
  if (!text) throw new Error('Netlify agent run prompt cannot be empty.')
  return text
}

/** @param {Record<string, any>} param0 */
async function chooseTransportInteractively({ requested, projectRoot }) {
  const clack = await loadClack()
  const detections = detectTransports({ projectRoot })
  if (requested && requested !== 'auto') return resolveTransport(requested, detections)

  const available = detections.filter((transport) => transport.available)
  if (available.length === 1) return available[0].id
  if (available.length === 0) {
    throw new Error(formatTransportSetupHelp(detections))
  }

  const selected = await clack.select({
    message: 'Where should nax orchestrate this workflow?',
    options: available.map((transport) => ({
      value: transport.id,
      label: transport.title,
      hint: `ready — ${transport.reason}`,
    })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

function orderSingleRunTransports(transports = []) {
  return [...transports].sort((a, b) => {
    if (a.id === NETLIFY_API_TRANSPORT) return -1
    if (b.id === NETLIFY_API_TRANSPORT) return 1
    return 0
  })
}

/** @param {Record<string, any>} param0 */
async function chooseSingleRunTransportInteractively({ requested, projectRoot }) {
  const detections = detectTransports({ projectRoot })
  if (requested && requested !== 'auto') {
    return resolveTransport(requested, detections)
  }
  const available = detections.filter((transport) => transport.available)
  if (available.length === 0) {
    throw new Error(formatTransportSetupHelp(detections))
  }
  if (!process.stdin.isTTY || available.length === 1) return available[0].id

  const clack = await loadClack()
  const selected = await clack.select({
    message: 'Where should we run this Netlify agent?',
    options: orderSingleRunTransports(available).map((transport) => ({
      value: transport.id,
      label: transport.title,
      hint: `ready — ${transport.reason}`,
    })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

async function collectFlowOptions(flow, options) {
  if (!process.stdin.isTTY || options.yes) return options
  const clack = await loadClack()
  const resolved = { ...options }
  for (const [key, spec] of Object.entries(flow.options || {})) {
    if (resolved[key]) continue
    const required = spec && spec.required === true
    if (!required) continue
    const value = await clack.text({
      message: spec.prompt || key,
      validate: (input) => (input && input.trim() ? undefined : `${key} is required`),
    })
    if (clack.isCancel(value)) process.exit(0)
    resolved[key] = value.trim()
  }
  return resolved
}

function flowAgents(flow) {
  const agents = []
  for (const agent of normalizeArray(flow.defaults?.agents)) agents.push(agent)
  for (const step of flow.steps || []) {
    for (const agent of normalizeArray(step.agents)) agents.push(agent)
  }
  return [...new Set(agents.filter(Boolean))]
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

function withSelectedAgents(flow, selectedAgents) {
  return applyAgentSelection(flow, { models: selectedAgents })
}

function selectedStepModels(options = {}) {
  return parseStepModelsEntries(options.stepModels || [])
}

function withSelectedStepModels(flow, options = {}) {
  const models = parseCsv(options.models)
  const stepModels = selectedStepModels(options)
  const selection = { models, stepModels }
  assertValidAgentSelection(flow, selection)
  return {
    flow: applyAgentSelection(flow, selection),
    stepModels,
  }
}

function runnableSteps(flow, options) {
  return findStepRange(flow, options).filter((step) => isHumanReviewStep(step) || normalizeArray(step.agents).length > 0)
}

function resolveStepDescription(flow, step) {
  if (step.description) return step.description
  try {
    return loadStepPrompt(flow, step).description || ''
  } catch (_err) {
    return ''
  }
}

function stepActionLabel(step, transport) {
  const action = String(step.action || 'issue')
  const submit = String(step.submit || 'new-run')
  if (isNetlifyApiTransport(transport)) {
    if (submit === 'new-run') return 'new agent run'
    if (submit === 'follow-up') return 'follow-up session'
    return submit
  }
  if (action === 'issue' && submit === 'new-run') return 'new issue'
  if (action === 'comment' && submit === 'follow-up') return 'follow-up comment'
  if (action === 'comment') return 'comment'
  if (action === 'issue') return 'issue'
  return [action, submit].filter(Boolean).join(' / ')
}

function wordWrap(text, width) {
  if (!text) return ''
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    lines.push(line)
  }
  return lines.join('\n')
}

function isUrlLine(line) {
  return /^https?:\/\//.test(String(line || '').trim())
}

function wrapBoxLines(lines, width) {
  return lines.map((line) => (isUrlLine(line) ? line : wordWrap(line, width))).join('\n')
}

const STEP_MAX_WIDTH = 200
const OUTER_TERMINAL_RATIO = 0.8

/** @param {Record<string, any>} param0 */
function printFlowPlan({ flow, steps, transport, branch, context, runState = null }) {
  const terminalWidth = process.stdout.columns || 100
  const outerMaxWidth = Math.max(60, Math.floor(terminalWidth * OUTER_TERMINAL_RATIO))
  const decorations = resumeStepDecorations({ steps, runState })
  const savedStepsById = new Map((runState?.steps || []).map((step) => [step.id, step]))
  const hasContext = context && context.trim()
  const flowDescriptionLines = flow.description
    ? wordWrap(flow.description, outerMaxWidth - 6).split('\n')
    : []
  const metaLines = [
    ...flowDescriptionLines,
    ...(flowDescriptionLines.length > 0 ? [''] : []),
    `Orchestrated via: ${isNetlifyApiTransport(transport) ? 'Netlify API' : 'GitHub Actions'}`,
    `Branch: ${branch}`,
    ...(hasContext ? ['Additional context: yes'] : []),
  ]
  const headings = steps.map((step, i) => `${i + 1}. ${step.title}`)
  const actionLabels = steps.map((step) => {
    const label = stepActionLabel(step, transport)
    const stateLabel = decorations.get(step.id)?.label
    return stateLabel ? `${stateLabel} · ${label}` : label
  })
  const descriptions = steps.map((step) => resolveStepDescription(flow, step))
  const chipsWidth = (agents) =>
    agents.reduce((sum, a) => sum + titleCase(a).length + 4, 0) + Math.max(0, agents.length - 1)
  const naturalStepInner = Math.max(
    ...headings.map((h, i) => h.length + actionLabels[i].length + 2),
    ...descriptions.map((d) => d.length),
    ...steps.map((step) => chipsWidth(step.agents)),
  )
  const targetStepInner = Math.min(naturalStepInner, STEP_MAX_WIDTH - 6, outerMaxWidth - 12)
  const wrappedDescriptions = descriptions.map((d) => (d ? wordWrap(d, targetStepInner) : ''))
  const stepWidth = targetStepInner + 6
  const outerInnerNeeded = Math.max(...metaLines.map((l) => l.length), stepWidth)
  const outerWidth = Math.min(outerInnerNeeded + 6, outerMaxWidth)
  const arrowPad = ' '.repeat(Math.floor(stepWidth / 2) - 1)

  const stepBlocks = steps.map((step, i) => {
    const savedStep = savedStepsById.get(step.id)
    const resultsPath = stepResultsSummaryPath({
      runState,
      savedStep,
      projectRoot: runState?.projectRoot || process.cwd(),
    })
    const chips = makeHorizontalBoxes(
      step.agents.map((agent) => {
        const color = resumeStatusColor(savedAgentStatus(savedStep, agent))
        const label = titleCase(agent)
        return {
          content: color ? colorText(label, color) : label,
          borderStyle: 'rounded',
          borderColor: color || undefined,
          paddingLeft: 1,
          paddingRight: 1,
        }
      }),
      { gap: 1 },
    )
    const lines = [
      wrappedDescriptions[i],
      chips,
      resultsPath ? `Results: ${resultsPath}` : '',
    ].filter(Boolean)
    const content = lines.join('\n')
    const decoration = decorations.get(step.id)
    const stepBorderColor = decoration?.label === 'completed'
      ? SUCCESS_COLOR
      : decoration?.label === 'pending'
        ? MUTED_COLOR
        : TEAL_COLOR
    const box = makeBox({
      title: {
        left: headings[i],
        right: actionLabels[i],
      },
      content,
      borderStyle: 'rounded',
      borderColor: stepBorderColor,
      width: stepWidth,
    })
    if (i === steps.length - 1) return box
    return `${box}\n${arrowPad}│\n${arrowPad}▼`
  }).join('\n')

  console.log('')
  console.log(makeBox({
    title: `Multi step agent workflow: "${flow.title}"`,
    content: `${metaLines.join('\n')}\n\n${stepBlocks}`,
    borderStyle: 'rounded',
    borderColor: TEAL_COLOR,
    width: outerWidth,
  }))
  console.log('')
}

function finalRunForRunState(runState) {
  const completed = (runState.steps || []).filter((s) => s.status === 'completed' || s.status === 'dry-run')
  if (completed.length === 0) return null
  const lastStep = completed[completed.length - 1]
  const runs = (lastStep.runs || []).filter((r) => r.status === 'completed' || r.status === 'dry-run')
  if (runs.length === 0) return null
  return { step: lastStep, run: runs[runs.length - 1] }
}

/** @param {Record<string, any>} param0 */
function localAgentRunUrl({ projectRoot, runnerId, sessionId, options = {} }) {
  if (!runnerId) return ''
  const expectedSiteId = String(options.netlifySiteId || options.siteId || '').trim()
  try {
    const statusRoot = configDirForNetlifyOptions(projectRoot, options)
    const env = expectedSiteId ? { ...process.env, NETLIFY_SITE_ID: expectedSiteId } : process.env
    const project = /** @type {Record<string, any> | null} */ (readNetlifyProject(statusRoot, env))
    if (expectedSiteId && project?.siteId && project.siteId !== expectedSiteId) return ''
    if (project?.adminUrl) {
      return formatAgentRunUrlFromAdminUrl(project.adminUrl, runnerId, sessionId)
    }
    if (project?.siteName) return formatAgentRunUrl(project.siteName, runnerId, sessionId)
  } catch (_err) {
    /* ignore */
  }
  return ''
}

/** @param {Record<string, any>} param0 */
function formatSubmittedLocalRunBoxes({ runs = [], prompt = {}, projectRoot, options = {} }) {
  if (runs.length === 0) return ''
  const teal = '#0d9488'
  const terminalWidth = process.stdout.columns || 120
  const ttyWidth = Math.min(120, Math.max(76, Math.floor(terminalWidth * 0.95)))
  return runs.map((run) => {
    const label = `${titleCase(run.agent)} ${prompt.title || 'Agent Run'}`
    const titleRight = run.sessionId || run.runnerId || ''
    const runUrl = run.links?.sessionUrl ||
      run.links?.agentRunUrl ||
      (projectRoot ? localAgentRunUrl({ projectRoot, runnerId: run.runnerId, sessionId: run.sessionId, options }) : '')
    const content = [
      `Status: ${run.status || 'submitted'}`,
      run.existingRunnerId ? 'Type: follow-up session' : 'Type: new agent run',
      `Runner ID: ${run.runnerId || 'unknown'}`,
      run.sessionId ? `Session ID: ${run.sessionId}` : '',
      Number.isFinite(run.submittedAfterSeconds) ? `Submitted after: ${run.submittedAfterSeconds}s` : '',
      runUrl ? `View run:\n${runUrl}` : '',
    ].filter(Boolean).join('\n')
    const longest = Math.max(
      label.length + titleRight.length + 4,
      ...content.split('\n').map((line) => line.length),
    )
    const width = process.stdout.isTTY ? ttyWidth : longest + 6
    return makeBox({
      title: {
        left: label,
        right: titleRight,
      },
      content,
      borderStyle: 'rounded',
      borderColor: teal,
      width,
    })
  }).join('\n')
}

/** @param {Record<string, any>} param0 */
function printSuccessBox({ flow, runState, transport, projectRoot }) {
  const green = '#22c55e'
  const final = finalRunForRunState(runState)
  if (!final) return
  const lines = [`Workflow "${flow.title}" complete.`, `Final step: ${final.step.title}`]
  const usage = usageSummariesForRunState(runState)
  if (isNetlifyApiTransport(transport)) {
    const url = final.run.links?.sessionUrl ||
      final.run.links?.agentRunUrl ||
      localAgentRunUrl({ projectRoot, runnerId: final.run.runnerId, sessionId: final.run.sessionId })
    if (url) {
      lines.push('Final agent run:', url)
    } else if (final.run.runnerId) {
      lines.push(`Final agent runner ID: ${final.run.runnerId}`)
    }
    if (final.run.deployUrl) lines.push('Deploy:', final.run.deployUrl)
    if (final.run.prUrl) lines.push('PR:', final.run.prUrl)
  } else {
    const url = final.run.commentUrl || final.run.issueUrl
    if (url) lines.push('Final result:', url)
  }
  if (usage.totalSummary) {
    lines.push(`Total usage: ${usage.totalSummary}`)
    for (const step of usage.steps) {
      lines.push(`Usage ${step.title}: ${step.summary}`)
    }
  }
  const artifactsRoot = artifactsRootForRunState(runState)
  if (artifactsRoot) lines.push('Artifacts:', artifactsRoot)
  const terminalWidth = process.stdout.columns || 100
  const outerMax = Math.max(60, Math.floor(terminalWidth * OUTER_TERMINAL_RATIO))
  const wrapped = wrapBoxLines(lines, outerMax - 6)
  const longest = Math.max(...wrapped.split('\n').map((l) => l.length))
  const width = process.stdout.isTTY ? Math.min(longest + 6, outerMax) : longest + 6
  console.log('')
  console.log(makeBox({
    title: 'Success',
    content: wrapped,
    borderStyle: 'rounded',
    borderColor: green,
    width,
  }))
  console.log('')
}

function handoffSummaryPath(runState = {}) {
  const root = artifactsRootForRunState(runState)
  return root ? path.join(root, 'summary.md') : ''
}

function relativeHandoffPath(projectRoot, summaryPath) {
  const relative = path.relative(projectRoot || process.cwd(), summaryPath)
  return relative && !relative.startsWith('..') ? relative : summaryPath
}

/** @param {any} projectRoot @param {Record<string, any>} param1 */
function findRunStateForHandoff(projectRoot, { runId } = {}) {
  const states = listRunStates(projectRoot)
  if (runId) {
    const matched = states.find((state) => state.runId === runId)
    if (!matched) throw new Error(`Could not find workflow ${runId} under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    return matched
  }
  return states[0] || null
}

/** @param {Record<string, any>} param0 */
function readHandoffSummary({ projectRoot, runId } = {}) {
  if (runId) {
    const runState = findRunStateForHandoff(projectRoot, { runId })
    if (!runState) throw new Error(`No nax workflows found under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    persistWorkflowArtifacts(runState, { summaryOnly: true })
    const summaryPath = handoffSummaryPath(runState)
    if (!summaryPath || !fs.existsSync(summaryPath)) {
      throw new Error(`Workflow ${runState.runId} does not have a handoff summary yet.`)
    }
    const summaryText = fs.readFileSync(summaryPath, 'utf8').trim()
    if (!summaryText) throw new Error(`Workflow ${runState.runId} has an empty handoff summary.`)
    return {
      kind: 'workflow',
      id: runState.runId,
      title: runState.flowTitle || runState.flowId || runState.runId,
      runState,
      summaryPath,
      displayPath: relativeHandoffPath(projectRoot, summaryPath),
      summaryText,
    }
  }
  return readHandoffSource(projectRoot)
}

/** @param {Record<string, any>} param0 */
function readSelectedHandoffSource({ projectRoot, runId = '', options = {} } = {}) {
  const query = handoffSourceQuery({ runId, options })
  return readHandoffSource(projectRoot, query)
}

/** @param {Record<string, any>} param0 */
function buildHandoffPrompt({ instructions = '', summaryPath = '', summaryText = '' } = {}) {
  return [
    String(instructions || '').trim()
      ? ['# Additional Instructions', '', String(instructions).trim()].join('\n')
      : '',
    [
      '# Prior Results Summary',
      '',
      summaryPath ? `Source: ${summaryPath}` : '',
      '',
      String(summaryText || '').trim(),
    ].filter((line) => line !== '').join('\n'),
  ].filter(Boolean).join('\n\n---\n\n')
}

function printPostSuccessHandoffHint(runState, projectRoot) {
  if (!process.stdout.isTTY) return
  const summaryPath = handoffSummaryPath(runState)
  if (!summaryPath || !fs.existsSync(summaryPath)) return
  const displayPath = relativeHandoffPath(projectRoot, summaryPath)
  console.log(`The results from your workflow are in ${displayPath}`)
  console.log('')
  console.log('Hand them off to another agent with:')
  console.log('')
  console.log('nax handoff')
  console.log('')
}

/** @param {any} text @param {Record<string, any>} param1 */
function copyToClipboard(text, { platform = process.platform, runCommand = spawnSync } = {}) {
  const candidates = platform === 'darwin'
    ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
  for (const [command, args] of candidates) {
    const result = runCommand(command, args, { input: text, encoding: 'utf8' })
    if (result.status === 0) return command
  }
  throw new Error(platform === 'darwin'
    ? 'Could not copy to clipboard with pbcopy.'
    : 'Could not copy to clipboard. Install wl-copy or xclip, or open the summary file directly.')
}

/** @param {any} source @param {Record<string, any>} param1 */
async function openHandoffSource(source = {}, { projectRoot = process.cwd(), opener } = {}) {
  const summaryPath = source.summaryPath || source.displayPath || ''
  if (!summaryPath) throw new Error('No previous results file path is available to open.')
  const absolutePath = path.isAbsolute(summaryPath) ? summaryPath : path.resolve(projectRoot, summaryPath)
  if (!fs.existsSync(absolutePath)) throw new Error(`Previous results file does not exist: ${absolutePath}`)
  const openFile = opener || (await import('open')).default
  await openFile(absolutePath)
  return absolutePath
}

function artifactDirectoryHasFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && artifactDirectoryHasFiles(path.join(dir, entry.name))) return true
  }
  return false
}

function printPartialArtifactHint(runState) {
  const dir = artifactsRootForRunState(runState)
  if (!artifactDirectoryHasFiles(dir)) return
  console.log('')
  console.log(`Partial artifacts: ${dir}`)
  if (runState?.flowId) console.log(`Resume:            nax run ${runState.flowId}`)
  console.log('')
}

/** @param {Record<string, any>} param0 */
async function prepareInteractiveFlowRun({ flow, options, transport, projectRoot }) {
  if (!process.stdin.isTTY || options.yes) {
    const { flow: configuredFlow, stepModels } = withSelectedStepModels(flow, options)
    const configuredOptions = {
      ...options,
      stepModels,
    }
    const steps = runnableSteps(configuredFlow, configuredOptions)
    if (steps.length === 0) {
      throw new Error('No workflow steps have selected agents.')
    }
    return {
      flow: configuredFlow,
      options: configuredOptions,
      steps,
      previewPrinted: false,
    }
  }

  const clack = await loadClack()
  const agents = flowAgents(flow)
  const requestedStepModels = selectedStepModels(options)
  let selectedAgents = parseCsv(options.models)
  if (selectedAgents.length === 0 && Object.keys(requestedStepModels).length > 0) {
    selectedAgents = agents
  }
  if (selectedAgents.length === 0) {
    const selected = await clack.multiselect({
      message: 'Choose Netlify agent models',
      options: agents.map((agent) => ({
        value: agent,
        label: titleCase(agent),
      })),
      initialValues: agents,
      required: true,
    })
    if (clack.isCancel(selected)) process.exit(0)
    selectedAgents = selected
  }

  let manualContext = readManualContext(options)
  if (!manualContext && options.contextPrompt !== false) {
    manualContext = await multiline({
      message: 'Additional context/instructions (optional)',
      placeholder: 'Hit enter to proceed. Ok if this is empty.',
    })
  }

  const configuredOptions = {
    ...options,
    context: manualContext || options.context,
    models: selectedAgents.join(','),
    stepModels: requestedStepModels,
  }
  assertValidAgentSelection(flow, {
    models: selectedAgents,
    stepModels: configuredOptions.stepModels,
  })
  const configuredFlow = applyAgentSelection(flow, {
    models: selectedAgents,
    stepModels: configuredOptions.stepModels,
  })
  const steps = runnableSteps(configuredFlow, configuredOptions)
  if (steps.length === 0) {
    throw new Error('No workflow steps have selected agents.')
  }

  await confirmRemoteRunnerCanMissLocalChanges({
    projectRoot,
    branch: configuredOptions.branch,
    options: configuredOptions,
  })

  printFlowPlan({
    flow: configuredFlow,
    steps,
    transport,
    branch: configuredOptions.branch,
    context: manualContext,
  })

  if (configuredOptions.dryRun) {
    console.log('Dry run only. No issues, comments, Agent Runner jobs, or .nax artifacts will be created.')
    return {
      flow: configuredFlow,
      options: configuredOptions,
      steps,
      previewPrinted: true,
    }
  }

  const confirmed = await clack.confirm({
    message: `Start the "${configuredFlow.title}" agent workflow?`,
    initialValue: true,
  })
  if (clack.isCancel(confirmed)) process.exit(0)
  if (!confirmed) {
    console.log('Cancelled')
    process.exit(0)
  }

  return {
    flow: configuredFlow,
    options: configuredOptions,
    steps,
    previewPrinted: true,
  }
}

function findStepRange(flow, options) {
  let steps = flow.steps
  if (options.step) {
    steps = steps.filter((step) => step.id === options.step)
    if (steps.length === 0) throw new Error(`Unknown step "${options.step}" in flow "${flow.id}"`)
  }
  if (options.fromStep) {
    const index = flow.steps.findIndex((step) => step.id === options.fromStep)
    if (index === -1) throw new Error(`Unknown from-step "${options.fromStep}" in flow "${flow.id}"`)
    steps = flow.steps.slice(index)
  }
  return steps
}

function issueNumbersFromStep(stepState) {
  return (stepState?.runs || [])
    .map((run) => run.issueNumber)
    .filter((number) => Number.isFinite(number))
}

function runsFromStep(stepState) {
  return Array.isArray(stepState?.runs) ? stepState.runs : []
}

function uniqueNumbers(numbers) {
  return [...new Set(numbers.filter((number) => Number.isFinite(number)))]
}

function sourceIssueNumbersForStep(step, completedStepStates) {
  if (!Array.isArray(step.input)) return []
  const numbers = []
  for (const input of step.input) {
    numbers.push(...issueNumbersFromStep(completedStepStates.get(input.step)))
  }
  return uniqueNumbers(numbers)
}

function sourceRunsForStep(step, completedStepStates) {
  if (!Array.isArray(step.input)) return []
  const runs = []
  for (const input of step.input) {
    const seen = new Set()
    for (const run of runsFromStep(completedStepStates.get(input.step))) {
      const key = run.runnerId || `${run.agent}:${run.stepId || input.step}:${runs.length}`
      if (seen.has(key)) continue
      seen.add(key)
      runs.push({ ...run, sourceStep: input.step })
    }
  }
  return runs
}

function formatLocalRunResults(runs) {
  const completed = runs.filter((run) => run.resultText && run.resultText.trim())
  if (completed.length === 0) return ''

  const parts = ['## Prior Agent Results']
  for (const run of completed) {
    const source = run.sourceStep ? ` from ${run.sourceStep}` : ''
    const title = `${titleCase(run.agent || 'agent')}${source}`
    parts.push(
      '',
      `<details>`,
      `<summary>${title}</summary>`,
      '',
      run.resultText.trim(),
      '',
      `</details>`,
    )
  }
  return parts.join('\n')
}

function compactTextForRetry(text, limit, label = 'content') {
  const value = String(text || '').trim()
  if (!value || value.length <= limit) return value
  if (limit < 200) return value.slice(0, limit).trim()

  const note = `\n\n[${label} compacted from ${value.length} chars for retry after Netlify runner argument limit. Middle omitted.]\n\n`
  const available = Math.max(0, limit - note.length)
  const headLength = Math.ceil(available * 0.65)
  const tailLength = Math.max(0, available - headLength)
  return `${value.slice(0, headLength).trimEnd()}${note}${value.slice(value.length - tailLength).trimStart()}`
}

function localSafePromptBytes(options = {}) {
  return safePromptBytes({
    safePromptBytes: options.safePromptBytes || options.safePromptBytes === 0
      ? options.safePromptBytes
      : options.promptSafeBytes || process.env.NAX_SAFE_PROMPT_BYTES || DEFAULT_LOCAL_SAFE_PROMPT_BYTES,
  })
}

function compactLocalTextByBytes(text, limit, label = 'content') {
  return compactTextByBytes(text, Math.max(0, Number(limit) || 0), label)
}

/** @param {any} runs @param {Record<string, any>} param1 */
function formatCompactLocalRunResults(runs, {
  perRunLimit = COMPACT_LOCAL_RESULT_CHAR_LIMIT,
  totalLimit = COMPACT_LOCAL_RESULTS_TOTAL_LIMIT,
} = {}) {
  const completed = runs.filter((run) => run.resultText && run.resultText.trim())
  if (completed.length === 0) return ''

  const parts = ['## Prior Agent Results']
  let used = utf8ByteLength(parts[0])
  for (let index = 0; index < completed.length; index += 1) {
    const run = completed[index]
    const source = run.sourceStep ? ` from ${run.sourceStep}` : ''
    const title = `${titleCase(run.agent || 'agent')}${source}`
    const blockPrefix = ['', `<details>`, `<summary>${title}</summary>`, ''].join('\n')
    const blockSuffix = ['', `</details>`].join('\n')
    const remaining = totalLimit - used
    const contentLimit = Math.min(perRunLimit, remaining - utf8ByteLength(blockPrefix) - utf8ByteLength(blockSuffix))
    if (contentLimit < 200) {
      parts.push('', `[${completed.length - index} prior results omitted to fit retry prompt size.]`)
      break
    }
    const content = compactLocalTextByBytes(run.resultText, contentLimit, `${title} result`)
    const block = [
      '',
      `<details>`,
      `<summary>${title}</summary>`,
      '',
      content,
      '',
      `</details>`,
    ].join('\n')
    parts.push(block)
    used += utf8ByteLength(block)
  }
  return compactLocalTextByBytes(parts.join('\n'), totalLimit, 'Prior Agent Results')
}

/** @param {Record<string, any>} param0 */
function buildLocalAgentPrompt({ model, prompt, context, roundResults }) {
  const summaryLabel = `${titleCase(prompt.name)} instructions`
  const parts = [
    `${titleCase(model)}: ${prompt.instruction}`.trim(),
    '',
    '<details>',
    `<summary>${summaryLabel}</summary>`,
    '',
    prompt.body,
    '',
    '</details>',
  ]

  if (roundResults && roundResults.trim()) {
    parts.push('', '---', '', roundResults.trim())
  }

  if (context && context.trim()) {
    parts.push('', '---', '', '## Additional Context', '', context.trim())
  }

  return parts.join('\n')
}

function renderStructuredForLocalEssentials(resultText) {
  const section = extractStructuredSection(resultText)
  if (!section) return ''
  return [
    section.heading,
    '',
    '```json',
    section.json,
    '```',
  ].join('\n')
}

function blobOffloadDisabled(options = {}) {
  return options.promptBlobDisable === true || process.env.NAX_PROMPT_BLOB_DISABLE === '1' || /^true$/i.test(process.env.NAX_PROMPT_BLOB_DISABLE || '')
}

function localPromptByteMetrics(promptText, compactPromptText, safeBytes) {
  return {
    promptBytes: utf8ByteLength(promptText),
    compactPromptBytes: utf8ByteLength(compactPromptText),
    safePromptBytes: safeBytes,
  }
}

/** @param {Record<string, any>} param0 */
function ensureStepBlobOffload({
  sourceRuns,
  roundResults,
  payloadText,
  refKind = 'prior-results',
  refStepId,
  runState,
  stepState,
  step,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
  onRetry = () => {},
} = {}) {
  if (!dryRun) {
    const contextError = blobOffloadContextError(netlify)
    if (contextError) throw new Error(contextError)
  }
  const seed = payloadText || roundResults || formatLocalRunResults(sourceRuns)
  const ref = blobRefForStep({
    runId: runState.runId,
    stepId: refStepId || step.id,
    payloadSeed: seed,
    kind: refKind,
  })
  if (stepState.promptBlobRef?.store === ref.store && stepState.promptBlobRef?.key === ref.key) return stepState.promptBlobRef
  const blobPayload = buildBlobPayload({ fullResults: seed, sentinel: ref.sentinel })
  const localDebug = dryRun
    ? {}
    : writeLocalBlobDebugPayload({
      runState,
      stepState,
      ref: { ...ref, kind: refKind },
      payload: blobPayload,
      kind: refKind,
      projectRoot,
    })
  const refInput = {
    ...ref,
    kind: refKind,
    ...localDebug,
    status: dryRun ? 'dry-run' : 'active',
  }
  const entry = dryRun
    ? {
      id: `${runState.runId || ''}:${ref.store}:${ref.key}`,
      runId: runState.runId || '',
      stepId: stepState.id || '',
      ...refInput,
      createdAt: new Date().toISOString(),
      cleanupAttempts: 0,
      lastCleanupError: '',
    }
    : addRunBlobRef(runState, stepState, refInput)
  if (dryRun) {
    runState.blobRefs = [...(Array.isArray(runState.blobRefs) ? runState.blobRefs : []), entry]
    stepState.blobRefs = [...(Array.isArray(stepState.blobRefs) ? stepState.blobRefs : []), entry]
  }
  stepState.promptBlobRef = entry
  if (!dryRun) {
    setBlob({
      store: ref.store,
      key: ref.key,
      value: blobPayload,
      siteId: netlify.siteId,
      token: netlify.env?.NETLIFY_AUTH_TOKEN,
      cwd: projectRoot,
      env: netlify.env,
      onRetry,
    })
  }
  return entry
}

/** @param {Record<string, any>} param0 */
function buildSafeCompactLocalPrompt({ agent, prompt, stepContext, sourceRuns, safeBytes }) {
  const basePrompt = buildLocalAgentPrompt({ model: agent, prompt, context: '', roundResults: '' })
  const remaining = Math.max(800, safeBytes - utf8ByteLength(basePrompt) - 400)
  const resultBudget = Math.floor(remaining * 0.7)
  const contextBudget = Math.max(0, remaining - resultBudget)
  const compactRoundResults = formatCompactLocalRunResults(sourceRuns, {
    totalLimit: resultBudget,
    perRunLimit: Math.max(500, Math.floor(resultBudget / Math.max(1, sourceRuns.length))),
  })
  const compactContext = compactLocalTextByBytes(stepContext, contextBudget, 'Additional Context')
  return buildLocalAgentPrompt({
    model: agent,
    prompt,
    context: compactContext,
    roundResults: compactRoundResults,
  })
}

/** @param {Record<string, any>} param0 */
function buildOffloadedRoundResults({ sourceRuns, blobRef, safeBytes }) {
  const essentialsBytes = Math.max(1200, Math.floor(safeBytes * 0.55))
  const inlineEssentials = buildInlineEssentials(sourceRuns, {
    renderStructured: renderStructuredForLocalEssentials,
    totalBytes: essentialsBytes,
  })
  const instruction = buildFetchInstruction(blobRef)
  return [inlineEssentials, instruction].filter(Boolean).join('\n\n')
}

function buildFullPromptWrapper({ blobRef }) {
  return buildFetchInstruction({
    ...blobRef,
    kind: 'full-prompt',
  })
}

/** @param {Record<string, any>} param0 */
function ensureFullPromptBlobOffload({
  agent,
  promptText,
  runState,
  stepState,
  step,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
  onRetry = () => {},
} = {}) {
  return ensureStepBlobOffload({
    sourceRuns: [],
    roundResults: '',
    payloadText: promptText,
    refKind: 'full-prompt',
    refStepId: [step?.id || 'step', agent || 'agent'].join('-'),
    runState,
    stepState,
    step,
    projectRoot,
    netlify,
    options,
    dryRun,
    onRetry,
  })
}

/** @param {Record<string, any>} param0 */
function prepareLocalPromptDelivery({
  agent,
  prompt,
  step,
  sourceRuns,
  roundResults,
  stepContext,
  runState,
  stepState,
  projectRoot,
  netlify,
  options = {},
  dryRun = false,
} = {}) {
  const safeBytes = localSafePromptBytes(options)
  const promptText = buildLocalAgentPrompt({
    model: agent,
    prompt,
    context: stepContext,
    roundResults,
  })
  const compactPromptText = buildSafeCompactLocalPrompt({
    agent,
    prompt,
    stepContext,
    sourceRuns,
    safeBytes,
  })
  const metrics = localPromptByteMetrics(promptText, compactPromptText, safeBytes)
  if (metrics.promptBytes <= safeBytes) {
    return {
      promptText,
      compactPromptText: metrics.compactPromptBytes < metrics.promptBytes ? compactPromptText : '',
      promptDelivery: { mode: 'inline', ...metrics },
    }
  }
  if (blobOffloadDisabled(options)) {
    if (metrics.compactPromptBytes <= safeBytes) {
      return {
        promptText: compactPromptText,
        compactPromptText,
        promptDelivery: {
          mode: 'compact',
          fallbackReason: 'blob-offload-disabled',
          ...metrics,
        },
      }
    }
    throw new Error([
      `Prompt for ${agent} ${step.id} is too large for Netlify runner argv and cannot be offloaded.`,
      `Full prompt: ${metrics.promptBytes.toLocaleString()} bytes.`,
      `Compact prompt: ${metrics.compactPromptBytes.toLocaleString()} bytes.`,
      `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
      'Blob offload is disabled by NAX_PROMPT_BLOB_DISABLE.',
    ].join(' '))
  }
  const contextError = dryRun ? '' : blobOffloadContextError(netlify)
  if (contextError) {
    if (metrics.compactPromptBytes <= safeBytes) {
      return {
        promptText: compactPromptText,
        compactPromptText,
        promptDelivery: {
          mode: 'compact',
          fallbackReason: 'blob-context-missing',
          fallbackError: contextError,
          ...metrics,
        },
      }
    }
    throw new Error([
      `Prompt for ${agent} ${step.id} is too large for Netlify runner argv and cannot be offloaded.`,
      `Full prompt: ${metrics.promptBytes.toLocaleString()} bytes.`,
      `Compact prompt: ${metrics.compactPromptBytes.toLocaleString()} bytes.`,
      `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
      contextError,
    ].join(' '))
  }
  let blobRef
  if (sourceRuns.length > 0) {
    try {
      blobRef = ensureStepBlobOffload({
        sourceRuns,
        roundResults,
        runState,
        stepState,
        step,
        projectRoot,
        netlify,
        options,
        dryRun,
        onRetry: ({ nextAttempt, attempts, delayMs, error, store, key }) => {
          const delaySeconds = Math.round(delayMs / 1000)
          console.log(`  Blob ${store}/${key}: retrying upload ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
        },
      })
      const offloadedRoundResults = buildOffloadedRoundResults({ sourceRuns, blobRef, safeBytes })
      const offloadedContext = compactLocalTextByBytes(stepContext, Math.max(0, Math.floor(safeBytes * 0.2)), 'Additional Context')
      const offloadedPromptText = buildLocalAgentPrompt({
        model: agent,
        prompt,
        context: offloadedContext,
        roundResults: offloadedRoundResults,
      })
      const offloadedBytes = utf8ByteLength(offloadedPromptText)
      if (offloadedBytes <= safeBytes) {
        return {
          promptText: offloadedPromptText,
          compactPromptText: compactPromptText && metrics.compactPromptBytes <= safeBytes ? compactPromptText : '',
          promptDelivery: {
            mode: 'blob',
            kind: 'prior-results',
            ...metrics,
            offloadedPromptBytes: offloadedBytes,
            blobRef,
            contextFetchPolicy: options.contextFetchPolicy || step.contextFetchPolicy || 'optional',
          },
          blobRef,
        }
      }
    } catch (error) {
      if (metrics.compactPromptBytes <= safeBytes) {
        return {
          promptText: compactPromptText,
          compactPromptText,
          promptDelivery: {
            mode: 'compact',
            fallbackReason: 'blob-set-failed',
            fallbackError: error?.message || String(error),
            ...metrics,
          },
        }
      }
      throw new Error([
        `Prompt for ${agent} ${step.id} is too large and blob offload failed.`,
        `Full prompt: ${metrics.promptBytes.toLocaleString()} bytes.`,
        `Compact prompt: ${metrics.compactPromptBytes.toLocaleString()} bytes.`,
        `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
        `Blob: ${stepState.promptBlobRef?.store || 'unknown'}/${stepState.promptBlobRef?.key || 'unknown'}.`,
        `Error: ${error?.message || String(error)}`,
      ].join(' '))
    }
  }

  try {
    blobRef = ensureFullPromptBlobOffload({
      agent,
      promptText,
      runState,
      stepState,
      step,
      projectRoot,
      netlify,
      options,
      dryRun,
      onRetry: ({ nextAttempt, attempts, delayMs, error, store, key }) => {
        const delaySeconds = Math.round(delayMs / 1000)
        console.log(`  Blob ${store}/${key}: retrying upload ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
      },
    })
  } catch (error) {
    if (metrics.compactPromptBytes <= safeBytes) {
      return {
        promptText: compactPromptText,
        compactPromptText,
        promptDelivery: {
          mode: 'compact',
          fallbackReason: 'blob-set-failed',
          fallbackError: error?.message || String(error),
          ...metrics,
        },
      }
    }
    throw new Error([
      `Prompt for ${agent} ${step.id} is too large and full-prompt blob offload failed.`,
      `Full prompt: ${metrics.promptBytes.toLocaleString()} bytes.`,
      `Compact prompt: ${metrics.compactPromptBytes.toLocaleString()} bytes.`,
      `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
      `Error: ${error?.message || String(error)}`,
    ].join(' '))
  }
  const offloadedPromptText = buildFullPromptWrapper({ blobRef })
  const offloadedBytes = utf8ByteLength(offloadedPromptText)
  if (offloadedBytes > safeBytes) {
    throw new Error([
      `Full-prompt wrapper for ${agent} ${step.id} still exceeds the safe Netlify runner budget.`,
      `Wrapper prompt: ${offloadedBytes.toLocaleString()} bytes.`,
      `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
      `Blob: ${blobRef.store}/${blobRef.key}.`,
    ].join(' '))
  }
  return {
    promptText: offloadedPromptText,
    compactPromptText: compactPromptText && metrics.compactPromptBytes <= safeBytes ? compactPromptText : '',
    promptDelivery: {
      mode: 'blob',
      kind: 'full-prompt',
      ...metrics,
      offloadedPromptBytes: offloadedBytes,
      blobRef,
      contextFetchPolicy: options.contextFetchPolicy || step.contextFetchPolicy || 'optional',
    },
    blobRef,
  }
}

function applyContextFetchClassification(run) {
  const ref = run.promptDelivery?.blobRef || run.blobRef
  if (!ref || !String(run.resultText || '').trim()) return run
  const classified = classifyContextFetch({
    reply: run.resultText,
    transcript: run.transcript || run.commandTranscript || run.rawResult?.transcript || run.raw?.transcript || '',
    commandOutput: run.commandOutput || run.rawResult?.commandOutput || run.raw?.commandOutput || '',
    fetchExitCode: run.fetchExitCode ?? run.rawResult?.fetchExitCode ?? run.raw?.fetchExitCode ?? null,
    fetchError: run.fetchError || run.rawResult?.fetchError || run.raw?.fetchError || '',
    marker: ref.marker,
    sentinel: ref.sentinel,
  })
  return {
    ...run,
    contextFetchStatus: classified.status,
    contextFetchSignals: classified.signals,
    contextFetchConfirmed: classified.confirmed,
    promptDelivery: {
      ...(run.promptDelivery || {}),
      contextFetchStatus: classified.status,
      contextFetchSignals: classified.signals,
      contextFetchConfirmed: classified.confirmed,
    },
  }
}

function blobRefHasCompletedGithubConsumer(runState = {}, ref = {}) {
  if (runState.transport !== 'github') return true
  const refId = ref.id || `${ref.runId || ''}:${ref.store || ''}:${ref.key || ''}`
  let foundConsumer = false
  for (const step of runState.steps || []) {
    for (const run of step.runs || []) {
      const runRef = run.blobRef || run.promptDelivery?.blobRef
      const runRefId = runRef?.id || `${runRef?.runId || ''}:${runRef?.store || ''}:${runRef?.key || ''}`
      if (runRefId !== refId) continue
      foundConsumer = true
      if (run.contextFetchConfirmed === true || run.promptDelivery?.contextFetchConfirmed === true) return true
      if (['completed', 'failed', 'timeout', 'dry-run'].includes(String(run.status || ''))) return true
    }
  }
  return !foundConsumer
}

/** @param {Record<string, any>} param0 */
function cleanupLocalWorkflowBlobs({ runState, projectRoot, netlify, reason = 'flow-terminal' } = {}) {
  if (!Array.isArray(runState?.blobRefs) || runState.blobRefs.length === 0) return []
  const deferredRefs = runState.transport === 'github'
    ? runState.blobRefs.filter((ref) => !blobRefHasCompletedGithubConsumer(runState, ref))
    : []
  const cleanupState = deferredRefs.length > 0
    ? {
        ...runState,
        blobRefs: runState.blobRefs.filter((ref) => blobRefHasCompletedGithubConsumer(runState, ref)),
      }
    : runState
  const results = cleanupRunBlobRefs(/** @type {any} */ ({
    runState: cleanupState,
    projectRoot,
    siteId: netlify?.siteId,
    token: netlify?.env?.NETLIFY_AUTH_TOKEN,
    env: netlify?.env,
    deleteBlob,
    log: (message) => console.warn(message),
  }))
  const failed = results.filter((result) => !result.ok)
  if (failed.length > 0) {
    runState.blobCleanupWarning = `${failed.length} prompt blob cleanup ${failed.length === 1 ? 'operation' : 'operations'} pending after ${reason}. Run "nax clean blobs --force" later.`
  }
  if (deferredRefs.length > 0) {
    runState.blobRefs = [...(cleanupState.blobRefs || []), ...deferredRefs]
    runState.blobCleanupWarning = `${deferredRefs.length} GitHub prompt blob ${deferredRefs.length === 1 ? 'ref was' : 'refs were'} left for TTL cleanup because consumer completion/fetch confirmation was not proven.`
  }
  return results
}

/** @param {Record<string, any>} param0 */
function cleanupWorkflowBlobsForRun({ runState, projectRoot, options = {}, reason = 'flow-terminal' } = {}) {
  if (!Array.isArray(runState?.blobRefs) || runState.blobRefs.length === 0) return []
  const netlify = resolveNetlifyProjectTarget({
    projectRoot,
    siteId: options.netlifySiteId,
    filter: options.filter,
    netlifyConfig: options.netlifyConfig,
  })
  return cleanupLocalWorkflowBlobs({ runState, projectRoot, netlify, reason })
}

function cancellableLocalRunnerIds(runState = {}) {
  const terminal = new Set(['completed', 'failed', 'timeout', 'cancelled', 'canceled', 'dry-run'])
  const ids = []
  for (const step of Array.isArray(runState.steps) ? runState.steps : []) {
    for (const run of Array.isArray(step.runs) ? step.runs : []) {
      const runnerId = String(run.runnerId || '').trim()
      if (!runnerId || run.existingRunnerId) continue
      if (terminal.has(String(run.status || '').toLowerCase())) continue
      ids.push(runnerId)
    }
  }
  return [...new Set(ids)]
}

/** @param {Record<string, any>} param0 */
function cancelLocalWorkflowRunnersForInterrupt({ runState, projectRoot, options = {}, reason = 'interrupted workflow', stopRun = stopAgentRun } = {}) {
  if (!isNetlifyApiTransport(runState?.transport)) return { runnerIds: [], stopped: [], warnings: [] }
  const runnerIds = cancellableLocalRunnerIds(runState)
  if (runnerIds.length === 0) return { runnerIds, stopped: [], warnings: [] }
  let env = process.env
  try {
    env = resolveNetlifyProjectTarget({
      projectRoot,
      siteId: options.netlifySiteId || runState.options?.netlifySiteId,
      filter: options.filter || runState.options?.filter,
      netlifyConfig: options.netlifyConfig || runState.options?.netlifyConfig,
    }).env
  } catch (_err) {
    env = process.env
  }
  const stopped = []
  const warnings = []
  for (const runnerId of runnerIds) {
    try {
      const result = stopRun({ projectRoot, runnerId, env })
      if (result?.stopped === true) stopped.push(runnerId)
      else warnings.push(`${runnerId}: ${result?.error || 'stop request did not report success'}`)
    } catch (error) {
      warnings.push(`${runnerId}: ${error?.message || String(error)}`)
    }
  }
  const stoppedSet = new Set(stopped)
  const cancelledAt = new Date().toISOString()
  for (const step of Array.isArray(runState.steps) ? runState.steps : []) {
    for (const run of Array.isArray(step.runs) ? step.runs : []) {
      if (!stoppedSet.has(String(run.runnerId || '').trim())) continue
      run.status = 'cancelled'
      run.cancelledAt = cancelledAt
      run.cancelReason = reason
    }
    const runs = Array.isArray(step.runs) ? step.runs : []
    if (runs.length > 0 && runs.every((run) => ['cancelled', 'canceled'].includes(String(run.status || '').toLowerCase()))) {
      step.status = 'cancelled'
    }
  }
  runState.remoteCancel = {
    reason,
    requestedAt: cancelledAt,
    runnerIds,
    stopped,
    warnings,
  }
  if (warnings.length > 0) {
    runState.remoteCancelWarning = `${warnings.length} remote ${warnings.length === 1 ? 'runner' : 'runners'} could not be stopped on interrupt.`
  }
  return { runnerIds, stopped, warnings }
}

function handleClean(target = '', options = {}) {
  const selected = String(target || '').trim().toLowerCase()
  if (selected && selected !== 'blobs') {
    throw new Error('Only `nax clean blobs` is implemented.')
  }
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: process.cwd() })
  const netlify = buildNetlifyEnv({ projectRoot, env: process.env, siteId: options.netlifySiteId })
  const results = sweepBlobRefs(/** @type {any} */ ({
    projectRoot,
    siteId: netlify.siteId,
    token: netlify.env.NETLIFY_AUTH_TOKEN,
    env: netlify.env,
    deleteBlob,
    dryRun: options.force !== true,
    ttlHours: Number.parseInt(options.ttlHours || process.env.NAX_BLOB_CLEANUP_TTL_HOURS || '24', 10),
    log: (message) => console.warn(message),
  }))
  const action = options.force ? 'Cleaned' : 'Would clean'
  console.log(`${action} ${results.length} prompt blob ${results.length === 1 ? 'ref' : 'refs'}.`)
  for (const result of results) {
    const ref = result.ref || {}
    console.log(`- ${ref.store}/${ref.key}${result.ok ? '' : ` — ${result.error?.message || 'failed'}`}`)
  }
  if (!options.force && results.length > 0) console.log('Run again with --force to delete these blobs.')
  if (options.force) compactBlobRefs(projectRoot)
  return results
}

/** @param {Record<string, any>} param0 */
function buildCompactLocalPromptForRetry({ flow, step, runState, run }) {
  const savedCompact = String(run.compactPromptText || '').trim()
  const savedPrompt = String(run.promptText || '')
  const safeBytes = localSafePromptBytes(runState.options || {})
  if (savedCompact && utf8ByteLength(savedCompact) < utf8ByteLength(savedPrompt) && utf8ByteLength(savedCompact) <= safeBytes) return savedCompact

  const options = runState.options || {}
  const prompt = loadStepPrompt(flow, step)
  const completedStepStates = completedStepMapFromRunState(runState)
  const sourceRuns = sourceRunsForStep(step, completedStepStates)
  const instructionOnly = buildLocalAgentPrompt({
    model: run.agent,
    prompt,
    context: '',
    roundResults: '',
  })
  const remaining = Math.max(800, safeBytes - utf8ByteLength(instructionOnly) - 400)
  const compactRoundResults = formatCompactLocalRunResults(sourceRuns, {
    totalLimit: Math.floor(remaining * 0.7),
    perRunLimit: Math.max(500, Math.floor(remaining * 0.7 / Math.max(1, sourceRuns.length))),
  })
  const compactContext = compactLocalTextByBytes(
    contextForRunState(runState, options),
    Math.floor(remaining * 0.3),
    'Additional Context',
  )
  const rebuilt = buildLocalAgentPrompt({
    model: run.agent,
    prompt,
    context: compactContext,
    roundResults: compactRoundResults,
  })
  if (rebuilt.trim() && (!savedPrompt || utf8ByteLength(rebuilt) < utf8ByteLength(savedPrompt)) && utf8ByteLength(rebuilt) <= safeBytes) return rebuilt
  return compactLocalTextByBytes(savedPrompt, safeBytes, 'Local agent prompt')
}

function completedStepMapFromRunState(runState) {
  const completed = new Map()
  for (const step of runState.steps || []) {
    if (step.status === 'completed' || step.status === 'dry-run') {
      completed.set(step.id, step)
    }
  }
  return completed
}

function firstRunnableStepIndex(flow, runState) {
  const byId = new Map((runState.steps || []).map((step) => [step.id, step]))
  for (let index = 0; index < flow.steps.length; index += 1) {
    const saved = byId.get(flow.steps[index].id)
    if (!saved || saved.status !== 'completed' && saved.status !== 'dry-run') return index
  }
  return flow.steps.length
}

function localStepStatus(stepState) {
  return stepState.runs.every((run) => run.status === 'completed' || run.status === 'dry-run')
    ? 'completed'
    : 'failed'
}

function humanReviewPauseError(runState, stepState) {
  const error = /** @type {Error & { code?: string, runId?: string, stepId?: string }} */ (new Error(`Workflow "${runState.flowTitle || runState.flowId}" is awaiting human review at step "${stepState.title || stepState.id}".`))
  error.code = AWAITING_REVIEW
  error.runId = runState.runId
  error.stepId = stepState.id
  return error
}

function requireHumanReview({ runState, step, runtimeEvents }) {
  const existing = (runState.steps || []).find((candidate) => candidate.id === step.id)
  const stepState = existing || createHumanReviewStepState(step)
  if (!existing) runState.steps.push(stepState)
  stepState.status = AWAITING_REVIEW
  stepState.review = {
    ...(stepState.review || {}),
    status: AWAITING_REVIEW,
    requestedAt: stepState.review?.requestedAt || new Date().toISOString(),
  }
  runState.status = AWAITING_REVIEW
  saveRunState(runState)
  runtimeEvents?.stepStatus(AWAITING_REVIEW, stepState, step, {
    review: stepState.review,
  })
  runtimeEvents?.workflowStatus(AWAITING_REVIEW, {
    stepId: stepState.id,
    stepTitle: stepState.title || stepState.id,
  })
  console.log(`\nAwaiting human review: ${stepState.title || stepState.id}`)
  console.log(`State: ${workflowStatePath(runState.dir)}`)
  throw humanReviewPauseError(runState, stepState)
}

function visualAgentStatusFromPoll(event = {}) {
  if (event.terminalSuccess) return 'completed'
  if (event.terminalFailure) return event.state === 'timeout' ? 'timeout' : 'failed'
  if (event.state === 'running' || event.state === 'processing' || event.state === 'executing') return 'running'
  if (event.state === 'retrying') return 'retrying'
  return 'waiting'
}

function emitStepArtifacts(runtimeEvents, runState, stepState) {
  if (!runtimeEvents?.enabled || !runState.dir || !stepState?.id) return
  const stepDir = stepArtifactsDir(runState, stepState)
  const relativeBase = path.relative(runState.dir, stepDir)
  runtimeEvents.artifactWritten('step_metadata', path.join(stepDir, 'step.json'), {
    stepId: stepState.id,
    stepTitle: stepState.title || stepState.id,
    relativePath: path.join(relativeBase, 'step.json'),
  })
  runtimeEvents.artifactWritten('step_usage', path.join(stepDir, 'usage.json'), {
    stepId: stepState.id,
    stepTitle: stepState.title || stepState.id,
    relativePath: path.join(relativeBase, 'usage.json'),
  })
  runtimeEvents.artifactWritten('step_summary', path.join(stepDir, 'summary.md'), {
    stepId: stepState.id,
    stepTitle: stepState.title || stepState.id,
    relativePath: path.join(relativeBase, 'summary.md'),
  })
}

function emitRunArtifact(runtimeEvents, runState, stepState, run, artifactResult) {
  if (!runtimeEvents?.enabled || !artifactResult || !runState.dir) return
  for (const [artifactType, filePath] of [
    ['agent_metadata', artifactResult.jsonPath],
    ['agent_result', artifactResult.markdownPath],
  ]) {
    if (!filePath) continue
    runtimeEvents.artifactWritten(artifactType, filePath, {
      stepId: stepState.id,
      stepTitle: stepState.title || stepState.id,
      agent: run.agent || '',
      runnerId: run.runnerId || '',
      sessionId: run.sessionId || '',
      relativePath: path.relative(runState.dir, filePath),
      attemptNumber: artifactResult.attemptNumber || null,
    })
  }
}

function emitWorkflowArtifacts(runtimeEvents, runState) {
  if (!runtimeEvents?.enabled || !runState.dir) return
  const artifactsDir = artifactsRootForRunState(runState)
  for (const [artifactType, fileName] of [
    ['workflow_usage', 'usage.json'],
    ['workflow_summary', 'summary.md'],
  ]) {
    runtimeEvents.artifactWritten(artifactType, path.join(artifactsDir, fileName), {
      relativePath: path.relative(runState.dir, path.join(artifactsDir, fileName)),
    })
  }
}

function futureFollowUpReferencesStep(flowSteps = [], currentStepIndex, stepId) {
  return flowSteps.slice(currentStepIndex + 1).some((step) => (
    step.submit === 'follow-up' &&
    Array.isArray(step.input) &&
    step.input.some((input) => input.step === stepId)
  ))
}

function stepIndexInFlowSteps(flowSteps = [], currentStepIndex, stepId) {
  const index = flowSteps.findIndex((step) => step.id === stepId)
  return index === -1 ? currentStepIndex : index
}

/** @param {Record<string, any>} param0 */
function shouldArchiveCompletedStep({ step, options = {}, flowSteps = [], currentStepIndex = -1 }) {
  if (!step) return false
  if (step.autoArchive === true) return true
  if (step.autoArchive === false) return false
  if (options.archive !== true) return false
  if (step.isArchivable === false) return false
  const index = stepIndexInFlowSteps(flowSteps, currentStepIndex, step.id)
  return index !== flowSteps.length - 1
}

function applyArchiveResultToRunner(runState, runnerId, archiveResult) {
  const touched = []
  const archivedAt = new Date().toISOString()
  for (const stepState of runState.steps || []) {
    let changed = false
    for (const run of stepState.runs || []) {
      if (run.runnerId !== runnerId) continue
      run.archived = archiveResult.archived === true
      run.archivedAt = archiveResult.archived === true ? archivedAt : ''
      run.archiveError = archiveResult.error || ''
      run.raw = {
        ...(run.raw || {}),
        archive: {
          archived: archiveResult.archived === true,
          archivedAt: archiveResult.archived === true ? archivedAt : '',
          error: archiveResult.error || '',
        },
      }
      changed = true
    }
    if (changed) touched.push(stepState)
  }
  return touched
}

/** @param {Record<string, any>} param0 */
function archiveEligibleCompletedLocalRuns({ runState, flowSteps, currentStepIndex, options = {}, projectRoot, netlify, archiveRun = archiveAgentRun }) {
  const archivedThisPass = new Set()
  const stepById = new Map((flowSteps || []).map((step) => [step.id, step]))
  for (const stepState of runState.steps || []) {
    const step = stepById.get(stepState.id)
    if (!shouldArchiveCompletedStep({ step, options, flowSteps, currentStepIndex })) continue
    if (stepState.status !== 'completed') continue
    if (futureFollowUpReferencesStep(flowSteps, currentStepIndex, stepState.id)) continue

    for (const run of stepState.runs || []) {
      if (run.status !== 'completed' || !run.runnerId || run.archived === true) continue
      if (archivedThisPass.has(run.runnerId)) continue
      archivedThisPass.add(run.runnerId)

      const archiveResult = archiveRun({
        projectRoot,
        runnerId: run.runnerId,
        env: netlify.env,
      })
      const touchedSteps = applyArchiveResultToRunner(runState, run.runnerId, archiveResult)
      for (const touchedStep of touchedSteps) {
        for (const touchedRun of touchedStep.runs || []) {
          if (touchedRun.runnerId === run.runnerId) persistRunArtifact(runState, touchedStep, touchedRun)
        }
        persistStepArtifacts(runState, touchedStep)
      }
      saveRunState(runState)
      if (archiveResult.archived) {
        console.log(`Archived Netlify agent run ${run.runnerId}`)
      } else {
        console.warn(`Failed to archive Netlify agent run ${run.runnerId}${archiveResult.error ? `: ${archiveResult.error}` : ''}`)
      }
    }
  }
}

function commentsAfterGithubPrompt(result, run = {}) {
  const comments = Array.isArray(result?.comments) ? result.comments : []
  if (!run.commentUrl) return comments
  const promptIndex = comments.findIndex((comment) => comment.url === run.commentUrl)
  return promptIndex === -1 ? comments : comments.slice(promptIndex + 1)
}

function isGithubFailureResultBody(body) {
  return bodyHasRunnerResultMarker(body) && /\bAgent Run failed\b/i.test(body)
}

function githubResultRepliesForRun(result, run = {}) {
  return commentsAfterGithubPrompt(result, run).filter((comment) => {
    const body = comment?.body || ''
    return bodyHasRunnerResultMarker(body) && !isGithubFailureResultBody(body)
  })
}

function githubFailureCommentsForRun(result, run = {}) {
  return commentsAfterGithubPrompt(result, run).filter((comment) => {
    const body = String(comment?.body || '')
    return isGithubFailureResultBody(body) || (bodyHasRunnerStatusMarker(body) && /\bNetlify Agent Run failed\b/i.test(body))
  })
}

function githubStatusCommentsForRun(result, run = {}) {
  return commentsAfterGithubPrompt(result, run).filter((comment) => {
    const body = String(comment?.body || '')
    return bodyHasRunnerStatusMarker(body) && netlifyAgentRunUrlFromBody(body)
  })
}

function githubPromptCommentForRun(result, run = {}) {
  if (!run.commentUrl) return null
  const comments = Array.isArray(result?.comments) ? result.comments : []
  return comments.find((comment) => comment.url === run.commentUrl) || null
}

function githubRunStatusFromStatusComment(body, fallback = 'running') {
  const text = String(body || '')
  if (/\bNetlify Agent Run completed\b/i.test(text) || /\bAgent Run completed\b/i.test(text)) return 'completed'
  if (/\bNetlify Agent Run failed\b/i.test(text) || /\bAgent Run failed\b/i.test(text)) return 'failed'
  if (/\bNetlify Agent Run timed out\b/i.test(text) || /\bAgent Run timed out\b/i.test(text)) return 'timeout'
  return fallback
}

function applyGithubStatusCommentToRun(result, run = {}) {
  const statusComments = githubStatusCommentsForRun(result, run)
  const latest = statusComments[statusComments.length - 1]
  const body = latest?.body || ''
  const agentRunUrl = netlifyAgentRunUrlFromBody(body)
  if (!agentRunUrl) return null
  const status = githubRunStatusFromStatusComment(body, 'running')
  const links = {
    ...(run.links || {}),
    agentRunUrl,
    ...(agentRunUrl.includes('?session=') ? { sessionUrl: agentRunUrl } : {}),
  }
  run.links = links
  if (!run.status || run.status === 'submitted' || run.status === 'pending' || status !== 'running') {
    run.status = status
  }
  return {
    comment: latest,
    run: {
      ...run,
      links,
      status,
    },
    agentRunUrl,
  }
}

function resultsScopedToGithubRuns(results, runs = []) {
  if (!Array.isArray(runs) || runs.length === 0) return results
  return results.map((result) => {
    const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber)
    if (!run) return result
    return {
      ...result,
      replies: githubResultRepliesForRun(result, run),
    }
  })
}

function findGithubRunnerFailures(results, runs = []) {
  const failures = []
  for (const result of results || []) {
    const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
    if (githubResultRepliesForRun(result, run).length > 0) continue
    for (const comment of githubFailureCommentsForRun(result, run)) {
      const body = String(comment?.body || '')
      const summary = body.match(/\*\*Failure summary:\*\*\s*([^\n]+)/i)?.[1]?.trim() || 'Agent run failed'
      failures.push({
        issueNumber: result.issueNumber,
        issueTitle: result.issueTitle,
        url: comment.url || result.issueUrl || '',
        summary,
      })
    }
  }
  return failures
}

const GITHUB_POLL_MAX_CONSECUTIVE_FAILURES = 5
const GITHUB_ACTION_FAILURE_GRACE_MS = 60000

function githubTerminalRunCount({ scopedResults = [], runs = [], failures = [], actionFailures = [] } = {}) {
  const terminal = new Set()
  for (const result of scopedResults) {
    if ((result.replies || []).length > 0) terminal.add(result.issueNumber)
  }
  for (const run of runs || []) {
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'timeout') terminal.add(run.issueNumber)
  }
  for (const failure of failures || []) terminal.add(failure.issueNumber)
  for (const failure of actionFailures || []) terminal.add(failure.issueNumber)
  return terminal.size
}

function githubFailureDetail(failures = []) {
  return failures
    .map((failure) => `#${failure.issueNumber} ${failure.issueTitle}: ${failure.summary}${failure.url ? ` (${failure.url})` : ''}`)
    .join('\n')
}

function githubSavedRunFailures(scopedResults = [], runs = [], existingIssueNumbers = new Set()) {
  const byIssueNumber = new Map((scopedResults || []).map((result) => [result.issueNumber, result]))
  return (runs || [])
    .filter((run) => (run.status === 'failed' || run.status === 'timeout') && !existingIssueNumbers.has(run.issueNumber))
    .map((run) => {
      const result = byIssueNumber.get(run.issueNumber) || {}
      return {
        issueNumber: run.issueNumber,
        issueTitle: result.issueTitle || run.issueTitle || titleCase(run.agent || 'agent'),
        url: run.links?.commentUrl || run.commentUrl || run.links?.agentRunUrl || '',
        summary: conciseErrorMessage(run.resultText || run.failureReason || run.status || 'Agent run failed'),
      }
    })
}

function githubCombinedFailures({ scopedResults = [], runs = [], failures = [], actionFailures = [] } = {}) {
  const seen = new Set()
  const combined = []
  for (const failure of [...failures, ...actionFailures]) {
    combined.push(failure)
    if (Number.isFinite(failure.issueNumber)) seen.add(failure.issueNumber)
  }
  combined.push(...githubSavedRunFailures(scopedResults, runs, seen))
  return combined
}

function normalizeGithubActionTitle(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function githubActionRunMatchesResult(actionRun, result, run = {}) {
  const title = normalizeGithubActionTitle(actionRun?.displayTitle)
  if (!title) return false
  const issueTitle = normalizeGithubActionTitle(result?.issueTitle)
  if (issueTitle && title === issueTitle) return true
  if (issueTitle && title.includes(issueTitle)) return true
  const agent = normalizeGithubActionTitle(run.agent || result?.model)
  return Boolean(agent && title.includes(agent))
}

function actionRunCreatedNearPrompt(actionRun, promptCreatedAt, { beforeMs = 15000, afterMs = 10 * 60 * 1000 } = {}) {
  const promptMs = Date.parse(promptCreatedAt || '')
  const actionMs = Date.parse(actionRun?.createdAt || '')
  if (!Number.isFinite(promptMs) || !Number.isFinite(actionMs)) return false
  return actionMs >= promptMs - beforeMs && actionMs <= promptMs + afterMs
}

function listRecentGithubActionRuns({ repo, since }) {
  const result = runGh([
    'run',
    'list',
    '--repo',
    repo,
    '--limit',
    '50',
    '--json',
    'databaseId,displayTitle,createdAt,conclusion,status,url',
  ], {
    attempts: 1,
    timeout: 30000,
  })
  let runs = []
  try {
    runs = JSON.parse(result.stdout || '[]')
  } catch {
    runs = []
  }
  const sinceMs = Date.parse(since || '')
  return runs.filter((run) => {
    if (run.status !== 'completed' || run.conclusion !== 'failure') return false
    if (!Number.isFinite(sinceMs)) return true
    const createdMs = Date.parse(run.createdAt || '')
    return Number.isFinite(createdMs) && createdMs >= sinceMs - 15000
  })
}

function loadGithubActionRunFailureLog({ repo, databaseId }) {
  if (!databaseId) return ''
  const result = runGh([
    'run',
    'view',
    String(databaseId),
    '--repo',
    repo,
    '--log-failed',
  ], {
    allowFailure: true,
    attempts: 1,
    timeout: 30000,
  })
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

function githubActionFailureReason(log) {
  const text = String(log || '')
  if (/argument list too long/i.test(text)) return 'argument-list-too-long'
  return 'github-action-failed'
}

function githubActionFailureSummary({ reason, promptBytes, envBytes }) {
  if (reason === 'argument-list-too-long') {
    const suffix = promptBytes
      ? ` Prompt body was ${promptBytes.toLocaleString()} bytes${envBytes ? ` (${envBytes.toLocaleString()} bytes as ${GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX} env string)` : ''}.`
      : ''
    return `GitHub Action failed before the Netlify Agent Runner could post status comments: argument list too long.${suffix}`
  }
  return 'GitHub Action failed before the Netlify Agent Runner could post status comments.'
}

function findGithubActionRunFailures({
  repo,
  results,
  runs = [],
  actionRunLoader = listRecentGithubActionRuns,
  actionRunLogLoader = loadGithubActionRunFailureLog,
  now = Date.now(),
  graceMs = GITHUB_ACTION_FAILURE_GRACE_MS,
}) {
  const prompts = []
  for (const result of results || []) {
    const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
    if (githubResultRepliesForRun(result, run).length > 0 || githubFailureCommentsForRun(result, run).length > 0) continue
    const prompt = githubPromptCommentForRun(result, run)
    if (!prompt?.createdAt) continue
    const promptMs = Date.parse(prompt.createdAt)
    if (!Number.isFinite(promptMs) || now - promptMs < graceMs) continue
    prompts.push({ result, run, prompt, promptMs })
  }
  if (prompts.length === 0) return []

  const since = new Date(Math.min(...prompts.map((item) => item.promptMs)) - 15000).toISOString()
  let actionRuns = []
  try {
    actionRuns = actionRunLoader({ repo, since }) || []
  } catch {
    actionRuns = []
  }

  const failures = []
  const usedActionRuns = new Set()
  for (const item of prompts) {
    const candidates = actionRuns
      .filter((actionRun) => !usedActionRuns.has(actionRun.databaseId || actionRun.url))
      .filter((actionRun) => githubActionRunMatchesResult(actionRun, item.result, item.run))
      .filter((actionRun) => actionRunCreatedNearPrompt(actionRun, item.prompt.createdAt))
      .sort((a, b) => Math.abs(Date.parse(a.createdAt) - item.promptMs) - Math.abs(Date.parse(b.createdAt) - item.promptMs))
    const actionRun = candidates[0]
    if (!actionRun) continue
    usedActionRuns.add(actionRun.databaseId || actionRun.url)
    const log = actionRunLogLoader({ repo, databaseId: actionRun.databaseId }) || ''
    const reason = githubActionFailureReason(log)
    const metrics = githubActionTriggerTextMetrics(item.run.promptText || item.prompt.body || '')
    failures.push({
      issueNumber: item.result.issueNumber,
      issueTitle: item.result.issueTitle,
      agent: item.run.agent || item.result.model || '',
      url: actionRun.url || '',
      actionRunId: actionRun.databaseId || '',
      createdAt: actionRun.createdAt || '',
      reason,
      summary: githubActionFailureSummary({
        reason,
        promptBytes: metrics.bodyBytes,
        envBytes: metrics.envBytes,
      }),
      promptBytes: metrics.bodyBytes,
      promptEnvBytes: metrics.envBytes,
      result: item.result,
      run: item.run,
      log,
    })
  }
  return failures
}

/** @param {Record<string, any>} param0 */
async function waitForGithubStep({
  repo,
  issueNumbers = [],
  runs = [],
  step,
  timeoutMinutes,
  pollMs = 15000,
  loader,
  onRunResult = () => {},
  maxConsecutiveFailures = GITHUB_POLL_MAX_CONSECUTIVE_FAILURES,
  actionRunLoader = listRecentGithubActionRuns,
  actionRunLogLoader = loadGithubActionRunFailureLog,
  actionRunFailureGraceMs = GITHUB_ACTION_FAILURE_GRACE_MS,
}) {
  const numbers = issueNumbers.length > 0
    ? issueNumbers
    : runs.map((run) => run.issueNumber).filter((number) => Number.isFinite(number))
  if (!numbers.length) return []
  const deadline = Date.now() + timeoutMinutes * 60 * 1000
  const reporter = makeStepProgressReporter({
    stepTitle: step.title,
    total: numbers.length,
    agents: step.agents || [],
  })
  let settled = false
  let consecutiveFailures = 0
  const emittedResults = new Set()
  const reconcileResults = async (results) => {
    const scopedResults = resultsScopedToGithubRuns(results, runs)
    for (const result of scopedResults) {
      const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
      const statusUpdate = applyGithubStatusCommentToRun(result, run)
      if (statusUpdate) {
        reporter.updateRun({
          result,
          reply: statusUpdate.comment,
          run: statusUpdate.run,
          state: run.status || 'running',
        })
      }
      const replies = result.replies || []
      const latest = replies[replies.length - 1]
      if (!latest?.url) continue
      const key = `${result.issueNumber}:${latest.url}`
      if (emittedResults.has(key)) continue
      emittedResults.add(key)
      const agentRunUrl = netlifyAgentRunUrlFromBody(latest.body || '')
      reporter.updateRun({
        result,
        reply: latest,
        run: {
          ...run,
          links: {
            ...(run.links || {}),
            agentRunUrl: agentRunUrl || run.links?.agentRunUrl || '',
            sessionUrl: agentRunUrl.includes('?session=')
              ? agentRunUrl
              : run.links?.sessionUrl || '',
          },
          status: 'completed',
        },
        state: 'completed',
        terminalSuccess: true,
      })
      await onRunResult({ result, reply: latest, run, status: 'completed' })
    }
    const completeCount = scopedResults.filter((r) => (r.replies || []).length > 0).length
    reporter.setCount(completeCount)
    return { scopedResults, completeCount }
  }

  try {
    while (Date.now() < deadline) {
      let results
      try {
        results = fetchRoundResults({
          repo,
          issueNumbers: numbers,
          embedAll: true,
          requireResultMarker: true,
          loader,
        })
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures += 1
        if (consecutiveFailures >= maxConsecutiveFailures) {
          reporter.fail(`${step.title}: poll failed ${consecutiveFailures} times in a row`)
          settled = true
          throw new Error(
            `Step "${step.id}" aborted after ${consecutiveFailures} consecutive poll failures: ${err.message}`,
          )
        }
        reporter.message(
          `transient poll error (${consecutiveFailures}/${maxConsecutiveFailures}); retrying — ${err.message}`,
        )
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        continue
      }
      const { scopedResults, completeCount } = await reconcileResults(results)
      const failures = findGithubRunnerFailures(results, runs)
      if (failures.length > 0) {
        for (const result of results || []) {
          const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
          for (const reply of githubFailureCommentsForRun(result, run)) {
            const key = `${result.issueNumber}:${reply.url || 'failed'}`
            if (emittedResults.has(key)) continue
            emittedResults.add(key)
            await onRunResult({ result, reply, run, status: 'failed' })
          }
        }
      }
      const actionFailures = findGithubActionRunFailures({
        repo,
        results,
        runs,
        actionRunLoader,
        actionRunLogLoader,
        graceMs: actionRunFailureGraceMs,
      })
      if (actionFailures.length > 0) {
        for (const failure of actionFailures) {
          const run = runs.find((candidate) => candidate.issueNumber === failure.issueNumber) || failure.run || {}
          Object.assign(run, {
            status: 'failed',
            failureKind: 'github-action-launch-failed',
            failureReason: failure.reason,
            actionRunUrl: failure.url,
            actionRunId: failure.actionRunId,
            promptBytes: failure.promptBytes,
            promptEnvBytes: failure.promptEnvBytes,
            resultText: failure.summary,
          })
          await onRunResult({
            result: failure.result,
            reply: null,
            run,
            status: 'failed',
          })
        }
      }
      const combinedFailures = githubCombinedFailures({ scopedResults, runs, failures, actionFailures })
      const failureCount = combinedFailures.length
      const terminalCount = githubTerminalRunCount({ scopedResults, runs, failures, actionFailures })
      if (terminalCount === scopedResults.length) {
        if (failureCount > 0) {
          const detail = githubFailureDetail(combinedFailures)
          reporter.fail(`${step.title}: ${completeCount}/${scopedResults.length} complete, ${failureCount} failed`)
          settled = true
          throw new Error(`Step "${step.id}" has failed agent runs:\n${detail}`)
        }
        reporter.done(`${step.title}: ${completeCount}/${scopedResults.length} complete`)
        settled = true
        return scopedResults
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    try {
      reporter.message('deadline reached; reconciling GitHub comments one last time')
      const finalResults = fetchRoundResults({
        repo,
        issueNumbers: numbers,
        embedAll: true,
        requireResultMarker: true,
        loader,
      })
      const { scopedResults, completeCount } = await reconcileResults(finalResults)
      const failures = findGithubRunnerFailures(finalResults, runs)
      const actionFailures = findGithubActionRunFailures({
        repo,
        results: finalResults,
        runs,
        actionRunLoader,
        actionRunLogLoader,
        graceMs: actionRunFailureGraceMs,
      })
      if (actionFailures.length > 0) {
        for (const failure of actionFailures) {
          const run = runs.find((candidate) => candidate.issueNumber === failure.issueNumber) || failure.run || {}
          Object.assign(run, {
            status: 'failed',
            failureKind: 'github-action-launch-failed',
            failureReason: failure.reason,
            actionRunUrl: failure.url,
            actionRunId: failure.actionRunId,
            promptBytes: failure.promptBytes,
            promptEnvBytes: failure.promptEnvBytes,
            resultText: failure.summary,
          })
          await onRunResult({
            result: failure.result,
            reply: null,
            run,
            status: 'failed',
          })
        }
      }
      const combinedFailures = githubCombinedFailures({ scopedResults, runs, failures, actionFailures })
      const failureCount = combinedFailures.length
      const terminalCount = githubTerminalRunCount({ scopedResults, runs, failures, actionFailures })
      if (failureCount > 0) {
        const detail = githubFailureDetail(combinedFailures)
        const status = terminalCount === scopedResults.length
          ? `${completeCount}/${scopedResults.length} complete, ${failureCount} failed`
          : `${completeCount}/${scopedResults.length} complete, ${failureCount} failed, ${scopedResults.length - terminalCount} timed out`
        reporter.fail(`${step.title}: ${status}`)
        settled = true
        throw new Error(`Step "${step.id}" has failed agent runs:\n${detail}`)
      }
      if (completeCount === scopedResults.length) {
        reporter.done(`${step.title}: ${completeCount}/${scopedResults.length} complete`)
        settled = true
        return scopedResults
      }
    } catch (err) {
      if (/has failed agent runs/.test(String(err?.message || ''))) throw err
      reporter.message(`final GitHub reconciliation failed: ${err.message}`)
    }
    reporter.fail(`Timed out waiting for ${step.title}`)
    settled = true
    throw new Error(`Timed out waiting for step "${step.id}" after ${timeoutMinutes} minutes`)
  } finally {
    if (!settled) reporter.fail(`Failed waiting for ${step.title}`)
  }
}

function githubStepStatus(stepState) {
  const runs = Array.isArray(stepState?.runs) ? stepState.runs : []
  if (runs.length > 0 && runs.every((run) => run.status === 'completed' || run.status === 'dry-run')) return 'completed'
  if (runs.some((run) => run.status === 'failed' || run.status === 'timeout')) return 'failed'
  return 'submitted'
}

/** @param {Record<string, any>} param0 */
async function completeGithubStep({ runState, repo, stepState, step, options, runtimeEvents }) {
  const timeoutMinutes = Number.parseInt(options.timeoutMinutes || '25', 10)
  if (step.waitFor !== WAIT_FOR_AGENT_RESULTS) {
    stepState.status = 'completed'
    persistStepArtifacts(runState, stepState)
    emitStepArtifacts(runtimeEvents, runState, stepState)
    runtimeEvents?.stepStatus('completed', stepState, step)
    return stepState
  }

  try {
    if (stepState.runs.some(shouldPollGithubRun)) {
      const issueNumbers = stepState.runs.map((run) => run.issueNumber).filter((number) => Number.isFinite(number))
      const results = await waitForGithubStep({
        repo,
        issueNumbers,
        runs: stepState.runs,
        step,
        timeoutMinutes,
        onRunResult: ({ result, reply, run, status }) => {
	          const normalized = applyContextFetchClassification(normalizeGithubRunResult({
	            run,
	            result,
	            reply,
	            status,
	            marker: parseRunnerResultMarker(reply?.body || ''),
	          }))
          const index = stepState.runs.findIndex((candidate) => candidate.issueNumber === normalized.issueNumber)
          if (index !== -1) {
            Object.assign(stepState.runs[index], normalized)
            const artifactResult = persistRunArtifact(runState, stepState, stepState.runs[index])
            emitRunArtifact(runtimeEvents, runState, stepState, stepState.runs[index], artifactResult)
            runtimeEvents?.agentStatus(normalized.status || 'completed', stepState.runs[index], stepState, step, {
              terminal: normalized.status === 'completed' || normalized.status === 'failed' || normalized.status === 'timeout',
              usage: normalized.usage || null,
              hasResult: Boolean(normalized.resultText),
            })
            saveRunState(runState)
          }
        },
      })
      for (const run of stepState.runs) {
        if (run.status === 'failed' || run.status === 'timeout') continue
        const result = results.find((item) => item.issueNumber === run.issueNumber)
        const replies = result?.replies || []
        const latest = replies[replies.length - 1]
	        const normalized = applyContextFetchClassification(normalizeGithubRunResult({
	          run,
	          result,
	          reply: latest,
	          status: latest ? 'completed' : 'timeout',
	          marker: parseRunnerResultMarker(latest?.body || ''),
	        }))
        Object.assign(run, normalized)
        runtimeEvents?.agentStatus(normalized.status || 'completed', run, stepState, step, {
          terminal: true,
          usage: normalized.usage || null,
          hasResult: Boolean(normalized.resultText),
        })
      }
    }
    stepState.status = githubStepStatus(stepState)
    saveRunState(runState)
  } finally {
    stepState.status = githubStepStatus(stepState)
    persistStepArtifacts(runState, stepState)
    emitStepArtifacts(runtimeEvents, runState, stepState)
    runtimeEvents?.stepStatus(stepState.status, stepState, step)
  }
  return stepState
}

/** @param {Record<string, any>} param0 */
async function executeGithubFlow({ flow, steps, options, runState, completedStepStates = new Map(), runtimeEvents }) {
  const repo = resolveRepo(options.repo)
  const date = options.date || getLocalDate()
  const baseContext = contextForRunState(runState, options)

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex]
    if (isHumanReviewStep(step)) {
      requireHumanReview({ runState, step, runtimeEvents })
    }
    const prompt = loadStepPrompt(flow, step)
    const stepState = {
      id: step.id,
      title: step.title,
      action: step.action,
      agents: step.agents,
      status: 'running',
      runs: [],
    }
    runState.steps.push(stepState)
    saveRunState(runState)
    runtimeEvents?.stepStatus('running', stepState, step)
    runtimeEvents?.stepStatus('running', stepState, step)

    const sourceIssues = sourceIssueNumbersForStep(step, completedStepStates).join(',')
    const recoveryIssues = step.action === 'comment' ? (options.fromIssues || options.fromIssue || options.issues || options.issue || '') : ''
    const fromIssues = sourceIssues || recoveryIssues
    const targetIssues = step.action === 'comment' ? fromIssues : ''
    const stepOptions = {
      ...options,
      repo,
      date,
      models: step.agents.join(','),
      issues: targetIssues || options.issues,
      issue: targetIssues || options.issue,
      fromIssues,
      fromIssue: fromIssues,
      yes: true,
      fetchResults: fromIssues ? options.fetchResults : false,
    }
    const roundResultsRaw = fetchRoundResultsForOptions(stepOptions, {
      embedAll: shouldEmbedAllReplies(prompt.name),
    })
    const input = {
      promptName: prompt.name,
      prompt,
      options: stepOptions,
      context: baseContext,
      roundResultsRaw,
      hasFutureSteps: stepIndex < steps.length - 1,
      runState,
      stepState,
      step,
      projectRoot: runState.projectRoot,
    }
    const plan = buildAndMaybeFallbackPlan(
      input,
      step.action === 'comment' ? buildCommentPlan : buildPlan,
    )

    if (step.action === 'comment') {
      printCommentPlan(plan, { dryRun: options.dryRun })
    } else {
      printPlan(plan, { dryRun: options.dryRun })
    }
    enforceGithubActionPromptBudget(plan, { dryRun: options.dryRun })

    if (options.dryRun) {
      stepState.status = 'dry-run'
	      stepState.runs = (plan.issues || []).map((issue) => ({
	        transport: 'github',
	        agent: issue.model,
	        status: 'dry-run',
	        promptText: issue.body,
	        resultText: '',
	        promptDelivery: issue.promptDelivery || null,
	        ...(issue.promptDelivery?.blobRef ? { blobRef: issue.promptDelivery.blobRef } : {}),
	        raw: issue,
	      }))
      completedStepStates.set(step.id, stepState)
      saveRunState(runState)
      for (const run of stepState.runs) runtimeEvents?.agentStatus('dry-run', run, stepState, step)
      runtimeEvents?.stepStatus('dry-run', stepState, step)
      continue
    }

    if (step.action === 'comment') {
      for (const issue of plan.issues) {
        const pendingRun = {
          transport: 'github',
          agent: issue.model,
          issueNumber: Number(issue.issueNumber),
          issueUrl: issue.issueUrl,
          raw: issue,
        }
        runtimeEvents?.agentStatus('submitting', pendingRun, stepState, step, { action: 'comment' })
        let url
        try {
          url = createDiscussionComment({
            repo: issue.targetRepo,
            targetKind: issue.targetKind,
            targetNumber: issue.targetNumber,
            body: issue.body,
          })
        } catch (error) {
          runtimeEvents?.agentStatus('failed', pendingRun, stepState, step, {
            phase: 'submit',
            action: 'comment',
            message: error?.message || String(error),
          })
          throw error
        }
        const issueNumber = Number(issue.issueNumber)
        stepState.runs.push({
          transport: 'github',
          agent: issue.model,
          status: 'submitted',
	          promptText: issue.body,
	          resultText: '',
	          promptDelivery: issue.promptDelivery || null,
	          ...(issue.promptDelivery?.blobRef ? { blobRef: issue.promptDelivery.blobRef } : {}),
	          issueNumber,
          issueUrl: issue.issueUrl,
          commentUrl: url,
          prUrl: issue.targetKind === 'pr' ? issue.targetUrl : '',
          raw: issue,
        })
        saveRunState(runState)
        runtimeEvents?.agentStatus('submitted', stepState.runs[stepState.runs.length - 1], stepState, step, {
          commentUrl: url,
        })
        console.log(`#${issue.issueNumber} ${issue.issueTitle}: ${url}`)
      }
    } else {
      for (const issue of plan.issues) {
        const pendingRun = {
          transport: 'github',
          agent: issue.model,
          raw: issue,
        }
        runtimeEvents?.agentStatus('submitting', pendingRun, stepState, step, { action: 'issue' })
        let url
        try {
          url = createIssue({
            repo: plan.repo,
            title: issue.title,
            body: issue.body,
            labels: plan.labels,
          })
        } catch (error) {
          runtimeEvents?.agentStatus('failed', pendingRun, stepState, step, {
            phase: 'submit',
            action: 'issue',
            message: error?.message || String(error),
          })
          throw error
        }
        const issueNumber = parseIssueNumberFromUrl(url)
        stepState.runs.push({
          transport: 'github',
          agent: issue.model,
          status: 'submitted',
	          promptText: issue.body,
	          resultText: '',
	          promptDelivery: issue.promptDelivery || null,
	          ...(issue.promptDelivery?.blobRef ? { blobRef: issue.promptDelivery.blobRef } : {}),
	          issueNumber,
          issueUrl: url,
          commentUrl: '',
          prUrl: '',
          raw: issue,
        })
        saveRunState(runState)
        runtimeEvents?.agentStatus('submitted', stepState.runs[stepState.runs.length - 1], stepState, step)
        console.log(`${issue.title}: ${url}`)
      }
    }

    for (const run of stepState.runs.filter(shouldPollGithubRun)) {
      runtimeEvents?.agentStatus('waiting', run, stepState, step)
    }

    await completeGithubStep({ runState, repo, stepState, step, options, runtimeEvents })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
  }
}

function addLocalRunLinks(run, projectRoot, options = {}) {
  const runUrl = localAgentRunUrl({ projectRoot, runnerId: run.runnerId, sessionId: run.sessionId, options })
  const baseRunUrl = localAgentRunUrl({ projectRoot, runnerId: run.runnerId, options })
  run.links = {
    ...(run.links || {}),
    ...(baseRunUrl ? { agentRunUrl: baseRunUrl } : {}),
    ...(runUrl ? { sessionUrl: runUrl } : {}),
  }
  return run
}

function reportTerminalLocalRun(reporter, run, projectRoot, options = {}) {
  addLocalRunLinks(run, projectRoot, options)
  reporter.updateRun({
    run,
    state: run.status,
    terminal: run.status === 'completed' || run.status === 'failed' || run.status === 'timeout',
    terminalSuccess: run.status === 'completed',
    terminalFailure: run.status === 'failed' || run.status === 'timeout',
  })
}

/** @param {Record<string, any>} param0 */
async function completeLocalStep({ runState, stepState, step, options, projectRoot, netlify, netlifyFilter, initialDelayMs, runtimeEvents }) {
  const timeoutMinutes = Number.parseInt(options.timeoutMinutes || '25', 10)
  const resolvedNetlifyFilter = netlifyFilter !== undefined
    ? netlifyFilter
    : resolveNetlifyFilter({ projectRoot, filter: options.filter }).filter
  if (step.waitFor === WAIT_FOR_AGENT_RESULTS && stepState.runs.some(shouldPollLocalRun)) {
    const reporter = makeStepProgressReporter({
      stepTitle: step.title,
      total: stepState.runs.length,
      agents: step.agents || [],
    })
    let settled = false
    try {
      const completedRuns = await waitForLocalAgentRuns({
        projectRoot,
        runs: stepState.runs,
        siteId: netlify.siteId,
        netlifyFilter: resolvedNetlifyFilter,
        env: netlify.env,
        timeoutMinutes,
        initialDelayMs,
        onProgress: (event) => {
          if (!event.run?.runnerId) return
          runtimeEvents?.agentStatus(visualAgentStatusFromPoll(event), event.run, stepState, step, {
            message: event.message || '',
            remoteState: event.state || '',
            currentTask: event.currentTask || '',
            retry: event.retry === true,
            retryReason: event.retryReason || '',
            error: event.error || '',
          })
          reporter.updateRun(event)
        },
        onTerminalRun: (run) => {
          const classifiedRun = applyContextFetchClassification(run)
          addLocalRunLinks(classifiedRun, projectRoot, options)
          const index = stepState.runs.findIndex((candidate) => candidate.runnerId === classifiedRun.runnerId)
          if (index !== -1) stepState.runs[index] = classifiedRun
          const artifactResult = persistRunArtifact(runState, stepState, classifiedRun)
          emitRunArtifact(runtimeEvents, runState, stepState, classifiedRun, artifactResult)
          reportTerminalLocalRun(reporter, classifiedRun, projectRoot)
          runtimeEvents?.agentStatus(classifiedRun.status || 'completed', classifiedRun, stepState, step, {
            terminal: true,
            usage: classifiedRun.usage || null,
            hasResult: Boolean(classifiedRun.resultText),
            contextFetchStatus: classifiedRun.contextFetchStatus || '',
            error: classifiedRun.status === 'failed' || classifiedRun.status === 'timeout' ? conciseErrorMessage(classifiedRun.resultText || classifiedRun.raw?.submissionError || '') : '',
          })
        },
      })
      const classifiedRuns = completedRuns.map((run) => {
        const classifiedRun = applyContextFetchClassification(run)
        addLocalRunLinks(classifiedRun, projectRoot, options)
        return classifiedRun
      })
      stepState.runs = classifiedRuns
      for (const run of classifiedRuns) {
        reporter.updateRun({
          run,
          state: run.status,
          terminal: run.status === 'completed' || run.status === 'failed' || run.status === 'timeout',
          terminalSuccess: run.status === 'completed',
          terminalFailure: run.status === 'failed' || run.status === 'timeout',
        })
      }
      const failedCount = classifiedRuns.filter((r) => r.status === 'failed' || r.status === 'timeout').length
      const completionSummary = agentStepCompletionSummary({
        stepTitle: step.title,
        runs: classifiedRuns,
        failedCount,
      })
      if (failedCount > 0) {
        reporter.fail(completionSummary)
      } else {
        reporter.done(completionSummary)
      }
      settled = true
    } finally {
      if (!settled) reporter.fail(`Failed waiting for ${step.title}`)
      stepState.status = localStepStatus(stepState)
      persistStepArtifacts(runState, stepState)
    }
  }
  stepState.status = localStepStatus(stepState)
  persistStepArtifacts(runState, stepState)
  emitStepArtifacts(runtimeEvents, runState, stepState)
  runtimeEvents?.stepStatus(stepState.status, stepState, step)
  return stepState
}

/** @param {Record<string, any>} param0 */
async function executeLocalFlow({ flow, steps, options, runState, projectRoot, completedStepStates = new Map(), runtimeEvents }) {
  const date = options.date || getLocalDate()
  const baseContext = contextForRunState(runState, options)
  const branch = options.branch || currentGitBranch(projectRoot)
  const netlify = resolveNetlifyProjectTarget({
    projectRoot,
    siteId: options.netlifySiteId,
    filter: options.filter,
    netlifyConfig: options.netlifyConfig,
  })
  const netlifyFilter = netlify.netlifyFilter
  const resolvedNetlifyOptions = netlifyOptionsFromTarget(options, netlify)
  Object.assign(options, resolvedNetlifyOptions)
  if (runState?.options) {
    runState.options = {
      ...runState.options,
      ...resolvedNetlifyOptions,
    }
    saveRunState(runState)
  }
  maybeReportNetlifySite(resolvedNetlifyOptions)
  maybeReportNetlifyFilter(netlifyFilter)

  for (const [stepIndex, step] of steps.entries()) {
    if (isHumanReviewStep(step)) {
      requireHumanReview({ runState, step, runtimeEvents })
    }
    const prompt = loadStepPrompt(flow, step)
    const stepState = {
      id: step.id,
      title: step.title,
      action: step.action,
      agents: step.agents,
      status: 'running',
      runs: [],
    }
    runState.steps.push(stepState)
    saveRunState(runState)

    const sourceRuns = sourceRunsForStep(step, completedStepStates)
    const roundResults = formatLocalRunResults(sourceRuns)
    const stepContext = contextWithOutputBudget(baseContext, options, {
      hasPriorResults: sourceRuns.length > 0,
      hasFutureSteps: stepIndex < steps.length - 1,
    })
    const runs = step.agents.map((agent) => {
      const followUpRun = step.submit === 'follow-up'
        ? sourceRuns.find((sourceRun) => sourceRun.agent === agent && sourceRun.runnerId)
        : null
      const delivery = prepareLocalPromptDelivery({
        agent,
        prompt,
        step,
        sourceRuns,
        roundResults,
        stepContext,
        runState,
        stepState,
        projectRoot,
        netlify,
        options,
        dryRun: options.dryRun,
      })
      const promptDelivery = /** @type {any} */ (delivery.promptDelivery || {})
      return {
        transport: NETLIFY_API_TRANSPORT,
        agent,
        status: options.dryRun ? 'dry-run' : 'pending',
        promptText: delivery.promptText,
        compactPromptText: delivery.compactPromptText && utf8ByteLength(delivery.compactPromptText) < utf8ByteLength(delivery.promptText) ? delivery.compactPromptText : '',
        promptDelivery,
        ...(delivery.blobRef ? { blobRef: delivery.blobRef } : {}),
        contextFetchPolicy: promptDelivery.contextFetchPolicy || '',
        resultText: '',
        runnerId: '',
        issueUrl: '',
        commentUrl: '',
        prUrl: '',
        deployUrl: '',
        existingRunnerId: followUpRun?.runnerId || '',
        raw: {
          stepId: step.id,
          promptName: prompt.name,
        },
      }
    })

    console.log(`\nRun Netlify API agents: ${step.title}`)
    for (const run of runs) {
      console.log(`\n- ${titleCase(run.agent)} ${prompt.title}`)
      console.log(`  prompt: ${prompt.name}`)
      console.log(`  body: ${run.promptText.length} chars / ${utf8ByteLength(run.promptText).toLocaleString()} bytes`)
      if (run.promptDelivery?.mode && run.promptDelivery.mode !== 'inline') {
        console.log(`  delivery: ${run.promptDelivery.mode}${run.promptDelivery.blobRef ? ` (${run.promptDelivery.blobRef.store}/${run.promptDelivery.blobRef.key})` : ''}`)
      }
    }

    if (options.dryRun) {
      stepState.status = 'dry-run'
      stepState.runs = runs
      completedStepStates.set(step.id, stepState)
      saveRunState(runState)
      for (const run of runs) runtimeEvents?.agentStatus('dry-run', run, stepState, step)
      runtimeEvents?.stepStatus('dry-run', stepState, step)
      continue
    }

    stepState.runs = runs
    saveRunState(runState)
    for (const run of runs) runtimeEvents?.agentStatus('pending', run, stepState, step)

    console.log(`\nSubmitting ${runs.length} Netlify agent ${runs.length === 1 ? 'run' : 'runs'} in parallel...`)
    const startedAt = Date.now()
    const pendingSubmissionLabels = new Set()
    const stopSubmissionHeartbeat = startSubmissionHeartbeat({
      pendingLabels: pendingSubmissionLabels,
      startedAt,
    })
    let submissions
    try {
      submissions = await Promise.allSettled(runs.map(async (run, index) => {
        const label = `${titleCase(run.agent)} ${prompt.title}`
        pendingSubmissionLabels.add(label)
        console.log(`- ${label}: submitting${run.existingRunnerId ? ' follow-up' : ''}...`)
        runtimeEvents?.agentStatus('submitting', run, stepState, step, {
          submit: step.submit || '',
          existingRunnerId: run.existingRunnerId || '',
        })
        try {
          const submitted = await submitLocalAgentRun({
            run,
            projectRoot,
            branch,
            siteId: netlify.siteId,
            netlifyFilter: netlifyFilter.filter,
            env: netlify.env,
            onRetry: ({ error, nextAttempt, attempts, delayMs }) => {
              const delaySeconds = Math.round(delayMs / 1000)
              runtimeEvents?.agentStatus('retrying', run, stepState, step, {
                attempt: nextAttempt,
                attempts,
                retryReason: error?.message || '',
                delayMs,
              })
              console.log(`  ${label}: submission failed, retrying ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
            },
          })
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
          submitted.submittedAfterSeconds = elapsedSeconds
          addLocalRunLinks(submitted, projectRoot, options)
          stepState.runs[index] = submitted
          saveRunState(runState)
          runtimeEvents?.agentStatus('submitted', submitted, stepState, step, {
            submittedAfterSeconds: elapsedSeconds,
          })
          console.log(`  ${label}: submitted after ${elapsedSeconds}s`)
          return submitted
        } catch (error) {
          const failedRun = {
            ...run,
            status: 'failed',
            resultText: error?.message || String(error || 'Submission failed'),
            raw: {
              ...run.raw,
              submissionError: error?.message || String(error || 'Submission failed'),
            },
          }
          stepState.runs[index] = failedRun
          saveRunState(runState)
          runtimeEvents?.agentStatus('failed', failedRun, stepState, step, {
            message: error?.message || String(error || 'Submission failed'),
            phase: 'submit',
          })
          console.log(`  ${label}: submission failed — ${conciseErrorMessage(error)}`)
          throw error
        } finally {
          pendingSubmissionLabels.delete(label)
        }
      }))
    } finally {
      stopSubmissionHeartbeat()
    }
    const failedSubmissions = submissions
      .map((result, index) => result.status === 'rejected'
        ? { label: `${titleCase(runs[index].agent)} ${prompt.title}`, error: result.reason }
        : null)
      .filter(Boolean)
    const submittedRuns = submissions.map((result, index) => {
      if (result.status === 'fulfilled') return result.value
      return stepState.runs[index]
    })
    stepState.runs = submittedRuns
    saveRunState(runState)
    if (failedSubmissions.length > 0) {
      throw new Error(submissionFailureSummary(failedSubmissions))
    }
    const submissionBoxes = formatSubmittedLocalRunBoxes({ runs: submittedRuns, prompt, projectRoot, options })
    if (submissionBoxes) {
      console.log('\nSubmitted Netlify agent runs:')
      console.log(submissionBoxes)
    }

    await completeLocalStep({ runState, stepState, step, options, projectRoot, netlify, netlifyFilter: netlifyFilter.filter, runtimeEvents })
    archiveEligibleCompletedLocalRuns({
      runState,
      flowSteps: steps,
      currentStepIndex: stepIndex,
      options,
      projectRoot,
      netlify,
    })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)

    if (stepState.status !== 'completed' && stepState.status !== 'dry-run') {
      throw new Error(`Local step "${step.id}" did not complete successfully.`)
    }
    console.log(`\n${nextLocalStepMessage(steps, stepIndex)}`)
  }
}

/** @param {Record<string, any>} param0 */
async function resumeLocalFlow({ flow, runState, projectRoot }) {
  trackRunState(runState)
  const options = await chooseNetlifyFilterOption({
    projectRoot,
    options: runState.options || {},
  })
  const branch = targetBranch(runState, { required: true })
  runState.options = {
    ...(runState.options || {}),
    ...options,
    branch,
  }
  saveRunState(runState)
  const netlify = resolveNetlifyProjectTarget({
    projectRoot,
    siteId: options.netlifySiteId,
    filter: options.filter,
    netlifyConfig: options.netlifyConfig,
  })
  runState.options = {
    ...runState.options,
    ...netlifyOptionsFromTarget(options, netlify),
  }
  saveRunState(runState)
  const completedStepStates = completedStepMapFromRunState(runState)
  const startIndex = firstRunnableStepIndex(flow, runState)
  if (startIndex >= flow.steps.length) {
    console.log(`Run ${runState.runId} is already complete.`)
    clearTrackedRunState(runState, { completed: true })
    return
  }

  const step = flow.steps[startIndex]
  const stepState = (runState.steps || []).find((candidate) => candidate.id === step.id)
  if (stepState && stepState.runs?.some(shouldPollLocalRun)) {
    console.log(`Resuming ${runState.runId}`)
    console.log(`Flow: ${flow.title}`)
    console.log(`State: ${workflowStatePath(runState.dir)}`)
    console.log(`Repair and continue: ${step.title}`)
    await completeLocalStep({ runState, stepState, step, options: runState.options, projectRoot, netlify, netlifyFilter: netlify.filter, initialDelayMs: 0 })
    archiveEligibleCompletedLocalRuns({
      runState,
      flowSteps: flow.steps,
      currentStepIndex: startIndex,
      options,
      projectRoot,
      netlify,
    })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
    if (stepState.status !== 'completed' && stepState.status !== 'dry-run') {
      throw new Error(`Local step "${step.id}" did not complete successfully.`)
    }
    await executeLocalFlow({
      flow,
      steps: flow.steps.slice(startIndex + 1),
      options: runState.options,
      runState,
      projectRoot,
      completedStepStates,
    })
    clearTrackedRunState(runState, { completed: true })
    return
  }

  await executeLocalFlow({
    flow,
    steps: flow.steps.slice(startIndex),
    options: runState.options,
    runState,
    projectRoot,
    completedStepStates,
  })
  clearTrackedRunState(runState, { completed: true })
}

/** @param {Record<string, any>} param0 */
async function resumeGithubFlow({ flow, runState, projectRoot }) {
  const options = runState.options || {}
  trackRunState(runState, {
    onInterrupt: ({ runState: activeRunState, reason }) => {
      cleanupWorkflowBlobsForRun({
        runState: activeRunState,
        projectRoot,
        options,
        reason: `interrupted workflow (${reason})`,
      })
    },
  })
  const repo = resolveRepo(options.repo)
  const completedStepStates = completedStepMapFromRunState(runState)
  const startIndex = firstRunnableStepIndex(flow, runState)
  if (startIndex >= flow.steps.length) {
    console.log(`Run ${runState.runId} is already complete.`)
    clearTrackedRunState(runState, { completed: true })
    return
  }

  const step = flow.steps[startIndex]
  const stepState = (runState.steps || []).find((candidate) => candidate.id === step.id)
  if (stepState && githubStepStatus(stepState) === 'completed') {
    console.log(`Resuming ${runState.runId}`)
    console.log(`Flow: ${flow.title}`)
    console.log(`State: ${workflowStatePath(runState.dir)}`)
    console.log(`Repair and continue: ${step.title} is already complete`)
    stepState.status = 'completed'
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
    await executeGithubFlow({
      flow,
      steps: flow.steps.slice(startIndex + 1),
      options,
      runState,
      completedStepStates,
    })
    clearTrackedRunState(runState, { completed: true })
    return
  }
  if (stepState && stepState.runs?.some(shouldPollGithubRun)) {
    console.log(`Resuming ${runState.runId}`)
    console.log(`Flow: ${flow.title}`)
    console.log(`State: ${workflowStatePath(runState.dir)}`)
    console.log(`Repair and continue: ${step.title}`)
    await completeGithubStep({ runState, repo, stepState, step, options })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
    if (stepState.status !== 'completed' && stepState.status !== 'dry-run') {
      throw new Error(`GitHub step "${step.id}" did not complete successfully.`)
    }
    await executeGithubFlow({
      flow,
      steps: flow.steps.slice(startIndex + 1),
      options,
      runState,
      completedStepStates,
    })
    clearTrackedRunState(runState, { completed: true })
    return
  }

  await executeGithubFlow({
    flow,
    steps: flow.steps.slice(startIndex),
    options,
    runState,
    completedStepStates,
  })
  clearTrackedRunState(runState, { completed: true })
}

/** @param {any} projectRoot @param {Record<string, any>} param1 */
function findRunStateForRetry(projectRoot, { runId, flowId, stepId, agent } = {}) {
  const states = listRunStates(projectRoot)
  if (runId) {
    const matched = states.find((state) => state.runId === runId)
    if (!matched) throw new Error(`Could not find workflow ${runId} under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    return matched
  }
  const matched = states.find((state) => {
    if (!isNetlifyApiTransport(state.transport)) return false
    if (flowId && state.flowId !== flowId) return false
    return localRetryCandidates(state, { stepId, agent }).length > 0
  })
  if (!matched) throw new Error('Could not find a failed Netlify API run to retry. Pass a run id explicitly.')
  return matched
}

async function handleRetry(runId, options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const runState = findRunStateForRetry(projectRoot, {
    runId,
    flowId: options.flow,
    stepId: options.step,
    agent: options.agent,
  })
  if (!isNetlifyApiTransport(runState.transport)) {
    throw new Error(`Run ${runState.runId} uses ${runState.transport || 'unknown'} transport; retry currently supports Netlify API runs only.`)
  }

  const flow = flowFromRunState(runState) || await loadFlow(runState.flowId, flowLoadOptions({
    ...(runState.options || {}),
    ...options,
  }, projectRoot))
  const candidates = localRetryCandidates(runState, {
    stepId: options.step,
    agent: options.agent,
  })
  if (candidates.length === 0) {
    throw new Error(`Run ${runState.runId} has no failed Netlify API runner matching the requested filters.`)
  }
  if (candidates.length > 1) {
    const choices = candidates.map(({ step, run }) => `${step.id}:${run.agent}`).join(', ')
    throw new Error(`More than one failed Netlify API runner can be retried (${choices}). Pass --step and --agent.`)
  }

  trackRunState(runState)
  const [{ step, stepIndex, run, runIndex }] = candidates
  const flowStep = flow.steps.find((candidate) => candidate.id === step.id)
  if (!flowStep) throw new Error(`Flow ${flow.id} no longer contains step ${step.id}.`)

  const branch = targetBranch(runState, { required: true })
  const retryOptions = await chooseNetlifyFilterOption({
    projectRoot,
    options: {
      ...(runState.options || {}),
      ...options,
      filter: options.filter || runState.options?.filter || '',
    },
  })
  const netlify = resolveNetlifyProjectTarget({
    projectRoot,
    siteId: retryOptions.netlifySiteId,
    filter: retryOptions.filter,
    netlifyConfig: retryOptions.netlifyConfig,
  })
  const resolvedRetryOptions = netlifyOptionsFromTarget(retryOptions, netlify)
  runState.options = {
    ...(runState.options || {}),
    ...(resolvedRetryOptions.filter ? { filter: resolvedRetryOptions.filter } : {}),
    ...(resolvedRetryOptions.netlifyConfig ? { netlifyConfig: resolvedRetryOptions.netlifyConfig } : {}),
    ...(resolvedRetryOptions.netlifySiteId ? { netlifySiteId: resolvedRetryOptions.netlifySiteId } : {}),
    ...(resolvedRetryOptions.netlifySiteSource ? { netlifySiteSource: resolvedRetryOptions.netlifySiteSource } : {}),
  }
  const netlifyFilter = netlify.netlifyFilter
  const compactPromptText = buildCompactLocalPromptForRetry({ flow, step: flowStep, runState, run })
  if (!compactPromptText || compactPromptText.length >= String(run.promptText || '').length) {
    throw new Error(`Could not build a shorter prompt for ${run.agent} ${step.id}.`)
  }

  console.log(`Retrying ${titleCase(run.agent)} ${step.title}`)
  console.log(`Run: ${runState.runId}`)
  console.log(`Runner: ${run.runnerId}`)
  console.log(`Prompt: ${String(run.promptText || '').length} -> ${compactPromptText.length} chars`)
  maybeReportNetlifySite(resolvedRetryOptions)
  maybeReportNetlifyFilter(netlifyFilter)

  const retryRun = {
    ...run,
    status: 'pending',
    promptText: compactPromptText,
    compactPromptText,
    resultText: '',
    existingRunnerId: run.runnerId,
    promptShrinkRetryCount: Number(run.promptShrinkRetryCount || 0) + 1,
    raw: {
      ...run.raw,
      retry: {
        reason: 'manual-compact-prompt',
        previousStatus: run.status,
        previousResultText: run.resultText || '',
      },
    },
  }
  const submitted = await submitLocalAgentRun({
    run: retryRun,
    projectRoot,
    branch,
    siteId: netlify.siteId,
    netlifyFilter: netlifyFilter.filter,
    env: netlify.env,
    onRetry: ({ error, nextAttempt, attempts, delayMs }) => {
      const delaySeconds = Math.round(delayMs / 1000)
      console.log(`Submission failed, retrying ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
    },
  })
  step.runs[runIndex] = submitted
  step.status = 'running'
  saveRunState(runState)

  const reporter = makeStepProgressReporter({
    stepTitle: step.title,
    total: 1,
    agents: [run.agent],
  })
  const completed = await waitForLocalAgentRuns({
    projectRoot,
    runs: [submitted],
    siteId: netlify.siteId,
    netlifyFilter: netlifyFilter.filter,
    env: netlify.env,
    timeoutMinutes: Number.parseInt(retryOptions.timeoutMinutes || runState.options?.timeoutMinutes || '25', 10),
    initialDelayMs: 0,
    onProgress: (event) => reporter.updateRun(event),
    onTerminalRun: (terminalRun) => {
      addLocalRunLinks(terminalRun, projectRoot, resolvedRetryOptions)
      step.runs[runIndex] = terminalRun
      persistRunArtifact(runState, step, terminalRun)
      reportTerminalLocalRun(reporter, terminalRun, projectRoot)
    },
  })
  const completedRun = completed[0]
  addLocalRunLinks(completedRun, projectRoot, resolvedRetryOptions)
  step.runs[runIndex] = completedRun
  step.status = localStepStatus(step)
  persistStepArtifacts(runState, step)
  reporter.updateRun({
    run: completedRun,
    state: completedRun.status,
    terminal: true,
    terminalSuccess: completedRun.status === 'completed',
    terminalFailure: completedRun.status !== 'completed',
  })
  if (completedRun.status === 'completed') {
    reporter.done(`${step.title}: ${titleCase(run.agent)} complete`)
  } else {
    reporter.fail(`${step.title}: ${titleCase(run.agent)} ${completedRun.status}`)
  }
  saveRunState(runState)

  if (step.status !== 'completed') {
    throw new Error(`Retried ${run.agent} run did not complete successfully.`)
  }

  const completedStepStates = completedStepMapFromRunState(runState)
  completedStepStates.set(step.id, step)
  await executeLocalFlow({
    flow,
    steps: flow.steps.slice(stepIndex + 1),
    options: runState.options || {},
    runState,
    projectRoot,
    completedStepStates,
  })
  clearTrackedRunState(runState, { completed: true })
  printSuccessBox({ flow, runState, transport: NETLIFY_API_TRANSPORT, projectRoot })
}

async function handleAdHocAgentRun(options = {}) {
  const invocationDir = path.resolve(options.invocationDir || process.cwd())
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: invocationDir })
  const transport = await chooseSingleRunTransportInteractively({
    requested: options.transport || 'auto',
    projectRoot,
  })
  const agent = await chooseAdHocAgentInteractively(options.agent)
  const promptText = await promptForAdHocAgentPrompt(options.prompt || options.context)
  if (options.dryRun) {
    console.log('Netlify agent run preview')
    console.log(`Transport: ${transport}`)
    console.log(`Agent: ${titleCase(agent)}`)
    console.log(`Prompt: ${promptText.length} chars`)
    console.log('')
    console.log(promptText)
    return
  }

  if (isNetlifyApiTransport(transport)) {
    const netlifyOptions = await chooseNetlifyFilterOption({ projectRoot, invocationDir, options })
    await runSingleNetlifyAgent({
      projectRoot,
      agent,
      promptText,
      title: 'Netlify Agent Run',
      source: {
        type: 'single-run',
        transport: NETLIFY_API_TRANSPORT,
        promptLength: promptText.length,
      },
      raw: {
        stepId: 'netlify-agent-run',
        promptName: 'netlify-agent-run',
      },
      options: netlifyOptions,
      startLabel: 'Netlify agent run',
    })
    return
  }

  await runSingleGithubAgent({
    projectRoot,
    agent,
    promptText,
    source: {
      type: 'single-run',
      transport: 'github',
      promptLength: promptText.length,
    },
    options,
  })
}

/** @param {{ projectRoot: string, options?: Record<string, any>, flow?: Record<string, any> | null }} param0 */
async function maybeResumeUnfinishedRun({ projectRoot, options = {}, flow = null }) {
  if (!process.stdin.isTTY || options.yes || options.dryRun) return false
  const resumableEntry = await findLatestResumableRun({ projectRoot, options, flow })
  if (!resumableEntry) return false
  const { runState: resumable, flow: resumableFlow } = resumableEntry

  const clack = await loadClack()
  printResumeRunDetails(resumable, { projectRoot })
  const selected = await clack.confirm({
    message: 'Resume and complete this unfinished workflow run?',
    initialValue: true,
  })
  if (clack.isCancel(selected)) process.exit(0)
  if (!selected) {
    dismissRunState(resumable)
    console.log(`Dismissed unfinished run ${resumable.runId}`)
    return false
  }

  const resumableSteps = runnableSteps(resumableFlow, resumable.options || {})
  printFlowPlan({
    flow: resumableFlow,
    steps: resumableSteps.length > 0 ? resumableSteps : resumableFlow.steps,
    transport: resumable.transport || 'github',
    branch: targetBranch(resumable) || currentGitBranch(projectRoot),
    context: resumable.options?.context || '',
    runState: resumable,
  })
  const resumeAfterPreview = await clack.confirm({
    message: `Resume ${resumableFlow.title} from saved run ${resumable.runId}?`,
    initialValue: true,
  })
  if (clack.isCancel(resumeAfterPreview)) process.exit(0)
  if (!resumeAfterPreview) return true
  if (resumable.transport === 'github') {
    await resumeGithubFlow({ flow: resumableFlow, runState: resumable, projectRoot })
  } else {
    await resumeLocalFlow({ flow: resumableFlow, runState: resumable, projectRoot })
  }
  return true
}

async function resumeRunById(runId, options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: process.cwd() })
  const runState = listRunStates(projectRoot).find((state) => state.runId === runId)
  if (!runState) throw new Error(`Could not find workflow run "${runId}".`)
  const flow = flowFromRunState(runState) || await loadFlow(runState.flowId, flowLoadOptions({ ...(runState.options || {}), ...options }, projectRoot))
  if (options.approveReview !== false) {
    approveHumanReviewGate({
      runState,
      stepId: options.stepId || '',
      reviewer: options.reviewer || 'visualizer',
    })
  }
  const refreshed = listRunStates(projectRoot).find((state) => state.runId === runId) || runState
  if (refreshed.transport === 'github') {
    await resumeGithubFlow({ flow, runState: refreshed, projectRoot })
  } else {
    await resumeLocalFlow({ flow, runState: refreshed, projectRoot })
  }
  return refreshed
}

async function handleRunEngine(flowId, options) {
  const invocationDir = path.resolve(process.cwd())
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: invocationDir })
  const runtimeEvents = createWorkflowEventContext({
    sink: options.runnerEventSink,
    notify: {
      notifyUrl: options.notifyUrl,
      notifyEvents: options.notifyEvents,
    },
  })
  if (flowId === 'ls' || flowId === 'list') {
    await handleList({ ...options, projectRoot })
    return
  }
  const wantsAdHoc = !flowId && (options.agent || options.prompt)
  if (!flowId && !wantsAdHoc && await maybeResumeUnfinishedRun({ projectRoot, options })) return
  const resolvedFlowId = flowId || (wantsAdHoc ? AD_HOC_RUN_TARGET : (process.stdin.isTTY ? await pickFlowInteractively({ projectRoot, options }) : 'review'))
  if (isAdHocRunTarget(resolvedFlowId)) {
    await handleAdHocAgentRun({ ...options, projectRoot, invocationDir })
    return
  }
  const flow = await loadFlow(resolvedFlowId, flowLoadOptions(options, projectRoot))

  if (await maybeResumeUnfinishedRun({ projectRoot, options, flow })) return

  const flowOptions = await collectFlowOptions(flow, options)
  const requestedTransport = flowOptions.transport || flow.defaults.transport
  let transport
  if (flowOptions.dryRun) {
    transport = resolveDryRunTransport({ requestedTransport, projectRoot })
  } else {
    const detections = detectTransports({ projectRoot })
    if ((requestedTransport === 'auto' || !requestedTransport) && detections.every((candidate) => !candidate.available)) {
      throw new Error(formatTransportSetupHelp(detections))
    }
    transport = process.stdin.isTTY
      ? await chooseTransportInteractively({ requested: requestedTransport, projectRoot })
      : resolveTransport(requestedTransport, detections)
    const selectedDetection = detections.find((candidate) => candidate.id === transport)
    if (!selectedDetection?.available) {
      throw new Error(
        [
          `Transport "${transport}" is not available: ${selectedDetection?.reason || 'unknown reason'}`,
          '',
          formatTransportSetupHelp(detections),
        ].join('\n'),
      )
    }
  }

  const target = resolveTarget({ options: flowOptions, projectRoot, transport })
  const branchOptions = {
    ...flowOptions,
    branch: target.branch,
    branchSource: target.sourceType,
    target,
  }

  const netlifyOptions = isNetlifyApiTransport(transport) && !branchOptions.dryRun
    ? await chooseNetlifyFilterOption({ projectRoot, invocationDir, options: branchOptions })
    : branchOptions

  const prepared = await prepareInteractiveFlowRun({ flow, options: netlifyOptions, transport, projectRoot })
  const configuredFlow = prepared.flow
  const configuredOptions = prepared.options
  const steps = prepared.steps

  if (configuredOptions.dryRun) {
    if (!prepared.previewPrinted) {
      printFlowPlan({
        flow: configuredFlow,
        steps,
        transport,
        branch: configuredOptions.branch,
        context: configuredOptions.context,
      })
      console.log('Dry run only. No issues, comments, Agent Runner jobs, or .nax artifacts will be created.')
    }
    return
  }

  const runContext = buildFlowRunContext({ options: configuredOptions, projectRoot, transport, target })

  const runState = createRunState({
    projectRoot,
    flow: configuredFlow,
    transport,
    target,
    options: {
      ...configuredOptions,
      projectRoot,
    },
  })
  trackRunState(runState, {
    onInterrupt: ({ runState: activeRunState, reason }) => {
      cleanupWorkflowBlobsForRun({
        runState: activeRunState,
        projectRoot,
        options: configuredOptions,
        reason: `interrupted workflow (${reason})`,
      })
      cancelLocalWorkflowRunnersForInterrupt({
        runState: activeRunState,
        projectRoot,
        options: configuredOptions,
        reason: `interrupted workflow (${reason})`,
      })
    },
  })
  runState.context = runContext
  saveRunState(runState)
  runtimeEvents.setRunState(runState)
  runtimeEvents.workflowStarted({
    command: ['nax', 'run', configuredFlow.id],
    options: {
      ...configuredOptions,
      transport,
    },
  })
  console.log(`Run ${runState.runId}`)
  console.log(`Flow: ${configuredFlow.title}`)
  console.log(`Target: ${targetSummary(target)}`)
  console.log(`Transport: ${transport}`)
  console.log(`Branch: ${configuredOptions.branch}`)
  console.log(`State: ${workflowStatePath(runState.dir)}`)

  try {
    if (isNetlifyApiTransport(transport)) {
      await executeLocalFlow({ flow: configuredFlow, steps, options: configuredOptions, runState, projectRoot, runtimeEvents })
    } else {
      await executeGithubFlow({ flow: configuredFlow, steps, options: configuredOptions, runState, runtimeEvents })
    }
    cleanupWorkflowBlobsForRun({
      runState,
      projectRoot,
      options: configuredOptions,
      reason: 'completed workflow',
    })

    clearTrackedRunState(runState, { completed: true })
    persistWorkflowArtifacts(runState, { summaryOnly: true })
    emitWorkflowArtifacts(runtimeEvents, runState)
    writeGithubStepSummary(runState)
    runtimeEvents.workflowStatus('completed')
    printSuccessBox({ flow: configuredFlow, runState, transport, projectRoot })
    printPostSuccessHandoffHint(runState, projectRoot)
  } catch (error) {
    if (error?.code === AWAITING_REVIEW) {
      persistWorkflowArtifacts(runState, { summaryOnly: true })
      emitWorkflowArtifacts(runtimeEvents, runState)
      writeGithubStepSummary(runState)
      console.log(`Workflow paused for human review. Resume it from the visualizer after approval.`)
      return AWAITING_REVIEW
    }
    runState.status = 'failed'
    try {
      cleanupWorkflowBlobsForRun({
        runState,
        projectRoot,
        options: configuredOptions,
        reason: 'failed workflow',
      })
    } catch (cleanupError) {
      runState.blobCleanupWarning = cleanupError?.message || String(cleanupError)
    }
    saveRunState(runState)
    persistWorkflowArtifacts(runState, { summaryOnly: true })
    emitWorkflowArtifacts(runtimeEvents, runState)
    writeGithubStepSummary(runState)
    runtimeEvents.workflowStatus('failed', { message: error?.message || String(error) })
    printPartialArtifactHint(runState)
    throw error
  } finally {
    await runtimeEvents.close()
  }

  if (configuredOptions.notify) {
    if (process.platform === 'darwin') {
      spawnSync('osascript', ['-e', `display notification "Flow ${configuredFlow.title} finished" with title "nax"`])
    } else {
      console.log(`--notify is only supported on macOS; skipping desktop notification.`)
    }
  }
}

async function handleRun(flowId, options = {}) {
  const result = await runWorkflow({
    flowId: flowId || '',
    options,
    engine: handleRunEngine,
    passthrough: true,
    forceNonInteractive: false,
  })
  if (result.status !== 'completed' && result.status !== AWAITING_REVIEW) {
    const message = result.stderr.trim().split('\n').filter(Boolean).pop() || `Workflow "${flowId || 'review'}" failed.`
    throw new Error(message)
  }
}

function printSkillInstallResults(results) {
  for (const result of results) {
    const relative = path.join(result.provider, 'skills', result.skill)
    console.log(`${result.status} -> ${relative} (v${result.version})`)
  }
}

function printSkillCheckResults(results) {
  if (results.length === 0) {
    console.log('No bundled skills found.')
    return
  }
  for (const result of results) {
    const relative = path.join(result.provider, 'skills', result.skill)
    if (!result.installed) {
      console.log(`${relative}: not installed`)
      continue
    }
    const suffix = result.current ? 'current' : 'stale; run `nax skills update`'
    console.log(`${relative}: v${result.installedVersion || '?'} package v${result.packageVersion} (${suffix})`)
  }
}

function printSkillsHelp() {
  console.log([
    'nax skills - manage project-local agent skills',
    '',
    'Usage:',
    '  nax skills install [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax skills update  [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax skills check   [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax skills list',
    '',
    `Supported providers: ${PROVIDER_DIRS.join(', ')}`,
    '',
    'By default, install/update targets detected provider directories in the current project.',
    'If no provider directory exists, nax installs into .claude/skills by default.',
  ].join('\n'))
}

async function handleSkills(subcommand = 'help', options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const common = {
    projectRoot,
    providers: options.provider,
    allProviders: options.allProviders === true,
    skill: options.skill,
    allSkills: options.allSkills === true,
  }
  switch (subcommand) {
    case 'install':
      printSkillInstallResults(installSkills({ ...common, dryRun: options.dryRun === true }))
      return
    case 'update':
      printSkillInstallResults(updateSkills({ ...common, dryRun: options.dryRun === true }))
      return
    case 'check':
      printSkillCheckResults(checkSkills(common))
      return
    case 'list':
      for (const skill of listBundledSkills()) console.log(skill)
      return
    case 'help':
    case undefined:
    case null:
      printSkillsHelp()
      return
    default:
      throw new Error(`Unknown skills subcommand "${subcommand}".`)
  }
}

/** @returns {import('commander').Command} */
function buildProgram() {
  return buildNaxProgram({
    actionOptions,
    collectOption,
    defaultOrchestrator: DEFAULT_ORCHESTRATOR,
    defaultOutputBudgetBytes: DEFAULT_OUTPUT_BUDGET_BYTES,
    handlers: {
      clean: handleClean,
      ci: handleCi,
      comment: handleComment,
      handoff: handleHandoff,
      init: handleInit,
      issue: handleIssue,
      list: handleList,
      previewBoxes: handlePreviewBoxes,
      previewSpinner: handlePreviewSpinner,
      recent: handleRecent,
      retry: handleRetry,
      run: handleRun,
      skills: handleSkills,
      sync: handleSync,
      visualize: handleVisualize,
    },
    mergeCommandOptions,
  })
}

if (require.main === module) {
  buildProgram().parseAsync(process.argv).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

module.exports = {
  buildCommentPlan,
  buildPlan,
  createComment,
  createDiscussionComment,
  buildProgram,
  createIssue,
  createPullRequestComment,
  extractLinkedPullRequest,
  inferModelFromIssueTitle,
  loadIssueMeta,
  loadPullRequestMeta,
  parseCsv,
  parseGitHubPullRequestUrl,
  resolveCommentTarget,
  _private: {
    completedStepMapFromRunState,
    AD_HOC_RUN_CHOICE,
    firstRunnableStepIndex,
    flowAgents,
    chooseNetlifyFilterOption,
    conciseErrorMessage,
    buildOutputBudgetContext,
    buildCompactLocalPromptForRetry,
    buildFetchInstruction,
    buildHandoffPrompt,
    buildOffloadedRoundResults,
    compactTextForRetry,
    compactLocalTextByBytes,
    contextWithOutputBudget,
    cancelLocalWorkflowRunnersForInterrupt,
    cancellableLocalRunnerIds,
    cleanupLocalWorkflowBlobs,
    cleanupWorkflowBlobsForRun,
    enforceGithubActionPromptBudget,
    copyToClipboard,
    findGithubRunnerFailures,
    findGithubActionRunFailures,
    formatGithubActionPromptBudgetError,
    applyGithubStatusCommentToRun,
    findLatestResumableRun,
    findRunStateForHandoff,
    formatDetailedRelativeTime,
    formatDidYouKnowLines,
    formatCompactHandoffSourceHint,
    formatHandoffSourceHint,
    formatLatestHandoffSourceHint,
    formatFlowList,
    formatFlowListBox,
    formatFlowListJson,
    formatNetlifyConfigAmbiguity,
    formatHandoffSourceKind,
    formatHandoffSourceLabel,
    formatHandoffSourceDetailBox,
    handleRun,
    handleRunEngine,
    handleCi,
    handleSync,
    handoffSourceDetailTitle,
    handoffSourceDetailLines,
    isAutomaticResumeCandidate,
    compactCurrentTask,
    formatTtyProgressRow,
    formatSubmittedLocalRunBoxes,
    handoffSummaryPath,
    handoffSourceMenuOptions,
    handoffSourceQuery,
    isAdHocRunTarget,
    netlifyConfigChoiceHint,
    netlifyProjectChoiceLabel,
    openHandoffSource,
    orderSingleRunTransports,
    resolveProjectRoot,
    nextLocalStepMessage,
    localRetryCandidates,
    localAgentRunUrl,
    sortNetlifyConfigChoices,
    agentStepCompletionSummary,
    applyContextFetchClassification,
    applyArchiveResultToRunner,
    archiveEligibleCompletedLocalRuns,
    AGENT_RUNNER_USE_CASES,
    DID_YOU_KNOW_BORDER_COLORS,
    futureFollowUpReferencesStep,
    githubStepStatus,
    githubActionPromptBudgetViolations,
    githubActionPromptBudgetWarnings,
    githubActionTriggerTextMetrics,
    githubActionFailureReason,
    githubActionFailureSummary,
    githubActionRunMatchesResult,
    outputBudgetBytes,
    outputBudgetEnabled,
    shouldArchiveCompletedStep,
    shouldPollGithubRun,
    clearRenderedProgressFrame,
    physicalRowCount,
    visibleLength,
    normalizeHandoffSourceKind,
    pickFlavor,
    formatCompactLocalRunResults,
    formatLocalRunResults,
    githubResultsToSourceRuns,
    githubSafePromptBytes,
    handleClean,
    makeStepProgressReporter,
    normalizeGithubRunResult,
    printPostSuccessHandoffHint,
    printSuccessBox,
    readHandoffSummary,
    relativeHandoffPath,
    formatResumeRunDetails,
    resumeLastStepTitle,
    resumeRunById,
    resumeRunDetailsTitle,
    resumeStatusColor,
    resumeStepDecorations,
    savedAgentStatus,
    savedStepStatus,
    stepResultsSummaryPath,
    workflowSummaryDisplayPath,
    startSubmissionHeartbeat,
    submissionFailureSummary,
    usageSummariesForRunState,
    resultsScopedToGithubRuns,
    runnableSteps,
    waitForGithubStep,
    sourceIssueNumbersForStep,
    sourceRunsForStep,
    prepareLocalPromptDelivery,
    ensureGithubPlanBlobOffload,
    buildAndMaybeFallbackPlan,
    renderStructuredForLocalEssentials,
    withSelectedAgents,
    withSelectedStepModels,
    workflowPickerLabel,
    workflowPickerHint,
    uniqueNumbers,
  },
}
