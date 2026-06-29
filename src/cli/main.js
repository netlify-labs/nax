const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { makeBox, makeHorizontalBoxes } = require('@davidwells/box-logger')
const { buildNaxProgram } = require('./commands/nax')
const {
  actionOptions,
  collectOption,
  mergeCommandOptions,
} = require('./commands/options')
const { DEFAULT_MODELS } = require('../core/constants')
const {
  buildIssueBody,
  buildIssueTitle,
  getLocalDate,
  listPrompts,
  loadPrompt,
  resolveRepo,
  titleCase,
} = require('../workflows/catalog/prompts')
const { buildAutomaticContext, resolveRemoteBranchSha } = require('../integrations/git/review-context')
const { legacyTargetFromRunState, resolveTarget, targetBranch, targetSummary } = require('../integrations/git/target')
const {
  chooseNetlifyFilterOption,
  configDirForNetlifyOptions,
  formatNetlifyConfigAmbiguity,
  maybeReportNetlifyConfig,
  maybeReportNetlifyFilter,
  maybeReportNetlifySite,
  netlifyConfigChoiceHint,
  netlifyOptionsFromTarget,
  netlifyProjectChoiceLabel,
  resolveProjectRoot,
  sortNetlifyConfigChoices,
} = require('../integrations/netlify/project-selection')
const {
  assertCrossReviewComplete,
  extractStructuredSection,
  fetchRoundResults,
  formatRoundResults,
  rawIssuesFromResults,
} = require('../workflows/round-results')
const { formatGroupHint, listRecentIssueGroups } = require('../integrations/github/issue-groups')
const { parseRunnerResultMarker } = require('../integrations/github/comment-markers')
const {
  formatAgentRunUrl,
  formatAgentRunUrlFromAdminUrl,
  formatUsageSummary,
  normalizeGithubRunResult,
  usageSummariesForRunState,
} = require('../workflows/results/agent-run-results')
const { runGh } = require('../integrations/github/gh-cli')
const { multiline } = require('../utils/multiline')
const { WAIT_FOR_AGENT_RESULTS, isHumanReviewStep, listFlows, loadFlow, loadStepPrompt } = requireWithoutArgvFlag('--verbose', () => require('../workflows/catalog/flows'))
const { createRunState, dismissRunState, isUnfinishedRun, listRunStates, saveRunState, workflowStatePath } = require('../storage/local/run-state')
const { AWAITING_REVIEW, approveHumanReviewGate, createHumanReviewStepState } = require('../workflows/human-review')
const {
  artifactsRootForRunState,
  persistRunArtifact,
  persistStepArtifacts,
  persistWorkflowArtifacts,
  safeArtifactName,
  stepArtifactsDir,
  writeGithubStepSummary,
} = require('../workflows/artifacts/workflow-artifacts')
const { clearTrackedRunState, markRunCompleted, trackRunState } = require('../storage/local/graceful-run-state')
const { persistAgentRunnerArtifact } = require('../workflows/artifacts/agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('../workflows/artifacts/agent-session-artifacts')
const { listHandoffSources, readHandoffSource, relativeDisplayPath } = require('../workflows/followups/handoff-sources')
const { handleCi } = require('./commands/ci')
const {
  AD_HOC_RUN_CHOICE,
  formatFlowList,
  formatFlowListBox,
  formatFlowListJson,
  workflowPickerHint,
  workflowPickerLabel,
} = require('./display/flow-list')
const {
  buildHandoffPrompt,
  copyToClipboard,
  findRunStateForHandoff,
  formatCompactHandoffSourceHint,
  formatHandoffSourceDetailBox,
  formatHandoffSourceHint,
  formatHandoffSourceKind,
  formatHandoffSourceLabel,
  formatLatestHandoffSourceHint,
  handoffSourceDetailLines,
  handoffSourceDetailTitle,
  handoffSourceMenuOptions,
  handoffSourceQuery,
  handoffSummaryPath,
  normalizeHandoffSourceKind,
  openHandoffSource,
  printPostSuccessHandoffHint,
  readHandoffSummary,
  readSelectedHandoffSource,
  relativeHandoffPath,
} = require('./commands/handoff')
const { handleInit } = require('./commands/init')
const { createIssueHandlers } = require('./commands/issue')
const { handleSync } = require('./commands/sync')
const {
  PROVIDER_DIRS,
  checkSkills,
  installSkills,
  listBundledSkills,
  updateSkills,
} = require('../integrations/skills')
const { NETLIFY_API_TRANSPORT, detectTransports, formatTransportSetupHelp, isNetlifyApiTransport, resolveTransport } = require('../integrations/transports')
const { readNetlifyProject } = require('../integrations/netlify/init')
const { runWorkflow } = require('../workflows/engine/runner')
const { createWorkflowEventContext } = require('../workflows/events/workflow-events')
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
} = require('../workflows/engine/progress')
const {
  addLocalRunLinks,
  applyArchiveResultToRunner,
  archiveEligibleCompletedLocalRuns,
  buildCompactLocalPromptForRetry,
  emitRunArtifact,
  emitStepArtifacts,
  emitWorkflowArtifacts,
  executeLocalFlow,
  formatSubmittedLocalRunBoxes,
  futureFollowUpReferencesStep,
  localAgentRunUrl,
  localStepStatus,
  reportTerminalLocalRun,
  requireHumanReview,
  resumeLocalFlow,
  shouldArchiveCompletedStep,
} = require('../workflows/engine/local-executor')
const {
  buildAndMaybeFallbackPlan,
  executeGithubFlow,
  resumeGithubFlow,
} = require('../workflows/engine/github-executor')
const {
  applyContextFetchClassification,
  blobOffloadDisabled,
  buildFullPromptWrapper,
  buildGithubFullPromptWrapper,
  buildLocalAgentPrompt,
  buildOffloadedRoundResults,
  buildSafeCompactLocalPrompt,
  cleanupLocalWorkflowBlobs,
  cleanupWorkflowBlobsForRun,
  compactLocalTextByBytes,
  compactTextForRetry,
  ensureFullPromptBlobOffload,
  ensureGithubIssueFullPromptBlobOffload,
  ensureGithubPlanBlobOffload,
  ensureStepBlobOffload,
  formatCompactLocalRunResults,
  formatLocalRunResults,
  githubIssueDeliveryKey,
  localPromptByteMetrics,
  localSafePromptBytes,
  optionalNetlifyForBlobOffload,
  prepareLocalPromptDelivery,
  renderStructuredForLocalEssentials,
} = require('../workflows/engine/prompt-delivery')
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
} = require('../workflows/engine/resume')
const { setBlob, deleteBlob } = require('../integrations/netlify/blobs')
const {
  addRunBlobRef,
  compactBlobRefs,
  cleanupRunBlobRefs,
  sweepBlobRefs,
} = require('../storage/local/blob-ref-registry')
const { writeLocalBlobDebugPayload } = require('../storage/local/blob-debug-cache')
const {
  blobRefForStep,
  buildBlobPayload,
  buildFetchInstruction,
  buildInlineEssentials,
  classifyContextFetch,
  compactTextByBytes,
  safePromptBytes,
} = require('../workflows/prompts/offload')
const {
  applyAgentSelection,
  assertValidAgentSelection,
  parseStepModelsEntries,
} = require('../core/agents/selection')
const {
  archiveAgentRun,
  buildNetlifyEnv,
  currentGitBranch,
  stopAgentRun,
  resolveNetlifyFilter,
  resolveNetlifyProjectTarget,
  submitLocalAgentRun,
  waitForLocalAgentRuns,
} = require('../integrations/netlify/local-runner')
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
} = require('../core/prompts/budget')
const {
  applyGithubStatusCommentToRun,
  findGithubActionRunFailures,
  findGithubRunnerFailures,
  githubActionFailureReason,
  githubActionFailureSummary,
  githubActionRunMatchesResult,
  githubStepStatus,
  resultsScopedToGithubRuns,
  waitForGithubStep,
} = require('../integrations/github/polling')
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
} = require('../integrations/github/issue-plan')

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
const STEP_MAX_WIDTH = 200
const OUTER_TERMINAL_RATIO = 0.8

