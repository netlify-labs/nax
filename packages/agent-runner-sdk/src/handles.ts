import type {
  BlobRef,
  EffectiveFollowUpInput,
  EffectiveStartInput,
  FailureCategory,
  LandingMode,
  OriginInfo,
  RunnerMode,
} from './domain.js'
import { BasicAgentRunnerSdkError } from './errors.js'
import type { PromptDeliveryAttempt } from './prompts/delivery.js'

export const AGENT_RUNNER_SDK_HANDLE_VERSION = 1 as const

export interface LandingProgress {
  prUrl?: string
  committedSessionIds?: string[]
  expectedPrHeadSha?: string
  mergedSha?: string
  published?: boolean
}

export interface HandlePolicy {
  landing: LandingMode
  deadlineAt: number
  retryBudget: {
    capacity: number
  }
}

export interface RetryAttempt {
  attempt: number
  category: FailureCategory
  code: string
  scheduledAt: number
  delayMs: number
}

export interface RetryProgress {
  capacity: number
  lastAttempt?: RetryAttempt
}

export interface BaseHandle {
  v: typeof AGENT_RUNNER_SDK_HANDLE_VERSION
  runnerId: string
  siteId: string
  agent: string
  origin?: OriginInfo
  input: EffectiveStartInput
  policy: HandlePolicy
  retries: RetryProgress
  promptDelivery?: PromptDeliveryAttempt
  landing?: LandingProgress
  currentSessionId: string
}

export interface RunHandle extends BaseHandle {
  kind: 'run'
}

export interface SessionHandle extends BaseHandle {
  kind: 'session'
  sessionId: string
  sessionInput: EffectiveFollowUpInput
}

export type Handle = RunHandle | SessionHandle

