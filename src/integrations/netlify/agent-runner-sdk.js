const { randomUUID } = require('crypto')
const {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  createAgentRunnerSdk,
  createNetlifyBlobStore,
  compactPromptByBytes,
  parseHandle,
} = require('nax-agent-runner-sdk')

const DEFAULT_DEADLINE_MS = 25 * 60 * 1000
const DEFAULT_RETRY_ATTEMPTS = 5
const DEFAULT_RETRY_DELAY_MS = 5000

/**
 * @typedef {import('nax-agent-runner-sdk').AgentRunnerSdk} AgentRunnerSdk
 * @typedef {import('nax-agent-runner-sdk').Handle} Handle
 * @typedef {import('nax-agent-runner-sdk').Runner} Runner
 * @typedef {import('nax-agent-runner-sdk').Session} Session
 *
 * @typedef {{
 *   sdk?: AgentRunnerSdk,
 *   transport?: import('nax-agent-runner-sdk').Transport,
 *   blobStore?: import('nax-agent-runner-sdk').BlobStore,
 *   env?: NodeJS.ProcessEnv,
 *   siteId?: string,
 *   promptTenant?: string,
 *   compactPromptText?: string,
 *   safePromptBytes?: number,
 *   promptBlobDisable?: boolean,
 *   retryAttempts?: number,
 *   retryDelayMs?: number,
 *   sleepFn?: (ms: number) => Promise<unknown>,
 *   onRetry?: (event: {
 *     error: Error,
 *     attempt: number,
 *     nextAttempt: number,
 *     attempts: number,
 *     delayMs: number,
 *   }) => void,
 * }} NaxAgentRunnerSdkOptions
 */

/** @param {NaxAgentRunnerSdkOptions} [options] @returns {AgentRunnerSdk} */
function createNaxAgentRunnerSdk({
  sdk,
  transport,
  blobStore: configuredBlobStore,
  env = process.env,
  siteId,
  promptTenant,
  compactPromptText = '',
  safePromptBytes,
  promptBlobDisable = false,
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleepFn,
  onRetry = () => {},
} = {}) {
  if (sdk) return sdk
  const attempts = Math.max(1, Math.floor(Number(retryAttempts) || DEFAULT_RETRY_ATTEMPTS))
  const delayMs = Math.max(0, Math.floor(Number(retryDelayMs) || DEFAULT_RETRY_DELAY_MS))
  const token = String(env.NETLIFY_AUTH_TOKEN || '').trim()
  const resolvedSiteId = String(siteId || env.NETLIFY_SITE_ID || '').trim()
  const blobStore = configuredBlobStore || (
    !promptBlobDisable && resolvedSiteId && token
      ? createNetlifyBlobStore({
          siteId: resolvedSiteId,
          token,
        })
      : undefined
  )
  const compact = compactPromptText
    ? (_prompt, { maxBytes }) => compactPromptByBytes(
        compactPromptText,
        { maxBytes },
      )
    : undefined
  return createAgentRunnerSdk({
    env,
    ...(transport ? { transport } : {}),
    retryAttempts: attempts,
    baseRetryDelayMs: delayMs,
    maxRetryDelayMs: delayMs,
    ...(blobStore ? { blobStore } : {}),
    promptDelivery: {
      env,
      ...(safePromptBytes === undefined ? {} : { safeBytes: safePromptBytes }),
      ...(promptTenant ? { tenant: promptTenant } : {}),
      ...(compact ? { compact } : {}),
    },
    ...(sleepFn ? { sleep: sleepFn } : {}),
    onTelemetry: (event) => {
      if (event.kind !== 'httpFailure' || event.retrying !== true) return
      onRetry({
        error: new Error(`Netlify Agent Runner API returned HTTP ${event.status}.`),
        attempt: event.attempt,
        nextAttempt: event.attempt + 1,
        attempts: event.maxAttempts,
        delayMs,
      })
    },
  })
}

/**
 * Safe delivery metadata copied from an SDK handle into nax artifacts.
 * Fetch commands and credentials intentionally remain SDK-private.
 *
 * @param {Handle} handle
 * @returns {import('../../types').AgentRun['promptDelivery']}
 */
function promptDeliveryArtifact(handle) {
  const delivery = handle.promptDelivery
  if (!delivery) return undefined
  const promptRef = delivery.promptRef
  return {
    mode: delivery.kind,
    safePromptBytes: delivery.safeBytes,
    promptBytes: delivery.semanticBytes || 0,
    submittedPromptBytes: delivery.submittedBytes,
    ...(promptRef
      ? {
          blobRef: {
            store: promptRef.store,
            key: promptRef.key,
            tenant: promptRef.tenant,
            expiresAt: promptRef.expiresAt,
            sentinel: delivery.sentinel || '',
            owner: 'nax-agent-runner-sdk',
            status: 'active',
          },
        }
      : {}),
  }
}

/** @param {unknown} value @returns {Handle | null} */
function parsePersistedHandle(value) {
  if (!value) return null
  try {
    return parseHandle(value)
  } catch {
    return null
  }
}

/**
 * Reconstruct the minimum safe handle needed to continue a pre-SDK nax
 * artifact. New submissions always persist the original full-fidelity handle.
 *
 * @param {{
 *   sdk: AgentRunnerSdk,
 *   run?: import('../../types').AgentRun,
 *   runnerId?: string,
 *   siteId?: string,
 *   agent?: string,
 *   promptText?: string,
 *   branch?: string,
 *   deadlineMs?: number,
 * }} input
 * @returns {Promise<Handle>}
 */
