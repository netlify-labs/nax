/**
 * Opaque JSON-like metadata whose keys are not known at this boundary.
 * @typedef {Record<string, unknown>} JsonMap
 *
 * Environment variables passed into child processes.
 * @typedef {Record<string, string | undefined>} StringEnv
 *
 * Empty map used before string links are populated.
 * @typedef {Record<PropertyKey, never>} EmptyMap
 *
 * String-only maps used for URLs, headers, and replacement dictionaries.
 * @typedef {Record<string, string | undefined> | EmptyMap} StringMap
 */

/**
 * Token, credit, and step-count usage normalized from Netlify agent results.
 * @typedef {{
 *   totalTokens?: number,
 *   total_tokens?: number,
 *   totalCreditsCost?: number,
 *   total_credits_cost?: number,
 *   stepsCount?: number,
 *   steps_count?: number,
 *   creditLimitExceeded?: boolean,
 *   credit_limit_exceeded?: boolean,
 * }} UsageSummary
 *
 * Normalized file-change metadata reported by a runner or session.
 * @typedef {{
 *   hasChanges?: boolean,
 *   hasSessionDiff?: boolean,
 *   hasRunnerDiff?: boolean,
 *   hasCumulativeDiff?: boolean,
 *   commitSha?: string,
 *   resultZipFileName?: string,
 *   attachedFileKeys?: string[],
 * }} FileChangesSummary
 */

/**
 * Git target information persisted on workflow runs and review context.
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   label?: string,
 *   branch?: string,
 *   ref?: string,
 *   sha?: string | null,
 *   sourceType?: string,
 *   verified?: boolean,
 *   caveats?: string[],
 *   agent?: string,
 *   mode?: string,
 *   status?: string,
 *   absolutePath?: string,
 *   path?: string,
 *   markdown?: string,
 *   defaultSelected?: boolean,
 *   isDefault?: boolean,
 * }} TargetLike
 *
 * Dashboard follow-up target or selectable artifact descriptor.
 * @typedef {TargetLike & {
 *   kind?: string,
 *   title?: string,
 *   summaryPath?: string,
 *   displayPath?: string,
 * }} FollowupTarget
 */

/**
 * One input dependency declared by a flow step.
 * @typedef {Record<string, unknown> & {
 *   step?: string,
 *   stepId?: string,
 *   id?: string,
 *   name?: string,
 * }} StepInput
 *
 * A workflow step definition merged with its durable runtime state.
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   title?: string,
 *   description?: string,
 *   prompt?: string,
 *   type?: string,
 *   action?: string,
 *   submit?: string,
 *   waitFor?: string,
 *   agents?: string[],
 *   input?: StepInput[],
 *   runs?: AgentRun[],
 *   status?: string,
 *   source?: JsonMap,
 *   review?: JsonMap,
 *   blobRefs?: BlobRef[],
 *   promptBlobRef?: BlobRef,
 * }} WorkflowStep
 *
 * Nax workflow definition loaded from a flow.yml file.
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   title?: string,
 *   description?: string,
 *   disabled?: boolean,
 *   dir?: string,
 *   file?: string,
 *   source?: string,
 *   sourceDir?: string,
 *   sourceLabel?: string,
 *   sourcePriority?: number,
 *   defaults?: {
 *     transport?: string,
 *     notify?: boolean,
 *     agents?: string[],
 *   },
 *   options?: JsonMap,
 *   steps?: WorkflowStep[],
 * }} WorkflowFlow
 *
 * Durable workflow state stored under .nax/workflows/<runId>/state.json.
 * @typedef {Record<string, unknown> & {
 *   schemaVersion?: number,
 *   generatedBy?: { name?: string, version?: string },
 *   runId?: string,
 *   flowId?: string,
 *   flowTitle?: string,
 *   flow?: WorkflowFlow,
 *   transport?: string,
 *   projectRoot?: string,
 *   dir?: string,
 *   status?: string,
 *   branch?: string,
 *   branchSource?: string,
 *   target?: TargetLike | null,
 *   source?: JsonMap,
 *   options?: JsonMap,
 *   context?: JsonMap,
 *   steps?: WorkflowStep[],
 *   blobRefs?: BlobRef[],
 *   createdAt?: string,
 *   updatedAt?: string,
 *   dismissedAt?: string,
 *   dismissReason?: string,
 *   githubStepSummary?: string,
 *   remoteCancel?: JsonMap,
 *   warnings?: string[],
 *   cancelledAt?: string,
 *   cancelReason?: string,
 * }} WorkflowRunState
 */

