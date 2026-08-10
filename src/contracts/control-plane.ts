export type ControlPlaneJsonPrimitive = boolean | number | string | null

export type ControlPlaneJsonValue =
  | ControlPlaneJsonPrimitive
  | ControlPlaneJsonObject
  | ControlPlaneJsonValue[]

export type ControlPlaneJsonObject = {
  [key: string]: ControlPlaneJsonValue
}

export type ControlPlaneRuntime = 'local-dashboard' | 'desktop' | 'hosted'

export type ControlPlaneActorKind = 'local-session' | 'user' | 'service'

export type ControlPlaneScope = {
  scopeId: string
  projectId: string
  accountId?: string
  siteId?: string
  repositoryId?: string
}

export type ControlPlaneActor = {
  actorId: string
  kind: ControlPlaneActorKind
  displayName?: string
  authenticated: boolean
  authorizationVersion?: string
}

export type ControlPlaneActorSummary = Pick<
  ControlPlaneActor,
  'actorId' | 'kind' | 'displayName' | 'authenticated'
>

export type ControlPlaneLocalDiagnostics = {
  projectRoot?: string
  dashboardInstanceId?: string
}

export type ControlPlaneToolName =
  | 'context_get'
  | 'workflow_list'
  | 'workflow_get'
  | 'workflow_plan'
  | 'agent_run_plan'
  | 'run_start'
  | 'run_list'
  | 'run_get'
  | 'run_wait'
  | 'run_cancel'
  | 'agent_run_retry'
  | 'agent_run_followup'
  | 'review_gate_resolve'

export type ControlPlaneOperation =
  | 'getContext'
  | 'listWorkflows'
  | 'getWorkflow'
  | 'createWorkflowPlan'
  | 'createAgentRunPlan'
  | 'startPlan'
  | 'listRuns'
  | 'getRun'
  | 'waitForRun'
  | 'cancelRun'
  | 'retryAgentRun'
  | 'submitFollowup'
  | 'resolveReviewGate'
  | 'getArtifact'

export type ControlPlaneCapabilityName = ControlPlaneToolName | 'resource_read'

export type ControlPlaneCapability = {
  available: boolean
  reason?: string
}

export type ControlPlaneCapabilities = Record<ControlPlaneCapabilityName, ControlPlaneCapability>

export type ControlPlaneAgentCatalog = {
  provenance: {
    source: string
    commit: string
    syncedAt: string
  }
  providers: Array<{
    id: string
    label: string
    defaultModel: string
    models: Array<{
      id: string
      label: string
      efforts: Array<{
        id: string
        label: string
        wireValue?: string
      }>
      aliasFor?: string
      upstreamDefaultEffort?: string
    }>
  }>
}

export type ControlPlaneTarget = {
  accountId?: string
  accountSlug?: string
  siteId: string
  siteName: string
  branch: string
  ref?: string
  sha?: string | null
  verified: boolean
  caveats: string[]
}

export type ControlPlaneContext = {
  runtime: ControlPlaneRuntime
  scope: ControlPlaneScope
  actor: ControlPlaneActorSummary
  capabilities: ControlPlaneCapabilities
  agentCatalog: ControlPlaneAgentCatalog
  target: ControlPlaneTarget | null
  currentBranch: string
  branches: string[]
  local?: ControlPlaneLocalDiagnostics
}

export type ControlPlaneAgentInstanceInput = {
  agent: string
  model?: string
  effort?: string
  label?: string
}

export type ControlPlaneAgentInstance = ControlPlaneAgentInstanceInput & {
  agentRunId?: string
  instanceId: string
  resolvedFrom?: 'latest' | 'default' | 'open' | 'pinned'
  status?: string
}

export type ControlPlaneWorkflowStep = {
  stepId: string
  title: string
  description?: string
  action: string
  submit: string
  waitFor: string
  agents: string[]
  instances: ControlPlaneAgentInstance[]
  reviewGate: boolean
}

