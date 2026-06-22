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
  onToggleAgent?: (stepId: string, agent: string, allAgents: string[]) => void
  onViewPrompt?: (node: WorkflowGraphNodeData) => void
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

export type HealthResponse = {
  ok: boolean
  projectRoot?: string
  tokenRequiredForMutations: boolean
  tokenRequiredForSensitiveReads: boolean
}

export type WorkflowGraphResponse = {
  workflow: Workflow
  graph: WorkflowGraph
}

export type Target = {
  branch: string
  ref: string
  sha: string | null
  sourceType: string
  verified: boolean
  caveats: string[]
}

export type DryRunOptions = {
  branch: string
  transport: string
  models: string[]
  stepModels: Record<string, string[]>
  context: string
  step: string
  fromStep: string
  target?: Target | null
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

export type DashboardRun = {
  id: string
  runId?: string
  flowId: string
  flowTitle?: string
  status: string
  transport?: string
  branch?: string
  target?: Target | null
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
  run: DashboardRun
}

export type RunsResponse = {
  active: DashboardRun[]
  durable: DashboardRun[]
}

export type RunGraphResponse = {
  run: DashboardRun
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
  absolutePath: string
  links: {
    sessionUrl?: string
    agentRunUrl?: string
    commentUrl?: string
    issueUrl?: string
    [key: string]: string | undefined
  }
  usage: Record<string, unknown> | null
  markdown: string
  promptMarkdown?: string
  promptPath?: string
  promptTitle?: string
}

export type RunFollowupTarget = {
  id: string
  kind: 'workflow-summary' | 'step-summary' | 'agent-result' | 'runner-summary' | 'session-result'
  label: string
  agent: string
  stepId: string
  stepNumber: number
  stepTitle: string
  runnerId: string
  sessionId: string
  status: string
  path: string
  absolutePath: string
  links: {
    sessionUrl?: string
    agentRunUrl?: string
    commentUrl?: string
    issueUrl?: string
    [key: string]: string | undefined
  }
  defaultMode: 'follow-up-thread' | 'fresh-runner'
  isDefault: boolean
}

export type RunFollowupArtifact = {
  id: string
  kind:
    | 'workflow-summary'
    | 'step-summary'
    | 'agent-result'
    | 'runner-summary'
    | 'session-result'
    | 'metadata-json'
    | 'usage-json'
    | 'attempt-markdown'
    | 'blob-debug'
  label: string
  path: string
  absolutePath: string
  sizeBytes: number
  defaultSelected: boolean
  advanced: boolean
  stepNumber: number
  source: {
    stepId: string
    stepNumber: number
    runnerId: string
    sessionId: string
  }
}

export type RunDetailsWorkflowStep = {
  id: string
  title: string
  status: string
  sourceType: string
  agents: string[]
  promptMarkdown: string
  promptPath: string
  promptTitle: string
}

export type RunDetails = {
  summaryPath: string
  summaryAbsolutePath: string
  summaryMarkdown: string
  finalMarkdown: string
  finalTitle: string
  workflowSteps: RunDetailsWorkflowStep[]
  sections: RunDetailsSection[]
  followupTargets: RunFollowupTarget[]
  followupArtifacts: RunFollowupArtifact[]
}

export type RunDetailsResponse = {
  run: DashboardRun
  details: RunDetails
}

export type RunFollowupRequest = {
  mode: 'follow-up-thread' | 'fresh-runner'
  prompt: string
  targetId: string
  models: string[]
  artifacts: Array<{ id: string; kind: string }>
}

export type RunFollowupSubmission = {
  id: string
  mode: 'continue-runner' | 'fresh-runner' | string
  agent: string
  runnerId: string
  sessionId: string
  status: string
  links: Record<string, string>
  issueUrl: string
  sessionArtifactPath: string
  runnerArtifactPath: string
  warnings: string[]
}

export type RunFollowupResponse = {
  followup: {
    id: string
    status: 'submitted' | string
    sourceWorkflowRunId: string
    target: RunFollowupTarget
    context: {
      artifactCount: number
      artifacts: RunFollowupArtifact[]
      delivery: 'none' | 'inline' | 'blob' | string
      bytes: number
      blobRef: Record<string, unknown> | null
    }
    plan: {
      mode: string
      targetId: string
      targetAgent: string
      submissions: Array<Record<string, unknown>>
      summary: string[]
    }
    submissions: RunFollowupSubmission[]
    sourceWorkflow: DashboardRun | null
    persistedWorkflow: DashboardRun | null
    warnings: string[]
  }
}

export type RunnerEvent = {
  id?: number
  schemaVersion?: number
  seq?: number
  eventId?: string
  type: string
  at?: string
  runId?: string
  flowId?: string
  flowTitle?: string
  status?: string
  stepId?: string
  stepTitle?: string
  agent?: string
  runnerId?: string
  sessionId?: string
  issueNumber?: number | null
  issueUrl?: string
  links?: Record<string, string>
  command?: string[]
  exitCode?: number | null
  signal?: string | null
  durationMs?: number
  text?: string
  message?: string
  [key: string]: unknown
}
