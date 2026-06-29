const { normalizeAgentList } = require('../../core/agents/selection')
const { isNetlifyApiTransport } = require('../../core/runs/resumable')
const { isTerminalRunStatus } = require('../../core/status')
const { targetBranch } = require('../../integrations/git/target')
const { resolveNetlifyProjectTarget, submitLocalAgentRun } = require('../../integrations/netlify/local-runner')
const { netlifyOptionsFromTarget } = require('../../integrations/netlify/project-selection')
const { saveRunState } = require('../../storage/local/run-state')
const { buildFollowupContextPackage } = require('../../workflows/followups/context')
const { prepareFollowupContextDelivery } = require('../../workflows/followups/delivery')
const { buildFollowupSubmissionPlan } = require('../../workflows/followups/plan')
const { buildFollowupPrompt, submitFollowupPlan } = require('../../workflows/followups/runner')
const { appendFollowupRunsToWorkflow, cancelFollowupRunInWorkflow, persistFreshPseudoWorkflow } = require('../../workflows/followups/persistence')
const { addLocalRunLinks } = require('../../workflows/engine/local-executor')
const { cancelHumanReviewGate } = require('../../workflows/human-review')
const { requestError } = require('../api/errors')
const { buildRunDetails } = require('../shared/run-details')
const { publicRunState } = require('../api/serializers')

/**
 * @typedef {{
 *   runState: Record<string, unknown>,
 *   body?: Record<string, unknown>,
 * }} ReviewCancelInput
 */

/** @param {ReviewCancelInput} input */
function cancelReviewGate({ runState, body = {} }) {
  const next = cancelHumanReviewGate({
    runState,
    stepId: String(body.stepId || ''),
    reviewer: 'dashboard',
    reason: String(body.reason || 'cancelled by reviewer'),
  })
  return {
    run: publicRunState(next),
    cancelled: true,
  }
}

/**
 * @typedef {{
 *   projectRoot: string,
 *   sourceRunId: string,
 *   durable: Record<string, unknown>,
 *   body?: Record<string, unknown>,
 *   env: NodeJS.ProcessEnv,
 *   followupSiteId: string,
 *   followupSiteName: string,
 *   followupNetlifyFilter: string,
 *   followupSubmitRun?: import('../../workflows/followups/runner').HandoffSubmitRun,
 *   writeBlob: FollowupBlobWriter | null,
 *   normalizeFollowupRequest: (body: Record<string, unknown>, details: object, durable: Record<string, unknown>) => FollowupRequest,
 *   makeBlobWriter: (input: { projectRoot: string, siteId: string, env: NodeJS.ProcessEnv, writeBlob?: FollowupBlobWriter | null, setBlobCommand?: typeof import('../../integrations/netlify/blobs').setBlob }) => FollowupBlobWriter | null,
 *   setBlobCommand?: typeof import('../../integrations/netlify/blobs').setBlob,
 *   linkSubmittedRun: (input: { siteName: string }) => (run?: Record<string, unknown>) => Record<string, unknown>,
 *   followupId: (sourceRunId?: string) => string,
 *   freshFollowupTitle: (sourceRun: Record<string, unknown>, target: Record<string, unknown>, freshResults: Array<Record<string, unknown>>) => string,
 *   submissionResponseItem: (result?: Record<string, unknown>) => object,
 * }} SubmitFollowupInput
 *
 * @typedef {(input: { ref: import('../../types').BlobRef, payload: string }) => Promise<unknown> | unknown} FollowupBlobWriter
 *
 * @typedef {{
 *   prompt: string,
 *   target: Record<string, unknown> & { id: string },
 *   artifacts: Array<{ id: string, kind?: string }>,
 *   mode: string,
 *   models: Array<string>,
 *   targetSha: string,
 *   targetBranch: string,
 * }} FollowupRequest
 */

/** @param {unknown} value */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** @param {unknown} status */
function isActiveWorkflowStepStatus(status) {
  return ['pending', 'queued', 'running', 'submitted', 'submitting', 'retrying', 'waiting'].includes(String(status || '').trim().toLowerCase())
}

