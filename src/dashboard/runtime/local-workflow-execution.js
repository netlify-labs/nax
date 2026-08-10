const { isUnfinishedRun, listRunStates } = require('../../storage/local/run-state')
const { submitAdHocAgentRun } = require('../services/mutations')
const { publicRunState } = require('../api/serializers')

/** @typedef {import('../../contracts').ControlPlaneAgentInstanceInput} ControlPlaneAgentInstanceInput */
/** @typedef {import('../../contracts').ControlPlaneJsonObject} ControlPlaneJsonObject */
/** @typedef {import('../../contracts').ControlPlaneRunSummary} ControlPlaneRunSummary */
/** @typedef {import('../../contracts').ControlPlaneStartResult} ControlPlaneStartResult */
/** @typedef {import('../../contracts').StoredControlPlanePlan} StoredControlPlanePlan */
/** @typedef {import('../../contracts').WorkflowExecutionBackend} WorkflowExecutionBackend */

const ACTIVE_WORKFLOW_STATUSES = new Set(['awaiting_review', 'interrupted', 'pending', 'running', 'starting', 'submitted', 'submitting', 'waiting'])

/**
 * @typedef {{
 *   projectRoot: string,
 *   env?: NodeJS.ProcessEnv,
 *   netlifyFilter?: string,
 *   submitRun?: import('../../workflows/followups/runner').HandoffSubmitRun,
 *   linkSubmittedRun?: (input: { siteName: string }) => (run?: Record<string, unknown>) => Record<string, unknown>,
 *   runWorkflowEngine?: (flowId: string, options: import('../../types').JsonMap) => Promise<unknown>,
 *   submitAgentRun?: (input: Parameters<typeof submitAdHocAgentRun>[0]) => Promise<{ run: Record<string, unknown> }>,
 *   listRuns?: (projectRoot: string) => Array<Record<string, unknown>>,
 *   startupTimeoutMs?: number,
 * }} LocalWorkflowExecutionOptions
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** @param {StoredControlPlanePlan} plan */
function planOrigin(plan) {
  return {
    source: 'mcp',
    planId: plan.planId,
    requestId: plan.requestId || '',
    expectedAgentRuns: plan.expectedAgentRuns,
  }
}

/** @param {StoredControlPlanePlan} plan */
function plannedLineups(plan) {
  return Object.fromEntries(plan.steps
    .filter((step) => !step.reviewGate && step.submit !== 'follow-up')
    .map((step) => [step.stepId, step.instances.map((instance) => ({
      agent: instance.agent,
      ...(instance.model ? { model: instance.model } : {}),
      ...(instance.effort ? { effort: instance.effort } : {}),
      ...(instance.label ? { label: instance.label } : {}),
    }))]))
}

