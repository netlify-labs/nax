// Prepares an explicit resume of a saved run: eligibility, the flow and its current digest, the
// per-instance plan and its preview. Shared by `nax run --resume`, the TTY offer and the dashboard.
const { loadFlow } = require('../catalog/flows')
const { flowDigest } = require('../catalog/flow-manifest')
const { flowFromRunState, flowLoadOptions, planResume, resumePreviewModel, resumeSubmitsIntoStep } = require('./resume')
const { isExplicitlyResumableRun, isNetlifyApiTransport } = require('../../core/runs/resumable')
const { targetBranch } = require('../../integrations/git/target')
const { resolveRemoteBranchSha } = require('../../integrations/git/review-context')

/**
 * @typedef {{
 *   flow: import('../../types').WorkflowFlow,
 *   currentFlowDigest: string,
 *   plan: import('./resume').ResumePlan,
 *   preview: import('./resume').ResumePreview,
 *   currentSha: string,
 *   blocked: { code: string, message: string } | null,
 * }} PreparedResume
 */

const RESUME_REFUSAL_CODES = new Set(['resume_unsupported_transport', 'not_resumable', 'workflow_unavailable'])

/** @param {string} code @param {string} message @returns {Error & { code: string }} */
function resumeRefusal(code, message) {
  return Object.assign(new Error(message), { code })
}

/** True for the coded errors prepareResume throws when a run cannot be resumed. @param {unknown} error */
function isResumeRefusal(error) {
  return RESUME_REFUSAL_CODES.has(String(/** @type {{ code?: unknown }} */ (error)?.code || ''))
}

/** @param {{ projectRoot: string, branch: string }} input @returns {string} */
function remoteBranchSha({ projectRoot, branch }) {
  return resolveRemoteBranchSha({ repoRoot: projectRoot, branch }).sha
}

/**
 * Loads the catalog version of the run's flow so edits since the run started are detected.
 * @param {import('../../types').WorkflowRunState} runState
 * @param {string} projectRoot
 * @param {import('../../types').JsonMap} options
 * @returns {Promise<import('../../types').WorkflowFlow | null>}
 */
async function catalogFlow(runState, projectRoot, options) {
  try {
    return await loadFlow(String(runState.flowId || ''), flowLoadOptions({ ...(runState.options || {}), ...options }, projectRoot))
  } catch (_error) {
    return null
  }
}

/**
 * Checks a run can be resumed explicitly (throwing a coded refusal otherwise), then plans it.
 * `blocked` is set when resume would stop before submitting anything: a reconcile stop, or a
 * moved branch head without `force`.
 * @param {{
 *   runState: import('../../types').WorkflowRunState,
 *   projectRoot: string,
 *   options?: import('../../types').JsonMap,
 *   includeCancelled?: boolean,
 *   force?: boolean,
 *   resolveRemoteSha?: (input: { projectRoot: string, branch: string }) => string,
 * }} input
 * @returns {Promise<PreparedResume>}
 */
async function prepareResume({ runState, projectRoot, options = {}, includeCancelled = false, force = false, resolveRemoteSha = remoteBranchSha }) {
  const runId = String(runState.runId || '')
  if (!isNetlifyApiTransport(runState.transport)) {
    throw resumeRefusal('resume_unsupported_transport', `Run ${runId} uses the ${runState.transport || 'unknown'} transport: mid-step resume supports netlify-api runs; GitHub runs resume at step level (run \`nax run\` in a terminal and accept the resume offer).`)
  }
  if (!isExplicitlyResumableRun(runState)) {
    throw resumeRefusal('not_resumable', `Run ${runId} is ${runState.status || 'finished'}; nothing to resume.`)
  }
  const catalog = await catalogFlow(runState, projectRoot, options)
  const flow = flowFromRunState(runState) || catalog
  if (!flow) throw resumeRefusal('workflow_unavailable', `Workflow "${runState.flowId}" for run ${runId} is no longer available.`)
  const currentFlowDigest = catalog ? flowDigest(catalog) : (runState.flowDigest ? flowDigest(flow) : '')
  const plan = planResume({ flow, runState, currentFlowDigest, includeCancelled, force })
  const branch = targetBranch(runState) || ''
  let currentSha = ''
  if (branch && runState.target?.sha) {
    try {
      currentSha = resolveRemoteSha({ projectRoot, branch })
    } catch (_error) {
      currentSha = ''
    }
  }
  const preview = resumePreviewModel({ runState, flow, plan, branch, currentSha })
  /** @type {{ code: string, message: string } | null} */
  let blocked = plan.reconciled.stop
  if (!blocked && !force && preview.headState === 'moved' && resumeSubmitsIntoStep(plan)) {
    blocked = { code: 'branch_moved_since_run', message: `The branch moved since run ${runId} started. Re-run with --force to resume anyway, or start a new run.` }
  }
  return { flow, currentFlowDigest, plan, preview, currentSha, blocked }
}

module.exports = {
  isResumeRefusal,
  prepareResume,
}