let clackModulePromise

function loadDashboardServer() {
  return require('../dashboard/server').startDashboardServer
}

/**
 * CLI options consumed by ad-hoc local and GitHub agent runs.
 * @typedef {import('../types').JsonMap & {
 *   branch?: string,
 *   netlifySiteId?: string,
 *   siteId?: string,
 *   filter?: string,
 *   netlifyConfig?: string,
 *   timeoutMinutes?: string | number,
 *   repo?: string,
 *   date?: string,
 *   runner?: string,
 *   labels?: string,
 *   label?: string,
 *   issues?: string,
 *   issue?: string,
 *   fromIssues?: string,
 *   fromIssue?: string,
 *   fetchResults?: boolean,
 *   dryRun?: boolean,
 *   run?: string,
 * }} AdHocRunOptions
 *
 * Input for submitting one ad-hoc Netlify agent run.
 * @typedef {{
 *   projectRoot?: string,
 *   agent?: string,
 *   promptText?: string,
 *   title?: string,
 *   source?: import('../types').JsonMap,
 *   raw?: import('../types').JsonMap,
 *   options?: AdHocRunOptions,
 *   beforeSubmit?: () => void,
 *   startLabel?: string,
 * }} SingleNetlifyAgentRunInput
 *
 * Input for submitting one ad-hoc GitHub-backed agent issue.
 * @typedef {{
 *   projectRoot?: string,
 *   agent?: string,
 *   promptText?: string,
 *   source?: import('../types').JsonMap,
 *   options?: AdHocRunOptions,
 * }} SingleGithubAgentRunInput
 */