/**
 * @param {Record<string, unknown>} durable
 * @param {Record<string, unknown>} body
 */
function retryTarget(durable, body = {}) {
  const stepId = stringValue(body.stepId).trim()
  const agent = stringValue(body.agent).trim().toLowerCase()
  const runnerId = stringValue(body.runnerId).trim()
  const sessionId = stringValue(body.sessionId).trim()
  if (!stepId || !agent) {
    throw requestError(400, 'missing_retry_target', 'Select a workflow step and agent result to retry.')
  }
  const steps = Array.isArray(durable.steps) ? durable.steps.map(objectValue) : []
  const step = steps.find((candidate) => stringValue(candidate.id) === stepId) || null
  if (!step) throw requestError(404, 'retry_step_not_found', `Workflow step "${stepId}" was not found.`)
  if (!isActiveWorkflowStepStatus(step.status)) {
    throw requestError(409, 'retry_step_not_active', `Workflow step "${stepId}" is no longer active.`)
  }
  const runs = Array.isArray(step.runs) ? step.runs.map(objectValue) : []
  const matches = runs
    .map((run, runIndex) => ({ run, runIndex }))
    .filter(({ run }) => {
      if (stringValue(run.agent).toLowerCase() !== agent) return false
      if (runnerId && stringValue(run.runnerId) !== runnerId) return false
      if (sessionId && stringValue(run.sessionId) !== sessionId) return false
      return true
    })
  if (matches.length === 0) throw requestError(404, 'retry_run_not_found', `No ${agent} run was found for step "${stepId}".`)
  if (matches.length > 1) throw requestError(409, 'ambiguous_retry_target', `More than one ${agent} run matched step "${stepId}".`)
  const match = matches[0]
  if (!isTerminalRunStatus(match.run.status)) {
    throw requestError(409, 'retry_run_not_terminal', `The ${agent} run is still active.`)
  }
  if (!stringValue(match.run.promptText).trim()) {
    throw requestError(409, 'retry_prompt_unavailable', `The saved ${agent} prompt is not available for retry.`)
  }
  return {
    step,
    run: match.run,
    runIndex: match.runIndex,
    stepId,
    agent,
  }
}

/**
 * @param {Record<string, unknown>} run
 * @param {{ requestedAt: string, reason: string }} retry
 * @param {Record<string, unknown>} [extra]
 */
function retryReplacementRun(run, retry, extra = {}) {
  return {
    ...run,
    status: 'pending',
    runnerId: '',
    sessionId: '',
    resultText: '',
    issueUrl: '',
    commentUrl: '',
    prUrl: '',
    deployUrl: '',
    links: {},
    existingRunnerId: '',
    raw: {
      ...objectValue(run.raw),
      dashboardRetry: {
        requestedAt: retry.requestedAt,
        reason: retry.reason,
        ...extra,
        previous: {
          agent: stringValue(run.agent),
          status: stringValue(run.status),
          runnerId: stringValue(run.runnerId),
          sessionId: stringValue(run.sessionId),
        },
      },
    },
  }
}

/**
 * @param {{
 *   projectRoot: string,
 *   durable: Record<string, unknown>,
 *   body?: Record<string, unknown>,
 *   env: NodeJS.ProcessEnv,
 *   submitRun?: typeof submitLocalAgentRun,
 * }} input
 */
