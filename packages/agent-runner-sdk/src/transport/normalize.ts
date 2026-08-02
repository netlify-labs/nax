import {
  InvalidApiShapeError,
} from '../errors.js'
import type {
  AgentRunnerApiStyle,
} from './types.js'
import type {
  Runner,
  Session,
  Usage,
} from '../domain.js'

type EntityKind = 'runner' | 'session'

export interface NormalizationOptions {
  apiStyle: AgentRunnerApiStyle
  endpoint: string
  reportUnknownField: (entity: EntityKind, field: string) => void
}

const RUNNER_FIELDS = new Set([
  'active_session_created_at',
  'activeSessionCreatedAt',
  'attached_file_keys',
  'attachedFileKeys',
  'base_deploy_id',
  'baseDeployId',
  'branch',
  'code_origin',
  'codeOrigin',
  'contributors',
  'created_at',
  'createdAt',
  'current_task',
  'currentTask',
  'done_at',
  'doneAt',
  'has_result_diff',
  'hasResultDiff',
  'id',
  'last_session_created_at',
  'lastSessionCreatedAt',
  'latest_session_is_published',
  'latestSessionIsPublished',
  'latest_session_mode',
  'latestSessionMode',
  'latest_session_state',
  'latestSessionState',
  'merge_commit_error',
  'mergeCommitError',
  'merge_commit_is_being_created',
  'mergeCommitIsBeingCreated',
  'merge_commit_sha',
  'mergeCommitSha',
  'merge_target_available',
  'mergeTargetAvailable',
  'needs_git_sync',
  'needsGitSync',
  'parent_agent_runner_id',
  'parentAgentRunnerId',
  'pr_branch',
  'prBranch',
  'pr_error',
  'prError',
  'pr_is_being_created',
  'prIsBeingCreated',
  'pr_number',
  'prNumber',
  'pr_state',
  'prState',
  'pr_url',
  'prUrl',
  'rebase_available',
  'rebaseAvailable',
  'result_branch',
  'resultBranch',
  'sha',
  'site_git_provider',
  'siteGitProvider',
  'site_id',
  'siteId',
  'site_name',
  'siteName',
  'state',
  'title',
  'updated_at',
  'updatedAt',
  'user',
])

const SESSION_FIELDS = new Set([
  'agent_config',
  'agentConfig',
  'agent_runner_id',
  'agentRunnerId',
  'attached_file_keys',
  'attachedFileKeys',
  'base_sha',
  'baseSha',
  'commit_sha',
  'commitSha',
  'created_at',
  'createdAt',
  'credit_limit_exceeded',
  'creditLimitExceeded',
  'credit_limit_exceeded_message',
  'creditLimitExceededMessage',
  'current_task',
  'currentTask',
  'deploy_id',
  'deployId',
  'deploy_url',
  'deployUrl',
  'dev_server_id',
  'devServerId',
  'done_at',
  'doneAt',
  'duration',
  'has_cumulative_diff',
  'hasCumulativeDiff',
  'has_result_diff',
  'hasResultDiff',
  'id',
  'is_discarded',
  'isDiscarded',
  'is_published',
  'isPublished',
  'mode',
  'prompt',
  'result',
  'result_zip_file_name',
  'resultZipFileName',
  'state',
  'steps',
  'steps_count',
  'stepsCount',
  'title',
  'updated_at',
  'updatedAt',
  'usage',
  'user',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function field(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
  apiStyle: AgentRunnerApiStyle,
): unknown {
  if (Object.hasOwn(value, snake)) return value[snake]
  if (apiStyle === 'bb-api' && Object.hasOwn(value, camel)) {
    return value[camel]
  }
  return undefined
}

function requiredString(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
  options: NormalizationOptions,
): string {
  const selected = field(value, snake, camel, options.apiStyle)
  if (typeof selected !== 'string' || selected.length === 0) {
    throw new InvalidApiShapeError(options.endpoint, snake)
  }
  return selected
}

function optionalString(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
  apiStyle: AgentRunnerApiStyle,
): string | undefined {
  const selected = field(value, snake, camel, apiStyle)
  return typeof selected === 'string' && selected.length > 0
    ? selected
    : undefined
}

function optionalBoolean(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
  apiStyle: AgentRunnerApiStyle,
): boolean | undefined {
  const selected = field(value, snake, camel, apiStyle)
  return typeof selected === 'boolean' ? selected : undefined
}

function optionalNumber(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
  apiStyle: AgentRunnerApiStyle,
): number | undefined {
  const selected = field(value, snake, camel, apiStyle)
  return typeof selected === 'number' && Number.isFinite(selected)
    ? selected
    : undefined
}

function timestamp(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
  apiStyle: AgentRunnerApiStyle,
): number | undefined {
  const selected = field(value, snake, camel, apiStyle)
  if (typeof selected === 'number' && Number.isFinite(selected)) {
    return selected
  }
  if (typeof selected !== 'string') return undefined
  const parsed = Date.parse(selected)
  return Number.isFinite(parsed) ? parsed : undefined
}

function addOptional<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined,
): asserts target is T & Record<K, V> {
  if (value !== undefined) Object.assign(target, { [key]: value })
}

function reportUnknown(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  entity: EntityKind,
  report: NormalizationOptions['reportUnknownField'],
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) report(entity, key)
  }
}