function invalidHandle(message: string, cause?: unknown): never {
  throw new BasicAgentRunnerSdkError(
    'invalid-handle',
    `Invalid Agent Runner SDK handle: ${message}`,
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalidHandle(`${field} must be an object.`)
  return value
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalidHandle(`${field} must be a non-empty string.`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return stringValue(value, field)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requestIdValue(value: unknown, field: string): string {
  const requestId = stringValue(value, field)
  if (!UUID_PATTERN.test(requestId)) {
    invalidHandle(`${field} must be a UUID.`)
  }
  return requestId
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidHandle(`${field} must be a finite number.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field)
  if (!Number.isInteger(parsed) || parsed < 0) {
    invalidHandle(`${field} must be a non-negative integer.`)
  }
  return parsed
}

function optionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) invalidHandle(`${field} must be an array.`)
  return value.map((item, index) => stringValue(item, `${field}[${index}]`))
}

const LANDING_MODES = new Set<LandingMode>([
  'pr',
  'merge',
  'publish',
  'none',
  'auto',
])

function landingMode(value: unknown, field: string): LandingMode {
  if (typeof value !== 'string' || !LANDING_MODES.has(value as LandingMode)) {
    invalidHandle(`${field} is not a supported landing mode.`)
  }
  return value as LandingMode
}

const RUNNER_MODES = new Set<RunnerMode>(['normal', 'create', 'ask'])

function optionalRunnerMode(
  value: unknown,
  field: string,
): RunnerMode | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !RUNNER_MODES.has(value as RunnerMode)) {
    invalidHandle(`${field} is not a supported runner mode.`)
  }
  return value as RunnerMode
}

function parseBlobRef(value: unknown, field: string): BlobRef {
  const record = recordValue(value, field)
  return {
    store: stringValue(record.store, `${field}.store`),
    key: stringValue(record.key, `${field}.key`),
    tenant: stringValue(record.tenant, `${field}.tenant`),
    expiresAt: finiteNumber(record.expiresAt, `${field}.expiresAt`),
  }
}

const PROMPT_DELIVERY_KINDS = new Set([
  'inline',
  'compact',
  'blob',
])

function parsePromptDelivery(
  value: unknown,
): PromptDeliveryAttempt | undefined {
  if (value === undefined) return undefined
  const record = recordValue(value, 'promptDelivery')
  if (
    typeof record.kind !== 'string'
    || !PROMPT_DELIVERY_KINDS.has(record.kind)
  ) {
    invalidHandle('promptDelivery.kind is invalid.')
  }
  const semanticBytes = record.semanticBytes === undefined
    ? undefined
    : nonNegativeInteger(
        record.semanticBytes,
        'promptDelivery.semanticBytes',
      )
  const promptRef = record.promptRef === undefined
    ? undefined
    : parseBlobRef(record.promptRef, 'promptDelivery.promptRef')
  const sentinel = optionalString(
    record.sentinel,
    'promptDelivery.sentinel',
  )
  if (record.kind === 'blob' && promptRef === undefined) {
    invalidHandle('blob prompt delivery requires promptDelivery.promptRef.')
  }
  if (
    record.kind !== 'blob'
    && (promptRef !== undefined || sentinel !== undefined)
  ) {
    invalidHandle(
      'inline and compact prompt delivery cannot contain blob metadata.',
    )
  }
  return {
    kind: record.kind as PromptDeliveryAttempt['kind'],
    safeBytes: nonNegativeInteger(
      record.safeBytes,
      'promptDelivery.safeBytes',
    ),
    ...(semanticBytes === undefined ? {} : { semanticBytes }),
    submittedBytes: nonNegativeInteger(
      record.submittedBytes,
      'promptDelivery.submittedBytes',
    ),
    ...(promptRef === undefined ? {} : { promptRef }),
    ...(sentinel === undefined ? {} : { sentinel }),
  }
}

function sameBlobRef(left: BlobRef, right: BlobRef): boolean {
  return (
    left.store === right.store
    && left.key === right.key
    && left.tenant === right.tenant
    && left.expiresAt === right.expiresAt
  )
}

function validatePromptDelivery(
  delivery: PromptDeliveryAttempt | undefined,
  input: EffectiveStartInput | EffectiveFollowUpInput,
): void {
  if (delivery === undefined) return
  if (delivery.submittedBytes > delivery.safeBytes) {
    invalidHandle(
      'promptDelivery.submittedBytes cannot exceed promptDelivery.safeBytes.',
    )
  }
  if (delivery.kind === 'blob') {
    if (
      input.promptRef === undefined
      || delivery.promptRef === undefined
      || !sameBlobRef(input.promptRef, delivery.promptRef)
    ) {
      invalidHandle(
        'blob prompt delivery must match the effective input promptRef.',
      )
    }
    return
  }
  if (input.prompt === undefined) {
    invalidHandle(
      'inline and compact prompt delivery require a semantic prompt.',
    )
  }
}

function parsePrompt(
  record: Record<string, unknown>,
  field: string,
): { prompt: string; promptRef?: never } | { prompt?: never; promptRef: BlobRef } {
  const hasPrompt = record.prompt !== undefined
  const hasPromptRef = record.promptRef !== undefined
  if (hasPrompt === hasPromptRef) {
    invalidHandle(`${field} must contain exactly one of prompt or promptRef.`)
  }
  return hasPrompt
    ? { prompt: stringValue(record.prompt, `${field}.prompt`) }
    : { promptRef: parseBlobRef(record.promptRef, `${field}.promptRef`) }
}

function parseEffectiveStartInput(value: unknown): EffectiveStartInput {
  const record = recordValue(value, 'input')
  const prompt = parsePrompt(record, 'input')
  const agent = optionalString(record.agent, 'input.agent')
  const model = optionalString(record.model, 'input.model')
  const branch = optionalString(record.branch, 'input.branch')
  const deployId = optionalString(record.deployId, 'input.deployId')
  const mode = optionalRunnerMode(record.mode, 'input.mode')
  const fileKeys = optionalStringArray(record.fileKeys, 'input.fileKeys')
  const land = record.land === undefined
    ? undefined
    : landingMode(record.land, 'input.land')
  const deadlineMs = record.deadlineMs === undefined
    ? undefined
    : nonNegativeInteger(record.deadlineMs, 'input.deadlineMs')
  const retryBudget = record.retryBudget === undefined
    ? undefined
    : {
        capacity: nonNegativeInteger(
          recordValue(record.retryBudget, 'input.retryBudget').capacity,
          'input.retryBudget.capacity',
        ),
      }

  return {
    ...prompt,
    siteId: stringValue(record.siteId, 'input.siteId'),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(branch === undefined ? {} : { branch }),
    ...(deployId === undefined ? {} : { deployId }),
    ...(mode === undefined ? {} : { mode }),
    ...(fileKeys === undefined ? {} : { fileKeys }),
    ...(land === undefined ? {} : { land }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(retryBudget === undefined ? {} : { retryBudget }),
    requestId: requestIdValue(record.requestId, 'input.requestId'),
  }
}

function parseEffectiveFollowUpInput(
  value: unknown,
): EffectiveFollowUpInput {
  const record = recordValue(value, 'sessionInput')
  const prompt = parsePrompt(record, 'sessionInput')
  const agent = optionalString(record.agent, 'sessionInput.agent')
  const model = optionalString(record.model, 'sessionInput.model')
  const mode = optionalRunnerMode(record.mode, 'sessionInput.mode')
  const fileKeys = optionalStringArray(record.fileKeys, 'sessionInput.fileKeys')

  return {
    ...prompt,
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(mode === undefined ? {} : { mode }),
    ...(fileKeys === undefined ? {} : { fileKeys }),
    requestId: requestIdValue(
      record.requestId,
      'sessionInput.requestId',
    ),
  }
}

function parseOrigin(value: unknown): OriginInfo | undefined {
  if (value === undefined) return undefined
  const record = recordValue(value, 'origin')
  const gitHost = optionalString(record.gitHost, 'origin.gitHost')
  const branch = optionalString(record.branch, 'origin.branch')
  const repositoryRecord = record.repository === undefined
    ? undefined
    : recordValue(record.repository, 'origin.repository')

  return {
    codeOrigin: stringValue(record.codeOrigin, 'origin.codeOrigin'),
    ...(gitHost === undefined ? {} : { gitHost }),
    ...(branch === undefined ? {} : { branch }),
    ...(repositoryRecord === undefined
      ? {}
      : {
          repository: {
            owner: stringValue(
              repositoryRecord.owner,
              'origin.repository.owner',
            ),
            name: stringValue(repositoryRecord.name, 'origin.repository.name'),
          },
        }),
  }
}

function parseLandingProgress(value: unknown): LandingProgress | undefined {
  if (value === undefined) return undefined
  const record = recordValue(value, 'landing')
  const prUrl = optionalString(record.prUrl, 'landing.prUrl')
  const committedSessionIds = optionalStringArray(
    record.committedSessionIds,
    'landing.committedSessionIds',
  )
  const expectedPrHeadSha = optionalString(
    record.expectedPrHeadSha,
    'landing.expectedPrHeadSha',
  )
  const mergedSha = optionalString(record.mergedSha, 'landing.mergedSha')
  if (record.published !== undefined && typeof record.published !== 'boolean') {
    invalidHandle('landing.published must be a boolean.')
  }

  return {
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(committedSessionIds === undefined ? {} : { committedSessionIds }),
    ...(expectedPrHeadSha === undefined ? {} : { expectedPrHeadSha }),
    ...(mergedSha === undefined ? {} : { mergedSha }),
    ...(record.published === undefined
      ? {}
      : { published: record.published }),
  }
}

const FAILURE_CATEGORIES = new Set<FailureCategory>([
  'authentication',
  'permission',
  'not-found',
  'validation',
  'capacity',
  'rate-limit',
  'transport',
  'argv-too-long',
  'terminal',
  'timeout',
  'cancelled',
  'prompt',
  'blob',
  'api-drift',
  'ambiguity',
  'landing',
  'platform',
  'github',
  'unknown',
])

function failureCategory(
  value: unknown,
  field: string,
): FailureCategory {
  if (
    typeof value !== 'string'
    || !FAILURE_CATEGORIES.has(value as FailureCategory)
  ) {
    invalidHandle(`${field} is not a supported failure category.`)
  }
  return value as FailureCategory
}

function parseRetryAttempt(
  value: unknown,
  capacity: number,
): RetryAttempt | undefined {
  if (value === undefined) return undefined
  const record = recordValue(value, 'retries.lastAttempt')
  const attempt = nonNegativeInteger(
    record.attempt,
    'retries.lastAttempt.attempt',
  )
  if (attempt === 0 || attempt !== capacity) {
    invalidHandle(
      'retries.lastAttempt.attempt must equal the non-zero retries.capacity.',
    )
  }
  return {
    attempt,
    category: failureCategory(
      record.category,
      'retries.lastAttempt.category',
    ),
    code: stringValue(record.code, 'retries.lastAttempt.code'),
    scheduledAt: finiteNumber(
      record.scheduledAt,
      'retries.lastAttempt.scheduledAt',
    ),
    delayMs: nonNegativeInteger(
      record.delayMs,
      'retries.lastAttempt.delayMs',
    ),
  }
}

function parseCurrentHandle(value: Record<string, unknown>): Handle {
  const input = parseEffectiveStartInput(value.input)
  const policyRecord = recordValue(value.policy, 'policy')
  const retryBudgetRecord = recordValue(
    policyRecord.retryBudget,
    'policy.retryBudget',
  )
  const retriesRecord = recordValue(value.retries, 'retries')
  const retryCapacity = nonNegativeInteger(
    retriesRecord.capacity,
    'retries.capacity',
  )
  const lastRetryAttempt = parseRetryAttempt(
    retriesRecord.lastAttempt,
    retryCapacity,
  )
  const origin = parseOrigin(value.origin)
  const landing = parseLandingProgress(value.landing)
  const promptDelivery = parsePromptDelivery(value.promptDelivery)
  const base: BaseHandle = {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    runnerId: stringValue(value.runnerId, 'runnerId'),
    siteId: stringValue(value.siteId, 'siteId'),
    agent: stringValue(value.agent, 'agent'),
    ...(origin === undefined ? {} : { origin }),
    input,
    policy: {
      landing: landingMode(policyRecord.landing, 'policy.landing'),
      deadlineAt: finiteNumber(policyRecord.deadlineAt, 'policy.deadlineAt'),
      retryBudget: {
        capacity: nonNegativeInteger(
          retryBudgetRecord.capacity,
          'policy.retryBudget.capacity',
        ),
      },
    },
    retries: {
      capacity: retryCapacity,
      ...(lastRetryAttempt === undefined
        ? {}
        : { lastAttempt: lastRetryAttempt }),
    },
    ...(promptDelivery === undefined ? {} : { promptDelivery }),
    ...(landing === undefined ? {} : { landing }),
    currentSessionId: stringValue(
      value.currentSessionId,
      'currentSessionId',
    ),
  }

  if (base.input.siteId !== base.siteId) {
    invalidHandle('input.siteId must equal siteId.')
  }
  if (value.kind === 'run') {
    validatePromptDelivery(promptDelivery, base.input)
    return { ...base, kind: 'run' }
  }
  if (value.kind !== 'session') {
    invalidHandle('kind must be run or session.')
  }
  const sessionId = stringValue(value.sessionId, 'sessionId')
  if (sessionId !== base.currentSessionId) {
    invalidHandle('sessionId must equal currentSessionId.')
  }
  const sessionInput = parseEffectiveFollowUpInput(value.sessionInput)
  validatePromptDelivery(promptDelivery, sessionInput)
  return {
    ...base,
    kind: 'session',
    sessionId,
    sessionInput,
  }
}

function decodeHandle(value: string | unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch (cause: unknown) {
    return invalidHandle('serialized value is not valid JSON.', cause)
  }
}

export function parseHandle(value: string | unknown): Handle {
  const decoded = recordValue(decodeHandle(value), 'handle')
  if (typeof decoded.v !== 'number' || !Number.isInteger(decoded.v)) {
    invalidHandle('v must be an integer schema version.')
  }
  if (decoded.v !== AGENT_RUNNER_SDK_HANDLE_VERSION) {
    throw new BasicAgentRunnerSdkError(
      'unsupported-handle-version',
      `Unsupported Agent Runner SDK handle version: ${decoded.v}.`,
    )
  }
  return parseCurrentHandle(decoded)
}

export function serializeHandle(handle: Handle): string {
  return JSON.stringify(parseHandle(handle))
}