async function retryAgentRun({ projectRoot, durable, body = {}, env, submitRun = submitLocalAgentRun }) {
  if (!isNetlifyApiTransport(durable.transport)) {
    throw requestError(409, 'unsupported_retry_transport', `Run ${stringValue(durable.runId)} uses ${stringValue(durable.transport) || 'unknown'} transport; retry supports Netlify API runs only.`)
  }
  const target = retryTarget(durable, body)
  const durableOptions = objectValue(durable.options)
  const netlify = resolveNetlifyProjectTarget({
    projectRoot,
    siteId: stringValue(durableOptions.netlifySiteId || durableOptions.siteId),
    filter: stringValue(durableOptions.filter),
    netlifyConfig: stringValue(durableOptions.netlifyConfig),
    env,
  })
  const resolvedOptions = netlifyOptionsFromTarget(durableOptions, netlify)
  durable.options = {
    ...durableOptions,
    ...(resolvedOptions.filter ? { filter: resolvedOptions.filter } : {}),
    ...(resolvedOptions.netlifyConfig ? { netlifyConfig: resolvedOptions.netlifyConfig } : {}),
    ...(resolvedOptions.netlifySiteId ? { netlifySiteId: resolvedOptions.netlifySiteId } : {}),
    ...(resolvedOptions.netlifySiteSource ? { netlifySiteSource: resolvedOptions.netlifySiteSource } : {}),
  }
  const replacement = retryReplacementRun(target.run, {
    requestedAt: new Date().toISOString(),
    reason: stringValue(body.reason).trim() || 'dashboard retry',
  }, {
    pending: true,
  })
  replacement.status = 'retrying'
  replacement.runnerId = `pending-retry-${replacement.raw.dashboardRetry.requestedAt.replace(/[^0-9A-Za-z]+/g, '-')}-${target.agent}`
  target.step.runs[target.runIndex] = replacement
  target.step.status = 'running'
  durable.status = 'running'
  saveRunState(durable)
  const submitCandidate = {
    ...replacement,
    status: 'pending',
    runnerId: '',
    raw: {
      ...replacement.raw,
      dashboardRetry: {
        ...objectValue(objectValue(replacement.raw).dashboardRetry),
        pending: false,
      },
    },
  }
  let submitted
  try {
    submitted = await submitRun({
      run: submitCandidate,
      projectRoot,
      branch: targetBranch(durable, { required: true }),
      siteId: netlify.siteId,
      netlifyFilter: netlify.netlifyFilter.filter,
      env: netlify.env,
    })
  } catch (error) {
    target.step.runs[target.runIndex] = {
      ...replacement,
      status: 'failed',
      resultText: error?.message || String(error || 'Retry submission failed'),
      raw: {
        ...replacement.raw,
        dashboardRetry: {
          ...objectValue(objectValue(replacement.raw).dashboardRetry),
          pending: false,
          submissionError: error?.message || String(error || 'Retry submission failed'),
        },
      },
    }
    saveRunState(durable)
    throw error
  }
  addLocalRunLinks(submitted, projectRoot, /** @type {import('../../types').JsonMap} */ (objectValue(durable.options)))
  target.step.runs[target.runIndex] = submitted
  target.step.status = 'running'
  durable.status = 'running'
  const saved = saveRunState(durable)
  return {
    run: publicRunState(saved),
    retried: true,
    stepId: target.stepId,
    agent: target.agent,
    previousRunnerId: stringValue(target.run.runnerId),
    runnerId: stringValue(submitted.runnerId),
    sessionId: stringValue(submitted.sessionId),
  }
}

