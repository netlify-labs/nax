import type { RunnerEvent, DashboardRun } from './types'

export type LiveVisualStatus =
  | 'queued'
  | 'active'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'abandoned'
  | 'skipped'
  | 'dry-run'
  | 'retrying'
  | 'submitted'
  | 'running'

export type LiveRunState = {
  run: DashboardRun | null
  output: string
  stepStatuses: Record<string, string>
  agentStatuses: Record<string, Record<string, string>>
  artifacts: RunnerEvent[]
  errors: string[]
  rawEvents: RunnerEvent[]
  seen: Record<string, true>
  stepSeqs: Record<string, number>
  agentSeqs: Record<string, Record<string, number>>
}

export type LiveRunAction =
  | { type: 'reset'; run?: DashboardRun | null }
  | { type: 'patch_step_statuses'; update: Record<string, string> | ((value: Record<string, string>) => Record<string, string>) }
  | { type: 'patch_agent_statuses'; update: Record<string, Record<string, string>> | ((value: Record<string, Record<string, string>>) => Record<string, Record<string, string>>) }
  | { type: 'event'; event: RunnerEvent }

export function initialLiveRunState(run: DashboardRun | null = null): LiveRunState {
  return {
    run,
    output: '',
    stepStatuses: {},
    agentStatuses: {},
    artifacts: [],
    errors: [],
    rawEvents: [],
    seen: {},
    stepSeqs: {},
    agentSeqs: {},
  }
}

function eventSeq(event: RunnerEvent): number {
  return typeof event.seq === 'number' ? event.seq : Number.MAX_SAFE_INTEGER
}

function eventDedupeKey(event: RunnerEvent): string {
  if (typeof event.eventId === 'string' && event.eventId) return `eventId:${event.eventId}`
  if (typeof event.seq === 'number' && event.runId) return `seq:${event.runId}:${event.seq}`
  if (typeof event.id === 'number') return `id:${event.id}`
  return ''
}

export function visualStatus(status = ''): LiveVisualStatus {
  const normalized = status.toLowerCase()
  if (['pending', 'queued'].includes(normalized)) return 'queued'
  if (['running', 'submitting', 'processing', 'executing'].includes(normalized)) return 'running'
  if (['submitted'].includes(normalized)) return 'submitted'
  if (['waiting'].includes(normalized)) return 'waiting'
  if (['retrying'].includes(normalized)) return 'retrying'
  if (['complete', 'completed'].includes(normalized)) return 'completed'
  if (['failed', 'timeout', 'error'].includes(normalized)) return 'failed'
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled'
  if (['abandoned'].includes(normalized)) return 'abandoned'
  if (['skipped'].includes(normalized)) return 'skipped'
  if (['dry-run'].includes(normalized)) return 'dry-run'
  return normalized ? normalized as LiveVisualStatus : 'queued'
}

function applyEvent(state: LiveRunState, event: RunnerEvent): LiveRunState {
  const key = eventDedupeKey(event)
  if (key && state.seen[key]) return state
  const seen = key ? { ...state.seen, [key]: true as const } : state.seen
  const withRawEvents = {
    ...state,
    seen,
    rawEvents: [...state.rawEvents.slice(-199), event],
  }

  if (event.type === 'stdout' || event.type === 'stderr') {
    return {
      ...withRawEvents,
      output: `${withRawEvents.output}${typeof event.text === 'string' ? event.text : ''}`,
    }
  }

  if (event.type === 'workflow_started') {
    return {
      ...withRawEvents,
      run: {
        ...(withRawEvents.run || { id: event.runId || '', flowId: event.flowId || '', status: 'running' }),
        runId: event.runId || withRawEvents.run?.runId,
        flowId: event.flowId || withRawEvents.run?.flowId || '',
        flowTitle: event.flowTitle || withRawEvents.run?.flowTitle,
        status: 'running',
        command: Array.isArray(event.command) ? event.command : withRawEvents.run?.command,
        startedAt: typeof event.at === 'string' ? event.at : withRawEvents.run?.startedAt,
      },
    }
  }

  if (event.type === 'step_status' && event.stepId && event.status) {
    const seq = eventSeq(event)
    const previousSeq = withRawEvents.stepSeqs[event.stepId] || 0
    if (seq < previousSeq) return withRawEvents
    return {
      ...withRawEvents,
      stepStatuses: {
        ...withRawEvents.stepStatuses,
        [event.stepId]: visualStatus(event.status),
      },
      stepSeqs: {
        ...withRawEvents.stepSeqs,
        [event.stepId]: seq,
      },
    }
  }

  if (event.type === 'agent_status' && event.stepId && event.agent && event.status) {
    const seq = eventSeq(event)
    const previousSeq = withRawEvents.agentSeqs[event.stepId]?.[event.agent] || 0
    if (seq < previousSeq) return withRawEvents
    return {
      ...withRawEvents,
      agentStatuses: {
        ...withRawEvents.agentStatuses,
        [event.stepId]: {
          ...(withRawEvents.agentStatuses[event.stepId] || {}),
          [event.agent]: visualStatus(event.status),
        },
      },
      agentSeqs: {
        ...withRawEvents.agentSeqs,
        [event.stepId]: {
          ...(withRawEvents.agentSeqs[event.stepId] || {}),
          [event.agent]: seq,
        },
      },
    }
  }

  if (event.type === 'artifact_written') {
    return {
      ...withRawEvents,
      artifacts: [...withRawEvents.artifacts, event],
    }
  }

  if (event.type === 'runner_event_error' || event.type === 'error') {
    return {
      ...withRawEvents,
      errors: typeof event.message === 'string' ? [...withRawEvents.errors, event.message] : withRawEvents.errors,
    }
  }

  if (event.type === 'workflow_cancelled' || event.type === 'workflow_completed' || event.type === 'workflow_failed' || event.type === 'exited') {
    return {
      ...withRawEvents,
      run: withRawEvents.run ? {
        ...withRawEvents.run,
        status: typeof event.status === 'string' ? event.status : withRawEvents.run.status,
        exitCode: typeof event.exitCode === 'number' ? event.exitCode : withRawEvents.run.exitCode,
        signal: typeof event.signal === 'string' ? event.signal : withRawEvents.run.signal,
        durationMs: typeof event.durationMs === 'number' ? event.durationMs : withRawEvents.run.durationMs,
        exitedAt: typeof event.at === 'string' ? event.at : withRawEvents.run.exitedAt,
      } : withRawEvents.run,
    }
  }

  return withRawEvents
}

export function liveRunReducer(state: LiveRunState, action: LiveRunAction): LiveRunState {
  if (action.type === 'reset') return initialLiveRunState(action.run || null)
  if (action.type === 'patch_step_statuses') {
    return {
      ...state,
      stepStatuses: typeof action.update === 'function' ? action.update(state.stepStatuses) : action.update,
    }
  }
  if (action.type === 'patch_agent_statuses') {
    return {
      ...state,
      agentStatuses: typeof action.update === 'function' ? action.update(state.agentStatuses) : action.update,
    }
  }
  return applyEvent(state, action.event)
}