/**
 * Input for resolving Netlify Agent Runner dashboard URLs.
 * @typedef {{
 *   projectRoot?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   options?: AdHocRunOptions,
 * }} LocalAgentRunUrlInput
 *
 * Input for rendering submitted local run boxes.
 * @typedef {{
 *   runs?: import('../types').AgentRun[],
 *   prompt?: { title?: string },
 *   projectRoot?: string,
 *   options?: AdHocRunOptions,
 * }} SubmittedLocalRunBoxesInput
 *
 * Input for rendering the workflow success summary box.
 * @typedef {{
 *   flow?: import('../types').WorkflowFlow | { title?: string },
 *   runState?: import('../types').WorkflowRunState,
 *   transport?: string,
 *   projectRoot?: string,
 * }} PrintSuccessBoxInput
 *
 * Detail moved below a success box when it is too wide for the terminal.
 * @typedef {{
 *   label: string,
 *   value: string,
 * }} SuccessBoxAttachment
 *
 * Minimal runtime event callbacks used by workflow execution.
 * @typedef {import('../types').JsonMap & {
 *   agentStatus?: (status: string, run?: import('../types').AgentRun, stepState?: import('../types').WorkflowStep, step?: import('../types').WorkflowStep, details?: import('../types').JsonMap) => void,
 *   stepStatus?: (status: string, stepState?: import('../types').WorkflowStep, step?: import('../types').WorkflowStep, details?: import('../types').JsonMap) => void,
 *   workflowStatus?: (status: string, details?: import('../types').JsonMap) => void,
 *   artifactWritten?: (type: string, filePath: string, details?: import('../types').JsonMap) => void,
 * }} WorkflowRuntimeEvents
 *
 * Result returned by local runner stop/archive hooks.
 * @typedef {{
 *   stopped?: boolean,
 *   archived?: boolean,
 *   accepted?: boolean,
 *   error?: string,
 *   commandError?: boolean,
 * }} RunnerControlResult
 */