async function resolveRunHandle({
  sdk,
  run = {},
  runnerId = run.runnerId || run.existingRunnerId,
  siteId = run.netlifySiteId,
  agent = run.agent,
  promptText = run.promptText,
  branch,
  deadlineMs = DEFAULT_DEADLINE_MS,
}) {
  const persisted = parsePersistedHandle(run.sdkHandle || run.raw?.sdkHandle)
  if (persisted) return persisted
  if (!runnerId) throw new Error('Netlify agent runner ID is required.')
  if (!siteId) {
    throw new Error(
      `Netlify site ID is required to resume legacy Agent Runner ${runnerId}.`,
    )
  }
  const sessions = await sdk.transport.listSessions(runnerId)
  const requestedSessionId = String(run.sessionId || '').trim()
  const current = (
    requestedSessionId
      ? sessions.find((session) => session.sessionId === requestedSessionId)
      : null
  ) || sessions[sessions.length - 1]
  if (!current?.sessionId) {
    throw new Error(
      `Could not resolve a current session for legacy Agent Runner ${runnerId}.`,
    )
  }
  const requestId = randomUUID()
  const resolvedDeadlineMs = Math.max(0, Number(deadlineMs) || DEFAULT_DEADLINE_MS)
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'run',
    runnerId,
    siteId,
    agent: agent || current.agent || 'claude',
    input: {
      siteId,
      prompt: promptText || current.prompt || 'Resume legacy nax Agent Runner.',
      agent: agent || current.agent || 'claude',
      ...(branch ? { branch } : {}),
      land: 'none',
      deadlineMs: resolvedDeadlineMs,
      retryBudget: { capacity: 1 },
      requestId,
    },
    policy: {
      landing: 'none',
      deadlineAt: Date.now() + resolvedDeadlineMs,
      retryBudget: { capacity: 1 },
    },
    retries: {
      capacity: Math.max(0, Number(run.autoRetryCount || 0)),
    },
    currentSessionId: current.sessionId,
  }
}

/** @param {Runner} runner */
function runnerArtifactPayload(runner) {
  return {
    id: runner.runnerId,
    state: runner.state,
    ...(runner.siteId ? { site_id: runner.siteId } : {}),
    ...(runner.siteName ? { site_name: runner.siteName } : {}),
    ...(runner.branch ? { branch: runner.branch } : {}),
    ...(runner.title ? { title: runner.title } : {}),
    ...(runner.codeOrigin ? { code_origin: runner.codeOrigin } : {}),
    ...(runner.createdAt !== undefined ? { created_at: new Date(runner.createdAt).toISOString() } : {}),
    ...(runner.updatedAt !== undefined ? { updated_at: new Date(runner.updatedAt).toISOString() } : {}),
    ...(runner.doneAt !== undefined ? { done_at: new Date(runner.doneAt).toISOString() } : {}),
    ...(runner.currentTask ? { current_task: runner.currentTask } : {}),
    ...(runner.latestSessionState ? { latest_session_state: runner.latestSessionState } : {}),
    ...(runner.hasResultDiff !== undefined ? { has_result_diff: runner.hasResultDiff } : {}),
    ...(runner.prUrl ? { pr_url: runner.prUrl } : {}),
    ...(runner.prNumber !== undefined ? { pr_number: runner.prNumber } : {}),
    ...(runner.prBranch ? { pr_branch: runner.prBranch } : {}),
    ...(runner.mergeCommitSha ? { merge_commit_sha: runner.mergeCommitSha } : {}),
  }
}

/** @param {Session} session */
function sessionArtifactPayload(session) {
  return {
    id: session.sessionId,
    agent_runner_id: session.runnerId,
    state: session.state,
    ...(session.prompt !== undefined ? { prompt: session.prompt } : {}),
    ...(session.resultText !== undefined ? { result: session.resultText } : {}),
    ...(session.title ? { title: session.title } : {}),
    ...(session.agent ? { agent_config: { agent: session.agent } } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.mode ? { mode: session.mode } : {}),
    ...(session.fileKeys ? { attached_file_keys: session.fileKeys } : {}),
    ...(session.createdAt !== undefined ? { created_at: new Date(session.createdAt).toISOString() } : {}),
    ...(session.updatedAt !== undefined ? { updated_at: new Date(session.updatedAt).toISOString() } : {}),
    ...(session.doneAt !== undefined ? { done_at: new Date(session.doneAt).toISOString() } : {}),
    ...(session.currentTask ? { current_task: session.currentTask } : {}),
    ...(session.commitSha ? { commit_sha: session.commitSha } : {}),
    ...(session.deployId ? { deploy_id: session.deployId } : {}),
    ...(session.deployUrl ? { deploy_url: session.deployUrl } : {}),
    ...(session.hasResultDiff !== undefined ? { has_result_diff: session.hasResultDiff } : {}),
    ...(session.hasCumulativeDiff !== undefined ? { has_cumulative_diff: session.hasCumulativeDiff } : {}),
    ...(session.creditLimitExceeded !== undefined ? { credit_limit_exceeded: session.creditLimitExceeded } : {}),
    ...(session.creditLimitExceededMessage ? { credit_limit_exceeded_message: session.creditLimitExceededMessage } : {}),
    ...(session.usage ? { usage: session.usage } : {}),
  }
}

module.exports = {
  createNaxAgentRunnerSdk,
  parsePersistedHandle,
  promptDeliveryArtifact,
  resolveRunHandle,
  runnerArtifactPayload,
  sessionArtifactPayload,
}
