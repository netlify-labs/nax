/**
 * @typedef {Record<string, unknown>} JsonObject
 *
 * @typedef {{
 *   id?: string,
 *   title?: string,
 *   description?: string,
 *   source?: string,
 *   sourceLabel?: string,
 *   sourceDir?: string,
 *   sourcePriority?: number | null,
 *   dir?: string,
 *   file?: string,
 *   defaults?: JsonObject,
 *   options?: JsonObject,
 *   steps?: Array<JsonObject>,
 * }} WorkflowPayload
 *
 * @typedef {{
 *   nodes?: Array<{ id?: string, type?: string, position?: { x?: number, y?: number }, data?: JsonObject }>,
 *   edges?: Array<JsonObject>,
 *   metadata?: JsonObject,
 * }} WorkflowGraphPayload
 *
 * @typedef {{
 *   count?: number,
 *   items?: WorkflowPayload[],
 * }} WorkflowListPayload
 *
 * @typedef {{
 *   workflow?: WorkflowPayload,
 *   graph?: WorkflowGraphPayload,
 * }} WorkflowGraphPayloadResponse
 *
 * @typedef {{
 *   listWorkflows?: () => Promise<WorkflowListPayload>,
 *   getWorkflow?: (id: string) => Promise<WorkflowPayload | null>,
 *   getWorkflowGraph?: (id: string) => Promise<WorkflowGraphPayloadResponse | null>,
 *   loadWorkflow?: (id: string) => Promise<JsonObject>,
 * }} WorkflowCatalog
 *
 * @typedef {{
 *   limit?: string | number | null,
 *   cursor?: string | null,
 * }} RunsPageInput
 *
 * @typedef {{
 *   limit?: number,
 *   offset?: number,
 *   total?: number,
 *   nextCursor?: string | null,
 *   hasMore?: boolean,
 * }} RunsPaginationPayload
 *
 * @typedef {{
 *   id?: string,
 *   runId?: string,
 *   flowId?: string,
 *   flowTitle?: string,
 *   status?: string,
 *   transport?: string,
 *   branch?: string,
 *   target?: JsonObject | null,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   dir?: string,
 *   summaryPath?: string,
 *   resumable?: boolean,
 *   steps?: Array<JsonObject>,
 *   command?: string[],
 *   startedAt?: string,
 *   exitedAt?: string,
 *   durationMs?: number,
 *   exitCode?: number | null,
 *   signal?: string | null,
 *   stdout?: string,
 *   stderr?: string,
 *   eventCount?: number,
 *   cancellable?: boolean,
 *   options?: JsonObject,
 *   raw?: JsonObject,
 * }} DashboardRunPayload
 *
 * @typedef {{
 *   runs?: DashboardRunPayload[],
 *   pagination?: RunsPaginationPayload,
 * }} RunsPagePayload
 *
 * @typedef {{
 *   run?: DashboardRunPayload,
 *   workflow?: WorkflowPayload,
 *   graph?: WorkflowGraphPayload,
 * }} RunGraphPayload
 *
 * @typedef {{
 *   id?: string,
 *   kind?: string,
 *   title?: string,
 *   stepId?: string,
 *   stepTitle?: string,
 *   agent?: string,
 *   status?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   path?: string,
 *   absolutePath?: string,
 *   links?: Record<string, string | undefined>,
 *   usage?: JsonObject | null,
 *   markdown?: string,
 *   promptMarkdown?: string,
 *   promptPath?: string,
 *   promptTitle?: string,
 * }} RunDetailsSectionPayload
 *
 * @typedef {{
 *   id?: string,
 *   kind?: string,
 *   label?: string,
 *   path?: string,
 *   absolutePath?: string,
 *   sizeBytes?: number,
 *   defaultSelected?: boolean,
 *   advanced?: boolean,
 *   stepNumber?: number,
 *   source?: JsonObject,
 * }} RunFollowupArtifactPayload
 *
 * @typedef {{
 *   summaryPath?: string,
 *   summaryAbsolutePath?: string,
 *   summaryMarkdown?: string,
 *   finalMarkdown?: string,
 *   finalTitle?: string,
 *   workflowSteps?: Array<JsonObject>,
 *   sections?: RunDetailsSectionPayload[],
 *   followupTargets?: Array<JsonObject>,
 *   followupArtifacts?: RunFollowupArtifactPayload[],
 * }} RunDetailsPayload
 *
 * @typedef {{
 *   run?: DashboardRunPayload,
 *   details?: RunDetailsPayload,
 * }} RunDetailsPayloadResponse
 *
 * @typedef {{
 *   listRunsPage?: (input?: RunsPageInput) => RunsPagePayload | Promise<RunsPagePayload>,
 *   getRun?: (id: string) => DashboardRunPayload | null | Promise<DashboardRunPayload | null>,
 *   getRunGraph?: (id: string) => Promise<RunGraphPayload | null>,
 *   getRunDetails?: (id: string) => Promise<RunDetailsPayloadResponse | null>,
 *   getRunState?: (id: string) => JsonObject | null,
 * }} RunStore
 *
 * @typedef {{
 *   runId?: string,
 *   since?: number,
 * }} EventsInput
 *
 * @typedef {{
 *   id?: number,
 *   schemaVersion?: number,
 *   seq?: number,
 *   eventId?: string,
 *   type?: string,
 *   at?: string,
 *   runId?: string,
 *   flowId?: string,
 *   flowTitle?: string,
 *   status?: string,
 *   stepId?: string,
 *   stepTitle?: string,
 *   agent?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   issueNumber?: number | null,
 *   issueUrl?: string,
 *   links?: Record<string, unknown>,
 *   command?: string[],
 *   exitCode?: number | null,
 *   signal?: string | null,
 *   durationMs?: number,
 *   text?: string,
 *   message?: string,
 * }} RunnerEventPayload
 *
 * @typedef {{
 *   line?: number | string,
 *   path?: string,
 *   message?: string,
 *   error?: string,
 * }} EventReplayErrorPayload
 *
 * @typedef {{
 *   run: DashboardRunPayload,
 *   events: RunnerEventPayload[],
 *   errors: EventReplayErrorPayload[],
 *   polling?: boolean,
 * }} EventsReplay
 *
 * @typedef {{
 *   listEvents?: (input?: EventsInput) => EventsReplay | null | Promise<EventsReplay | null>,
 * }} EventStore
 *
 * @typedef {{
 *   listActiveRuns?: () => DashboardRunPayload[],
 *   getActiveRun?: (id: string) => DashboardRunPayload | null,
 *   getActiveEvents?: (id: string, since?: number) => EventsReplay | null,
 * }} LiveRuns
 *
 * @typedef {{ statusCode?: number, body: JsonObject }} DashboardMutationEnvelope
 * @typedef {DashboardMutationEnvelope | JsonObject | null} DashboardMutationResult
 *
 * @typedef {{
 *   openFile?: (body: JsonObject) => Promise<DashboardMutationResult>,
 *   dryRunWorkflow?: (id: string, body: JsonObject) => Promise<DashboardMutationResult>,
 *   startWorkflow?: (id: string, body: JsonObject) => Promise<DashboardMutationResult>,
 *   cancelRun?: (id: string, body: JsonObject) => Promise<DashboardMutationResult>,
 *   approveReview?: (id: string, body: JsonObject) => Promise<DashboardMutationResult>,
 *   cancelReview?: (id: string, body: JsonObject) => Promise<DashboardMutationResult>,
 *   retryAgentRun?: (id: string, body: JsonObject) => Promise<DashboardMutationResult>,
 *   submitFollowup?: (id: string, body: JsonObject) => Promise<DashboardMutationResult>,
 *   cancelFollowup?: (id: string, body: JsonObject) => Promise<DashboardMutationResult>,
 * }} DashboardMutations
 *
 * @typedef {{
 *   readText?: (path: string) => Promise<string | null> | string | null,
 *   writeText?: (path: string, body: string) => Promise<void> | void,
 *   list?: (prefix: string) => Promise<string[]> | string[],
 * }} ArtifactStore
 *
 * @typedef {{
 *   get?: (key: string) => Promise<Uint8Array | string | null> | Uint8Array | string | null,
 *   set?: (key: string, value: Uint8Array | string, metadata?: Record<string, unknown>) => Promise<void> | void,
 *   delete?: (key: string) => Promise<void> | void,
 * }} BlobStore
 *
 * @typedef {{
 *   submit?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   cancel?: (id: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   status?: (id: string) => Promise<Record<string, unknown> | null>,
 * }} AgentRunnerTransport
 */

module.exports = {}
