// Implements `nax run --resume <run-id>`: preview the per-instance reconciliation, confirm, then
// resume the run in place, resubmitting only the agent instances that did not finish.
const { formatResumePreview } = require('../../workflows/engine/resume')
const { isResumeRefusal, prepareResume } = require('../../workflows/engine/resume-preparation')
const { resumeLocalFlow } = require('../../workflows/engine/local-executor')
const { listRunStates } = require('../../storage/local/run-state')

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
  resolveRemoteSha,
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
  const force = options.force === true
  const includeCancelled = options.includeCancelled === true
  /** @type {import('../../workflows/engine/resume-preparation').PreparedResume} */
  let prepared
  try {
    prepared = await prepareResume({
      runState,
      projectRoot,
      options: /** @type {import('../../types').JsonMap} */ (options),
      includeCancelled,
      force,
      ...(resolveRemoteSha ? { resolveRemoteSha } : {}),
    })
  } catch (error) {
    if (!isResumeRefusal(error)) throw error
    return fail(/** @type {Error} */ (error).message)
  }
  stdout(formatResumePreview(prepared.preview))
  if (prepared.blocked) return fail(`Cannot resume (${prepared.blocked.code}): ${prepared.blocked.message}`)
  if (options.dry) return 0
  if (!force) {
    if (!isTTY) return fail('nax run --resume needs confirmation. Re-run with --force to resume without a prompt, or --dry to only preview.')
    if (!await confirm(`Resume ${runId}?`)) return fail('Cancelled.')
  }
  const { currentSha } = prepared
  await resume({
    flow: prepared.flow,
    runState,
    projectRoot,
    currentFlowDigest: prepared.currentFlowDigest,
    includeCancelled,
    force,
    forceUnlock: options.forceUnlock === true,
    ...(currentSha ? { resolveRemoteSha: () => currentSha } : {}),
  })
  return 0
}

module.exports = {
  handleResumeCommand,
}
