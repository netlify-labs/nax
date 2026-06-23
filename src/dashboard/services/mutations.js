const { normalizeAgentList } = require('../../agent-selection')
const { buildFollowupContextPackage } = require('../../followup-context')
const { prepareFollowupContextDelivery } = require('../../followup-delivery')
const { buildFollowupSubmissionPlan } = require('../../followup-plan')
const { buildFollowupPrompt, submitFollowupPlan } = require('../../handoff-runner')
const { appendFollowupRunsToWorkflow, cancelFollowupRunInWorkflow, persistFreshPseudoWorkflow } = require('../../followup-persistence')
const { cancelHumanReviewGate } = require('../../human-review')
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
 *   followupSubmitRun?: import('../../handoff-runner').HandoffSubmitRun,
 *   writeBlob: FollowupBlobWriter | null,
 *   normalizeFollowupRequest: (body: Record<string, unknown>, details: object, durable: Record<string, unknown>) => FollowupRequest,
 *   makeBlobWriter: (input: { projectRoot: string, siteId: string, env: NodeJS.ProcessEnv, writeBlob?: FollowupBlobWriter | null, setBlobCommand?: typeof import('../../netlify/blobs').setBlob }) => FollowupBlobWriter | null,
 *   setBlobCommand?: typeof import('../../netlify/blobs').setBlob,
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
  submitFollowup,
}
