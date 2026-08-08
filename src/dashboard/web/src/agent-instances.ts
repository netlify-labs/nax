import type { AgentInstanceConfiguration, AgentInstanceDescriptor } from './types'

// Keep aligned with src/core/constants.js; the server enforces the same hard limit.
export const MAX_STEP_AGENT_INSTANCES = 4

export function agentInstanceId(agent: string, model?: string, effort?: string): string {
  return `${agent}:${model && model !== 'auto' ? model : 'auto'}:${effort && effort !== 'auto' ? effort : 'auto'}`
}

export function configuredAgentInstance(
  instance: AgentInstanceDescriptor,
  config: AgentInstanceConfiguration,
): AgentInstanceDescriptor {
  const configuredAgent = config.agent || instance.agent
  const configuredModel = config.model && config.model !== 'auto' ? config.model : undefined
  const configuredEffort = configuredModel && config.effort && config.effort !== 'auto' ? config.effort : undefined
  const { agent: _agent, model: _model, effort: _effort, ...base } = instance
  return {
    ...base,
    agent: configuredAgent,
    id: agentInstanceId(configuredAgent, configuredModel, configuredEffort),
    ...(configuredModel ? { model: configuredModel } : {}),
    ...(configuredEffort ? { effort: configuredEffort } : {}),
    resolvedFrom: configuredModel ? 'pinned' : 'open',
  }
}

export function instanceDisplayName(instance: AgentInstanceDescriptor): string {
  return instance.label || instance.model || 'Auto'
}

export function instanceFromRun(run: Record<string, unknown>): AgentInstanceDescriptor | null {
  const agent = typeof run.agent === 'string' ? run.agent : ''
  if (!agent) return null
  const model = typeof run.model === 'string' && run.model ? run.model : undefined
  const effort = typeof run.effort === 'string' && run.effort ? run.effort : undefined
  return {
    agent,
    id: typeof run.instanceId === 'string' && run.instanceId
      ? run.instanceId
      : agentInstanceId(agent, model, effort),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(typeof run.instanceLabel === 'string' && run.instanceLabel ? { label: run.instanceLabel } : {}),
    resolvedFrom: model ? 'pinned' : 'open',
  }
}