export type ControlPlaneWorkflowSummary = {
  workflowId: string
  title: string
  description: string
  source: string
  sourceLabel: string
  stepCount: number
  agents: string[]
}

export type ControlPlaneWorkflow = ControlPlaneWorkflowSummary & {
  defaults: ControlPlaneJsonObject
  options: ControlPlaneJsonObject
  steps: ControlPlaneWorkflowStep[]
}

export type ControlPlaneGraph = {
  nodes: Array<{
    id: string
    kind: string
    data: ControlPlaneJsonObject
  }>
  edges: Array<{
    id: string
    source: string
    target: string
    kind: string
    data: ControlPlaneJsonObject
  }>
  metadata: ControlPlaneJsonObject
}

export type ControlPlaneWorkflowQuery = {
  source?: string
  limit?: number
  cursor?: string
}

export type ControlPlaneWorkflowList = {
  workflows: ControlPlaneWorkflowSummary[]
  nextCursor: string | null
}

export type ControlPlaneWorkflowReadOptions = {
  includeGraph?: boolean
}

export type ControlPlaneWorkflowRead = {
  workflow: ControlPlaneWorkflow
  graph?: ControlPlaneGraph
}

export type ControlPlaneWorkflowPlanInput = {
  workflowId: string
  branch?: string
  instances?: ControlPlaneAgentInstanceInput[]
  stepInstances?: Record<string, ControlPlaneAgentInstanceInput[]>
  context?: string
  onlyStep?: string
  fromStep?: string
}

export type ControlPlaneAgentRunPlanInput = {
  prompt: string
  instance: ControlPlaneAgentInstanceInput
  branch?: string
}

export type ControlPlanePlanKind = 'workflow' | 'agent-run'

export type ControlPlanePlanWarning = {
  code: string
  message: string
}

export type ControlPlanePlan = {
  planId: string
  kind: ControlPlanePlanKind
  status: 'prepared' | 'starting' | 'started' | 'failed'
  scope: ControlPlaneScope
  target: ControlPlaneTarget
  expiresAt: string
  workflowId?: string
  steps: ControlPlaneWorkflowStep[]
  instances: ControlPlaneAgentInstanceInput[]
  expectedAgentRuns: number
  warnings: ControlPlanePlanWarning[]
  summary: string
}

export type ControlPlaneUsageTotals = {
  totalTokens?: number
  totalCreditsCost?: number
  stepsCount?: number
  creditLimitExceeded?: boolean
}

export type ControlPlaneAgentRunSummary = {
  agentRunId: string
  runId: string
  stepId?: string
  instanceId?: string
  agent: string
  model?: string
  effort?: string
  runnerId?: string
  sessionId?: string
  status: string
}

export type ControlPlaneReviewGate = {
  reviewGateId: string
  runId: string
  stepId: string
  status: 'awaiting' | 'approved' | 'cancelled'
  reason?: string
}

export type ControlPlaneRunSummary = {
  runId: string
  workflowId?: string
  title?: string
  source?: string
  status: string
  branch?: string
  target?: ControlPlaneTarget | null
  createdAt?: string
  updatedAt?: string
  lastEventAt?: string
  stalled?: boolean
  cancellable?: boolean
  agentRuns?: ControlPlaneAgentRunSummary[]
  reviewGate?: ControlPlaneReviewGate | null
  usageTotals?: ControlPlaneUsageTotals
}

export type ControlPlaneRunQuery = {
  status?: string
  workflowId?: string
  limit?: number
  cursor?: string
}

export type ControlPlaneRunList = {
  runs: ControlPlaneRunSummary[]
  nextCursor: string | null
  total?: number
}

export type ControlPlaneRunView = 'summary' | 'details' | 'graph' | 'events'

export type ControlPlaneRunReadOptions = {
  view: ControlPlaneRunView
  sectionId?: string
  since?: string
  limit?: number
}

