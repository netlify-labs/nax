export type WorkflowStep = {
  id: string
  title: string
  description: string
  prompt: string
  type?: string
  action: string
  submit: string
  agents: string[]
  input: Array<Record<string, unknown>>
  waitFor: string
  review?: Record<string, unknown> | null
  autoArchive: boolean | null
  isArchivable: boolean
}

export type Workflow = {
  id: string
  title: string
  description: string
  source: string
  sourceLabel: string
  sourceDir: string
  sourcePriority: number | null
  dir: string
  file: string
  defaults: Record<string, unknown>
  options: Record<string, unknown>
  steps: WorkflowStep[]
}

export type WorkflowGraphNodeData = {
  kind: 'workflow-step'
  flowId: string
  stepId: string
  index: number
  graphIndex: number
  number: number
  title: string
  description: string
  action: string
  submit: string
  submitLabel: string
  waitFor: string
  agents: string[]
  input: Array<Record<string, unknown>>
  status: string
  runs: Array<Record<string, unknown>>
  sourceLabel: string
  promptMarkdown: string
  promptPath: string
  promptTitle: string
  selectedAgents?: string[]
  agentStatuses?: Record<string, string>
  agentInteraction?: 'toggle' | 'view-result'
  onToggleAgent?: (stepId: string, agent: string, allAgents: string[]) => void
  onViewAgentResult?: (node: WorkflowGraphNodeData, agent: string) => void
}

export type WorkflowGraph = {
  nodes: Array<{
    id: string
    type: string
    position: { x: number; y: number }
    data: WorkflowGraphNodeData
  }>
  edges: Array<{
    id: string
    source: string
    target: string
    type: string
    animated: boolean
    label?: string
    data: Record<string, unknown>
  }>
  metadata: {
    flowId: string
    title: string
    description: string
    source: string
    sourceLabel: string
    stepCount: number
    renderedStepCount: number
    agents: string[]
    selectedAgents: string[]
    hasRunState: boolean
  }
}

export type WorkflowListResponse = {
  count: number
  items: Workflow[]
}

export type WorkflowGraphResponse = {
  workflow: Workflow
  graph: WorkflowGraph
}
