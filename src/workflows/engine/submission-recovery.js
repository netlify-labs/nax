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
 * True for a run that tried to submit and has no runner: either the send may have landed
 * (pending after send, ambiguous create) or it failed during submit after the checkpoint.
 * @param {import('../../types').AgentRun} run
 */
function needsRecovery(run) {
  if (run.runnerId || !rawOf(run).submitCheckpoint) return false
  const failedAtSubmit = String(run.status || '') === 'failed' && rawOf(run).failurePhase === 'submit'
  return maybeCreatedSubmission(run) || failedAtSubmit
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
    if (!needsRecovery(run)) continue
    const raw = rawOf(run)
    const checkpoint = /** @type {import('nax-agent-runner-sdk').SubmitCheckpoint} */ (raw.submitCheckpoint)
    const window = /** @type {import('nax-agent-runner-sdk').RequestWindow} */ (raw.submitWindow || { sentAt: checkpoint.sentAt, failedAt: now() })
    const sourceRun = checkpoint.kind === 'session'
      ? [...sourceStates.values()].flatMap((step) => step.runs || []).find((candidate) => candidate.runnerId === checkpoint.runnerId && candidate.sdkHandle)
      : null
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
        const { submissionError: _error, submissionErrorCode: _code, failurePhase: _phase, ...kept } = raw
        stepState.runs[index] = {
          ...run,
          status: 'submitted',
          resultText: '',
          runnerId: result.handle.runnerId,
          sessionId: result.handle.currentSessionId,
          sdkHandle: result.handle,
          raw: { ...kept, submitReconcile: { kind: 'matched' } },
        }
        notes.push(`${instanceId}: found runner ${result.handle.runnerId} from the saved submission; polling it instead of resubmitting`)
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