export type ControlPlaneRunDetailsSection = {
  sectionId: string
  kind: 'step' | 'agent-run' | 'session'
  title: string
  status: string
  agentRunId?: string
  resourceUri?: string
  markdown?: string
}

export type ControlPlaneRunDetails = {
  summary?: string
  sections: ControlPlaneRunDetailsSection[]
  artifacts: Array<{
    artifactId: string
    label: string
    kind: string
    sizeBytes: number
    resourceUri: string
  }>
}

export type ControlPlaneEvent = {
  cursor: string
  eventId: string
  type: string
  at: string
  runId: string
  stepId?: string
  agentRunId?: string
  status?: string
  message?: string
  data?: ControlPlaneJsonObject
}

export type ControlPlaneEventPage = {
  events: ControlPlaneEvent[]
  nextCursor: string
  truncated: boolean
}

export type ControlPlaneRunRead = {
  run: ControlPlaneRunSummary
  view: ControlPlaneRunView
  details?: ControlPlaneRunDetails
  graph?: ControlPlaneGraph
  events?: ControlPlaneEventPage
}

export type ControlPlaneWaitReason = 'events' | 'terminal' | 'review' | 'stalled' | 'timeout'

export type ControlPlaneWaitResult = {
  run: ControlPlaneRunSummary
  reason: ControlPlaneWaitReason
  events: ControlPlaneEvent[]
  nextCursor: string
  retryAfterMs?: number
}

export type ControlPlaneStartResult = {
  run: ControlPlaneRunSummary
  accepted: boolean
  replayed: boolean
}

export type ControlPlaneCancelTarget = {
  runId: string
  agentRunId?: string
  reason?: string
}

export type ControlPlaneCancelResult = {
  run: ControlPlaneRunSummary
  cancelled: boolean
  agentRunId?: string
  warnings: string[]
}

export type ControlPlaneAgentRetryInput = {
  runId: string
  agentRunId: string
  requestId: string
}

export type ControlPlaneAgentRetryResult = {
  run: ControlPlaneRunSummary
  previousAgentRunId: string
  agentRun: ControlPlaneAgentRunSummary
  replayed: boolean
}

export type ControlPlaneFollowupInput = {
  runId: string
  agentRunId: string
  requestId: string
  prompt: string
  mode?: 'follow-up-thread' | 'fresh-runner'
  artifactIds?: string[]
  instances?: ControlPlaneAgentInstanceInput[]
}

export type ControlPlaneFollowupResult = {
  sourceRunId: string
  run: ControlPlaneRunSummary
  agentRuns: ControlPlaneAgentRunSummary[]
  replayed: boolean
  warnings: string[]
}

export type ControlPlaneReviewDecisionInput = {
  runId: string
  reviewGateId: string
  decision: 'approve' | 'cancel'
  reason?: string
}

export type ControlPlaneReviewDecisionResult = {
  run: ControlPlaneRunSummary
  reviewGate: ControlPlaneReviewGate
  replayed: boolean
}

export type ControlPlaneArtifact = {
  artifactId: string
  runId: string
  contentType: string
  sizeBytes: number
  content: string | Uint8Array
}

export type ControlPlaneErrorShape = {
  code: string
  message: string
  recoverable: boolean
  details?: ControlPlaneJsonObject
}

export type ControlPlaneNextAction =
  | {
      kind: 'tool'
      tool: ControlPlaneToolName
      arguments: ControlPlaneJsonObject
    }
  | {
      kind: 'resource'
      uri: string
    }
  | {
      kind: 'command'
      command: string
    }

export type ControlPlaneAuthorizationTarget = {
  kind: 'scope' | 'workflow' | 'plan' | 'run' | 'agent-run' | 'review-gate' | 'artifact'
  id?: string
  parentId?: string
}

export type ControlPlaneAuthorizationRequest = {
  operation: ControlPlaneOperation
  scope: ControlPlaneScope
  actor: ControlPlaneActor
  target: ControlPlaneAuthorizationTarget
}

