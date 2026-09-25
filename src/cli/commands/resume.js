// Implements `nax run --resume <run-id>`: preview the per-instance reconciliation, confirm, then
// resume the run in place, resubmitting only the agent instances that did not finish.
const { loadFlow } = require('../../workflows/catalog/flows')
const { flowDigest } = require('../../workflows/catalog/flow-manifest')
const { flowFromRunState, flowLoadOptions, formatResumePreview, planResume, resumeSubmitsIntoStep } = require('../../workflows/engine/resume')
const { resumeLocalFlow } = require('../../workflows/engine/local-executor')
const { isExplicitlyResumableRun, isNetlifyApiTransport } = require('../../core/runs/resumable')
const { listRunStates } = require('../../storage/local/run-state')
const { targetBranch } = require('../../integrations/git/target')
const { resolveRemoteBranchSha } = require('../../integrations/git/review-context')

/**
 * @typedef {{
 *   projectRoot: string,
 *   dry?: boolean,
 *   force?: boolean,
 *   includeCancelled?: boolean,
 *   forceUnlock?: boolean,
 *   flowsDir?: string,
 *   flowsDirs?: string[] | string,
 * }} ResumeCommandOptions
 * @typedef {{
 *   stdout?: (text: string) => void,
 *   stderr?: (text: string) => void,
 *   isTTY?: boolean,
 *   confirm?: (message: string) => Promise<boolean>,
 *   resolveRemoteSha?: (input: { projectRoot: string, branch: string }) => string,
 *   resume?: typeof resumeLocalFlow,
 * }} ResumeCommandDependencies
 */

async function clackConfirm(/** @type {string} */ message) {
  const clack = await import('@clack/prompts')
  const confirmed = await clack.confirm({ message, initialValue: true })
  return !clack.isCancel(confirmed) && confirmed === true
}

/** @param {{ projectRoot: string, branch: string }} input @returns {string} */
function remoteBranchSha({ projectRoot, branch }) {
  return resolveRemoteBranchSha({ repoRoot: projectRoot, branch }).sha
}

/**
 * Plans a resume and renders its preview, including whether the branch head moved since the run
 * started. Shared by `nax run --resume` and the TTY resume offer.
 * @param {{
 *   runState: import('../../types').WorkflowRunState,
 *   flow: import('../../types').WorkflowFlow,
 *   projectRoot: string,
 *   currentFlowDigest?: string,
 *   includeCancelled?: boolean,
 *   force?: boolean,
 *   resolveRemoteSha?: (input: { projectRoot: string, branch: string }) => string,
 * }} input
 * @returns {{ plan: import('../../workflows/engine/resume').ResumePlan, text: string, currentSha: string }}
 */
function resumePreview({ runState, flow, projectRoot, currentFlowDigest = '', includeCancelled = false, force = false, resolveRemoteSha = remoteBranchSha }) {
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
  return { plan, text: formatResumePreview({ runState, flow, plan, branch, currentSha }), currentSha }
}

/**
 * Loads the catalog version of the run's flow so edits since the run started are detected.
 * @param {import('../../types').WorkflowRunState} runState
 * @param {ResumeCommandOptions} options
 * @returns {Promise<import('../../types').WorkflowFlow | null>}
 */
async function catalogFlow(runState, options) {
  try {
    return await loadFlow(String(runState.flowId || ''), flowLoadOptions({ ...(runState.options || {}), ...options }, options.projectRoot))
  } catch (_error) {
    return null
  }
}

/**
 * Handler for `nax run --resume <run-id>`.
 * @param {string} runId
 * @param {ResumeCommandOptions} options
 * @param {ResumeCommandDependencies} [deps]
 * @returns {Promise<number>} exit code
 */
async function handleResumeCommand(runId, options, {
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm = clackConfirm,
  resolveRemoteSha = remoteBranchSha,
  resume = resumeLocalFlow,
} = {}) {
  const fail = (/** @type {string} */ message) => {
    stderr(message)
    process.exitCode = 1
    return 1
  }
  const { projectRoot } = options
  const runState = listRunStates(projectRoot).find((state) => state.runId === runId)
  if (!runState) return fail(`Could not find workflow run "${runId}". List runs with: nax handoff`)
  if (!isNetlifyApiTransport(runState.transport)) {
    return fail(`Run ${runId} uses the ${runState.transport || 'unknown'} transport: mid-step resume supports netlify-api runs; GitHub runs resume at step level (run \`nax run\` in a terminal and accept the resume offer).`)
  }
  if (!isExplicitlyResumableRun(runState)) return fail(`Run ${runId} is ${runState.status || 'finished'}; nothing to resume.`)

  const embedded = flowFromRunState(runState)
  const catalog = await catalogFlow(runState, options)
  const flow = embedded || catalog
  if (!flow) return fail(`Workflow "${runState.flowId}" for run ${runId} is no longer available.`)
  const currentFlowDigest = catalog ? flowDigest(catalog) : (runState.flowDigest ? flowDigest(flow) : '')
  const force = options.force === true
  const includeCancelled = options.includeCancelled === true
  const { plan, text, currentSha } = resumePreview({ runState, flow, projectRoot, currentFlowDigest, includeCancelled, force, resolveRemoteSha })
  stdout(text)
  const stop = plan.reconciled.stop
  if (stop) return fail(`Cannot resume (${stop.code}): ${stop.message}`)
  const runSha = String(runState.target?.sha || '')
  if (!force && currentSha && runSha && currentSha !== runSha && resumeSubmitsIntoStep(plan)) {
    return fail(`Cannot resume (branch_moved_since_run): the branch moved since run ${runId} started. Re-run with --force to resume anyway, or start a new run.`)
  }
  if (options.dry) return 0
  if (!force) {
    if (!isTTY) return fail('nax run --resume needs confirmation. Re-run with --force to resume without a prompt, or --dry to only preview.')
    if (!await confirm(`Resume ${runId}?`)) return fail('Cancelled.')
  }
  await resume({
    flow,
    runState,
    projectRoot,
    currentFlowDigest,
    includeCancelled,
    force,
    forceUnlock: options.forceUnlock === true,
    ...(currentSha ? { resolveRemoteSha: () => currentSha } : {}),
  })
  return 0
}

module.exports = {
  handleResumeCommand,
  resumePreview,
}
