const { eventLogPathForRunState } = require('./runner-event-log')
const { createRunnerEventEmitter } = require('./runner-events')
const { createNotificationDispatcher } = require('../../integrations/notifications')

/**
 * Sink called with each workflow event after emission.
 * @callback WorkflowEventSink
 * @param {import('../../types').JsonMap} event
 * @returns {void}
 */

/**
 * Workflow command options safe to include in emitted events.
 * @typedef {import('../../types').JsonMap & {
 *   branch?: string,
 *   branchSource?: string,
 *   target?: import('../../types').TargetLike | null,
 *   transport?: string,
 *   models?: unknown,
 *   stepModels?: unknown,
 *   context?: unknown,
 *   fromStep?: string,
 *   step?: string,
 * }} WorkflowSafeOptionInput
 *
 * Sanitized workflow command options included in event payloads.
 * @typedef {{
 *   branch: string,
 *   branchSource: string,
 *   target: import('../../types').TargetLike | null,
 *   transport: string,
 *   models: unknown,
 *   stepModels: unknown,
 *   context?: unknown,
 *   fromStep: string,
 *   step: string,
 * }} WorkflowSafeOptions
 *
 * Dependencies and sinks for a workflow event context.
 * @typedef {{
 *   sink?: WorkflowEventSink,
 *   notifications?: import('../../integrations/notifications').NotificationDispatcher,
 *   notify?: import('../../integrations/notifications').NotificationDispatcherOptions,
 *   emitter?: import('./runner-events').RunnerEventEmitter,
 *   env?: NodeJS.ProcessEnv,
 *   stream?: import('stream').Writable,
 *   fd?: number | string,
 *   now?: import('./runner-events').RunnerEventClock,
 *   onError?: import('./runner-events').RunnerEventErrorHandler,
 * }} WorkflowEventContextOptions
 *
 * Workflow event context returned to workflow runners.
 * @typedef {{
 *   readonly enabled: boolean,
 *   emit: (type: string, payload?: import('../../types').JsonMap) => import('../../types').JsonMap,
 *   setRunState: (nextRunState?: import('../../types').WorkflowRunState) => void,
 *   workflowStarted: (input?: WorkflowStartedInput) => import('../../types').JsonMap,
 *   workflowStatus: (status: string, payload?: import('../../types').JsonMap) => import('../../types').JsonMap,
 *   stepStatus: WorkflowStepStatusEmitter,
 *   agentStatus: WorkflowAgentStatusEmitter,
 *   artifactWritten: WorkflowArtifactEmitter,
 *   close: () => Promise<void>,
 * }} WorkflowEventContext
 */

/**
 * Agent run shape accepted by workflow event emitters.
 * @typedef {import('../../types').AgentRun & {
 *   attempt?: number,
 *   attempts?: number,
 * }} WorkflowEventAgentRun
 *
 * Workflow start command payload.
 * @typedef {{
 *   command?: string[],
 *   options?: WorkflowSafeOptionInput,
 * }} WorkflowStartedInput
 *
 * Emits a workflow step status event.
 * @callback WorkflowStepStatusEmitter
 * @param {string} status
 * @param {import('../../types').WorkflowStep} [stepState]
 * @param {import('../../types').WorkflowStep} [step]
 * @param {import('../../types').JsonMap} [payload]
 * @returns {import('../../types').JsonMap}
 *
 * Emits a workflow agent status event.
 * @callback WorkflowAgentStatusEmitter
 * @param {string} status
 * @param {WorkflowEventAgentRun} [run]
 * @param {import('../../types').WorkflowStep} [stepState]
 * @param {import('../../types').WorkflowStep} [step]
 * @param {import('../../types').JsonMap} [payload]
 * @returns {import('../../types').JsonMap}
 *
 * Emits an artifact-written workflow event.
 * @callback WorkflowArtifactEmitter
 * @param {string} kind
 * @param {string} filePath
 * @param {import('../../types').JsonMap} [payload]
 * @returns {import('../../types').JsonMap}
 */