export type ControlPlaneAuthorizationPort = {
  authorize(request: ControlPlaneAuthorizationRequest): Promise<void> | void
}

export type NaxControlPlane = {
  getContext(scope: ControlPlaneScope, actor: ControlPlaneActor): Promise<ControlPlaneContext>
  listWorkflows(scope: ControlPlaneScope, actor: ControlPlaneActor, query: ControlPlaneWorkflowQuery): Promise<ControlPlaneWorkflowList>
  getWorkflow(scope: ControlPlaneScope, actor: ControlPlaneActor, workflowId: string, options?: ControlPlaneWorkflowReadOptions): Promise<ControlPlaneWorkflowRead>
  createWorkflowPlan(scope: ControlPlaneScope, actor: ControlPlaneActor, input: ControlPlaneWorkflowPlanInput): Promise<ControlPlanePlan>
  createAgentRunPlan(scope: ControlPlaneScope, actor: ControlPlaneActor, input: ControlPlaneAgentRunPlanInput): Promise<ControlPlanePlan>
  startPlan(scope: ControlPlaneScope, actor: ControlPlaneActor, planId: string, requestId: string): Promise<ControlPlaneStartResult>
  listRuns(scope: ControlPlaneScope, actor: ControlPlaneActor, query: ControlPlaneRunQuery): Promise<ControlPlaneRunList>
  getRun(scope: ControlPlaneScope, actor: ControlPlaneActor, runId: string, options: ControlPlaneRunReadOptions): Promise<ControlPlaneRunRead>
  waitForRun(scope: ControlPlaneScope, actor: ControlPlaneActor, runId: string, cursor?: string, timeoutMs?: number, signal?: AbortSignal): Promise<ControlPlaneWaitResult>
  cancelRun(scope: ControlPlaneScope, actor: ControlPlaneActor, target: ControlPlaneCancelTarget): Promise<ControlPlaneCancelResult>
  retryAgentRun(scope: ControlPlaneScope, actor: ControlPlaneActor, input: ControlPlaneAgentRetryInput): Promise<ControlPlaneAgentRetryResult>
  submitFollowup(scope: ControlPlaneScope, actor: ControlPlaneActor, input: ControlPlaneFollowupInput): Promise<ControlPlaneFollowupResult>
  resolveReviewGate(scope: ControlPlaneScope, actor: ControlPlaneActor, input: ControlPlaneReviewDecisionInput): Promise<ControlPlaneReviewDecisionResult>
  getArtifact(scope: ControlPlaneScope, actor: ControlPlaneActor, runId: string, artifactId: string): Promise<ControlPlaneArtifact>
}

export type NaxControlPlaneClient = {
  getContext(): Promise<ControlPlaneContext>
  listWorkflows(query: ControlPlaneWorkflowQuery): Promise<ControlPlaneWorkflowList>
  getWorkflow(workflowId: string, options?: ControlPlaneWorkflowReadOptions): Promise<ControlPlaneWorkflowRead>
  createWorkflowPlan(input: ControlPlaneWorkflowPlanInput): Promise<ControlPlanePlan>
  createAgentRunPlan(input: ControlPlaneAgentRunPlanInput): Promise<ControlPlanePlan>
  startPlan(planId: string, requestId: string): Promise<ControlPlaneStartResult>
  listRuns(query: ControlPlaneRunQuery): Promise<ControlPlaneRunList>
  getRun(runId: string, options: ControlPlaneRunReadOptions): Promise<ControlPlaneRunRead>
  waitForRun(runId: string, cursor?: string, timeoutMs?: number, signal?: AbortSignal): Promise<ControlPlaneWaitResult>
  cancelRun(target: ControlPlaneCancelTarget): Promise<ControlPlaneCancelResult>
  retryAgentRun(input: ControlPlaneAgentRetryInput): Promise<ControlPlaneAgentRetryResult>
  submitFollowup(input: ControlPlaneFollowupInput): Promise<ControlPlaneFollowupResult>
  resolveReviewGate(input: ControlPlaneReviewDecisionInput): Promise<ControlPlaneReviewDecisionResult>
  getArtifact(runId: string, artifactId: string): Promise<ControlPlaneArtifact>
}

