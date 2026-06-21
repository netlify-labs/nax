const { eventLogPathForRunState } = require('./runner-event-log')
const { createRunnerEventEmitter } = require('./runner-events')
const { createNotificationDispatcher } = require('./notifications')

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
  let runState = null

  function emit(type, payload = {}) {
    const event = emitter.emit(type, payload)
    if (sink) sink(event)
    notifications.notify(event)
    return event
  }

  function setRunState(nextRunState = {}) {
    runState = nextRunState
    emitter.setContext({
      runId: runState.runId || '',
      flowId: runState.flowId || '',
      logPath: runState.dir ? eventLogPathForRunState(runState) : '',
    })
  }

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

  function workflowStarted({ command = [], options: runOptions = {} } = {}) {
    return emit('workflow_started', {
      ...baseRunPayload(),
      status: 'running',
      command,
      options: safeOptions(runOptions),
    })
  }

  function workflowStatus(status, payload = {}) {
    return emit(`workflow_${status}`, {
      ...baseRunPayload(),
      status,
      ...payload,
    })
  }

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