/** @param {StoredControlPlanePlan} plan */
function assertExpectedSubmissions(plan) {
  const expected = plan.steps.reduce((total, step) => total + step.instances.length, 0)
  if (expected !== plan.expectedAgentRuns) {
    throw Object.assign(new Error(`Run plan expected ${plan.expectedAgentRuns} Agent Runner submissions but its immutable steps contain ${expected}.`), {
      code: 'invalid_plan_state',
      recoverable: false,
      details: { mutationTransmitted: false, expectedAgentRuns: plan.expectedAgentRuns, actualAgentRuns: expected },
    })
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {StoredControlPlanePlan} plan
 * @returns {ControlPlaneRunSummary}
 */
function controlPlaneRunSummary(value, plan) {
  const run = objectValue(value)
  const runId = stringValue(run.runId || run.id)
  return {
    runId,
    ...(plan.workflowId ? { workflowId: plan.workflowId } : { workflowId: stringValue(run.flowId || 'agent-run') }),
    ...(run.flowTitle || run.title ? { title: stringValue(run.flowTitle || run.title) } : {}),
    source: 'mcp',
    status: stringValue(run.status || 'running'),
    branch: plan.target.branch,
    target: { ...plan.target, caveats: [...(plan.target.caveats || [])] },
    ...(run.createdAt || run.startedAt ? { createdAt: stringValue(run.createdAt || run.startedAt) } : {}),
    ...(run.updatedAt ? { updatedAt: stringValue(run.updatedAt) } : {}),
    ...(typeof run.cancellable === 'boolean' ? { cancellable: run.cancellable } : {}),
  }
}

/** @param {Record<string, unknown>} state @param {StoredControlPlanePlan} plan */
function stateBelongsToPlan(state, plan) {
  const source = objectValue(state.source)
  const controlPlane = objectValue(state.options).controlPlane
  return stringValue(source.planId || objectValue(controlPlane).planId) === plan.planId
}

/** @param {Record<string, unknown>} state */
function activeWorkflowState(state) {
  return ACTIVE_WORKFLOW_STATUSES.has(stringValue(state.status).toLowerCase()) || isUnfinishedRun(state)
}

/**
 * @param {LocalWorkflowExecutionOptions} options
 * @returns {WorkflowExecutionBackend}
 */
function createLocalWorkflowExecutionBackend({
  projectRoot,
  env = process.env,
  netlifyFilter = '',
  submitRun,
  linkSubmittedRun = () => (run = {}) => run,
  runWorkflowEngine,
  submitAgentRun = submitAdHocAgentRun,
  listRuns = listRunStates,
  startupTimeoutMs = 30_000,
}) {
  if (!projectRoot) throw new TypeError('Local workflow execution requires a project root.')
  const startingWorkflowIds = new Set()

  /** @returns {(flowId: string, options: import('../../types').JsonMap) => Promise<unknown>} */
  function workflowEngine() {
    if (runWorkflowEngine) return runWorkflowEngine
    const engine = require('../../cli/main').handleRunEngine
    if (typeof engine !== 'function') throw new Error('The in-process workflow engine is unavailable.')
    return engine
  }

  /** @param {StoredControlPlanePlan} plan @returns {Promise<ControlPlaneStartResult>} */
  async function startWorkflowPlan(plan) {
    if (!plan.workflowId) {
      throw Object.assign(new Error('Workflow plan is missing its workflow ID.'), {
        code: 'invalid_plan_state',
        details: { mutationTransmitted: false },
      })
    }
    const active = listRuns(projectRoot).find((state) => stringValue(state.flowId) === plan.workflowId && activeWorkflowState(state))
    if (startingWorkflowIds.has(plan.workflowId) || active) {
      throw Object.assign(new Error(`Workflow "${plan.workflowId}" already has an active run.`), {
        code: 'duplicate_run',
        recoverable: true,
        details: { mutationTransmitted: false, existingRunId: stringValue(active?.runId) },
      })
    }
    startingWorkflowIds.add(plan.workflowId)
    const origin = planOrigin(plan)
    /** @type {(value: ControlPlaneRunSummary) => void} */
    let resolveStarted = () => {}
    /** @type {(reason: Error) => void} */
    let rejectStarted = () => {}
    let started = false
    const startup = new Promise((resolve, reject) => {
      resolveStarted = resolve
      rejectStarted = reject
    })
    const timer = setTimeout(() => {
      if (started) return
      rejectStarted(Object.assign(new Error(`Workflow "${plan.workflowId}" did not produce a durable run ID within ${startupTimeoutMs}ms.`), {
        code: 'run_start_timeout',
        recoverable: true,
        details: { ambiguous: true },
      }))
    }, startupTimeoutMs)
    timer.unref?.()

    const execution = Promise.resolve().then(() => workflowEngine()(plan.workflowId || '', {
      projectRoot,
      yes: true,
      force: true,
      transport: 'netlify-api',
      branch: plan.target.branch,
      siteId: plan.target.siteId,
      netlifySiteId: plan.target.siteId,
      ...(netlifyFilter ? { filter: netlifyFilter } : {}),
      ...(typeof plan.normalizedInput.context === 'string' ? { context: plan.normalizedInput.context } : {}),
      ...(typeof plan.normalizedInput.onlyStep === 'string' ? { step: plan.normalizedInput.onlyStep } : {}),
      ...(typeof plan.normalizedInput.fromStep === 'string' ? { fromStep: plan.normalizedInput.fromStep } : {}),
      controlPlane: origin,
      controlPlaneTarget: { ...plan.target, caveats: [...(plan.target.caveats || [])] },
      controlPlaneLineups: plannedLineups(plan),
      controlPlaneSelectedSteps: plan.steps.map((step) => step.stepId),
      runnerEventSink: (event) => {
        if (started || stringValue(event.type) !== 'workflow_started' || !stringValue(event.runId)) return
        started = true
        clearTimeout(timer)
        startingWorkflowIds.delete(plan.workflowId || '')
        resolveStarted(controlPlaneRunSummary(event, plan))
      },
    }))
    execution.then(() => {
      if (started) return
      clearTimeout(timer)
      startingWorkflowIds.delete(plan.workflowId || '')
      rejectStarted(Object.assign(new Error(`Workflow "${plan.workflowId}" exited before producing a durable run ID.`), {
        code: 'run_binding_missing',
        recoverable: true,
        details: { mutationTransmitted: false },
      }))
    }, () => {})
    execution.catch((error) => {
      if (started) return
      clearTimeout(timer)
      startingWorkflowIds.delete(plan.workflowId || '')
      const failure = error instanceof Error ? error : new Error(String(error))
      Object.assign(failure, {
        code: objectValue(error).code || 'run_start_failed',
        details: { ...objectValue(objectValue(error).details), mutationTransmitted: false },
      })
      rejectStarted(failure)
    })
    const run = await startup
    return { run, accepted: true, replayed: false }
  }

  /** @param {StoredControlPlanePlan} plan @returns {Promise<ControlPlaneStartResult>} */
  async function startAgentPlan(plan) {
    const input = objectValue(plan.normalizedInput)
    const instance = /** @type {ControlPlaneAgentInstanceInput} */ (objectValue(input.instance))
    const origin = planOrigin(plan)
    const result = await submitAgentRun({
      projectRoot,
      body: {
        prompt: stringValue(input.prompt),
        agent: instance.agent,
        transport: 'netlify-api',
        branch: plan.target.branch,
        ...(instance.model ? { models: { [instance.agent]: instance.model } } : {}),
        ...(instance.effort ? { efforts: { [instance.agent]: instance.effort } } : {}),
      },
      env,
      siteId: plan.target.siteId,
      siteName: plan.target.siteName,
      netlifyFilter,
      submitRun,
      linkSubmittedRun,
      target: { ...plan.target, caveats: [...(plan.target.caveats || [])], sourceType: 'mcp' },
      source: {
        id: `mcp-${plan.planId}`,
        type: 'mcp',
        mode: 'fresh-runner',
        ...origin,
        controlPlane: origin,
      },
    })
    return {
      run: controlPlaneRunSummary(objectValue(result.run), plan),
      accepted: true,
      replayed: false,
    }
  }

  return {
    async startPlan(plan) {
      assertExpectedSubmissions(plan)
      return plan.kind === 'workflow' ? startWorkflowPlan(plan) : startAgentPlan(plan)
    },
    async reconcilePlan(plan) {
      const state = listRuns(projectRoot).find((candidate) => (
        (plan.runId && stringValue(candidate.runId) === plan.runId) || stateBelongsToPlan(candidate, plan)
      ))
      if (!state) return null
      const run = controlPlaneRunSummary(publicRunState(state), plan)
      if (!run.runId) return null
      return { run, accepted: false, replayed: true }
    },
  }
}

module.exports = {
  assertExpectedSubmissions,
  activeWorkflowState,
  controlPlaneRunSummary,
  createLocalWorkflowExecutionBackend,
  planOrigin,
  plannedLineups,
  stateBelongsToPlan,
}
