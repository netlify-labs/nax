import type {
  EffectiveFollowUpInput,
  EffectiveStartInput,
  RequestWindow,
} from './domain.js'

export type AgentRunnerSdkErrorCode =
  | 'invalid-api-shape'
  | 'create-ambiguous'
  | 'session-create-ambiguous'
  | 'session-already-active'
  | 'github-token-required'
  | 'pr-head-changed'
  | 'prompt-too-large'
  | 'prompt-ref-expired'
  | 'cli-transport-incompatible'
  | 'cli-transport-unavailable'
  | 'auth-missing'
  | 'auth-invalid'
  | 'auth-expired'
  | 'auth-permission'
  | 'http-error'
  | 'validation-error'
  | 'capacity-exhausted'
  | 'argv-too-long'
  | 'missing-coding-installation'
  | 'invalid-handle'
  | 'unsupported-handle-version'

type PayloadErrorCode =
  | 'invalid-api-shape'
  | 'create-ambiguous'
  | 'session-create-ambiguous'
  | 'session-already-active'
  | 'pr-head-changed'

export type BasicAgentRunnerSdkErrorCode = Exclude<
  AgentRunnerSdkErrorCode,
  PayloadErrorCode
>

export class AgentRunnerSdkError<
  C extends AgentRunnerSdkErrorCode = AgentRunnerSdkErrorCode,
> extends Error {
  readonly code: C

  protected constructor(code: C, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentRunnerSdkError'
    this.code = code
  }
}

export class BasicAgentRunnerSdkError<
  C extends BasicAgentRunnerSdkErrorCode = BasicAgentRunnerSdkErrorCode,
> extends AgentRunnerSdkError<C> {
  constructor(code: C, message: string, options?: ErrorOptions) {
    super(code, message, options)
  }
}

export class InvalidApiShapeError extends AgentRunnerSdkError<'invalid-api-shape'> {
  readonly endpoint: string
  readonly field: string

  constructor(endpoint: string, field: string, options?: ErrorOptions) {
    super(
      'invalid-api-shape',
      `Agent Runner API response from ${endpoint} has an invalid required field: ${field}.`,
      options,
    )
    this.endpoint = endpoint
    this.field = field
  }
}

export class CreateAmbiguousError extends AgentRunnerSdkError<'create-ambiguous'> {
  readonly effectiveInput: EffectiveStartInput
  readonly window: RequestWindow

  constructor(
    effectiveInput: EffectiveStartInput,
    window: RequestWindow,
    options?: ErrorOptions,
  ) {
    super(
      'create-ambiguous',
      'Agent Runner creation may have reached the service; reconcile before retrying.',
      options,
    )
    this.effectiveInput = effectiveInput
    this.window = window
  }
}

export class SessionCreateAmbiguousError
  extends AgentRunnerSdkError<'session-create-ambiguous'> {
  readonly effectiveInput: EffectiveFollowUpInput
  readonly window: RequestWindow

  constructor(
    effectiveInput: EffectiveFollowUpInput,
    window: RequestWindow,
    options?: ErrorOptions,
  ) {
    super(
      'session-create-ambiguous',
      'Agent Runner session creation may have reached the service; reconcile before retrying.',
      options,
    )
    this.effectiveInput = effectiveInput
    this.window = window
  }
}

export class SessionAlreadyActiveError
  extends AgentRunnerSdkError<'session-already-active'> {
  readonly effectiveInput: EffectiveFollowUpInput
  readonly window: RequestWindow
  readonly activeSessionId?: string

  constructor(
    effectiveInput: EffectiveFollowUpInput,
    window: RequestWindow,
    activeSessionId?: string,
    options?: ErrorOptions,
  ) {
    super(
      'session-already-active',
      'The Agent Runner already has an active session; reconcile it before continuing.',
      options,
    )
    this.effectiveInput = effectiveInput
    this.window = window
    this.activeSessionId = activeSessionId
  }
}

export class PrHeadChangedError extends AgentRunnerSdkError<'pr-head-changed'> {
  readonly expectedSha: string
  readonly actualSha?: string

  constructor(expectedSha: string, actualSha?: string, options?: ErrorOptions) {
    super(
      'pr-head-changed',
      'The pull request head changed before merge; refusing to merge a different revision.',
      options,
    )
    this.expectedSha = expectedSha
    this.actualSha = actualSha
  }
}

type BasicErrorUnion = {
  [C in BasicAgentRunnerSdkErrorCode]: AgentRunnerSdkError<C>
}[BasicAgentRunnerSdkErrorCode]

export type AnyAgentRunnerSdkError =
  | BasicErrorUnion
  | InvalidApiShapeError
  | CreateAmbiguousError
  | SessionCreateAmbiguousError
  | SessionAlreadyActiveError
  | PrHeadChangedError

export type AgentRunnerSdkErrorForCode<C extends AgentRunnerSdkErrorCode> =
  Extract<AnyAgentRunnerSdkError, { readonly code: C }>

export function isAgentRunnerSdkError(
  value: unknown,
): value is AnyAgentRunnerSdkError
export function isAgentRunnerSdkError<C extends AgentRunnerSdkErrorCode>(
  value: unknown,
  code: C,
): value is AgentRunnerSdkErrorForCode<C>
export function isAgentRunnerSdkError(
  value: unknown,
  code?: AgentRunnerSdkErrorCode,
): value is AnyAgentRunnerSdkError {
  return value instanceof AgentRunnerSdkError
    && (code === undefined || value.code === code)
}
