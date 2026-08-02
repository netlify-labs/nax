import { randomUUID } from 'node:crypto'

import type {
  EffectiveFollowUpInput,
  EffectiveStartInput,
  FollowUpInput,
  StartInput,
} from './domain.js'
import {
  BasicAgentRunnerSdkError,
  CreateAmbiguousError,
  SessionAlreadyActiveError,
  SessionCreateAmbiguousError,
} from './errors.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_MARKER_PREFIX = '<!-- agent-runner-sdk-request-id:'
const REQUEST_MARKER_SUFFIX = ' -->'
const REQUEST_MARKER_SEPARATOR = '\n\n'
const REQUEST_MARKER_PATTERN =
  /<!-- agent-runner-sdk-request-id:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->/gi
const NEUTRALIZED_USER_MARKER = '[reserved Agent Runner request marker removed]'
const REQUEST_ID_WIDTH = 36

export const requestMarkerOverheadBytes = Buffer.byteLength(
  REQUEST_MARKER_SEPARATOR
    + REQUEST_MARKER_PREFIX
    + '0'.repeat(REQUEST_ID_WIDTH)
    + REQUEST_MARKER_SUFFIX,
  'utf8',
)

export interface OperationPreparationOptions {
  deliveredPrompt?: string
  randomUUID?: () => string
  rotateRequestId?: boolean
}

type WithDeliveredPrompt<T> =
  T extends { requestId: string }
    ? Omit<T, 'prompt' | 'promptRef'> & {
        prompt: string
        promptRef?: never
      }
    : never

export type DeliveredStartInput = WithDeliveredPrompt<EffectiveStartInput>
export type DeliveredFollowUpInput =
  WithDeliveredPrompt<EffectiveFollowUpInput>

export interface PreparedStartOperation {
  effectiveInput: EffectiveStartInput
  submittedInput: DeliveredStartInput
}

export interface PreparedFollowUpOperation {
  effectiveInput: EffectiveFollowUpInput
  submittedInput: DeliveredFollowUpInput
}

export interface SubmittedStartOperation<T> {
  effectiveInput: EffectiveStartInput
  value: T
}

export interface SubmittedFollowUpOperation<T> {
  effectiveInput: EffectiveFollowUpInput
  value: T
}

function resolveRequestId(
  supplied: string | undefined,
  generate: () => string,
  rotate: boolean,
): string {
  const requestId = rotate || supplied === undefined ? generate() : supplied
  if (!UUID_PATTERN.test(requestId)) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'Agent Runner requestId must be a UUID.',
    )
  }
  return requestId
}

export function requestMarkerFor(requestId: string): string {
  if (!UUID_PATTERN.test(requestId)) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'Agent Runner requestId must be a UUID.',
    )
  }
  return `${REQUEST_MARKER_PREFIX}${requestId}${REQUEST_MARKER_SUFFIX}`
}

export function hasRequestMarker(value: string, requestId: string): boolean {
  return value.includes(requestMarkerFor(requestId))
}

function submittedPromptFor(
  semanticPrompt: string | undefined,
  deliveredPrompt: string | undefined,
  requestId: string,
): string {
  const prompt = deliveredPrompt ?? semanticPrompt
  if (prompt === undefined) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'A delivered prompt is required when preparing a prompt reference.',
    )
  }
  const safePrompt = prompt.replace(
    REQUEST_MARKER_PATTERN,
    NEUTRALIZED_USER_MARKER,
  )
  return `${safePrompt}${REQUEST_MARKER_SEPARATOR}${requestMarkerFor(
    requestId,
  )}`
}

export function stripRequestMarkers(value: string): string {
  return value
    .replace(REQUEST_MARKER_PATTERN, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function prepareStartOperation(
  input: StartInput,
  options: OperationPreparationOptions = {},
): PreparedStartOperation {
  const requestId = resolveRequestId(
    input.requestId,
    options.randomUUID ?? randomUUID,
    options.rotateRequestId ?? false,
  )
  const effectiveInput: EffectiveStartInput = {
    ...input,
    requestId,
  }
  const { prompt: semanticPrompt, promptRef: _promptRef, ...startOptions } =
    effectiveInput
  const submittedInput: DeliveredStartInput = {
    ...startOptions,
    prompt: submittedPromptFor(
      semanticPrompt,
      options.deliveredPrompt,
      requestId,
    ),
  }
  return { effectiveInput, submittedInput }
}

export function prepareFollowUpOperation(
  input: FollowUpInput,
  options: OperationPreparationOptions = {},
): PreparedFollowUpOperation {
  const requestId = resolveRequestId(
    input.requestId,
    options.randomUUID ?? randomUUID,
    options.rotateRequestId ?? false,
  )
  const effectiveInput: EffectiveFollowUpInput = {
    ...input,
    requestId,
  }
  const { prompt: semanticPrompt, promptRef: _promptRef, ...followUpOptions } =
    effectiveInput
  const submittedInput: DeliveredFollowUpInput = {
    ...followUpOptions,
    prompt: submittedPromptFor(
      semanticPrompt,
      options.deliveredPrompt,
      requestId,
    ),
  }
  return { effectiveInput, submittedInput }
}

export async function submitStartOperation<T>(
  prepared: PreparedStartOperation,
  submit: (input: EffectiveStartInput) => Promise<T>,
): Promise<SubmittedStartOperation<T>> {
  try {
    return {
      effectiveInput: prepared.effectiveInput,
      value: await submit(prepared.submittedInput),
    }
  } catch (error: unknown) {
    if (error instanceof CreateAmbiguousError) {
      throw new CreateAmbiguousError(
        prepared.effectiveInput,
        error.window,
        { cause: error },
      )
    }
    throw error
  }
}

export async function submitFollowUpOperation<T>(
  prepared: PreparedFollowUpOperation,
  submit: (input: EffectiveFollowUpInput) => Promise<T>,
): Promise<SubmittedFollowUpOperation<T>> {
  try {
    return {
      effectiveInput: prepared.effectiveInput,
      value: await submit(prepared.submittedInput),
    }
  } catch (error: unknown) {
    if (error instanceof SessionCreateAmbiguousError) {
      throw new SessionCreateAmbiguousError(
        prepared.effectiveInput,
        error.window,
        { cause: error },
      )
    }
    if (error instanceof SessionAlreadyActiveError) {
      throw new SessionAlreadyActiveError(
        prepared.effectiveInput,
        error.window,
        error.activeSessionId,
        { cause: error },
      )
    }
    throw error
  }
}
