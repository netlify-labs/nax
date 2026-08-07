const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { makeBox, makeHorizontalBoxes } = require('@davidwells/box-logger')
const { version: packageVersion } = require('../../package.json')
const { buildNaxProgram } = require('./commands/nax')
const {
  actionOptions,
  collectOption,
  mergeCommandOptions,
} = require('./commands/options')
const { DEFAULT_AGENT_PROVIDERS } = require('../core/constants')
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
  wordWrap,
  workflowPickerHint,
  workflowPickerLabel,
} = require('./display/flow-list')
const { buildCostsReport, formatCostsTable } = require('./display/costs-report')
const { terminalTrafficLights } = require('./display/terminal')
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
const {
  NETLIFY_API_TRANSPORT,
  detectTransports,
  formatTransportSetupHelp,
  isNetlifyApiTransport,
  resolveTransport,
  resolveTransportForAgentConfigurations,
} = require('../integrations/transports')
const { readNetlifyProject } = require('../integrations/netlify/init')
const { enforceRunPreflight } = require('../integrations/netlify/preflight')
const {
  formatDashboardNetlifyContext,
  resolveDashboardNetlifyContext,
} = require('../integrations/netlify/dashboard-context')
const { runWorkflow } = require('../workflows/engine/runner')
const { DEFAULT_OUTPUT_BUDGET_BYTES, completedStepMapFromRunState } = require('../workflows/engine/execution-context')
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
  cleanupWorkflowBlobsForRun,
  localSafePromptBytes,
} = require('../workflows/engine/prompt-delivery')
const {
  MUTED_COLOR,
  SUCCESS_COLOR,
  TEAL_COLOR,
  colorText,
  findLatestResumableRun,
  flowFromRunState,
  flowLoadOptions,
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
const { deleteBlob } = require('../integrations/netlify/blobs')
const {
  compactBlobRefs,
  sweepBlobRefs,
} = require('../storage/local/blob-ref-registry')
const {
  applyAgentSelection,
  assertValidAgentSelection,
  parseStepAgentsEntries,
} = require('../core/agents/selection')
const {
  SUPPORTED_AGENT_PROVIDERS,
  formatAgentConfigLabel,
  getAgentEffortOptions,
  getAgentModelOptions,
  getAgentProviderLabel,
  getBestModelForProvider,
  getEffortAvailabilityNotice,
  getHighestEffortForModel,
  normalizeProviderEffortMap,
  normalizeProviderModelMap,
  normalizeStepProviderEffortMap,
  normalizeStepProviderModelMap,
  resolveAgentRunConfig,
} = require('../core/agents/configuration')
const {
  formatAgentInstanceSpec,
  parseAgentInstanceList,
  resolveLineup,
} = require('../core/agents/instances')
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
  inferAgentFromIssueTitle,
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

const COMPACT_LOCAL_RESULT_CHAR_LIMIT = 6000
const COMPACT_LOCAL_RESULTS_TOTAL_LIMIT = 36000
const COMPACT_LOCAL_CONTEXT_CHAR_LIMIT = 12000
const DEFAULT_LOCAL_SAFE_PROMPT_BYTES = 16384
const AD_HOC_RUN_TARGET = '__ad_hoc_agent_run__'
const STEP_MAX_WIDTH = 200
const OUTER_TERMINAL_RATIO = 0.8
const INSTANCE_SOFT_CAP = 6

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
 *   model?: string,
 *   effort?: string,
 *   models?: Record<string, string>,
 *   efforts?: Record<string, string>,
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

function githubSafePromptBytes(options = {}) {
  return githubSafePromptBytesWithLocalBudget(options, { localSafePromptBytes })
}


async function loadClack() {
  clackModulePromise = clackModulePromise || import('@clack/prompts')
  return clackModulePromise
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

/** @param {import('../types').JsonMap} [options] */
async function handleCosts(options = {}) {
  const projectRoot = resolveProjectRoot(String(options.projectRoot || ''), { cwd: process.cwd() })
  const limit = Number.parseInt(String(options.limit || ''), 10)
  const report = buildCostsReport(listRunStates(projectRoot), {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
  })
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (report.runs.length === 0) {
    console.log('No saved workflow runs found.')
    return
  }
  for (const line of formatCostsTable(report)) console.log(line)
}

async function handleDashboard(flowId, options = {}) {
  const invocationDir = process.cwd()
  const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: invocationDir })
  const runId = typeof options.run === 'string' ? options.run.trim() : ''
  if (flowId && runId) throw new Error('Pass either a dashboard workflow argument or --run, not both.')
  if (flowId) {
    await loadFlow(flowId, flowLoadOptions(options, projectRoot))
  }

  const netlifyContext = await resolveDashboardNetlifyContext({
    projectRoot,
    invocationDir,
    timeoutMs: 3000,
  })
  const netlifyAccess = netlifyContext.targetAccess || {
    ok: false,
    code: 'no_site',
    message: netlifyContext.targetError || 'No Agent Runner site could be resolved.',
    account: netlifyContext.account,
    site: null,
  }
  const {
    targetAccess: _targetAccess,
    ...publicNetlifyContext
  } = netlifyContext
  const defaultRunOptions = netlifyContext.target
    ? {
        siteId: netlifyContext.target.siteId,
        netlifySiteId: netlifyContext.target.siteId,
        ...(netlifyContext.target.filter ? { filter: netlifyContext.target.filter } : {}),
      }
    : {}

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
    netlifyAccess,
    netlifyContext: publicNetlifyContext,
    defaultRunOptions,
  })

  console.log(`Nax dashboard: ${instance.url}`)
  console.log(`Project root:  ${instance.projectRoot}`)
  for (const line of formatDashboardNetlifyContext(netlifyContext)) console.log(line)
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
  const agents = parsed.length > 0 ? parsed : DEFAULT_AGENT_PROVIDERS
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
  const directModels = options.model !== undefined
    ? { [agent]: options.model }
    : options.models
  const directEfforts = options.effort !== undefined
    ? { [agent]: options.effort }
    : options.efforts
  const resolvedConfig = resolveAgentRunConfig(agent, {
    globalCli: {
      models: directModels,
      efforts: directEfforts,
    },
  })
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
    ...(resolvedConfig.model ? { model: resolvedConfig.model } : {}),
    ...(resolvedConfig.effort ? { effort: resolvedConfig.effort } : {}),
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
      ...(resolvedConfig.warnings.length > 0 ? { configurationWarnings: resolvedConfig.warnings } : {}),
      ...raw,
    },
  }

  if (typeof beforeSubmit === 'function') beforeSubmit()
  const resolvedNetlifyOptions = netlifyOptionsFromTarget(options, netlify)
  maybeReportNetlifySite(resolvedNetlifyOptions)
  maybeReportNetlifyConfig(resolvedNetlifyOptions)
  maybeReportNetlifyFilter(netlifyFilter)
  console.log(`\nStarting ${formatAgentConfigLabel(run)} ${startLabel || runTitle.toLowerCase()}...`)
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
      netlifySiteId: netlify.siteId,
      source: artifactSource,
      createdAt: completed.createdAt || new Date().toISOString(),
      updatedAt: completed.updatedAt || new Date().toISOString(),
    })
    const runnerArtifact = persistAgentRunnerArtifact({
      projectRoot,
      runnerId: completed.runnerId,
      netlifySiteId: netlify.siteId,
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
    agent,
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
    netlifySiteId: options.netlifySiteId || options.siteId || '',
    source: artifactSource,
    createdAt: completed.createdAt || new Date().toISOString(),
    updatedAt: completed.updatedAt || new Date().toISOString(),
  })
  const runnerArtifact = completed.runnerId ? persistAgentRunnerArtifact({
    projectRoot,
    runnerId: completed.runnerId,
    netlifySiteId: options.netlifySiteId || options.siteId || '',
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
      options: DEFAULT_AGENT_PROVIDERS.map((agent) => ({ value: agent, label: titleCase(agent) })),
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
    options,
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
    options: SUPPORTED_AGENT_PROVIDERS.map((agent) => ({ value: agent, label: titleCase(agent) })),
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

/**
 * @param {string} transport
 * @param {ReturnType<typeof detectTransports>} detections
 * @returns {string}
 */
function unavailableTransportMessage(transport, detections) {
  const selectedDetection = detections.find((candidate) => candidate.id === transport)
  return [
    `Transport "${transport}" is not available: ${selectedDetection?.reason || 'unknown reason'}`,
    '',
    formatTransportSetupHelp(detections),
  ].join('\n')
}

async function chooseSingleRunTransportInteractively({ requested, projectRoot }) {
  const detections = detectTransports({ projectRoot })
  if (requested && requested !== 'auto') {
    const transport = resolveTransport(requested, detections)
    const selectedDetection = detections.find((candidate) => candidate.id === transport)
    if (!selectedDetection?.available) throw new Error(unavailableTransportMessage(transport, detections))
    return transport
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
  return applyAgentSelection(flow, { agents: selectedAgents })
}

/**
 * Resolve one workflow step with every declaration and CLI override applied in precedence order.
 * @param {import('../types').WorkflowFlow} flow
 * @param {import('../types').WorkflowStep} step
 * @param {import('../types').JsonMap} [options]
 * @param {string} [requestedTransport]
 */
function resolvedLineupForStep(flow, step, options = {}, requestedTransport) {
  const models = normalizeProviderModelMap(options.models)
  const efforts = normalizeProviderEffortMap(options.efforts)
  const stepModels = normalizeStepProviderModelMap(options.stepModels)
  const stepEfforts = normalizeStepProviderEffortMap(options.stepEfforts)
  const transport = requestedTransport ||
    (typeof options.transport === 'string' ? options.transport : '') ||
    flow.defaults?.transport ||
    'auto'
  return resolveLineup(Array.isArray(step.lineup) ? step.lineup : step.agents || [], {
    requestedTransport: transport,
    models: {
      ...normalizeProviderModelMap(flow.defaults?.models),
      ...normalizeProviderModelMap(step.models),
      ...models,
      ...(stepModels[step.id] || {}),
    },
    efforts: {
      ...normalizeProviderEffortMap(flow.defaults?.efforts),
      ...normalizeProviderEffortMap(step.efforts),
      ...efforts,
      ...(stepEfforts[step.id] || {}),
    },
  })
}

/**
 * @param {import('../types').WorkflowFlow} flow
 * @param {import('../types').JsonMap} options
 * @returns {{
 *   models: Record<string, string>,
 *   efforts: Record<string, string>,
 *   stepModels: Record<string, Record<string, string>>,
 *   stepEfforts: Record<string, Record<string, string>>,
 * }}
 */
function selectedAgentConfiguration(flow, options = {}) {
  const models = normalizeProviderModelMap(options.models)
  const efforts = normalizeProviderEffortMap(options.efforts)
  const stepModels = normalizeStepProviderModelMap(options.stepModels)
  const stepEfforts = normalizeStepProviderEffortMap(options.stepEfforts)
  const steps = new Map((flow.steps || []).map((step) => [step.id, step]))

  for (const stepId of new Set([...Object.keys(stepModels), ...Object.keys(stepEfforts)])) {
    if (!steps.has(stepId)) {
      throw new Error(`Unknown step "${stepId}" in model/effort configuration for flow "${flow.id}".`)
    }
  }

  const selectedByStep = new Map((flow.steps || []).map((step) => [
    step.id,
    new Set(Array.isArray(step.agents) ? step.agents : []),
  ]))
  const selectedAnywhere = new Set(
    [...selectedByStep.values()].flatMap((agents) => [...agents]),
  )
  for (const agent of new Set([...Object.keys(models), ...Object.keys(efforts)])) {
    if (!selectedAnywhere.has(agent)) {
      throw new Error(`Agent "${agent}" has a model or effort override but is not selected. Add it with --agents.`)
    }
  }
  for (const [stepId, configured] of Object.entries(stepModels)) {
    for (const agent of Object.keys(configured)) {
      if (!selectedByStep.get(stepId)?.has(agent)) {
        throw new Error(`Agent "${agent}" has a model override for step "${stepId}" but is not selected. Add it with --step-agents.`)
      }
    }
  }
  for (const [stepId, configured] of Object.entries(stepEfforts)) {
    for (const agent of Object.keys(configured)) {
      if (!selectedByStep.get(stepId)?.has(agent)) {
        throw new Error(`Agent "${agent}" has an effort override for step "${stepId}" but is not selected. Add it with --step-agents.`)
      }
    }
  }

  const configuredOptions = { ...options, models, efforts, stepModels, stepEfforts }
  for (const step of flow.steps || []) resolvedLineupForStep(flow, step, configuredOptions)

  return { models, efforts, stepModels, stepEfforts }
}

/**
 * @param {import('../types').WorkflowFlow} flow
 * @param {import('../types').JsonMap} options
 * @returns {Array<{ agent: string, model?: string, effort?: string }>}
 */
function materializedAgentConfigurations(flow, options = {}) {
  const configurations = []
  for (const step of flow.steps || []) {
    const resolved = resolvedLineupForStep(flow, step, options)
    configurations.push(...resolved.instances)
  }
  return configurations
}

/**
 * Prompt model then effort for a single ad hoc agent, pre-selecting the best model and its
 * highest effort. Auto stays available but is not the default. Returns provider-keyed maps.
 * @param {{
 *   clack: {
 *     select: (input: Record<string, unknown>) => Promise<unknown>,
 *     isCancel: (value: unknown) => boolean,
 *   },
 *   agent: string,
 *   exit?: (code?: number) => never,
 * }} input
 * @returns {Promise<{ models: Record<string, string>, efforts: Record<string, string> }>}
 */
async function chooseSingleAgentConfigInteractively({ clack, agent, exit = process.exit }) {
  const providerLabel = getAgentProviderLabel(agent)
  const modelOptions = getAgentModelOptions(agent)
  const selectedModel = await clack.select({
    message: `${providerLabel} model`,
    options: modelOptions.map((option) => ({ value: option.id, label: option.label })),
    initialValue: getBestModelForProvider(agent),
  })
  if (clack.isCancel(selectedModel)) exit(0)
  const model = String(selectedModel)
  if (model === 'auto') return { models: { [agent]: 'auto' }, efforts: { [agent]: 'auto' } }

  const effortOptions = getAgentEffortOptions(agent, model)
  if (effortOptions.length === 1) {
    const notice = getEffortAvailabilityNotice(agent, model)
    if (notice) console.log(`${providerLabel}: ${notice}`)
    return { models: { [agent]: model }, efforts: { [agent]: 'auto' } }
  }
  const selectedEffort = await clack.select({
    message: `${providerLabel} reasoning effort`,
    options: effortOptions.map((option) => ({ value: option.id, label: option.label })),
    initialValue: getHighestEffortForModel(agent, model),
  })
  if (clack.isCancel(selectedEffort)) exit(0)
  return { models: { [agent]: model }, efforts: { [agent]: String(selectedEffort) } }
}

/**
 * Offer zero or more additional instances for providers already selected in the workflow.
 * Each added instance uses the flagship model and highest supported effort as its defaults.
 * @param {{
 *   clack: {
 *     confirm: (input: Record<string, unknown>) => Promise<unknown>,
 *     select: (input: Record<string, unknown>) => Promise<unknown>,
 *     isCancel: (value: unknown) => boolean,
 *   },
 *   agents: string[],
 *   exit?: (code?: number) => never,
 * }} input
 * @returns {Promise<Array<{ agent: string, model?: string, effort?: string }>>}
 */
async function addAgentInstancesInteractively({ clack, agents, exit = process.exit }) {
  /** @type {Array<{ agent: string, model?: string, effort?: string }>} */
  const added = []
  while (agents.length > 0) {
    const shouldAdd = await clack.confirm({
      message: 'Add another agent instance?',
      initialValue: false,
    })
    if (clack.isCancel(shouldAdd)) exit(0)
    if (!shouldAdd) break

    const selectedAgent = await clack.select({
      message: 'Choose provider for the additional instance',
      options: agents.map((agent) => ({ value: agent, label: getAgentProviderLabel(agent) })),
      initialValue: agents[0],
    })
    if (clack.isCancel(selectedAgent)) exit(0)
    const agent = String(selectedAgent)
    const configured = await chooseSingleAgentConfigInteractively({ clack, agent, exit })
    const model = configured.models[agent]
    const effort = configured.efforts[agent]
    added.push({
      agent,
      ...(model && model !== 'auto' ? { model } : {}),
      ...(model && model !== 'auto' && effort && effort !== 'auto' ? { effort } : {}),
    })
  }
  return added
}

/**
 * @param {{
 *   clack: { confirm: (input: Record<string, unknown>) => Promise<unknown>, select: (input: Record<string, unknown>) => Promise<unknown>, isCancel: (value: unknown) => boolean },
 *   flow: import('../types').WorkflowFlow,
 *   options: import('../types').JsonMap,
 *   agents: string[],
 *   exit?: (code: number) => never,
 * }} input
 * @returns {Promise<{ models: Record<string, string>, efforts: Record<string, string> }>}
 */
async function configureAgentsInteractively({ clack, flow, options, agents, exit = process.exit }) {
  const models = normalizeProviderModelMap(options.models)
  const efforts = normalizeProviderEffortMap(options.efforts)
  if (Object.keys(models).length > 0 || Object.keys(efforts).length > 0) return { models, efforts }

  const configure = await clack.confirm({
    message: 'Configure model and reasoning effort for selected agents?',
    initialValue: false,
  })
  if (clack.isCancel(configure)) exit(0)
  if (!configure) return { models, efforts }

  for (const agent of agents) {
    const agentLabel = getAgentProviderLabel(agent)
    const step = (flow.steps || []).find((candidate) => (candidate.agents || []).includes(agent))
    const inherited = resolveAgentRunConfig(agent, {
      defaults: {
        models: flow.defaults?.models,
        efforts: flow.defaults?.efforts,
      },
      step: {
        models: step?.models,
        efforts: step?.efforts,
      },
    })
    const modelOptions = getAgentModelOptions(agent, { includeModel: inherited.model })
    const selectedModel = await clack.select({
      message: `${agentLabel} model`,
      options: modelOptions.map((option) => ({ value: option.id, label: option.label })),
      initialValue: inherited.model || 'auto',
    })
    if (clack.isCancel(selectedModel)) exit(0)
    models[agent] = String(selectedModel)

    if (models[agent] === 'auto') {
      efforts[agent] = 'auto'
      continue
    }
    const effortOptions = getAgentEffortOptions(agent, models[agent], {
      includeEffort: inherited.effort,
    })
    if (effortOptions.length === 1) {
      efforts[agent] = 'auto'
      const notice = getEffortAvailabilityNotice(agent, models[agent])
      if (notice) console.log(`${agentLabel}: ${notice}`)
      continue
    }
    const inheritedEffort = inherited.effort === 'xhigh' ? 'max' : inherited.effort
    const initialEffort = models[agent] === inherited.model &&
      effortOptions.some((option) => option.id === inheritedEffort)
      ? inheritedEffort
      : 'auto'
    const selectedEffort = await clack.select({
      message: `${agentLabel} reasoning effort`,
      options: effortOptions.map((option) => ({ value: option.id, label: option.label })),
      initialValue: initialEffort,
    })
    if (clack.isCancel(selectedEffort)) exit(0)
    efforts[agent] = String(selectedEffort)
  }
  return { models, efforts }
}

function withSelectedStepAgents(flow, options = {}) {
  const agents = parseCsv(options.agents)
  const stepAgents = selectedStepAgents(options)
  const selection = { agents, stepAgents }
  assertValidAgentSelection(flow, selection)
  const configuredFlow = applyAgentSelection(flow, selection)
  const configuration = selectedAgentConfiguration(configuredFlow, options)
  return {
    flow: configuredFlow,
    stepAgents,
    ...configuration,
  }
}

function runnableSteps(flow, options) {
  return findStepRange(flow, options).filter((step) => isHumanReviewStep(step) || normalizeArray(step.agents).length > 0)
}

/**
 * @param {import('../types').WorkflowFlow} flow
 * @param {import('../types').WorkflowStep[]} steps
 * @param {import('../types').JsonMap} options
 * @param {string} transport
 * @returns {Array<{ stepId: string, title: string, count: number }>}
 */
function lineupSoftCapViolations(flow, steps, options, transport) {
  return steps.flatMap((step) => {
    if (isHumanReviewStep(step)) return []
    const count = resolvedLineupForStep(flow, step, options, transport).instances.length
    return count > INSTANCE_SOFT_CAP ? [{ stepId: step.id, title: step.title, count }] : []
  })
}

/** @param {Array<{ title: string, count: number }>} violations @returns {string} */
function formatLineupSoftCap(violations) {
  return violations.map((entry) => `${entry.title} (${entry.count})`).join(', ')
}

/**
 * @param {{
 *   clack: { confirm: (input: Record<string, unknown>) => Promise<unknown>, isCancel: (value: unknown) => boolean },
 *   violations: Array<{ title: string, count: number }>,
 *   force?: boolean,
 *   exit?: (code?: number) => never,
 * }} input
 */
async function confirmLineupSoftCapInteractively({ clack, violations, force = false, exit = process.exit }) {
  if (force || violations.length === 0) return
  const confirmed = await clack.confirm({
    message: `Run steps with more than ${INSTANCE_SOFT_CAP} instances: ${formatLineupSoftCap(violations)}?`,
    initialValue: false,
  })
  if (clack.isCancel(confirmed)) exit(0)
  if (!confirmed) {
    console.log('Cancelled')
    exit(0)
  }
}

/**
 * @param {{
 *   flow: import('../types').WorkflowFlow,
 *   steps: import('../types').WorkflowStep[],
 *   transport: string,
 *   branch: string,
 *   context?: string,
 *   runState?: import('../types').WorkflowRunState | null,
 *   options?: import('../types').JsonMap,
 * }} input
 */
function printFlowPlan({ flow, steps, transport, branch, context, runState = null, options = {} }) {
  const terminalWidth = process.stdout.columns || 100
  const outerMaxWidth = Math.max(60, Math.floor(terminalWidth * OUTER_TERMINAL_RATIO))
  const decorations = resumeStepDecorations({ steps, runState })
  const savedStepsById = new Map((runState?.steps || []).map((step) => [step.id, step]))
  const hasContext = context && context.trim()
  const flowDescriptionLines = flow.description
    ? wordWrap(flow.description, outerMaxWidth - 6).split('\n')
    : []
  const lineupsByStep = new Map(steps.map((step) => [
    step.id,
    isHumanReviewStep(step)
      ? { instances: [], warnings: [] }
      : resolvedLineupForStep(flow, step, options, transport),
  ]))
  const lineupWarningLines = steps.flatMap((step) =>
    (lineupsByStep.get(step.id)?.warnings || []).map((warning) => `Warning: ${step.id}: ${warning.message}`))
  const metaLines = [
    ...flowDescriptionLines,
    ...(flowDescriptionLines.length > 0 ? [''] : []),
    `Orchestrated via: ${isNetlifyApiTransport(transport) ? 'Netlify API' : 'GitHub Actions'}`,
    `Branch: ${branch}`,
    ...(hasContext ? ['Additional context: yes'] : []),
    ...((flow.warnings || []).map((warning) => `Warning: ${warning.stepId ? `${warning.stepId}: ` : ''}${warning.message || warning.code || 'workflow warning'}`)),
    ...lineupWarningLines,
  ]
  const headings = steps.map((step, i) => `${i + 1}. ${step.title}`)
  const actionLabels = steps.map((step) => {
    const label = stepActionLabel(step, transport)
    const stateLabel = decorations.get(step.id)?.label
    return stateLabel ? `${stateLabel} · ${label}` : label
  })
  const descriptions = steps.map((step) => resolveStepDescription(flow, step))
  const agentLabelsByStep = new Map(steps.map((step) => [
    step.id,
    (lineupsByStep.get(step.id)?.instances || []).map(formatAgentConfigLabel),
  ]))
  const chipsWidth = (labels) =>
    labels.reduce((sum, label) => sum + label.length + 4, 0) + Math.max(0, labels.length - 1)
  const naturalStepInner = Math.max(
    ...headings.map((h, i) => h.length + actionLabels[i].length + 2),
    ...descriptions.map((d) => d.length),
    ...steps.map((step) => chipsWidth(agentLabelsByStep.get(step.id) || [])),
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
      (agentLabelsByStep.get(step.id) || []).map((label, agentIndex) => {
        const instance = lineupsByStep.get(step.id)?.instances[agentIndex]
        const color = resumeStatusColor(savedAgentStatus(savedStep, instance?.id || instance?.agent))
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
    const {
      flow: configuredFlow,
      stepAgents,
      models,
      efforts,
      stepModels,
      stepEfforts,
    } = withSelectedStepAgents(flow, options)
    const configuredOptions = {
      ...options,
      stepAgents,
      models,
      efforts,
      stepModels,
      stepEfforts,
    }
    const steps = runnableSteps(configuredFlow, configuredOptions)
    if (steps.length === 0) {
      throw new Error('No workflow steps have selected agents.')
    }
    const violations = lineupSoftCapViolations(configuredFlow, steps, configuredOptions, transport)
    if (!configuredOptions.dryRun && configuredOptions.force !== true && violations.length > 0) {
      throw new Error(
        `More than ${INSTANCE_SOFT_CAP} agent instances are configured for ${formatLineupSoftCap(violations)}. ` +
        'Review the lineup and re-run with --force to approve it in non-interactive mode.',
      )
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
  const requestedStepAgents = selectedStepAgents(options)
  let selectedAgents = parseCsv(options.agents)
  if (selectedAgents.length === 0 && Object.keys(requestedStepAgents).length > 0) {
    selectedAgents = agents
  }
  if (selectedAgents.length === 0) {
    const selected = await clack.multiselect({
      message: 'Choose Netlify agent providers',
      options: agents.map((agent) => ({
        value: agent,
        label: titleCase(agent),
      })),
      initialValues: agents,
      required: true,
    })
    if (clack.isCancel(selected)) process.exit(0)
    selectedAgents = Array.isArray(selected) ? selected.map(String) : []
  }
  const selectedInstances = parseAgentInstanceList(selectedAgents)
  const selectedProviders = [...new Set(selectedInstances.map((instance) => instance.agent))]
  const hasInlineConfiguration = selectedInstances.some((instance) => instance.model || instance.effort)
  let interactiveConfiguration = hasInlineConfiguration
    ? {
        models: normalizeProviderModelMap(options.models),
        efforts: normalizeProviderEffortMap(options.efforts),
      }
    : await configureAgentsInteractively({
        clack,
        flow,
        options,
        agents: selectedProviders,
      })
  const addedInstances = await addAgentInstancesInteractively({
    clack,
    agents: selectedProviders,
  })
  if (addedInstances.length > 0) {
    const baseInstances = selectedInstances.map((instance) => {
      if (instance.model || instance.effort) return instance
      const model = interactiveConfiguration.models[instance.agent]
      const effort = interactiveConfiguration.efforts[instance.agent]
      return {
        agent: instance.agent,
        ...(model && model !== 'auto' ? { model } : {}),
        ...(model && model !== 'auto' && effort && effort !== 'auto' ? { effort } : {}),
      }
    })
    selectedAgents = [...baseInstances, ...addedInstances].map(formatAgentInstanceSpec)
    interactiveConfiguration = { models: {}, efforts: {} }
  } else {
    selectedAgents = selectedInstances.map(formatAgentInstanceSpec)
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
    agents: selectedAgents.join(','),
    stepAgents: requestedStepAgents,
    models: interactiveConfiguration.models,
    efforts: interactiveConfiguration.efforts,
  }
  assertValidAgentSelection(flow, {
    agents: selectedAgents,
    stepAgents: configuredOptions.stepAgents,
  })
  const configuredFlow = applyAgentSelection(flow, {
    agents: selectedAgents,
    stepAgents: configuredOptions.stepAgents,
  })
  Object.assign(configuredOptions, selectedAgentConfiguration(configuredFlow, configuredOptions))
  const steps = runnableSteps(configuredFlow, configuredOptions)
  if (steps.length === 0) {
    throw new Error('No workflow steps have selected agents.')
  }
  materializedAgentConfigurations(configuredFlow, { ...configuredOptions, transport })

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
    options: configuredOptions,
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

  const violations = lineupSoftCapViolations(configuredFlow, steps, configuredOptions, transport)
  await confirmLineupSoftCapInteractively({
    clack,
    violations,
    force: configuredOptions.force === true,
  })

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

function selectedStepAgents(options = {}) {
  return parseStepAgentsEntries(options.stepAgents || [])
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
 *   stopRun?: (input: { projectRoot?: string, runnerId?: string, siteId?: string, env?: NodeJS.ProcessEnv, sdkHandle?: import('nax-agent-runner-sdk').Handle }) => RunnerControlResult | Promise<RunnerControlResult>,
 * }} input
 */
async function cancelLocalWorkflowRunnersForInterrupt({ runState, projectRoot, options = {}, reason = 'interrupted workflow', stopRun = stopAgentRun } = {}) {
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
      const run = (runState.steps || [])
        .flatMap((step) => Array.isArray(step.runs) ? step.runs : [])
        .find((item) => String(item.runnerId || '').trim() === runnerId)
      const result = await stopRun({
        projectRoot,
        runnerId,
        siteId: run?.netlifySiteId || options.netlifySiteId,
        env,
        ...(run?.sdkHandle ? { sdkHandle: run.sdkHandle } : {}),
      })
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

/** @param {CompleteGithubStepInput} param0 */
/**
 * @param {string} projectRoot
 * @param {{
 *   runId?: string,
 *   flowId?: string,
 *   stepId?: string,
 *   agent?: string,
 *   instanceId?: string,
 * }} [options]
 */
function findRunStateForRetry(projectRoot, { runId, flowId, stepId, agent, instanceId } = {}) {
  const states = listRunStates(projectRoot)
  if (runId) {
    const matched = states.find((state) => state.runId === runId)
    if (!matched) throw new Error(`Could not find workflow ${runId} under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    return matched
  }
  const matched = states.find((state) => {
    if (!isNetlifyApiTransport(state.transport)) return false
    if (flowId && state.flowId !== flowId) return false
    return localRetryCandidates(state, { stepId, agent, instanceId }).length > 0
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
    instanceId: options.instance,
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
    instanceId: options.instance,
  })
  if (candidates.length === 0) {
    throw new Error(`No retryable failed agents found for ${runState.runId}. Use nax handoff ${runState.runId} to work from completed results.`)
  }
  if (candidates.length > 1) {
    const choices = candidates.map(({ step, run }) => `${step.id}:${run.instanceId || run.agent}`).join(', ')
    throw new Error(`More than one failed Netlify API runner can be retried (${choices}). Pass --step and --instance.`)
  }

  trackRunState(runState)
  const [{ step, stepIndex, run, runIndex }] = candidates
  const retryingPartialStep = step.status === 'completed_with_failures'
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

  console.log(`Retrying ${run.instanceLabel || run.instanceId || titleCase(run.agent)} ${step.title}`)
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

  if (completedRun.status !== 'completed') {
    throw new Error(`Retried ${run.agent} run did not complete successfully.`)
  }

  if (retryingPartialStep) {
    if ((runState.steps || []).some((candidate) => candidate.status === 'completed_with_failures' || candidate.status === 'failed')) {
      runState.status = 'completed_with_failures'
      saveRunState(runState)
    } else {
      markRunCompleted(runState)
    }
    clearTrackedRunState(runState)
    printSuccessBox({ flow, runState, transport: NETLIFY_API_TRANSPORT, projectRoot })
    return
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
  const agent = await chooseAdHocAgentInteractively(options.agent)
  let configuredOptions = options
  if (process.stdin.isTTY && options.model === undefined && options.effort === undefined) {
    const clack = await loadClack()
    const interactiveConfiguration = await chooseSingleAgentConfigInteractively({ clack, agent })
    configuredOptions = {
      ...options,
      models: interactiveConfiguration.models,
      efforts: interactiveConfiguration.efforts,
    }
  }
  const promptText = await promptForAdHocAgentPrompt(options.prompt || options.context)
  const resolvedConfig = resolveAgentRunConfig(agent, {
    globalCli: {
      models: configuredOptions.model === undefined ? configuredOptions.models : { [agent]: configuredOptions.model },
      efforts: configuredOptions.effort === undefined ? configuredOptions.efforts : { [agent]: configuredOptions.effort },
    },
  })
  const pinnedConfiguration = Boolean(resolvedConfig.model || resolvedConfig.effort)
  const transport = pinnedConfiguration
    ? resolveTransportForAgentConfigurations({
        requested: configuredOptions.transport || 'auto',
        detections: configuredOptions.dryRun
          ? [{ id: 'github', available: true }, { id: NETLIFY_API_TRANSPORT, available: true }]
          : detectTransports({ projectRoot }),
        configurations: [resolvedConfig],
      })
    : await chooseSingleRunTransportInteractively({
        requested: configuredOptions.transport || 'auto',
        projectRoot,
      })
  if (configuredOptions.dryRun) {
    console.log('Netlify agent run preview')
    console.log(`Transport: ${transport}`)
    console.log(`Agent: ${formatAgentConfigLabel(resolvedConfig)}`)
    console.log(`Prompt: ${promptText.length} chars`)
    console.log('')
    console.log(promptText)
    return
  }

  if (isNetlifyApiTransport(transport)) {
    const netlifyOptions = await chooseNetlifyFilterOption({ projectRoot, invocationDir, options: configuredOptions })
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
    options: configuredOptions,
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
    context: String(resumable.options?.context || ''),
    runState: resumable,
    options: resumable.options || {},
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
  const configurationPreview = withSelectedStepAgents(flow, flowOptions)
  const previewConfigurations = materializedAgentConfigurations(
    configurationPreview.flow,
    { ...flowOptions, ...configurationPreview },
  )
  let transport
  if (flowOptions.dryRun) {
    transport = resolveTransportForAgentConfigurations({
      requested: requestedTransport,
      detections: [
        { id: 'github', available: true },
        { id: NETLIFY_API_TRANSPORT, available: true },
      ],
      configurations: previewConfigurations,
    })
  } else {
    const detections = detectTransports({ projectRoot })
    if ((requestedTransport === 'auto' || !requestedTransport) && detections.every((candidate) => !candidate.available)) {
      throw new Error(formatTransportSetupHelp(detections))
    }
    const hasPinnedConfiguration = previewConfigurations.some((configuration) => configuration.model || configuration.effort)
    transport = process.stdin.isTTY && !hasPinnedConfiguration
      ? await chooseTransportInteractively({ requested: requestedTransport, projectRoot })
      : resolveTransportForAgentConfigurations({
          requested: requestedTransport,
          detections,
          configurations: previewConfigurations,
        })
    const selectedDetection = detections.find((candidate) => candidate.id === transport)
    if (!selectedDetection?.available) {
      throw new Error(unavailableTransportMessage(transport, detections))
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
  if (isNetlifyApiTransport(transport) && !netlifyOptions.dryRun) {
    await enforceRunPreflight({
      projectRoot,
      siteId: netlifyOptions.netlifySiteId || netlifyOptions.siteId,
    })
  }

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
        options: configuredOptions,
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
    onInterrupt: async ({ runState: activeRunState, reason }) => {
      cleanupWorkflowBlobsForRun({
        runState: activeRunState,
        projectRoot,
        options: configuredOptions,
        reason: `interrupted workflow (${reason})`,
      })
      await cancelLocalWorkflowRunnersForInterrupt({
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
    const stderr = result.stderr.trim()
    const lines = stderr.split('\n').filter(Boolean)
    const shouldPreserveSetupHelp = /No runnable transport detected|Transport "[^"]+" is not available|no Netlify auth token/i.test(stderr)
    const message = shouldPreserveSetupHelp
      ? stderr
      : (lines.pop() || `Workflow "${flowId || 'review'}" failed.`)
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
      costs: handleCosts,
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
    version: packageVersion,
  })
}

if (require.main === module) {
  buildProgram().parseAsync(process.argv).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

module.exports = {
  addAgentInstancesInteractively,
  buildCommentPlan,
  buildPlan,
  createComment,
  createDiscussionComment,
  buildProgram,
  cancelLocalWorkflowRunnersForInterrupt,
  chooseSingleAgentConfigInteractively,
  configureAgentsInteractively,
  confirmLineupSoftCapInteractively,
  createIssue,
  createPullRequestComment,
  extractLinkedPullRequest,
  flowAgents,
  inferAgentFromIssueTitle,
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
  lineupSoftCapViolations,
  withSelectedAgents,
  withSelectedStepAgents,
  parseGitHubPullRequestUrl,
  resolveCommentTarget,
  resumeRunById,
}