/** @param {SubmitFollowupInput} input */
async function submitFollowup({
  projectRoot,
  sourceRunId,
  durable,
  body = {},
  env,
  followupSiteId,
  followupSiteName,
  followupNetlifyFilter,
  followupSubmitRun,
  writeBlob,
  normalizeFollowupRequest,
  makeBlobWriter,
  setBlobCommand,
  linkSubmittedRun,
  followupId,
  freshFollowupTitle,
  submissionResponseItem,
}) {
  const details = buildRunDetails(durable)
  const normalized = normalizeFollowupRequest(body, details, durable)
  const durableOptions = objectValue(durable.options)
  const durableSteps = Array.isArray(durable.steps) ? /** @type {Array<Record<string, unknown>>} */ (durable.steps) : []
  const sourceWorkflowRunId = stringValue(durable.runId || sourceRunId)
  const contextPackage = buildFollowupContextPackage({
    projectRoot,
    details,
    artifacts: normalized.artifacts,
  })
  const delivery = await prepareFollowupContextDelivery({
    contextPackage,
    runId: sourceWorkflowRunId,
    stepId: 'dashboard-followup',
    options: durableOptions,
    writeBlob: makeBlobWriter({
      projectRoot,
      siteId: followupSiteId,
      env,
      writeBlob,
      setBlobCommand,
    }),
  })
  const sourceArtifactIds = contextPackage.artifacts.map((artifact) => artifact.id)
  const plan = buildFollowupSubmissionPlan({
    requestedMode: normalized.mode,
    target: normalized.target,
    models: normalized.models,
    fallbackModels: normalizeAgentList(
      durableOptions.models ||
      durableSteps.flatMap((step) => Array.isArray(step.agents) ? step.agents : []) ||
      ['codex']
    ),
    sourceArtifactIds,
    targetSha: normalized.targetSha,
    targetBranch: normalized.targetBranch,
  })
  const promptText = buildFollowupPrompt({
    instructions: normalized.prompt,
    contextText: delivery.promptContext,
  })
  const id = followupId(sourceWorkflowRunId)
  const results = await submitFollowupPlan({
    projectRoot,
    promptText,
    submissions: plan.submissions,
    shared: {
      branch: normalized.targetBranch,
      siteId: followupSiteId,
      netlifyFilter: followupNetlifyFilter,
      env,
      submitRun: followupSubmitRun,
      linkRun: linkSubmittedRun({ siteName: followupSiteName }),
      source: {
        id,
        sourceWorkflowRunId,
        sourceTargetId: normalized.target.id,
        sourceArtifactIds,
      },
      raw: {
        dashboardFollowup: {
          id,
          sourceWorkflowRunId,
          targetId: normalized.target.id,
          delivery: delivery.delivery,
        },
      },
    },
  })
  const warnings = results.flatMap((result) => result.warnings || [])
  const freshResults = results
    .filter((result) => result.submission?.mode === 'fresh-runner')
    .map((result) => result.run)
  let persistedSourceWorkflow = null
  try {
    persistedSourceWorkflow = appendFollowupRunsToWorkflow({
      runState: durable,
      runs: results.map((result) => result.run),
      promptText,
      target: normalized.target,
      source: {
        id,
        sourceWorkflowRunId,
        sourceTargetId: normalized.target.id,
        sourceArtifactIds,
        delivery: delivery.delivery,
      },
    })
  } catch (error) {
    warnings.push(error?.message || String(error))
  }
  let persistedWorkflow = null
  if (freshResults.length > 0) {
    try {
      persistedWorkflow = persistFreshPseudoWorkflow({
        projectRoot,
        runs: freshResults,
        promptText,
        target: {
          sha: normalized.targetSha,
          branch: normalized.targetBranch,
          sourceType: 'dashboard-followup',
        },
        source: {
          id,
          sourceWorkflowRunId,
          sourceTargetId: normalized.target.id,
          sourceArtifactIds,
        },
        title: freshFollowupTitle(durable, normalized.target, freshResults),
        stepTitle: freshResults.length === 1
          ? `${titleCaseAgent(freshResults[0].agent)} follow-up`
          : 'Multi-agent follow-up',
      })
    } catch (error) {
      warnings.push(error?.message || String(error))
    }
  }

  return {
    id,
    status: 'submitted',
    sourceWorkflowRunId,
    target: normalized.target,
    context: {
      artifactCount: contextPackage.artifactCount,
      artifacts: contextPackage.artifacts,
      delivery: delivery.delivery,
      bytes: delivery.bytes,
      blobRef: delivery.blobRef || null,
    },
    plan,
    submissions: results.map(submissionResponseItem),
    sourceWorkflow: persistedSourceWorkflow ? publicRunState(persistedSourceWorkflow) : null,
    persistedWorkflow: persistedWorkflow ? publicRunState(persistedWorkflow) : null,
    warnings,
  }
}

