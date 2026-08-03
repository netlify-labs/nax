import type {
  FailureCategory,
  FailureClassification,
  FailureSeverity,
  FailureStage,
} from '../domain.js'
import {
  HttpResponseError,
  isAgentRunnerSdkError,
} from '../errors.js'

export interface FailureProfile {
  category: FailureCategory
  code: string
  title: string
  message: string
  remediation: readonly string[]
  severity: FailureSeverity
  retryable: boolean
  userActionRequired: boolean
  stage: FailureStage
}

export interface FailureContext {
  stage?: FailureStage
  terminal?: 'runner' | 'session'
}

function profile(
  value: FailureProfile,
): Readonly<FailureProfile> {
  return Object.freeze({
    ...value,
    remediation: Object.freeze([...value.remediation]),
  })
}

export const CORE_FAILURE_PROFILES = Object.freeze({
  authentication: profile({
    category: 'authentication',
    code: 'authentication-failed',
    title: 'Netlify authentication failed',
    message: 'The Agent Runner request could not authenticate to Netlify.',
    remediation: [
      'Provide a current Netlify personal access token.',
      'Run `netlify login` when using local CLI token discovery.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate',
  }),
  authMissing: profile({
    category: 'authentication',
    code: 'auth-missing',
    title: 'Netlify auth token is missing',
    message: 'A Netlify API token is required.',
    remediation: [
      'Pass a token explicitly or set `NETLIFY_AUTH_TOKEN`.',
      'Run `netlify login` when using local CLI token discovery.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate',
  }),
  authInvalid: profile({
    category: 'authentication',
    code: 'auth-invalid',
    title: 'Netlify auth token is invalid',
    message: 'The Netlify API token was rejected.',
    remediation: [
      'Replace the token with a current Netlify personal access token.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate',
  }),
  authExpired: profile({
    category: 'authentication',
    code: 'auth-expired',
    title: 'Netlify auth token expired',
    message: 'The Netlify API token has expired or was revoked.',
    remediation: [
      'Create and configure a new Netlify personal access token.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate',
  }),
  permission: profile({
    category: 'permission',
    code: 'permission-denied',
    title: 'Agent Runner access was denied',
    message: 'The authenticated account cannot perform this Agent Runner operation.',
    remediation: [
      'Verify that the token can access the target site and team.',
      'Verify that the site repository is covered by the Netlify GitHub Coding installation.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'transport',
  }),
  notFound: profile({
    category: 'not-found',
    code: 'not-found',
    title: 'Agent Runner resource was not found',
    message: 'The requested Netlify site, runner, or session does not exist or is not visible to this token.',
    remediation: [
      'Verify the site, runner, and session identifiers.',
      'Verify that the token belongs to an account with access to the target site.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'transport',
  }),
  validation: profile({
    category: 'validation',
    code: 'validation-error',
    title: 'Agent Runner input is invalid',
    message: 'The Agent Runner operation was rejected because its input or persisted handle is invalid.',
    remediation: [
      'Correct the reported input or handle field before retrying.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'validate',
  }),
  rateLimit: profile({
    category: 'rate-limit',
    code: 'rate-limited',
    title: 'Netlify API rate limit reached',
    message: 'Netlify rate limiting prevented the Agent Runner operation.',
    remediation: [
      'Allow the SDK retry policy to back off before creating a replacement attempt.',
    ],
    severity: 'warning',
    retryable: true,
    userActionRequired: false,
    stage: 'transport',
  }),
  transport: profile({
    category: 'transport',
    code: 'transport-failed',
    title: 'Agent Runner transport failed',
    message: 'The SDK could not complete the Agent Runner transport operation.',
    remediation: [
      'Inspect the typed transport error and retry the original operation only when its operation-specific policy permits it.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: false,
    stage: 'transport',
  }),
  capacity: profile({
    category: 'capacity',
    code: 'model-capacity',
    title: 'Agent capacity is temporarily unavailable',
    message: 'The selected agent or model is temporarily at capacity.',
    remediation: [
      'Allow the bounded SDK retry policy to create a replacement attempt.',
      'Select a different agent if capacity errors persist.',
    ],
    severity: 'warning',
    retryable: true,
    userActionRequired: false,
    stage: 'session',
  }),
  retryBudget: profile({
    category: 'capacity',
    code: 'capacity-exhausted',
    title: 'Agent Runner retry budget exhausted',
    message: 'The persisted Agent Runner retry budget has been exhausted.',
    remediation: [
      'Inspect the last safe retry reason before starting a new run.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'create',
  }),
  creditLimit: profile({
    category: 'capacity',
    code: 'credit-limit-exceeded',
    title: 'Agent Runner credit limit exceeded',
    message: 'The Agent Runner account credit limit was exceeded.',
    remediation: [
      'Review account usage and credit limits before starting another run.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'session',
  }),
  argvTooLong: profile({
    category: 'argv-too-long',
    code: 'argv-too-long',
    title: 'Prompt exceeds the process argument limit',
    message: 'The submitted prompt is too large for the current launch path.',
    remediation: [
      'Use prompt-reference delivery or reduce the inline prompt size.',
      'Do not retry the unchanged inline prompt.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'prompt',
  }),
  terminal: profile({
    category: 'terminal',
    code: 'session-terminal-failed',
    title: 'Agent Runner session failed',
    message: 'The Agent Runner session reached a failed terminal state.',
    remediation: [
      'Inspect the run result and logs for the underlying failure.',
      'Correct the underlying issue before starting a new logical attempt.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'session',
  }),
  timeout: profile({
    category: 'timeout',
    code: 'request-timeout',
    title: 'Agent Runner deadline expired',
    message: 'The Agent Runner operation exceeded its request or absolute run deadline.',
    remediation: [
      'Reduce the task scope or start a new run with an intentionally larger deadline.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'runner',
  }),
  cancelled: profile({
    category: 'cancelled',
    code: 'cancelled',
    title: 'Agent Runner operation was cancelled',
    message: 'The Agent Runner or current session was cancelled.',
    remediation: [
      'Start a new run only if cancellation was not intentional.',
    ],
    severity: 'warning',
    retryable: false,
    userActionRequired: false,
    stage: 'runner',
  }),
  prompt: profile({
    category: 'prompt',
    code: 'prompt-too-large',
    title: 'Agent Runner prompt delivery failed',
    message: 'The prompt could not be delivered under the configured size or lifetime policy.',
    remediation: [
      'Reduce the prompt size or create a fresh prompt reference.',
      'Do not silently extend an expired prompt reference.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'prompt',
  }),
  blob: profile({
    category: 'blob',
    code: 'blob-delivery-failed',
    title: 'Agent Runner blob delivery failed',
    message: 'The prompt or attachment blob could not be stored, fetched, verified, or removed.',
    remediation: [
      'Verify the tenant-scoped blob configuration and reference lifetime.',
      'Reuse the retained blob only while its reference remains valid.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'blob',
  }),
  apiDrift: profile({
    category: 'api-drift',
    code: 'invalid-api-shape',
    title: 'Agent Runner API contract changed',
    message: 'The Agent Runner API response is missing a required field or has an invalid shape.',
    remediation: [
      'Do not guess at the missing value or retry the same malformed response.',
      'Update the SDK contract after verifying the current API response.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'transport',
  }),
  ambiguity: profile({
    category: 'ambiguity',
    code: 'create-ambiguous',
    title: 'Agent Runner create outcome is ambiguous',
    message: 'The create request may have reached Netlify and must be reconciled before any replacement is created.',
    remediation: [
      'Use the typed request window and exact request marker to reconcile the create.',
      'Do not blindly replay the create when reconciliation returns none or ambiguous.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'create',
  }),
  landing: profile({
    category: 'landing',
    code: 'landing-failed',
    title: 'Agent Runner landing failed',
    message: 'The run succeeded, but its commit, pull request, merge, or publish step failed.',
    remediation: [
      'Inspect the independent landing outcome and resume from its persisted checkpoint.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'landing',
  }),
  platform: profile({
    category: 'platform',
    code: 'platform-server-error',
    title: 'Netlify Agent Runner service error',
    message: 'Netlify returned a transient Agent Runner server error.',
    remediation: [
      'Allow the bounded SDK retry policy to back off before creating a replacement attempt.',
      'Check Netlify service status if server errors persist.',
    ],
    severity: 'error',
    retryable: true,
    userActionRequired: false,
    stage: 'transport',
  }),
  unknown: profile({
    category: 'unknown',
    code: 'unknown-error',
    title: 'Unknown Agent Runner failure',
    message: 'The operation failed without matching a stable Agent Runner failure profile.',
    remediation: [
      'Inspect the typed error and logs before deciding whether a new attempt is safe.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'unknown',
  }),
})

function classification(
  value: Readonly<FailureProfile>,
  overrides: {
    code?: string
    stage?: FailureStage
    status?: number
  } = {},
): FailureClassification {
  return {
    category: value.category,
    code: overrides.code ?? value.code,
    title: value.title,
    message: value.message,
    remediation: [...value.remediation],
    severity: value.severity,
    retryable: value.retryable,
    userActionRequired: value.userActionRequired,
    stage: overrides.stage ?? value.stage,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string {
  const fieldValue = value?.[field]
  return typeof fieldValue === 'string' ? fieldValue : ''
}

function failureText(error: unknown): string {
  if (typeof error === 'string') return error.toLowerCase()
  if (error instanceof Error) return error.message.toLowerCase()
  const value = record(error)
  return [
    stringField(value, 'message'),
    stringField(value, 'error'),
    stringField(value, 'errorMessage'),
    stringField(value, 'stderr'),
    stringField(value, 'details'),
  ].filter(Boolean).join('\n').toLowerCase()
}

function statusFor(error: unknown): number | undefined {
  if (error instanceof HttpResponseError) return error.status
  const value = record(error)
  const candidate = value?.status ?? value?.statusCode
  return typeof candidate === 'number' && Number.isInteger(candidate)
    ? candidate
    : undefined
}

function codeFor(error: unknown): string {
  if (isAgentRunnerSdkError(error)) return error.code
  const code = record(error)?.code
  return typeof code === 'string' ? code.trim().toLowerCase() : ''
}

function withContext(
  value: Readonly<FailureProfile>,
  context: FailureContext,
  overrides: { code?: string; status?: number } = {},
): FailureClassification {
  return classification(value, {
    ...overrides,
    ...(context.stage === undefined ? {} : { stage: context.stage }),
  })
}

export function classifyCoreFailure(
  error: unknown,
  context: FailureContext = {},
): FailureClassification {
  const code = codeFor(error)
  const status = statusFor(error)
  const text = failureText(error)
  const override = {
    ...(code ? { code } : {}),
    ...(status === undefined ? {} : { status }),
  }

  if (code === 'auth-missing') {
    return withContext(CORE_FAILURE_PROFILES.authMissing, context, override)
  }
  if (code === 'auth-expired' || code === 'token_expired'
    || /token.{0,20}(expired|revoked)/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.authExpired, context, override)
  }
  if (code === 'auth-invalid' || status === 401 || /\b401\b/.test(text)
    || /token.{0,20}invalid/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.authInvalid, context, override)
  }
  if (/\bmissing netlify(?: api)? (?:auth )?token\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.authMissing, context, {
      ...override,
      code: code || 'auth-missing',
    })
  }
  if (code === 'auth-permission' || code === 'missing-coding-installation'
    || status === 403 || /\b403\b/.test(text)
    || /\b(access denied|permission denied|forbidden)\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.permission, context, override)
  }
  if (code === 'not-found' || status === 404 || /\b404\b/.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.notFound, context, override)
  }
  if (code === 'invalid-api-shape'
    || /\b(malformed api response|invalid json|parse error)\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.apiDrift, context, override)
  }
  if (code === 'create-ambiguous' || code === 'session-create-ambiguous'
    || code === 'session-already-active') {
    return withContext(CORE_FAILURE_PROFILES.ambiguity, context, override)
  }
  if (code === 'argv-too-long' || code === 'prompt_too_large'
    || /argument list too long/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.argvTooLong, context, override)
  }
  if (code.startsWith('prompt-')
    || /\bprompt reference.{0,20}expired\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.prompt, context, override)
  }
  if (code.startsWith('blob-') || /\bblob.{0,40}(fetch|store|verify|delete).{0,20}(failed|error)\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.blob, context, override)
  }
  if (code === 'capacity-exhausted') {
    return withContext(CORE_FAILURE_PROFILES.retryBudget, context, override)
  }
  if (code === 'credit-limit-exceeded') {
    return withContext(CORE_FAILURE_PROFILES.creditLimit, context, override)
  }
  if (code === 'model-capacity' || code === 'model_capacity'
    || /\b(model|agent).{0,30}(at capacity|is not available|unavailable)\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.capacity, context, {
      ...override,
      code: code || 'model-capacity',
    })
  }
  if (code === 'rate-limited' || code === 'rate_limited' || status === 429
    || /\b(rate limit|too many requests)\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.rateLimit, context, override)
  }
  if (status !== undefined && status >= 500) {
    return withContext(CORE_FAILURE_PROFILES.platform, context, override)
  }
  if (
    /\b50[0-4]\b|\b(bad gateway|gateway timeout|service unavailable|internal server error)\b/i.test(text)
  ) {
    return withContext(CORE_FAILURE_PROFILES.platform, context, {
      ...override,
      code: code || 'platform-server-error',
    })
  }
  if (code === 'network-error' || code === 'cli-transport-incompatible'
    || code === 'cli-transport-unavailable'
    || /\b(econnrefused|enotfound|network error|command not found)\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.transport, context, override)
  }
  if (code === 'request-timeout' || /\b(timed out|timeout)\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.timeout, context, override)
  }
  if (code === 'cancelled' || code === 'canceled'
    || /\b(cancelled|canceled|abandoned)\b/i.test(text)) {
    return withContext(CORE_FAILURE_PROFILES.cancelled, context, override)
  }
  if (code === 'validation-error' || code === 'invalid-handle'
    || code === 'unsupported-handle-version' || code === 'invalid-pr-branch') {
    return withContext(CORE_FAILURE_PROFILES.validation, context, override)
  }
  if (context.terminal !== undefined || /^terminal-/.test(code)) {
    const terminalStage = context.terminal ?? 'session'
    return classification(CORE_FAILURE_PROFILES.terminal, {
      ...override,
      code: code || `${terminalStage}-terminal-failed`,
      stage: terminalStage,
    })
  }
  if (context.stage === 'landing') {
    return withContext(CORE_FAILURE_PROFILES.landing, context, override)
  }
  return withContext(CORE_FAILURE_PROFILES.unknown, context, override)
}