function normalizeUsage(value: unknown): Usage | null {
  const source = record(value)
  if (!source) return null
  const usage: Usage = {}
  addOptional(usage, 'totalTokens', optionalNumber(
    source,
    'total_tokens',
    'totalTokens',
    'bb-api',
  ))
  addOptional(usage, 'totalInputTokens', optionalNumber(
    source,
    'total_input_tokens',
    'totalInputTokens',
    'bb-api',
  ))
  addOptional(usage, 'totalOutputTokens', optionalNumber(
    source,
    'total_output_tokens',
    'totalOutputTokens',
    'bb-api',
  ))
  addOptional(usage, 'totalCachedInputTokens', optionalNumber(
    source,
    'total_cached_input_tokens',
    'totalCachedInputTokens',
    'bb-api',
  ))
  addOptional(usage, 'totalCachedOutputTokens', optionalNumber(
    source,
    'total_cached_output_tokens',
    'totalCachedOutputTokens',
    'bb-api',
  ))
  addOptional(usage, 'totalCreditsCost', optionalNumber(
    source,
    'total_credits_cost',
    'totalCreditsCost',
    'bb-api',
  ))
  return usage
}

export function normalizeRunner(
  value: unknown,
  options: NormalizationOptions,
): Runner {
  const source = record(value)
  if (!source) throw new InvalidApiShapeError(options.endpoint, 'response')
  reportUnknown(source, RUNNER_FIELDS, 'runner', options.reportUnknownField)

  const runner: Runner = {
    runnerId: requiredString(source, 'id', 'runnerId', options),
    state: requiredString(source, 'state', 'state', options),
  }
  const style = options.apiStyle
  addOptional(runner, 'siteId', optionalString(source, 'site_id', 'siteId', style))
  addOptional(runner, 'siteName', optionalString(source, 'site_name', 'siteName', style))
  addOptional(runner, 'branch', optionalString(source, 'branch', 'branch', style))
  addOptional(runner, 'title', optionalString(source, 'title', 'title', style))
  addOptional(runner, 'codeOrigin', optionalString(source, 'code_origin', 'codeOrigin', style))
  addOptional(runner, 'createdAt', timestamp(source, 'created_at', 'createdAt', style))
  addOptional(runner, 'updatedAt', timestamp(source, 'updated_at', 'updatedAt', style))
  addOptional(runner, 'doneAt', timestamp(source, 'done_at', 'doneAt', style))
  addOptional(runner, 'lastSessionCreatedAt', timestamp(
    source,
    'last_session_created_at',
    'lastSessionCreatedAt',
    style,
  ))
  addOptional(runner, 'activeSessionCreatedAt', timestamp(
    source,
    'active_session_created_at',
    'activeSessionCreatedAt',
    style,
  ))
  addOptional(runner, 'currentTask', optionalString(source, 'current_task', 'currentTask', style))
  addOptional(runner, 'latestSessionState', optionalString(
    source,
    'latest_session_state',
    'latestSessionState',
    style,
  ))
  addOptional(runner, 'latestSessionMode', optionalString(
    source,
    'latest_session_mode',
    'latestSessionMode',
    style,
  ))
  addOptional(runner, 'latestSessionIsPublished', optionalBoolean(
    source,
    'latest_session_is_published',
    'latestSessionIsPublished',
    style,
  ))
  addOptional(runner, 'hasResultDiff', optionalBoolean(source, 'has_result_diff', 'hasResultDiff', style))
  addOptional(runner, 'needsGitSync', optionalBoolean(source, 'needs_git_sync', 'needsGitSync', style))
  addOptional(runner, 'mergeTargetAvailable', optionalBoolean(
    source,
    'merge_target_available',
    'mergeTargetAvailable',
    style,
  ))
  addOptional(runner, 'prUrl', optionalString(source, 'pr_url', 'prUrl', style))
  addOptional(runner, 'prNumber', optionalNumber(source, 'pr_number', 'prNumber', style))
  addOptional(runner, 'prBranch', optionalString(source, 'pr_branch', 'prBranch', style))
  addOptional(runner, 'prState', optionalString(source, 'pr_state', 'prState', style))
  addOptional(runner, 'prError', optionalString(source, 'pr_error', 'prError', style))
  addOptional(runner, 'prIsBeingCreated', optionalBoolean(
    source,
    'pr_is_being_created',
    'prIsBeingCreated',
    style,
  ))
  addOptional(runner, 'mergeCommitSha', optionalString(
    source,
    'merge_commit_sha',
    'mergeCommitSha',
    style,
  ))
  addOptional(runner, 'mergeCommitError', optionalString(
    source,
    'merge_commit_error',
    'mergeCommitError',
    style,
  ))
  addOptional(runner, 'mergeCommitIsBeingCreated', optionalBoolean(
    source,
    'merge_commit_is_being_created',
    'mergeCommitIsBeingCreated',
    style,
  ))
  return runner
}

