const path = require('path')
const { makeBox } = require('@davidwells/box-logger')
const { formatAgentRunUrl, formatAgentRunUrlFromAdminUrl } = require('../results/agent-run-results')
const { WAIT_FOR_AGENT_RESULTS, isHumanReviewStep, loadStepPrompt } = require('../catalog/flows')
const { AWAITING_REVIEW, createHumanReviewStepState } = require('../human-review')
const { readNetlifyProject } = require('../../integrations/netlify/init')
const { describeRunFailure } = require('../../integrations/netlify/failure-guidance')
const {
  archiveAgentRun,
  currentGitBranch,
  resolveNetlifyFilter,
  resolveNetlifyProjectTarget,
  submitLocalAgentRun,
  waitForLocalAgentRuns,
} = require('../../integrations/netlify/local-runner')
const {
  chooseNetlifyFilterOption,
  configDirForNetlifyOptions,
  maybeReportNetlifyConfig,
  maybeReportNetlifyFilter,
  maybeReportNetlifySite,
  netlifyOptionsFromTarget,
} = require('../../integrations/netlify/project-selection')
const { titleCase, getLocalDate } = require('../catalog/prompts')
const { readRunState, saveRunState, workflowStatePath } = require('../../storage/local/run-state')
const { clearTrackedRunState, markRunCompleted, trackRunState } = require('../../storage/local/graceful-run-state')
const { targetBranch } = require('../../integrations/git/target')
const { NETLIFY_API_TRANSPORT } = require('../../integrations/transports')
const {
  artifactsRootForRunState,
  persistRunArtifact,
  persistStepArtifacts,
  stepArtifactsDir,
} = require('../artifacts/workflow-artifacts')
const {
  applyContextFetchClassification,
  buildLocalAgentPrompt,
  compactLocalTextByBytes,
  formatCompactLocalRunResults,
  formatLocalRunResults,
  localSafePromptBytes,
  prepareLocalPromptDelivery,
} = require('./prompt-delivery')
const { utf8ByteLength } = require('../../core/prompts/budget')
const { formatAgentConfigLabel } = require('../../core/agents/configuration')
const { resolveLineup } = require('../../core/agents/instances')
const {
  completedStepMapFromRunState,
  contextForRunState,
  contextWithOutputBudget,
  firstRunnableStepIndex,
  sourceRunsForStep,
} = require('./execution-context')
const {
  agentStepCompletionSummary,
  conciseErrorMessage,
  localRetryCandidates,
  makeStepProgressReporter,
  nextLocalStepMessage,
  shouldPollLocalRun,
  startSubmissionHeartbeat,
} = require('./progress')
const { MAX_PARALLEL_RUNS, mapInWaves } = require('./wave-scheduler')

/** @type {Map<string, (import('../../types').JsonMap & { siteId?: string, adminUrl?: string, siteName?: string }) | null>} */
const localNetlifyProjectCache = new Map()

