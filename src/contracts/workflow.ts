export type AgentInstanceDescriptor = {
  id: string
  agent: string
  model?: string
  effort?: string
  label?: string
  resolvedFrom?: 'latest' | 'default' | 'open' | 'pinned'
  status?: string
}

export type WorkflowStep = {
  id: string
  title: string
  description: string
  prompt: string
  type?: string
  action: string
  submit: string
  agents: string[]
  instances: AgentInstanceDescriptor[]
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
  findings?: { step: string, adapter: string } | null
}

export type AgentInstanceConfiguration = {
  agent: string
  model: string
  effort: string
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
  instances: AgentInstanceDescriptor[]
  input: Array<Record<string, unknown>>
  status: string
  runs: Array<Record<string, unknown>>
  sourceLabel: string
  promptMarkdown: string
  promptPath: string
  promptTitle: string
  selectedAgents?: AgentInstanceDescriptor[]
  agentStatuses?: Record<string, string>
  agentInteraction?: 'toggle' | 'view-result'
  inheritedFromStepId?: string
  onToggleAgent?: (stepId: string, agent: string, allAgents: string[], declaredAgents?: string[]) => void
  onConfigureAgent?: (stepId: string, instanceId: string, config: AgentInstanceConfiguration) => void
  onRemoveAgent?: (stepId: string, instanceId: string) => void
  onRemoveAllAgents?: (stepId: string) => void
  onAddInstances?: (stepId: string, instances: AgentInstanceDescriptor[]) => void
  onViewAgentResult?: (node: WorkflowGraphNodeData, instanceId: string) => void
  onCancelAgentRun?: (node: WorkflowGraphNodeData, instanceId: string) => void | Promise<void>
  onRetryAgentRun?: (node: WorkflowGraphNodeData, instanceId: string) => void | Promise<void>
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
    selectedAgents: AgentInstanceDescriptor[]
    hasRunState: boolean
  }
}

export type WorkflowDiagnostic = {
  stepId: string
  code: string
  message: string
  hint: string
}

export type InvalidWorkflowSummary = {
  id: string
  file: string
  status: 'invalid' | 'load-failed'
  invalid: true
  errorCount: number
  diagnostics: WorkflowDiagnostic[]
}

export type WorkflowListResponse = {
  count: number
  items: Workflow[]
  invalid?: InvalidWorkflowSummary[]
}

export type WorkflowGraphResponse = {
  workflow: Workflow
  graph: WorkflowGraph
}

export type Finding = {
  key: string
  localId: string
  sourceLocalId?: string
  rank: number | null
  bucket: 'consensus' | 'contested' | 'merge_dependent' | string
  title: string
  category: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  severityRaw?: string
  status: string
  file: string
  line: number | null
  lineEnd: number | null
  claim: string
  evidence: string
  suggestedFix: string
  confidence: string
  agents: string[]
}

export type FindingsDiagnostic = {
  stepId: string
  instanceId: string
  code: string
  message: string
}

export type FindingsArtifact = {
  schemaVersion: number
  runId: string
  flowId: string
  adapter: string
  generatedAt: string
  source: { stepId: string, instanceId: string, runnerId: string, sessionId: string, resultUrl: string | null }
  target: { branch: string, sha: string | null, pullRequest?: { number: number, url: string, isCrossRepository: boolean } }
  findings: Finding[]
  diagnostics: FindingsDiagnostic[]
}