/**
 * @param {{
 *   projectRoot: string,
 *   durable: Record<string, unknown>,
 *   body?: Record<string, unknown>,
 *   env: NodeJS.ProcessEnv,
 *   stopRun: Function,
 * }} input
 */
async function cancelFollowup({ projectRoot, durable, body = {}, env, stopRun }) {
  const runnerId = String(body.runnerId || '').trim()
  const sessionId = String(body.sessionId || '').trim()
  if (!runnerId && !sessionId) {
    throw requestError(400, 'missing_followup_run', 'Select a follow-up runner or session to cancel.')
  }
  const warnings = []
  const result = cancelFollowupRunInWorkflow({
    runState: durable,
    stepId: String(body.stepId || '').trim(),
    runnerId,
    sessionId,
    agent: String(body.agent || '').trim(),
  })
  let remoteStopped = false
  if (result.changed && runnerId && !result.run?.existingRunnerId) {
    const stopped = await stopRun({
      projectRoot,
      runnerId,
      env,
    })
    remoteStopped = stopped.stopped === true
    if (!remoteStopped && stopped.error) warnings.push(stopped.error)
  }
  return {
    run: publicRunState(result.runState),
    cancelled: result.changed,
    remoteStopped,
    warnings,
  }
}

/**
 * @param {{
 *   run?: Record<string, unknown> | null,
 *   durable?: Record<string, unknown> | null,
 *   projectRoot: string,
 *   env: NodeJS.ProcessEnv,
 *   stopWorkflowRunners: Function,
 *   stopRun: Function,
 *   applyRemoteCancelToWorkflow: Function,
 *   recordEvent: Function,
 *   recordCancelSemantics: Function,
 *   publicRun: Function,
 * }} input
 */
async function cancelRun({
  run,
  durable,
  projectRoot,
  env,
  stopWorkflowRunners,
  stopRun,
  applyRemoteCancelToWorkflow,
  recordEvent,
  recordCancelSemantics,
  publicRun,
}) {
  const remoteCancel = durable
    ? await stopWorkflowRunners({
        runState: durable,
        projectRoot,
        env,
        stopRun,
      })
    : { runnerIds: [], stopped: [], warnings: [] }
  if (durable) applyRemoteCancelToWorkflow(durable, remoteCancel, { reason: 'cancelled from dashboard' })
  if (!run) {
    return {
      run: publicRunState(durable),
      cancelled: Boolean(durable?.status === 'cancelled' || remoteCancel.stopped.length > 0),
      remoteStopped: remoteCancel.stopped.length,
      remoteStopAttempted: remoteCancel.runnerIds.length,
      warnings: remoteCancel.warnings,
    }
  }
  if (remoteCancel.runnerIds.length > 0) {
    recordEvent(run, 'remote_cancel_requested', {
      runnerIds: remoteCancel.runnerIds,
      stoppedRunnerIds: remoteCancel.stopped,
      warnings: remoteCancel.warnings,
    })
  }
  const canCancelLive = run.status === 'running' && run.cancellable
  const localCancelled = canCancelLive && typeof run.cancel === 'function' ? Boolean(run.cancel()) : false
  run.cancelRequested = localCancelled || remoteCancel.stopped.length > 0
  run.cancellable = canCancelLive ? !localCancelled : false
  recordEvent(run, 'cancel_requested', {
    remoteStopped: remoteCancel.stopped.length,
    remoteStopAttempted: remoteCancel.runnerIds.length,
  })
  if (localCancelled) recordCancelSemantics(run)
  return {
    run: publicRun(run),
    cancelled: localCancelled || Boolean(durable?.status === 'cancelled') || remoteCancel.stopped.length > 0,
    remoteStopped: remoteCancel.stopped.length,
    remoteStopAttempted: remoteCancel.runnerIds.length,
    warnings: remoteCancel.warnings,
  }
}

function titleCaseAgent(agent = '') {
  const value = String(agent || '').trim()
  if (!value) return 'Agent'
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

module.exports = {
  cancelFollowup,
  cancelReviewGate,
  cancelRun,
  retryAgentRun,
  submitFollowup,
}