/**
 * CLI/workflow options consumed by local Netlify API execution.
 * @typedef {import('../../types').JsonMap & {
 *   archive?: boolean,
 *   branch?: string,
 *   date?: string,
 *   dryRun?: boolean,
 *   filter?: string,
 *   netlifyConfig?: string,
 *   netlifySiteId?: string,
 *   models?: Record<string, string>,
 *   efforts?: Record<string, string>,
 *   stepModels?: Record<string, Record<string, string>>,
 *   stepEfforts?: Record<string, Record<string, string>>,
 *   outputBudget?: boolean,
 *   outputBudgetBytes?: number | string,
 *   siteId?: string,
 *   timeoutMinutes?: string | number,
 * }} LocalExecutorOptions
 *
 * Netlify site context resolved for a local workflow.
 * @typedef {import('../../types').JsonMap & {
 *   siteId?: string,
 *   env?: NodeJS.ProcessEnv,
 *   netlifyFilter?: import('../../types').JsonMap & {
 *     filter?: string,
 *   },
 *   filter?: string,
 * }} LocalNetlifyContext
 *
 * Runtime event callbacks used by workflow execution.
 * @typedef {import('../../types').JsonMap & {
 *   agentStatus?: (status: string, run?: import('../../types').AgentRun, stepState?: import('../../types').WorkflowStep, step?: import('../../types').WorkflowStep, details?: import('../../types').JsonMap) => void,
 *   stepStatus?: (status: string, stepState?: import('../../types').WorkflowStep, step?: import('../../types').WorkflowStep, details?: import('../../types').JsonMap) => void,
 *   workflowStatus?: (status: string, details?: import('../../types').JsonMap) => void,
 *   artifactWritten?: (type: string, filePath: string, details?: import('../../types').JsonMap) => void,
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
 * Input for resolving Netlify Agent Runner dashboard URLs.
 * @typedef {{
 *   projectRoot?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   options?: LocalExecutorOptions,
 * }} LocalAgentRunUrlInput
 *
 * Input for rendering submitted local run boxes.
 * @typedef {{
 *   runs?: import('../../types').AgentRun[],
 *   prompt?: { title?: string },
 *   projectRoot?: string,
 *   options?: LocalExecutorOptions,
 * }} SubmittedLocalRunBoxesInput
 *
 * Shared input for local workflow executor helpers.
 * @typedef {{
 *   flow?: import('../../types').WorkflowFlow,
 *   steps?: import('../../types').WorkflowStep[],
 *   options?: LocalExecutorOptions,
 *   runState?: import('../../types').WorkflowRunState,
 *   projectRoot?: string,
 *   completedStepStates?: Map<string, import('./execution-context').ExecutionStepState>,
 *   runtimeEvents?: WorkflowRuntimeEvents,
 *   submitAgentRun?: typeof submitLocalAgentRun,
 *   waitForAgentRuns?: typeof waitForLocalAgentRuns,
 * }} LocalWorkflowExecutionInput
 *
 * Input for completing one local workflow step.
 * @typedef {LocalWorkflowExecutionInput & {
 *   stepState?: import('../../types').WorkflowStep,
 *   step?: import('../../types').WorkflowStep,
 *   netlify?: LocalNetlifyContext,
 *   netlifyFilter?: import('../../types').JsonMap | string,
 *   initialDelayMs?: number,
 *   waitForAgentRuns?: typeof waitForLocalAgentRuns,
 * }} CompleteLocalStepInput
 *
 * Input for waiting on a submitted subset while a scheduler slot remains occupied.
 * @typedef {CompleteLocalStepInput & {
 *   runs: import('../../types').AgentRun[],
 *   reporter: import('./progress').StepProgressReporter,
 * }} WaitForLocalRunSubsetInput
 *
 * Input for rebuilding a smaller prompt when retrying a local runner.
 * @typedef {{
 *   flow: import('../../types').WorkflowFlow,
 *   step: import('../../types').WorkflowStep,
 *   runState: import('../../types').WorkflowRunState,
 *   run: import('../../types').AgentRun,
 * }} CompactLocalPromptForRetryInput
 *
 * Human-review pause input.
 * @typedef {{
 *   runState: import('../../types').WorkflowRunState,
 *   step: import('../../types').WorkflowStep,
 *   runtimeEvents?: WorkflowRuntimeEvents,
 * }} RequireHumanReviewInput
 *
 * Remote run progress event subset used for local status rendering.
 * @typedef {import('../../types').JsonMap & {
 *   terminalSuccess?: boolean,
 *   terminalFailure?: boolean,
 *   state?: string,
 * }} LocalRunProgressEvent
 *
 * Persisted run artifact paths returned by workflow artifact writers.
 * @typedef {{
 *   attemptNumber?: number | null,
 *   jsonPath?: string,
 *   markdownPath?: string,
 *   canonical?: import('../../types').JsonMap | null,
 * }} PersistedRunArtifactResult
 */

