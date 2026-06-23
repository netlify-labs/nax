const { resumeWorkflow, runWorkflow } = require('../../workflows/engine/runner')

/**
 * @typedef {(event: Record<string, unknown>) => void} DashboardEventSink
 *
 * @typedef {{
 *   runWorkflow?: typeof runWorkflow,
 *   resumeWorkflow?: typeof resumeWorkflow,
 * }} LocalInProcessDeps
 *
 * @typedef {{
 *   flowId: string,
 *   projectRoot: string,
 *   options?: object,
 *   tailOutput?: boolean,
 *   deps?: LocalInProcessDeps,
 * }} DryRunWorkflowInput
 *
 * @typedef {{
 *   runId: string,
 *   projectRoot: string,
 *   stepId?: string,
 *   tailOutput?: boolean,
 *   eventSink?: DashboardEventSink,
 *   deps?: LocalInProcessDeps,
 * }} ResumeWorkflowRunInput
 */

/** @param {DryRunWorkflowInput} input */
function dryRunWorkflow({ flowId, projectRoot, options = {}, tailOutput = false, deps = {} }) {
  const runWorkflowCommand = deps.runWorkflow || runWorkflow
  return runWorkflowCommand({
    flowId,
    projectRoot,
    options: /** @type {import('../../workflows/engine/runner').WorkflowCommandOptions} */ (options),
    dryRun: true,
    passthrough: tailOutput,
  })
}

/** @param {ResumeWorkflowRunInput} input */
function resumeWorkflowRun({ runId, projectRoot, stepId = '', tailOutput = false, eventSink = () => {}, deps = {} }) {
  const resumeWorkflowCommand = deps.resumeWorkflow || resumeWorkflow
  return resumeWorkflowCommand({
    runId,
    projectRoot,
    options: { projectRoot, stepId, reviewer: 'dashboard', yes: true, force: true },
    passthrough: tailOutput,
    eventSink,
  })
}

module.exports = {
  dryRunWorkflow,
  resumeWorkflowRun,
}
