// Recovers submissions whose response was lost before resume plans the step: each run with a saved
// submit checkpoint and no runner id is reconciled against the Agent Runner API by request marker.
const { completedStepMapFromRunState, firstRunnableStepIndex } = require('./execution-context')
const { reconcileLocalSubmission } = require('../../integrations/netlify/local-runner')
const { maybeCreatedSubmission } = require('./resume')

/**
 * @typedef {(input: {
 *   checkpoint: import('nax-agent-runner-sdk').SubmitCheckpoint,
 *   window: import('nax-agent-runner-sdk').RequestWindow,
 *   sourceHandle?: import('nax-agent-runner-sdk').Handle,
 *   siteId?: string,
 * }) => Promise<import('nax-agent-runner-sdk').ReconciliationResult<import('nax-agent-runner-sdk').Handle>>} ReconcileSubmission
 */

/** @param {import('../../types').AgentRun} run @returns {Record<string, unknown>} */
function rawOf(run) {
  return /** @type {Record<string, unknown>} */ (run.raw || {})
}

/**
 * The saved request to reconcile, if any: an automatic retry that may have created a replacement
 * runner or session, or a first submission with no runner that may have landed or failed during
 * submit after its checkpoint.
 * @param {import('../../types').AgentRun} run
 * @returns {import('nax-agent-runner-sdk').SubmitCheckpoint | null}
 */
function checkpointToRecover(run) {
  const raw = rawOf(run)
  if (raw.retrySubmitCheckpoint) return /** @type {import('nax-agent-runner-sdk').SubmitCheckpoint} */ (raw.retrySubmitCheckpoint)
  if (run.runnerId || !raw.submitCheckpoint) return null
  const failedAtSubmit = String(run.status || '') === 'failed' && raw.failurePhase === 'submit'
  return maybeCreatedSubmission(run) || failedAtSubmit ? /** @type {import('nax-agent-runner-sdk').SubmitCheckpoint} */ (raw.submitCheckpoint) : null
}

/**
 * Reconciles recoverable runs of the step resume would start at, in place. A matched runner is
 * adopted (the run becomes `submitted` so resume polls it); `none`, `ambiguous` and errors are
 * recorded in `raw.submitReconcile` for the reconcile table. Callers decide when to save.
 * @param {{
 *   flow: import('../../types').WorkflowFlow,
 *   runState: import('../../types').WorkflowRunState,
 *   reconcileSubmission?: ReconcileSubmission,
 *   now?: () => number,
 * }} input
 * @returns {Promise<{ notes: string[] }>}
 */
async function recoverSubmissions({ flow, runState, reconcileSubmission = reconcileLocalSubmission, now = Date.now }) {
  /** @type {string[]} */
  const notes = []
  const startIndex = firstRunnableStepIndex(flow, runState)
  const flowStep = flow.steps[startIndex]
  const stepState = flowStep ? (runState.steps || []).find((candidate) => candidate.id === flowStep.id) : null
  if (!stepState?.runs) return { notes }
  const sourceStates = completedStepMapFromRunState(runState)
  for (const [index, run] of stepState.runs.entries()) {
    const checkpoint = checkpointToRecover(run)
    if (!checkpoint) continue
    const raw = rawOf(run)
    const retry = Boolean(raw.retrySubmitCheckpoint)
    const window = /** @type {import('nax-agent-runner-sdk').RequestWindow} */ ((!retry && raw.submitWindow) || { sentAt: checkpoint.sentAt, failedAt: now() })
    // A follow-up continues its source runner; a retry session continues this run's own runner.
    const sourceRun = checkpoint.kind !== 'session'
      ? null
      : retry && run.sdkHandle
        ? run
        : [...sourceStates.values()].flatMap((step) => step.runs || []).find((candidate) => candidate.runnerId === checkpoint.runnerId && candidate.sdkHandle)
    const instanceId = String(run.instanceId || run.agent || '')
    const siteId = String(runState.options?.netlifySiteId || /** @type {{ siteId?: string }} */ (checkpoint.effectiveInput).siteId || '')
    try {
      const result = await reconcileSubmission({
        checkpoint,
        window,
        ...(sourceRun?.sdkHandle ? { sourceHandle: /** @type {import('nax-agent-runner-sdk').Handle} */ (sourceRun.sdkHandle) } : {}),
        ...(siteId ? { siteId } : {}),
      })
      if (result.kind === 'matched') {
        const { submissionError: _error, submissionErrorCode: _code, failurePhase: _phase, retrySubmitCheckpoint: _retry, ...kept } = raw
        stepState.runs[index] = {
          ...run,
          status: 'submitted',
          resultText: '',
          runnerId: result.handle.runnerId,
          sessionId: result.handle.currentSessionId,
          sdkHandle: result.handle,
          raw: { ...kept, submitReconcile: { kind: 'matched' } },
        }
        notes.push(`${instanceId}: found runner ${result.handle.runnerId} from the saved ${retry ? 'automatic retry' : 'submission'}; polling it instead of resubmitting`)
      } else if (result.kind === 'ambiguous') {
        run.raw = { ...raw, submitReconcile: { kind: 'ambiguous', candidates: result.candidates.map((candidate) => candidate.runnerId) } }
      } else {
        run.raw = { ...raw, submitReconcile: { kind: 'none' } }
      }
    } catch (error) {
      run.raw = { ...raw, submitReconcile: { kind: 'error', message: error instanceof Error ? error.message : String(error) } }
      notes.push(`${instanceId}: could not check for a runner from the saved submission (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { notes }
}

module.exports = {
  recoverSubmissions,
}