/** @param {LocalAgentRunUrlInput} param0 @returns {string} */
function localAgentRunUrl({ projectRoot, runnerId, sessionId, options = {} }) {
  if (!runnerId) return ''
  const runOptions = /** @type {LocalExecutorOptions} */ (options || {})
  const expectedSiteId = String(runOptions.netlifySiteId || runOptions.siteId || '').trim()
  try {
    const statusRoot = configDirForNetlifyOptions(projectRoot, runOptions)
    const env = expectedSiteId ? { ...process.env, NETLIFY_SITE_ID: expectedSiteId } : process.env
    const cacheKey = `${statusRoot}\0${expectedSiteId}`
    let project = localNetlifyProjectCache.get(cacheKey)
    if (project === undefined) {
      project = /** @type {(import('../../types').JsonMap & { siteId?: string, adminUrl?: string, siteName?: string }) | null} */ (readNetlifyProject(statusRoot, env))
      localNetlifyProjectCache.set(cacheKey, project)
    }
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

/** @param {SubmittedLocalRunBoxesInput} param0 @returns {string} */
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

/** @param {CompactLocalPromptForRetryInput} param0 @returns {string} */
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

/**
 * Instance-aware step status (Arena nax-2rx6.4.5). A step with a mix of succeeded and failed
 * instances is `completed_with_failures` and the workflow proceeds with the survivors; a step
 * where every instance failed is `failed` and the workflow halts (no cascade).
 * @param {import('../../types').WorkflowStep} stepState @returns {string}
 */
function localStepStatus(stepState) {
  const runs = stepState.runs || []
  if (runs.length === 0) return 'completed'
  const succeeded = runs.filter((run) => run.status === 'completed' || run.status === 'dry-run')
  if (succeeded.length === runs.length) return 'completed'
  if (succeeded.length === 0) return 'failed'
  return 'completed_with_failures'
}

/** A step status that lets the workflow proceed to the next step. */
function localStepProceeds(status) {
  return status === 'completed' || status === 'dry-run' || status === 'completed_with_failures'
}

/**
 * Enforces workflow control-flow and exit semantics after a local step settles.
 * @param {import('../../types').WorkflowStep} stepState
 * @param {{ final?: boolean }} [options]
 * @returns {void}
 */
function assertLocalStepOutcome(stepState, { final = false } = {}) {
  if (!localStepProceeds(stepState.status)) {
    const error = /** @type {Error & { code?: string, stepId?: string }} */ (
      new Error(`Local step "${stepState.id}" failed: every agent instance failed.`)
    )
    error.code = 'NAX_ALL_INSTANCES_FAILED'
    error.stepId = stepState.id
    throw error
  }
  if (final && stepState.status === 'completed_with_failures') {
    const error = /** @type {Error & { code?: string, stepId?: string }} */ (
      new Error(`Local step "${stepState.id}" completed with failed agent instances.`)
    )
    error.code = 'NAX_PARTIAL_FINAL_STEP'
    error.stepId = stepState.id
    throw error
  }
}

/**
 * Runs of a follow-up step's single continuation source — the FIRST input step. Additional
 * input steps supply read-only context only and do not create continuations (Arena nax-2rx6.4.4).
 * @param {import('../../types').WorkflowStep} step
 * @param {Map<string, { runs?: import('../../types').AgentRun[] }>} completedStepStates
 * @returns {import('../../types').AgentRun[]}
 */
function continuationSourceRuns(step, completedStepStates) {
  const inputs = Array.isArray(step.input) ? step.input : []
  const first = inputs.find((entry) => entry && entry.step)
  if (!first) return []
  const source = completedStepStates.get(String(first.step))
  return Array.isArray(source && source.runs) ? source.runs : []
}

/**
 * Selects only successful sessions from the first input and rejects accidental fresh fan-out.
 * @param {import('../../types').WorkflowStep} step
 * @param {Map<string, { runs?: import('../../types').AgentRun[] }>} completedStepStates
 * @returns {import('../../types').AgentRun[]}
 */
function completedContinuationRuns(step, completedStepStates) {
  if (step.submit !== 'follow-up') return []
  const inheritedRuns = continuationSourceRuns(step, completedStepStates)
    .filter((sourceRun) => sourceRun.runnerId && sourceRun.status === 'completed')
  if (inheritedRuns.length > 0) return inheritedRuns
  const sourceStepId = Array.isArray(step.input) ? step.input.find((entry) => entry?.step)?.step : ''
  const error = /** @type {Error & { code?: string, stepId?: string, sourceStepId?: string }} */ (
    new Error(`Follow-up step "${step.id}" has no completed runner sessions to continue from its first input${sourceStepId ? ` "${sourceStepId}"` : ''}.`)
  )
  error.code = 'NAX_FOLLOWUP_SOURCE_UNAVAILABLE'
  error.stepId = step.id
  error.sourceStepId = String(sourceStepId || '')
  throw error
}

/**
 * @param {import('../../types').AgentRun[]} inheritedRuns
 * @param {{ agent: string, id: string }} instance
 * @returns {import('../../types').AgentRun | null}
 */
function continuationRunForInstance(inheritedRuns, instance) {
  return inheritedRuns.find((sourceRun) => sourceRun.runnerId
    && (sourceRun.instanceId ? sourceRun.instanceId === instance.id : sourceRun.agent === instance.agent)) || null
}

/**
 * @param {import('../../types').WorkflowRunState} runState
 * @param {import('../../types').WorkflowStep} stepState
 * @returns {Error & { code?: string, runId?: string, stepId?: string }}
 */
function humanReviewPauseError(runState, stepState) {
  const error = /** @type {Error & { code?: string, runId?: string, stepId?: string }} */ (new Error(`Workflow "${runState.flowTitle || runState.flowId}" is awaiting human review at step "${stepState.title || stepState.id}".`))
  error.code = AWAITING_REVIEW
  error.runId = runState.runId
  error.stepId = stepState.id
  return error
}

/** @param {RequireHumanReviewInput} param0 @returns {never} */
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

/** @param {LocalRunProgressEvent} [event] @returns {string} */
function visualAgentStatusFromPoll(event = {}) {
  if (event.terminalSuccess) return 'completed'
  if (event.terminalFailure) return event.state === 'timeout' ? 'timeout' : 'failed'
  if (event.state === 'running' || event.state === 'processing' || event.state === 'executing') return 'running'
  if (event.state === 'retrying') return 'retrying'
  return 'waiting'
}

/**
 * @param {WorkflowRuntimeEvents | undefined} runtimeEvents
 * @param {import('../../types').WorkflowRunState} runState
 * @param {import('../../types').WorkflowStep} stepState
 * @returns {void}
 */
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

/**
 * @param {WorkflowRuntimeEvents | undefined} runtimeEvents
 * @param {import('../../types').WorkflowRunState} runState
 * @param {import('../../types').WorkflowStep} stepState
 * @param {import('../../types').AgentRun} run
 * @param {PersistedRunArtifactResult | null | undefined} artifactResult
 * @returns {void}
 */
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

/**
 * @param {WorkflowRuntimeEvents | undefined} runtimeEvents
 * @param {import('../../types').WorkflowRunState} runState
 * @returns {void}
 */
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

/**
 * @param {import('../../types').WorkflowStep[]} [flowSteps]
 * @param {number} [currentStepIndex]
 * @param {string} [stepId]
 * @returns {boolean}
 */
function futureFollowUpReferencesStep(flowSteps = [], currentStepIndex = -1, stepId) {
  return flowSteps.slice(currentStepIndex + 1).some((step) => (
    step.submit === 'follow-up' &&
    Array.isArray(step.input) &&
    step.input.some((input) => input.step === stepId)
  ))
}

/**
 * @param {import('../../types').WorkflowStep[]} [flowSteps]
 * @param {number} [currentStepIndex]
 * @param {string} [stepId]
 * @returns {number}
 */
function stepIndexInFlowSteps(flowSteps = [], currentStepIndex = -1, stepId) {
  const index = flowSteps.findIndex((step) => step.id === stepId)
  return index === -1 ? currentStepIndex : index
}

/**
 * @param {{
 *   step?: import('../../types').WorkflowStep,
 *   options?: LocalExecutorOptions,
 *   flowSteps?: import('../../types').WorkflowStep[],
 *   currentStepIndex?: number,
 * }} input
 * @returns {boolean}
 */
function shouldArchiveCompletedStep({ step, options = {}, flowSteps = [], currentStepIndex = -1 }) {
  if (!step) return false
  if (step.autoArchive === true) return true
  if (step.autoArchive === false) return false
  if (options.archive !== true) return false
  if (step.isArchivable === false) return false
  const index = stepIndexInFlowSteps(flowSteps, currentStepIndex, step.id)
  return index !== flowSteps.length - 1
}

/**
 * @param {import('../../types').WorkflowRunState} runState
 * @param {string} runnerId
 * @param {RunnerControlResult} archiveResult
 * @returns {import('../../types').WorkflowStep[]}
 */
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

/**
 * @param {{
 *   runState?: import('../../types').WorkflowRunState,
 *   flowSteps?: import('../../types').WorkflowStep[],
 *   currentStepIndex?: number,
 *   options?: LocalExecutorOptions,
 *   projectRoot?: string,
 *   netlify?: import('../../types').JsonMap & { env?: NodeJS.ProcessEnv },
 *   archiveRun?: (input: { projectRoot?: string, runnerId?: string, env?: NodeJS.ProcessEnv }) => RunnerControlResult | Promise<RunnerControlResult>,
 * }} input
 * @returns {Promise<void>}
 */
async function archiveEligibleCompletedLocalRuns({ runState, flowSteps, currentStepIndex, options = {}, projectRoot, netlify, archiveRun = archiveAgentRun }) {
  const archivedThisPass = new Set()
  const stepById = new Map((flowSteps || []).map((step) => [step.id, step]))
  for (const stepState of runState.steps || []) {
    const step = stepById.get(stepState.id)
    if (!shouldArchiveCompletedStep({ step, options, flowSteps, currentStepIndex })) continue
    if (stepState.status !== 'completed' && stepState.status !== 'completed_with_failures') continue
    if (futureFollowUpReferencesStep(flowSteps, currentStepIndex, stepState.id)) continue

    for (const run of stepState.runs || []) {
      if (run.status !== 'completed' || !run.runnerId || run.archived === true) continue
      if (archivedThisPass.has(run.runnerId)) continue
      archivedThisPass.add(run.runnerId)

      const archiveResult = await archiveRun({
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

/** @param {import('../../types').AgentRun} run @param {string} projectRoot @param {LocalExecutorOptions} [options] @returns {import('../../types').AgentRun} */
function addLocalRunLinks(run, projectRoot, options = {}) {
  const runUrl = run.links?.sessionUrl || localAgentRunUrl({ projectRoot, runnerId: run.runnerId, sessionId: run.sessionId, options })
  const baseRunUrl = run.links?.agentRunUrl || localAgentRunUrl({ projectRoot, runnerId: run.runnerId, options })
  run.links = {
    ...(run.links || {}),
    ...(baseRunUrl ? { agentRunUrl: baseRunUrl } : {}),
    ...(runUrl ? { sessionUrl: runUrl } : {}),
  }
  return run
}

/**
 * @param {import('./progress').StepProgressReporter} reporter
 * @param {import('../../types').AgentRun} run
 * @param {string} projectRoot
 * @param {LocalExecutorOptions} [options]
 * @returns {void}
 */
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

/**
 * Finds the persisted slot for a run even when an SDK retry replaces its runner id.
 * @param {import('../../types').AgentRun[]} runs
 * @param {import('../../types').AgentRun} run
 * @returns {number}
 */
function localRunIndex(runs, run) {
  if (run.instanceId) {
    const instanceIndex = runs.findIndex((candidate) => candidate.instanceId === run.instanceId)
    if (instanceIndex !== -1) return instanceIndex
  }
  return runs.findIndex((candidate) => candidate.runnerId === run.runnerId)
}

/**
 * Waits for a submitted subset to become terminal and merges every update into the full step.
 * The caller keeps its scheduler slot until this promise settles.
 * @param {WaitForLocalRunSubsetInput} param0
 * @returns {Promise<import('../../types').AgentRun[]>}
 */
async function waitForLocalRunSubset({ runState, stepState, step, runs, reporter, options, projectRoot, netlify, netlifyFilter, initialDelayMs, runtimeEvents, waitForAgentRuns = waitForLocalAgentRuns }) {
  const timeoutMinutes = Number.parseInt(String(options.timeoutMinutes || '25'), 10)
  const resolvedNetlifyFilter = netlifyFilter !== undefined
    ? netlifyFilter
    : resolveNetlifyFilter({ projectRoot, filter: options.filter }).filter
  const completedRuns = await waitForAgentRuns({
    projectRoot,
    runs,
    siteId: netlify.siteId,
    netlifyFilter: resolvedNetlifyFilter,
    env: netlify.env,
    timeoutMinutes,
    initialDelayMs,
    onProgress: (event) => {
      if (!event.run?.runnerId) return
      if (event.retry === true) {
        const retryIndex = localRunIndex(stepState.runs, event.run)
        if (retryIndex !== -1) {
          stepState.runs[retryIndex] = event.run
          saveRunState(runState)
        }
      }
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
      const index = localRunIndex(stepState.runs, classifiedRun)
      if (index !== -1) stepState.runs[index] = classifiedRun
      const artifactResult = persistRunArtifact(runState, stepState, classifiedRun)
      emitRunArtifact(runtimeEvents, runState, stepState, classifiedRun, artifactResult)
      saveRunState(runState)
      reportTerminalLocalRun(reporter, classifiedRun, projectRoot)
      const failureDetail = classifiedRun.status === 'failed' || classifiedRun.status === 'timeout'
        ? conciseErrorMessage(classifiedRun.resultText || classifiedRun.raw?.submissionError || '')
        : ''
      const failureMessage = describeRunFailure(failureDetail)
      runtimeEvents?.agentStatus(classifiedRun.status || 'completed', classifiedRun, stepState, step, {
        terminal: true,
        usage: classifiedRun.usage || null,
        hasResult: Boolean(classifiedRun.resultText),
        contextFetchStatus: classifiedRun.contextFetchStatus || '',
        error: failureDetail,
        ...(failureMessage ? { message: failureMessage } : {}),
      })
    },
    refreshRuns: () => {
      if (!runState?.dir || !stepState?.id) return []
      try {
        const refreshed = readRunState(workflowStatePath(runState.dir))
        const refreshedStep = Array.isArray(refreshed.steps)
          ? refreshed.steps.find((candidate) => candidate?.id === stepState.id)
          : null
        const refreshedRuns = Array.isArray(refreshedStep?.runs) ? refreshedStep.runs : []
        const identities = new Set(runs.map((run) => run.instanceId || run.runnerId))
        return refreshedRuns.filter((run) => identities.has(run.instanceId || run.runnerId))
      } catch (_err) {
        return []
      }
    },
  })
  return completedRuns.map((run) => {
    const classifiedRun = applyContextFetchClassification(run)
    addLocalRunLinks(classifiedRun, projectRoot, options)
    const index = localRunIndex(stepState.runs, classifiedRun)
    if (index !== -1) stepState.runs[index] = classifiedRun
    reporter.updateRun({
      run: classifiedRun,
      state: classifiedRun.status,
      terminal: classifiedRun.status === 'completed' || classifiedRun.status === 'failed' || classifiedRun.status === 'timeout',
      terminalSuccess: classifiedRun.status === 'completed',
      terminalFailure: classifiedRun.status === 'failed' || classifiedRun.status === 'timeout',
    })
    return classifiedRun
  })
}

/** @param {CompleteLocalStepInput} param0 @returns {Promise<import('../../types').WorkflowStep>} */
async function completeLocalStep({ runState, stepState, step, options, projectRoot, netlify, netlifyFilter, initialDelayMs, runtimeEvents, waitForAgentRuns = waitForLocalAgentRuns }) {
  if (step.waitFor === WAIT_FOR_AGENT_RESULTS && stepState.runs.some(shouldPollLocalRun)) {
    const reporter = makeStepProgressReporter({
      stepTitle: step.title,
      total: stepState.runs.length,
      agents: step.agents || [],
    })
    let settled = false
    try {
      const classifiedRuns = await waitForLocalRunSubset({
        runState,
        stepState,
        step,
        runs: stepState.runs,
        reporter,
        options,
        projectRoot,
        netlify,
        netlifyFilter,
        initialDelayMs,
        runtimeEvents,
        waitForAgentRuns,
      })
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
  saveRunState(runState)
  return stepState
}

/** @param {LocalWorkflowExecutionInput} param0 @returns {Promise<void>} */
async function executeLocalFlow({ flow, steps, options, runState, projectRoot, completedStepStates = new Map(), runtimeEvents, submitAgentRun = submitLocalAgentRun, waitForAgentRuns = waitForLocalAgentRuns }) {
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
  maybeReportNetlifyConfig(resolvedNetlifyOptions)
  maybeReportNetlifyFilter(netlifyFilter)

  for (const [stepIndex, step] of steps.entries()) {
    if (isHumanReviewStep(step)) {
      requireHumanReview({ runState, step, runtimeEvents })
    }
    const inheritedRuns = completedContinuationRuns(step, completedStepStates)
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
    // Resolve the step's lineup into agent instances (one AgentRun per instance). The lineup
    // preserves fan-out/object entries; provider-keyed models/efforts maps bridge to bare
    // instances. Precedence: defaults < step < globalCli < stepCli.
    const stepLineup = Array.isArray(step.lineup) && step.lineup.length > 0 ? step.lineup : step.agents
    const mergedModels = {
      ...(flow.defaults?.models || {}),
      ...(step.models || {}),
      ...(options.models || {}),
      ...(options.stepModels?.[step.id] || {}),
    }
    const mergedEfforts = {
      ...(flow.defaults?.efforts || {}),
      ...(step.efforts || {}),
      ...(options.efforts || {}),
      ...(options.stepEfforts?.[step.id] || {}),
    }
    // Follow-up steps INHERIT their lineup from the continuation source (the first input step)
    // and continue each of its instances' own sessions by (sourceStepId, instanceId). This is a
    // no-op for single-instance-per-provider flows (ids already match) and is what lets a
    // multi-instance step (e.g. two Claude models) each continue its own session.
    /** @type {import('../../types').AgentInstance[]} */
    let instances
    /** @type {string[]} */
    let lineupWarnings
    if (inheritedRuns.length > 0) {
      instances = inheritedRuns.map((sourceRun) => ({
        agent: sourceRun.agent,
        ...(sourceRun.model ? { model: sourceRun.model } : {}),
        ...(sourceRun.effort ? { effort: sourceRun.effort } : {}),
        id: sourceRun.instanceId || `${sourceRun.agent}:auto:auto`,
        resolvedFrom: sourceRun.resolvedFrom || 'open',
        ...(sourceRun.instanceLabel ? { label: sourceRun.instanceLabel } : {}),
      }))
      lineupWarnings = []
    } else {
      const resolvedLineup = resolveLineup(stepLineup, {
        requestedTransport: NETLIFY_API_TRANSPORT,
        models: mergedModels,
        efforts: mergedEfforts,
      })
      instances = resolvedLineup.instances
      lineupWarnings = resolvedLineup.warnings.map((warning) => warning.message)
    }
    /** @type {import('../../types').AgentRun[]} */
    const runs = instances.map((instance) => {
      const agent = instance.agent
      const followUpRun = step.submit === 'follow-up'
        ? continuationRunForInstance(inheritedRuns, instance)
        : null
      const delivery = prepareLocalPromptDelivery({
        agent,
        prompt,
        step,
        sourceRuns,
        roundResults,
        stepContext,
        options,
      })
      const promptDelivery = /** @type {import('../../types').JsonMap & { contextFetchPolicy?: string }} */ (delivery.promptDelivery || {})
      return {
        transport: NETLIFY_API_TRANSPORT,
        agent,
        instanceId: instance.id,
        ...(instance.model ? { model: instance.model } : {}),
        ...(instance.effort ? { effort: instance.effort } : {}),
        ...(instance.resolvedFrom ? { resolvedFrom: instance.resolvedFrom } : {}),
        ...(instance.label ? { instanceLabel: instance.label } : {}),
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
        ...(followUpRun?.sdkHandle ? { sdkHandle: followUpRun.sdkHandle } : {}),
        raw: {
          workflowRunId: runState.runId,
          stepId: step.id,
          promptName: prompt.name,
          ...(lineupWarnings.length > 0 ? { configurationWarnings: lineupWarnings } : {}),
        },
      }
    })

    console.log(`\nRun Netlify API agents: ${step.title}`)
    for (const run of runs) {
      console.log(`\n- ${formatAgentConfigLabel(run)} ${prompt.title}`)
      console.log(`  prompt: ${prompt.name}`)
      console.log(`  body: ${run.promptText.length} chars / ${utf8ByteLength(run.promptText).toLocaleString()} bytes`)
      if (run.promptDelivery?.mode && run.promptDelivery.mode !== 'inline') {
        const blobRef = /** @type {import('../../types').BlobRef | undefined} */ (run.promptDelivery.blobRef)
        console.log(`  delivery: ${run.promptDelivery.mode}${blobRef ? ` (${blobRef.store}/${blobRef.key})` : ''}`)
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

    console.log(`\nRunning ${runs.length} Netlify agent ${runs.length === 1 ? 'run' : 'runs'} with up to ${MAX_PARALLEL_RUNS} non-terminal at once...`)
    const startedAt = Date.now()
    const pendingSubmissionLabels = new Set()
    const reporter = step.waitFor === WAIT_FOR_AGENT_RESULTS
      ? makeStepProgressReporter({
          stepTitle: step.title,
          total: runs.length,
          agents: runs.map((run) => run.instanceLabel || run.instanceId || run.agent),
        })
      : null
    const stopSubmissionHeartbeat = startSubmissionHeartbeat({
      pendingLabels: pendingSubmissionLabels,
      startedAt,
    })
    let submissions
    try {
      submissions = await mapInWaves(runs, MAX_PARALLEL_RUNS, async (run, index) => {
        const label = `${titleCase(run.agent)} ${prompt.title}`
        /** @type {import('../../types').AgentRun} */
        let activeRun = run
        let phase = 'submit'
        pendingSubmissionLabels.add(label)
        console.log(`- ${label}: submitting${run.existingRunnerId ? ' follow-up' : ''}...`)
        runtimeEvents?.agentStatus('submitting', run, stepState, step, {
          submit: step.submit || '',
          existingRunnerId: run.existingRunnerId || '',
        })
        try {
          const submitted = await submitAgentRun({
            run,
            projectRoot,
            branch,
            siteId: netlify.siteId,
            netlifyFilter: netlifyFilter.filter,
            env: netlify.env,
            timeoutMinutes: Number(options.timeoutMinutes || 25),
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
          activeRun = submitted
          addLocalRunLinks(submitted, projectRoot, options)
          stepState.runs[index] = submitted
          saveRunState(runState)
          runtimeEvents?.agentStatus('submitted', submitted, stepState, step, {
            submittedAfterSeconds: elapsedSeconds,
          })
          console.log(`  ${label}: submitted after ${elapsedSeconds}s`)
          pendingSubmissionLabels.delete(label)
          if (reporter) {
            phase = 'wait'
            const [terminalRun] = await waitForLocalRunSubset({
              runState,
              stepState,
              step,
              runs: [submitted],
              reporter,
              options,
              projectRoot,
              netlify,
              netlifyFilter: netlifyFilter.filter,
              runtimeEvents,
              initialDelayMs: 0,
              waitForAgentRuns,
            })
            activeRun = terminalRun || submitted
          }
          return activeRun
        } catch (error) {
          const failedRun = {
            ...activeRun,
            status: 'failed',
            resultText: error?.message || String(error || 'Submission failed'),
            raw: {
              ...activeRun.raw,
              submissionError: error?.message || String(error || 'Submission failed'),
              failurePhase: phase,
            },
          }
          stepState.runs[index] = failedRun
          saveRunState(runState)
          runtimeEvents?.agentStatus('failed', failedRun, stepState, step, {
            message: error?.message || String(error || 'Submission failed'),
            phase,
          })
          console.log(`  ${label}: ${phase} failed — ${conciseErrorMessage(error)}`)
          reporter?.updateRun({
            run: failedRun,
            state: 'failed',
            error: failedRun.resultText,
            terminal: true,
            terminalFailure: true,
          })
          return failedRun
        } finally {
          pendingSubmissionLabels.delete(label)
        }
      })
    } finally {
      stopSubmissionHeartbeat()
    }
    const submittedRuns = submissions.map((result, index) => {
      if (result.status === 'fulfilled') return result.value
      return stepState.runs[index]
    })
    stepState.runs = submittedRuns
    saveRunState(runState)
    const submissionBoxes = formatSubmittedLocalRunBoxes({ runs: submittedRuns, prompt, projectRoot, options })
    if (submissionBoxes) {
      console.log('\nSubmitted Netlify agent runs:')
      console.log(submissionBoxes)
    }

    if (reporter) {
      const failedCount = submittedRuns.filter((run) => run.status === 'failed' || run.status === 'timeout').length
      const completionSummary = agentStepCompletionSummary({
        stepTitle: step.title,
        runs: submittedRuns,
        failedCount,
      })
      if (failedCount > 0) reporter.fail(completionSummary)
      else reporter.done(completionSummary)
    }

    await completeLocalStep({ runState, stepState, step, options, projectRoot, netlify, netlifyFilter: netlifyFilter.filter, runtimeEvents })
    await archiveEligibleCompletedLocalRuns({
      runState,
      flowSteps: steps,
      currentStepIndex: stepIndex,
      options,
      projectRoot,
      netlify,
    })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)

    assertLocalStepOutcome(stepState, { final: stepIndex === steps.length - 1 })
    console.log(`\n${nextLocalStepMessage(steps, stepIndex)}`)
  }
}

/**
 * @param {{
 *   flow?: import('../../types').WorkflowFlow,
 *   runState?: import('../../types').WorkflowRunState,
 *   projectRoot?: string,
 * }} param0
 * @returns {Promise<void>}
 */
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
    markRunCompleted(runState)
    clearTrackedRunState(runState)
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
    await archiveEligibleCompletedLocalRuns({
      runState,
      flowSteps: flow.steps,
      currentStepIndex: startIndex,
      options,
      projectRoot,
      netlify,
    })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
    assertLocalStepOutcome(stepState, { final: startIndex === flow.steps.length - 1 })
    await executeLocalFlow({
      flow,
      steps: flow.steps.slice(startIndex + 1),
      options: runState.options,
      runState,
      projectRoot,
      completedStepStates,
    })
    markRunCompleted(runState)
    clearTrackedRunState(runState)
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
  markRunCompleted(runState)
  clearTrackedRunState(runState)
}

module.exports = {
  addLocalRunLinks,
  applyArchiveResultToRunner,
  archiveEligibleCompletedLocalRuns,
  assertLocalStepOutcome,
  buildCompactLocalPromptForRetry,
  completeLocalStep,
  completedContinuationRuns,
  continuationRunForInstance,
  continuationSourceRuns,
  localStepStatus,
  localStepProceeds,
  localRunIndex,
  emitRunArtifact,
  emitStepArtifacts,
  emitWorkflowArtifacts,
  executeLocalFlow,
  formatSubmittedLocalRunBoxes,
  futureFollowUpReferencesStep,
  humanReviewPauseError,
  localAgentRunUrl,
  reportTerminalLocalRun,
  requireHumanReview,
  resumeLocalFlow,
  shouldArchiveCompletedStep,
  visualAgentStatusFromPoll,
  waitForLocalRunSubset,
}
