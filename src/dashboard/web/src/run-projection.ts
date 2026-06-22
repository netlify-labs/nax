import { visualStatus } from './liveRunReducer'
import type { WorkflowGraph, WorkflowGraphNodeData } from './types'

export const completedStatuses = new Set(['completed', 'dry-run'])
export const activeOrCompletedStatuses = new Set(['running', 'submitted', 'completed', 'dry-run'])
export const activeStatuses = new Set(['running', 'submitted', 'waiting', 'retrying', 'queued'])
export const failedStatuses = new Set(['failed', 'timeout', 'cancelled', 'abandoned'])

type StepStatusInput = {
  status?: string
  agents?: string[]
  selectedAgents?: string[]
  runs?: Array<Record<string, unknown>>
  agentStatuses?: Record<string, string>
}

type ProjectWorkflowGraphOptions = {
  graph: WorkflowGraph | null
  stepModels: Record<string, string[]>
  stepStatuses: Record<string, string>
  stepAgentStatuses: Record<string, Record<string, string>>
}

function runString(run: Record<string, unknown>, key: string): string {
  const value = run[key]
  return typeof value === 'string' ? value : ''
}

export function agentStatusesFromRuns(runs: Array<Record<string, unknown>> = []): Record<string, string> {
  const statuses: Record<string, string> = {}
  for (const run of runs) {
    const agent = runString(run, 'agent')
    if (!agent) continue
    const status = runString(run, 'status')
    if (status) statuses[agent] = visualStatus(status)
    else if (runString(run, 'runnerId') || runString(run, 'sessionId')) statuses[agent] = 'submitted'
  }
  return statuses
}

export function selectedAgentsForStep(step: StepStatusInput, selectedOverride?: string[]): string[] {
  const agents = step.agents || []
  const selected = selectedOverride && selectedOverride.length > 0
    ? selectedOverride
    : step.selectedAgents && step.selectedAgents.length > 0
      ? step.selectedAgents
      : agents
  return selected.filter((agent) => agents.includes(agent))
}

export function displayAgentStatuses(
  step: StepStatusInput,
  liveStatuses: Record<string, string> = {},
  selectedAgents = selectedAgentsForStep(step),
): Record<string, string> {
  const merged = {
    ...agentStatusesFromRuns(step.runs || []),
    ...(step.agentStatuses || {}),
    ...liveStatuses,
  }
  const stepStatus = visualStatus(step.status || '')
  if (activeStatuses.has(stepStatus)) {
    for (const agent of selectedAgents) {
      if (!merged[agent]) merged[agent] = stepStatus
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
  const selectedStatuses = selectedAgents.map((agent) => agentStatuses[agent] || '').filter(Boolean)
  if (selectedStatuses.some((status) => failedStatuses.has(status))) return 'failed'
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
    selectedAgents?: string[]
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
  stepModels,
  stepStatuses,
  stepAgentStatuses,
}: ProjectWorkflowGraphOptions): WorkflowGraph | null {
  if (!graph) return null
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      data: projectWorkflowNodeData(node.data, {
        selectedAgents: Object.prototype.hasOwnProperty.call(stepModels, node.data.stepId)
          ? stepModels[node.data.stepId]
          : node.data.selectedAgents || node.data.agents,
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