export type NaxControlPlanePorts = NaxControlPlane & ControlPlaneAuthorizationPort & {
  audit?: ControlPlaneAuditSink
  auditContext?: ControlPlaneAuditContext
  auditNow?: () => Date
  auditClock?: () => number
}

export type StoredControlPlanePlan = ControlPlanePlan & {
  actorId: string
  requestHash: string
  normalizedInput: ControlPlaneJsonObject
  createdAt: string
  updatedAt: string
  requestId?: string
  runId?: string
  failure?: ControlPlaneErrorShape
}

export type ControlPlaneRunPlanStore = {
  create(plan: StoredControlPlanePlan): Promise<StoredControlPlanePlan>
  get(planId: string): Promise<StoredControlPlanePlan | null>
  claimStart(planId: string, requestId: string, expectedStatus: 'prepared' | 'failed'): Promise<StoredControlPlanePlan | null>
  bindStarted(planId: string, requestId: string, runId: string): Promise<StoredControlPlanePlan>
  markFailed(planId: string, requestId: string, failure: ControlPlaneErrorShape): Promise<StoredControlPlanePlan>
  listStaleStarting(before: string): Promise<StoredControlPlanePlan[]>
  pruneExpired?(before: string): Promise<number>
}

export type StoredControlPlaneMutation = {
  operation: string
  requestId: string
  intentHash: string
  status: 'starting' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  result?: ControlPlaneJsonObject
  failure?: ControlPlaneErrorShape
}

export type ControlPlaneMutationClaim = {
  claimed: boolean
  record: StoredControlPlaneMutation
}

export type ControlPlaneMutationStore = {
  claim(input: { operation: string, requestId: string, intentHash: string }): Promise<ControlPlaneMutationClaim>
  complete(operation: string, requestId: string, result: ControlPlaneJsonObject): Promise<StoredControlPlaneMutation>
  fail(operation: string, requestId: string, failure: ControlPlaneErrorShape): Promise<StoredControlPlaneMutation>
}

export type WorkflowExecutionBackend = {
  startPlan(plan: StoredControlPlanePlan): Promise<ControlPlaneStartResult>
  reconcilePlan(plan: StoredControlPlanePlan): Promise<ControlPlaneStartResult | null>
}

export type ControlPlaneEventStore = {
  listEvents(scope: ControlPlaneScope, runId: string, cursor?: string, limit?: number): Promise<ControlPlaneEventPage>
  waitForEvents(scope: ControlPlaneScope, runId: string, cursor?: string, timeoutMs?: number): Promise<ControlPlaneWaitResult>
}

export type ControlPlaneArtifactStore = {
  getArtifact(scope: ControlPlaneScope, runId: string, artifactId: string): Promise<ControlPlaneArtifact | null>
}

export type ControlPlaneAuditEvent = {
  operation: ControlPlaneOperation
  activity: ControlPlaneCapabilityName
  at: string
  durationMs: number
  ok: boolean
  errorCode?: string
  scopeId: string
  actorId: string
  runtime?: ControlPlaneRuntime
  clientName?: string
  clientVersion?: string
  planId?: string
  requestId?: string
  workflowId?: string
  runId?: string
  expectedAgentRuns?: number
  createdAgentRuns?: number
  usageTotals?: ControlPlaneUsageTotals
}

export type ControlPlaneAuditSink = {
  record(event: ControlPlaneAuditEvent): Promise<void> | void
}

export type ControlPlaneAuditContext = {
  runtime?: ControlPlaneRuntime
  clientName?: string
  clientVersion?: string
}
