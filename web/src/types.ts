export type WorkflowStep = {
  id: string
  title: string
  description: string
  prompt: string
  action: string
  submit: string
  agents: string[]
  input: Array<Record<string, unknown>>
  waitFor: string
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
  onToggleAgent?: (stepId: string, agent: string, allAgents: string[]) => void
  onViewPrompt?: (node: WorkflowGraphNodeData) => void
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

export type HealthResponse = {
  ok: boolean
  projectRoot: string
  tokenRequiredForMutations: boolean
}

export type WorkflowGraphResponse = {
  workflow: Workflow
  graph: WorkflowGraph
}

export type DryRunOptions = {
  branch: string
  transport: string
  models: string[]
  stepModels: Record<string, string[]>
  context: string
  step: string
  fromStep: string
}

export type DryRunResult = {
  status: string
  command: string[]
  startedAt: string
  exitedAt: string
  durationMs: number
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

export type DryRunResponse = {
  workflow: Workflow
  dryRun: DryRunResult
}

export type VisualizeRun = {
  id: string
  runId?: string
  flowId: string
  flowTitle?: string
  status: string
  transport?: string
  branch?: string
  createdAt?: string
  updatedAt?: string
  dir?: string
  summaryPath?: string
  resumable?: boolean
  steps?: Array<Record<string, unknown>>
  command?: string[]
  startedAt?: string
  exitedAt?: string
  durationMs?: number
  exitCode?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
  eventCount?: number
  cancellable?: boolean
  options?: Partial<DryRunOptions>
}

export type StartRunResponse = {
  workflow: Workflow
  run: VisualizeRun
}

export type RunsResponse = {
  active: VisualizeRun[]
  durable: VisualizeRun[]
}

export type RunGraphResponse = {
  run: VisualizeRun
  workflow: Workflow
  graph: WorkflowGraph
}

export type RunDetailsSection = {
  id: string
  kind: 'step' | 'session'
  title: string
  stepId: string
  stepTitle: string
  agent: string
  status: string
  runnerId: string
  sessionId: string
  path: string
  links: Record<string, string>
  usage: Record<string, unknown> | null
  markdown: string
}

export type RunDetails = {
  summaryPath: string
  summaryMarkdown: string
  finalMarkdown: string
  finalTitle: string
  sections: RunDetailsSection[]
}

export type RunDetailsResponse = {
  run: VisualizeRun
  details: RunDetails
}