/**
 * Shared input for GitHub and local workflow executor helpers.
 * @typedef {{
 *   flow?: import('../types').WorkflowFlow,
 *   steps?: import('../types').WorkflowStep[],
 *   options?: AdHocRunOptions,
 *   runState?: import('../types').WorkflowRunState,
 *   projectRoot?: string,
 *   completedStepStates?: Map<string, import('../types').WorkflowStep>,
 *   runtimeEvents?: WorkflowRuntimeEvents,
 * }} WorkflowExecutionInput
 *
 * Input for completing one local workflow step.
 * @typedef {WorkflowExecutionInput & {
 *   stepState?: import('../types').WorkflowStep,
 *   step?: import('../types').WorkflowStep,
 *   netlify?: import('../types').JsonMap & {
 *     siteId?: string,
 *     env?: NodeJS.ProcessEnv,
 *   },
 *   netlifyFilter?: import('../types').JsonMap,
 *   initialDelayMs?: number,
 * }} CompleteLocalStepInput
 *
 * Input for completing one GitHub workflow step.
 * @typedef {WorkflowExecutionInput & {
 *   repo?: string,
 *   stepState?: import('../types').WorkflowStep,
 *   step?: import('../types').WorkflowStep,
 * }} CompleteGithubStepInput
 */

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

function resolveDryRunTransport({ requestedTransport, projectRoot }) {
  const requested = requestedTransport || 'auto'
  if (requested && requested !== 'auto') return resolveTransport(requested, [])
  const detections = detectTransports({ projectRoot })
  return detections.find((candidate) => candidate.available)?.id || NETLIFY_API_TRANSPORT
}

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


async function loadClack() {
  clackModulePromise = clackModulePromise || import('@clack/prompts')
  return clackModulePromise
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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

async function handleDashboard(flowId, options = {}) {
  const invocationDir = process.cwd()
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: invocationDir })
  const runId = typeof options.run === 'string' ? options.run.trim() : ''
  if (flowId && runId) throw new Error('Pass either a dashboard workflow argument or --run, not both.')
  if (flowId) {
    await loadFlow(flowId, flowLoadOptions(options, projectRoot))
  }

  const startServer = loadDashboardServer()
  const instance = await startServer({
    projectRoot,
    flowsDir: options.flowsDir,
    flowsDirs: options.flowsDirs,
    host: options.host || '127.0.0.1',
    port: options.port,
    initialWorkflow: flowId || '',
    initialPath: runId ? `/runs/${encodeURIComponent(runId)}/details` : '',
    dev: options.dev === true,
    tail: options.tail === true,
  })

  console.log(`Nax dashboard: ${instance.url}`)
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

function isAdHocRunTarget(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === AD_HOC_RUN_TARGET ||
    normalized === 'ad-hoc' ||
    normalized === 'adhoc' ||
    normalized === 'agent' ||
    normalized === 'agent-run'
}

/**
 * Finds the nearest ancestor that already contains nax artifacts.
 * @param {string} [cwd]
 * @param {string} [excludeRoot]
 * @returns {string}
 */
function nearestParentNaxRoot(cwd = process.cwd(), excludeRoot = '') {
  let current = path.resolve(cwd)
  const excluded = excludeRoot ? path.resolve(excludeRoot) : ''

  while (true) {
    if (current !== excluded && fs.existsSync(path.join(current, '.nax'))) return current
    const parent = path.dirname(current)
    if (parent === current) return ''
    current = parent
  }
}

/**
 * Reads a handoff source from the site-local root, falling back to an older parent .nax.
 * @param {string} runId
 * @param {import('./commands/options').CliOptions} options
 * @param {{ cwd?: string }} [context]
 * @returns {{ projectRoot: string, handoff: ReturnType<typeof readSelectedHandoffSource> }}
 */
function readSelectedHandoffWithFallback(runId, options = {}, { cwd = process.cwd() } = {}) {
  const primaryRoot = resolveProjectRoot(options.projectRoot, { cwd })
  try {
    return {
      projectRoot: primaryRoot,
      handoff: readSelectedHandoffSource({ projectRoot: primaryRoot, runId, options }),
    }
  } catch (error) {
    if (options.projectRoot) throw error
    const fallbackRoot = nearestParentNaxRoot(cwd, primaryRoot)
    if (!fallbackRoot) throw error
    try {
      return {
        projectRoot: fallbackRoot,
        handoff: readSelectedHandoffSource({ projectRoot: fallbackRoot, runId, options }),
      }
    } catch (_fallbackError) {
      throw error
    }
  }
}