/** @param {WorkflowSafeOptionInput} [options] @returns {WorkflowSafeOptions} */
function safeOptions(options = {}) {
  return {
    branch: options.branch || '',
    branchSource: options.branchSource || '',
    target: options.target || null,
    transport: options.transport || '',
    models: options.models || '',
    stepModels: options.stepModels || {},
    fromStep: options.fromStep || '',
    step: options.step || '',
  }
}

/** @param {WorkflowEventContextOptions} [options] @returns {WorkflowEventContext} */
function createWorkflowEventContext(options = {}) {
  const sink = typeof options.sink === 'function' ? options.sink : null
  const notifications = options.notifications || createNotificationDispatcher({
    ...(options.notify || {}),
    env: options.env,
  })
  const emitter = options.emitter || createRunnerEventEmitter({
    env: options.env,
    stream: options.stream,
    fd: options.fd,
    now: options.now,
    onError: options.onError,
  })
  /** @type {import('../../types').WorkflowRunState | null} */
  let runState = null

  /** @param {string} type @param {import('../../types').JsonMap} [payload] */
  function emit(type, payload = {}) {
    const event = emitter.emit(type, payload)
    if (sink) sink(event)
    notifications.notify(event)
    return event
  }

  /** @param {import('../../types').WorkflowRunState} [nextRunState] */
  function setRunState(nextRunState = {}) {
    runState = nextRunState
    emitter.setContext({
      runId: runState.runId || '',
      flowId: runState.flowId || '',
      logPath: runState.dir ? eventLogPathForRunState(runState) : '',
    })
  }

  /** @returns {import('../../types').JsonMap} */
  function baseRunPayload() {
    return {
      runId: runState?.runId || '',
      flowId: runState?.flowId || '',
      flowTitle: runState?.flowTitle || runState?.flow?.title || '',
      projectRoot: runState?.projectRoot || '',
      transport: runState?.transport || '',
      branch: runState?.branch || runState?.options?.branch || '',
      target: runState?.target || null,
    }
  }

  /** @param {WorkflowStartedInput} [input] */
  function workflowStarted({ command = [], options: runOptions = {} } = {}) {
    return emit('workflow_started', {
      ...baseRunPayload(),
      status: 'running',
      command,
      options: safeOptions(runOptions),
    })
  }

  /** @param {string} status @param {import('../../types').JsonMap} [payload] */
  function workflowStatus(status, payload = {}) {
    return emit(`workflow_${status}`, {
      ...baseRunPayload(),
      status,
      ...payload,
    })
  }

  /** @type {WorkflowStepStatusEmitter} */
  function stepStatus(status, stepState = {}, step = {}, payload = {}) {
    return emit('step_status', {
      ...baseRunPayload(),
      stepId: stepState.id || step.id || '',
      stepTitle: stepState.title || step.title || stepState.id || step.id || '',
      status,
      agents: Array.isArray(stepState.agents) ? stepState.agents : Array.isArray(step.agents) ? step.agents : [],
      ...payload,
    })
  }

  /** @type {WorkflowAgentStatusEmitter} */
  function agentStatus(status, run = {}, stepState = {}, step = {}, payload = {}) {
    return emit('agent_status', {
      ...baseRunPayload(),
      stepId: stepState.id || step.id || run.raw?.stepId || '',
      stepTitle: stepState.title || step.title || '',
      agent: run.agent || '',
      status,
      runnerId: run.runnerId || '',
      sessionId: run.sessionId || '',
      issueNumber: run.issueNumber || null,
      issueUrl: run.issueUrl || '',
      links: run.links || {},
      attempt: run.attempt || run.attempts || null,
      ...payload,
    })
  }

  /** @type {WorkflowArtifactEmitter} */
  function artifactWritten(kind, filePath, payload = {}) {
    return emit('artifact_written', {
      ...baseRunPayload(),
      kind,
      path: filePath || '',
      ...payload,
    })
  }

  return {
    get enabled() {
      return emitter.enabled || Boolean(sink)
    },
    emit,
    setRunState,
    workflowStarted,
    workflowStatus,
    stepStatus,
    agentStatus,
    artifactWritten,
    close: async () => {
      await notifications.flush()
      emitter.close()
    },
  }
}

module.exports = {
  createWorkflowEventContext,
  safeOptions,
}