/**
 * Runtime status for a submitted model invocation, local runner submission, or GitHub-backed agent issue.
 * @typedef {{
 *   transport?: string,
 *   agent?: string,
 *   model?: string,
 *   status?: string,
 *   promptText?: string,
 *   compactPromptText?: string,
 *   resultText?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   issueNumber?: number,
 *   issueUrl?: string,
 *   commentUrl?: string,
 *   prUrl?: string,
 *   deployUrl?: string,
 *   actionRunUrl?: string,
 *   existingRunnerId?: string,
 *   links?: StringMap,
 *   usage?: UsageSummary,
 *   creditLimitExceeded?: boolean,
 *   stepsCount?: number,
 *   fileChanges?: FileChangesSummary,
 *   source?: JsonMap,
 *   raw?: JsonMap,
 *   rawResult?: JsonMap & {
 *     latestSession?: JsonMap & { state?: string },
 *     runner?: JsonMap,
 *     session?: JsonMap,
 *     sessions?: unknown,
 *   },
 *   latest?: JsonMap,
 *   promptDelivery?: { blobRef?: BlobRef, [key: string]: unknown },
 *   contextFetchStatus?: string,
 *   contextFetchSignals?: string[],
 *   contextFetchConfirmed?: boolean,
 *   blobRef?: BlobRef,
 *   archived?: boolean,
 *   archivedAt?: string,
 *   archiveError?: string,
 *   cancelledAt?: string,
 *   cancelReason?: string,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   submittedAfterSeconds?: number,
 *   autoRetryCount?: number,
 *   promptShrinkRetryCount?: number,
 *   error?: string,
 * }} AgentRun
 *
 * Materialized Netlify Agent Runner session artifact.
 * @typedef {{
 *   sessionId?: string,
 *   runnerId?: string,
 *   agent?: string,
 *   status?: string,
 *   resultText?: string,
 *   stepId?: string,
 *   sourceStep?: string,
 *   usage?: UsageSummary,
 *   fileChanges?: FileChangesSummary,
 *   links?: StringMap,
 *   source?: JsonMap,
 *   raw?: JsonMap,
 *   createdAt?: string,
 *   updatedAt?: string,
 * }} AgentSession
 *
 * Materialized Netlify Agent Runner artifact, optionally with session summaries.
 * @typedef {{
 *   runnerId?: string,
 *   agent?: string,
 *   status?: string,
 *   latestSessionId?: string,
 *   sessionIds?: string[],
 *   sessions?: AgentSession[],
 *   usage?: UsageSummary,
 *   fileChanges?: FileChangesSummary,
 *   links?: StringMap,
 *   source?: JsonMap,
 *   raw?: JsonMap,
 *   latest?: JsonMap,
 *   createdAt?: string,
 *   updatedAt?: string,
 * }} AgentRunner
 */

/**
 * Tracked Netlify Blob reference used for offloaded prompts and cleanup.
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   runId?: string,
 *   stepId?: string,
 *   store?: string,
 *   key?: string,
 *   marker?: string,
 *   sentinel?: string,
 *   kind?: string,
 *   status?: string,
 *   localPath?: string,
 *   localMetadataPath?: string,
 *   localBytes?: number,
 *   cleanupAttempts?: number,
 *   lastCleanupError?: string,
 *   createdAt?: string,
 *   updatedAt?: string,
 *   cleanedAt?: string,
 * }} BlobRef
 *
 * Result from a blob cleanup attempt.
 * @typedef {{
 *   ref: BlobRef,
 *   ok: boolean,
 *   dryRun?: boolean,
 *   error?: unknown,
 * }} BlobCleanupResult
 */

/**
 * Normalized command result returned by sync command wrappers.
 * @typedef {{
 *   status?: number | null,
 *   stdout?: string,
 *   stderr?: string,
 *   error?: (Error & { code?: string, killed?: boolean }) | null,
 *   signal?: string | null,
 *   timeoutMs?: number,
 *   detail?: string,
 * }} CommandResult
 *
 * Callback used by command-wrapper injection points.
 * @typedef {(command: string, args: string[], options?: Record<string, unknown>) => CommandResult} RunCommand
 *
 * Generic event sink for runner, workflow, notification, and dashboard events.
 * @typedef {(event: JsonMap) => void} EventSink
 */

/**
 * Shape returned by GitHub issue/comment queries.
 * @typedef {Record<string, unknown> & {
 *   number?: number,
 *   title?: string,
 *   url?: string,
 *   body?: string,
 *   author?: { login?: string },
 *   comments?: GitHubComment[],
 *   createdAt?: string,
 *   updatedAt?: string,
 * }} GitHubIssue
 *
 * GitHub issue or pull request comment body used as an agent response.
 * @typedef {Record<string, unknown> & {
 *   body?: string,
 *   url?: string,
 *   author?: { login?: string },
 *   createdAt?: string,
 * }} GitHubComment
 */

/**
 * Follow-up delivery payload written to Netlify Blobs.
 * @typedef {{
 *   ref: BlobRef,
 *   payload: string,
 * }} BlobWriteInput
 *
 * Function that persists offloaded context to blob storage.
 * @typedef {(input: BlobWriteInput) => unknown | Promise<unknown>} BlobWriter
 */

module.exports = {}