export function normalizeSession(
  value: unknown,
  options: NormalizationOptions,
): Session {
  const source = record(value)
  if (!source) throw new InvalidApiShapeError(options.endpoint, 'response')
  reportUnknown(source, SESSION_FIELDS, 'session', options.reportUnknownField)

  const session: Session = {
    sessionId: requiredString(source, 'id', 'sessionId', options),
    runnerId: requiredString(
      source,
      'agent_runner_id',
      'agentRunnerId',
      options,
    ),
    state: requiredString(source, 'state', 'state', options),
    usage: normalizeUsage(field(source, 'usage', 'usage', options.apiStyle)),
  }
  const style = options.apiStyle
  addOptional(session, 'prompt', optionalString(source, 'prompt', 'prompt', style))
  addOptional(session, 'resultText', optionalString(source, 'result', 'result', style))
  addOptional(session, 'title', optionalString(source, 'title', 'title', style))
  const agentConfig = record(field(source, 'agent_config', 'agentConfig', style))
  if (agentConfig) {
    addOptional(session, 'agent', optionalString(agentConfig, 'agent', 'agent', style))
    addOptional(session, 'model', optionalString(agentConfig, 'model', 'model', style))
  }
  addOptional(session, 'mode', optionalString(source, 'mode', 'mode', style))
  addOptional(session, 'createdAt', timestamp(source, 'created_at', 'createdAt', style))
  addOptional(session, 'updatedAt', timestamp(source, 'updated_at', 'updatedAt', style))
  addOptional(session, 'doneAt', timestamp(source, 'done_at', 'doneAt', style))
  addOptional(session, 'currentTask', optionalString(source, 'current_task', 'currentTask', style))
  addOptional(session, 'commitSha', optionalString(source, 'commit_sha', 'commitSha', style))
  addOptional(session, 'deployId', optionalString(source, 'deploy_id', 'deployId', style))
  addOptional(session, 'deployUrl', optionalString(source, 'deploy_url', 'deployUrl', style))
  addOptional(session, 'hasResultDiff', optionalBoolean(source, 'has_result_diff', 'hasResultDiff', style))
  addOptional(session, 'hasCumulativeDiff', optionalBoolean(
    source,
    'has_cumulative_diff',
    'hasCumulativeDiff',
    style,
  ))
  addOptional(session, 'isPublished', optionalBoolean(source, 'is_published', 'isPublished', style))
  addOptional(session, 'isDiscarded', optionalBoolean(source, 'is_discarded', 'isDiscarded', style))
  addOptional(session, 'creditLimitExceeded', optionalBoolean(
    source,
    'credit_limit_exceeded',
    'creditLimitExceeded',
    style,
  ))
  addOptional(session, 'creditLimitExceededMessage', optionalString(
    source,
    'credit_limit_exceeded_message',
    'creditLimitExceededMessage',
    style,
  ))
  const stepsCount = optionalNumber(source, 'steps_count', 'stepsCount', style)
  if (stepsCount !== undefined) {
    session.usage = { ...(session.usage ?? {}), stepsCount }
  }
  if (session.creditLimitExceeded !== undefined) {
    session.usage = {
      ...(session.usage ?? {}),
      creditLimitExceeded: session.creditLimitExceeded,
    }
  }
  return session
}
