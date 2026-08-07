import { visualStatus } from './liveRunReducer'
import {
  activeOrCompletedStatuses,
  activeStatuses,
  completedStatuses,
  failedStatuses,
  isActiveStatus,
  isTerminalStatus,
  statusKey,
} from './status-model'
import type { AgentInstanceDescriptor, WorkflowGraph, WorkflowGraphNodeData } from './types'

export { activeOrCompletedStatuses, activeStatuses, completedStatuses, failedStatuses }

type StepStatusInput = {
  status?: string
  agents?: string[]
  instances?: AgentInstanceDescriptor[]
  selectedAgents?: AgentInstanceDescriptor[]
  runs?: Array<Record<string, unknown>>
  agentStatuses?: Record<string, string>
}

type ProjectWorkflowGraphOptions = {
  graph: WorkflowGraph | null
  stepAgents: Record<string, AgentInstanceDescriptor[]>
  stepStatuses: Record<string, string>
  stepAgentStatuses: Record<string, Record<string, string>>
}

function runString(run: Record<string, unknown>, key: string): string {
  const value = run[key]
  return typeof value === 'string' ? value : ''
}

function runInstanceId(run: Record<string, unknown>): string {
  const explicit = runString(run, 'instanceId')
  if (explicit) return explicit
  const agent = runString(run, 'agent')
  if (!agent) return ''
  return `${agent}:${runString(run, 'model') || 'auto'}:${runString(run, 'effort') || 'auto'}`
}

export function agentStatusesFromRuns(runs: Array<Record<string, unknown>> = []): Record<string, string> {
  const statuses: Record<string, string> = {}
  for (const run of runs) {
    const instanceId = runInstanceId(run)
    if (!instanceId) continue
    const status = runString(run, 'status')
    if (status) statuses[instanceId] = visualStatus(status)
    else if (runString(run, 'runnerId') || runString(run, 'sessionId')) statuses[instanceId] = statusKey('submitted')
  }
  return statuses
}

export function selectedAgentsForStep(
  step: StepStatusInput,
  selectedOverride?: AgentInstanceDescriptor[],
): AgentInstanceDescriptor[] {
  return selectedOverride && selectedOverride.length > 0
    ? selectedOverride
    : step.selectedAgents && step.selectedAgents.length > 0
      ? step.selectedAgents
      : step.instances || []
}

export function displayAgentStatuses(
  step: StepStatusInput,
  liveStatuses: Record<string, string> = {},
  selectedAgents = selectedAgentsForStep(step),
): Record<string, string> {
  const runStatuses = agentStatusesFromRuns(step.runs || [])
  const merged = {
    ...runStatuses,
    ...(step.agentStatuses || {}),
    ...liveStatuses,
  }
  for (const [agent, status] of Object.entries(runStatuses)) {
    if (isTerminalStatus(status)) merged[agent] = status
  }
  const stepStatus = visualStatus(step.status || '')
  if (isTerminalStatus(stepStatus)) {
    for (const instance of selectedAgents) {
      if (!merged[instance.id] || isActiveStatus(merged[instance.id])) merged[instance.id] = stepStatus
    }
  } else if (activeStatuses.has(stepStatus)) {
    for (const instance of selectedAgents) {
      if (!merged[instance.id]) merged[instance.id] = stepStatus
    }
  }
  return merged
}

export function displayStepStatus(
  step: StepStatusInput,
  agentStatuses: Record<string, string>,
  selectedAgents = selectedAgentsForStep(step),
): string {
  const stepStatus = visualStatus(step.status || '')
  const selectedStatuses = selectedAgents.map((instance) => agentStatuses[instance.id] || '').filter(Boolean)
  const failedCount = selectedStatuses.filter((status) => failedStatuses.has(status)).length
  const completedCount = selectedStatuses.filter((status) => completedStatuses.has(status)).length
  if (
    failedCount > 0 &&
    completedCount > 0 &&
    failedCount + completedCount === selectedAgents.length
  ) return 'completed_with_failures'
  if (failedCount > 0) return 'failed'
  if (
    activeStatuses.has(stepStatus) &&
    selectedAgents.length > 0 &&
    selectedStatuses.length === selectedAgents.length &&
    selectedStatuses.every((status) => completedStatuses.has(status))
  ) {
    return 'completed'
  }
  if (activeStatuses.has(stepStatus) && selectedStatuses.some((status) => activeStatuses.has(status))) return stepStatus
  return stepStatus
}

export function projectWorkflowNodeData(
  node: WorkflowGraphNodeData,
  options: {
    selectedAgents?: AgentInstanceDescriptor[]
    stepStatus?: string
    liveAgentStatuses?: Record<string, string>
  } = {},
): WorkflowGraphNodeData {
  const selectedAgents = selectedAgentsForStep(node, options.selectedAgents)
  const statusInput = {
    ...node,
    status: options.stepStatus || node.status,
    selectedAgents,
  }
  const agentStatuses = displayAgentStatuses(statusInput, options.liveAgentStatuses || {}, selectedAgents)
  return {
    ...statusInput,
    status: displayStepStatus(statusInput, agentStatuses, selectedAgents),
    agentStatuses,
    selectedAgents,
  }
}

export function projectWorkflowGraph({
  graph,
  stepAgents,
  stepStatuses,
  stepAgentStatuses,
}: ProjectWorkflowGraphOptions): WorkflowGraph | null {
  if (!graph) return null
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      data: projectWorkflowNodeData(node.data, {
        selectedAgents: Object.prototype.hasOwnProperty.call(stepAgents, node.data.stepId)
          ? stepAgents[node.data.stepId]
          : node.data.selectedAgents || node.data.instances,
        stepStatus: stepStatuses[node.data.stepId] || node.data.status,
        liveAgentStatuses: stepAgentStatuses[node.data.stepId] || {},
      }),
    })),
  }
}

export function workflowGraphNodeByStepId(graph: WorkflowGraph | null, stepId: string): WorkflowGraphNodeData | null {
  if (!graph || !stepId) return null
  return graph.nodes.find((node) => node.data.stepId === stepId)?.data || null
}