async function handleRecent(options) {
  const primaryRoot = resolveProjectRoot(options.projectRoot, { cwd: process.cwd() })
  const requestedType = options.type || 'all'
  let projectRoot = primaryRoot
  let sources = listHandoffSources(projectRoot)
  if (!options.projectRoot && sources.length === 0) {
    const fallbackRoot = nearestParentNaxRoot(process.cwd(), primaryRoot)
    if (fallbackRoot) {
      const fallbackSources = listHandoffSources(fallbackRoot)
      if (fallbackSources.length > 0) {
        projectRoot = fallbackRoot
        sources = fallbackSources
      }
    }
  }
  sources = sources
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

/** @param {SingleNetlifyAgentRunInput} [input] */
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
  const resolvedNetlifyOptions = netlifyOptionsFromTarget(options, netlify)
  maybeReportNetlifySite(resolvedNetlifyOptions)
  maybeReportNetlifyConfig(resolvedNetlifyOptions)
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
      timeoutMinutes: Number.parseInt(String(options.timeoutMinutes || '25'), 10),
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

/** @param {SingleGithubAgentRunInput} [input] */
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
  const timeoutMinutes = Number.parseInt(String(options.timeoutMinutes || '25'), 10)
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

async function handleHandoff(runId, options) {
  const selected = readSelectedHandoffWithFallback(runId, options, { cwd: process.cwd() })
  const projectRoot = selected.projectRoot
  let handoff = selected.handoff

  if (options.path) {
    console.log(handoff.displayPath)
    return
  }

  if (options.copy) {
    const command = copyToClipboard(handoff.summaryText)
    console.log(`\nCopied ${handoff.displayPath} to clipboard with ${command}.`)
    return
  }

  if (options.copyPath) {
    const command = copyToClipboard(handoff.displayPath)
    console.log(`\nCopied ${handoff.displayPath} path to clipboard with ${command}.`)
    return
  }

  if (options.open) {
    await openHandoffSource(handoff, { projectRoot })
    console.log(`\nOpened ${handoff.displayPath}.`)
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
    throw new Error('nax run agent <type> requires prompt text in non-TTY mode. Pass a positional prompt or --prompt "...".')
  }
  const value = await multiline({
    message: 'Prompt for the Netlify agent run',
    placeholder: 'Describe what you want this agent to do.',
  })
  const text = String(value || '').trim()
  if (!text) throw new Error('Netlify agent run prompt cannot be empty.')
  return text
}

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

function withSelectedAgents(flow, selectedAgents) {
  return applyAgentSelection(flow, { models: selectedAgents })
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

/** @param {PrintSuccessBoxInput} param0 */
function printSuccessBox({ flow, runState, transport, projectRoot }) {
  const green = '#22c55e'
  const final = finalRunForRunState(runState)
  if (!final) return
  const terminalWidth = process.stdout.columns || 100
  const outerMax = successBoxOuterMaxWidth(terminalWidth)
  const contentWidth = Math.max(20, outerMax - 6)
  const lines = [`Workflow "${flow.title}" complete.`, `Final step: ${final.step.title}`]
  /** @type {SuccessBoxAttachment[]} */
  const attachments = []
  const usage = usageSummariesForRunState(runState)
  if (isNetlifyApiTransport(transport)) {
    const url = final.run.links?.sessionUrl ||
      final.run.links?.agentRunUrl ||
      localAgentRunUrl({ projectRoot, runnerId: final.run.runnerId, sessionId: final.run.sessionId })
    if (url) {
      addSuccessBoxDetail(lines, attachments, 'Final agent run', url, contentWidth)
    } else if (final.run.runnerId) {
      lines.push(`Final agent runner ID: ${final.run.runnerId}`)
    }
    addSuccessBoxDetail(lines, attachments, 'Deploy', final.run.deployUrl, contentWidth)
    addSuccessBoxDetail(lines, attachments, 'PR', final.run.prUrl, contentWidth)
  } else {
    const url = final.run.commentUrl || final.run.issueUrl
    addSuccessBoxDetail(lines, attachments, 'Final result', url, contentWidth)
  }
  if (usage.totalSummary) {
    lines.push(`Total usage: ${usage.totalSummary}`)
    for (const step of usage.steps) {
      lines.push(`Usage ${step.title}: ${step.summary}`)
    }
  }
  const artifactsRoot = artifactsRootForRunState(runState)
  addSuccessBoxDetail(lines, attachments, 'Artifacts', artifactsRoot, contentWidth)
  const wrapped = wrapBoxLines(lines, contentWidth)
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
  if (attachments.length > 0) {
    console.log('')
    console.log(formatSuccessBoxAttachments(attachments))
  }
  console.log('')
}

function printPartialArtifactHint(runState) {
  const dir = artifactsRootForRunState(runState)
  if (!artifactDirectoryHasFiles(dir)) return
  console.log('')
  console.log(`Partial artifacts: ${dir}`)
  if (runState?.flowId) console.log(`Resume:            nax run ${runState.flowId}`)
  console.log('')
}

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




async function promptForOptionalHandoffInstructions() {
  const value = await multiline({
    message: 'Additional instructions for the next agent run',
    placeholder: 'Hit enter to just pass the workflow summary.',
  })
  return String(value || '').trim()
}

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

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

function selectedStepModels(options = {}) {
  return parseStepModelsEntries(options.stepModels || [])
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

/** @param {number} terminalWidth */
function successBoxOuterMaxWidth(terminalWidth) {
  if (!process.stdout.isTTY) return Math.max(60, Math.floor(terminalWidth * OUTER_TERMINAL_RATIO))
  const proportional = Math.floor(terminalWidth * OUTER_TERMINAL_RATIO)
  return Math.max(24, Math.min(terminalWidth, Math.max(40, proportional)))
}

/**
 * @param {string[]} lines
 * @param {SuccessBoxAttachment[]} attachments
 * @param {string} label
 * @param {unknown} value
 * @param {number} contentWidth
 */
function addSuccessBoxDetail(lines, attachments, label, value, contentWidth) {
  if (!value) return
  const detail = String(value)
  if (detail.length > contentWidth) {
    lines.push(`${label}: see below`)
    attachments.push({ label, value: detail })
    return
  }
  lines.push(`${label}:`, detail)
}

/** @param {SuccessBoxAttachment[]} attachments */
function formatSuccessBoxAttachments(attachments) {
  return attachments.map(({ label, value }) => `${label}:\n${value}`).join('\n\n')
}

function finalRunForRunState(runState) {
  const completed = (runState.steps || []).filter((s) => s.status === 'completed' || s.status === 'dry-run')
  if (completed.length === 0) return null
  const lastStep = completed[completed.length - 1]
  const runs = (lastStep.runs || []).filter((r) => r.status === 'completed' || r.status === 'dry-run')
  if (runs.length === 0) return null
  return { step: lastStep, run: runs[runs.length - 1] }
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

/**
 * @param {{
 *   runState?: import('../types').WorkflowRunState,
 *   projectRoot?: string,
 *   options?: AdHocRunOptions,
 *   reason?: string,
 *   stopRun?: (input: { projectRoot?: string, runnerId?: string, env?: NodeJS.ProcessEnv }) => RunnerControlResult,
 * }} input
 */
function cancelLocalWorkflowRunnersForInterrupt({ runState, projectRoot, options = {}, reason = 'interrupted workflow', stopRun = stopAgentRun } = {}) {
  if (!isNetlifyApiTransport(runState?.transport)) return { runnerIds: [], stopped: [], warnings: [] }
  const runnerIds = cancellableLocalRunnerIds(runState)
  if (runnerIds.length === 0) return { runnerIds, stopped: [], warnings: [] }
  let env = process.env
  try {
    const savedOptions = /** @type {AdHocRunOptions} */ (runState.options || {})
    env = resolveNetlifyProjectTarget({
      projectRoot,
      siteId: options.netlifySiteId || savedOptions.netlifySiteId,
      filter: options.filter || savedOptions.filter,
      netlifyConfig: options.netlifyConfig || savedOptions.netlifyConfig,
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
    throw new Error('Only `nax admin clean blobs` is implemented.')
  }
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: process.cwd() })
  const netlify = buildNetlifyEnv({ projectRoot, env: process.env, siteId: options.netlifySiteId })
  const results = sweepBlobRefs({
    projectRoot,
    siteId: netlify.siteId,
    token: netlify.env.NETLIFY_AUTH_TOKEN,
    env: netlify.env,
    deleteBlob,
    dryRun: options.force !== true,
    ttlHours: Number.parseInt(options.ttlHours || process.env.NAX_BLOB_CLEANUP_TTL_HOURS || '24', 10),
    log: (message) => console.warn(message),
  })
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

/** @param {CompleteGithubStepInput} param0 */
/**
 * @param {string} projectRoot
 * @param {{
 *   runId?: string,
 *   flowId?: string,
 *   stepId?: string,
 *   agent?: string,
 * }} [options]
 */
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
    throw new Error(`No retryable failed agents found for ${runState.runId}. Use nax handoff ${runState.runId} to work from completed results.`)
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
  maybeReportNetlifyConfig(resolvedRetryOptions)
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
  markRunCompleted(runState)
  clearTrackedRunState(runState)
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

/**
 * @param {{
 *   projectRoot: string,
 *   options?: AdHocRunOptions & { yes?: boolean, dryRun?: boolean },
 *   flow?: import('../types').WorkflowFlow | null,
 * }} param0
 */
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
      reviewer: options.reviewer || 'dashboard',
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

    markRunCompleted(runState)
    clearTrackedRunState(runState)
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
      console.log(`Workflow paused for human review. Resume it from the dashboard after approval.`)
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
    const suffix = result.current ? 'current' : 'stale; run `nax admin skills update`'
    console.log(`${relative}: v${result.installedVersion || '?'} package v${result.packageVersion} (${suffix})`)
  }
}

function printSkillsHelp() {
  console.log([
    'nax admin skills - manage project-local agent skills',
    '',
    'Usage:',
    '  nax admin skills install [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax admin skills update  [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax admin skills check   [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax admin skills list',
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
  const issueHandlers = createIssueHandlers({ buildAndMaybeFallbackPlan, loadClack })
  return buildNaxProgram({
    actionOptions,
    collectOption,
    defaultOrchestrator: DEFAULT_ORCHESTRATOR,
    defaultOutputBudgetBytes: DEFAULT_OUTPUT_BUDGET_BYTES,
    handlers: {
      clean: handleClean,
      ci: handleCi,
      comment: issueHandlers.handleComment,
      handoff: handleHandoff,
      init: handleInit,
      issue: issueHandlers.handleIssue,
      list: handleList,
      previewBoxes: handlePreviewBoxes,
      previewSpinner: handlePreviewSpinner,
      retry: handleRetry,
      run: handleRun,
      skills: handleSkills,
      sync: handleSync,
      dashboard: handleDashboard,
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
  cancelLocalWorkflowRunnersForInterrupt,
  createIssue,
  createPullRequestComment,
  extractLinkedPullRequest,
  flowAgents,
  inferModelFromIssueTitle,
  findRunStateForRetry,
  handleAdHocAgentRun,
  handleHandoff,
  handleRetry,
  handleRun,
  handleRunEngine,
  loadIssueMeta,
  loadPullRequestMeta,
  maybeResumeUnfinishedRun,
  isAdHocRunTarget,
  orderSingleRunTransports,
  parseCsv,
  prepareInteractiveFlowRun,
  printFlowPlan,
  printSuccessBox,
  runnableSteps,
  withSelectedAgents,
  withSelectedStepModels,
  parseGitHubPullRequestUrl,
  resolveCommentTarget,
  resumeRunById,
}
