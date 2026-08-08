import {
  DEFAULT_PROMPT_BLOB_TTL_SECONDS,
  MAX_PROMPT_BLOB_BYTES,
} from '../blobs/netlify.js'
import type {
  BlobRef,
  BlobStore,
  PromptInput,
} from '../domain.js'
import {
  BasicAgentRunnerSdkError,
  isAgentRunnerSdkError,
} from '../errors.js'
import { requestMarkerOverheadBytes } from '../operations.js'

export const DEFAULT_SAFE_PROMPT_BYTES = 16 * 1_024
const MIN_SUBSTANTIVE_RESULT_BYTES = 1_200

export type PromptDeliveryKind = 'inline' | 'compact' | 'blob'
export type SentinelVerdict =
  | 'confirmed'
  | 'failed'
  | 'probable'
  | 'suspect'

export interface PromptDeliveryAttempt {
  kind: PromptDeliveryKind
  safeBytes: number
  semanticBytes?: number
  submittedBytes: number
  promptRef?: BlobRef
  sentinel?: string
}

export interface PromptCompactionContext {
  maxBytes: number
}

export type PromptCompactor = (
  prompt: string,
  context: PromptCompactionContext,
) => string | Promise<string>

export interface PromptDeliveryContext {
  siteId: string
  operation: 'start' | 'followUp'
  runnerId?: string
}

type ContextValue = string | ((
  context: PromptDeliveryContext,
) => string)

export interface PromptDeliveryPolicyOptions {
  safeBytes?: number
  hardMaxBytes?: number
  blobTtlSeconds?: number
  inlineInstructions?: string
  tenant?: ContextValue
  key?: ContextValue
  compact?: PromptCompactor
  env?: Record<string, string | undefined>
}

export interface SentinelEvidence {
  expectedSentinel: string
  resultText?: string
  transcript?: string
  commandOutput?: string
  fetchExitCode?: number | null
  fetchError?: string
  blobOnlyNeedles?: string[]
}

export interface SentinelClassification {
  verdict: SentinelVerdict
  confirmed: boolean
  signals: string[]
}

export interface PreparePromptDeliveryOptions {
  promptInput: PromptInput
  decoratedPrompt: string
  decorate: (deliveredPrompt: string) => string
  context: PromptDeliveryContext
  blobStore?: BlobStore
  promptRefDelivery?: (ref: BlobRef) => string | Promise<string>
  policy?: PromptDeliveryPolicyOptions
  now?: () => number
}

export interface PreparedPromptDelivery {
  effectivePrompt: PromptInput
  deliveredPrompt?: string
  attempt: PromptDeliveryAttempt
}

const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function configuredPositiveInteger(
  value: number | string | undefined,
  field: string,
  fallback: number,
): number {
  const candidate = value === undefined || value === ''
    ? fallback
    : Number(value)
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} must be a positive integer.`,
    )
  }
  return candidate
}

function resolveContextValue(
  value: ContextValue | undefined,
  context: PromptDeliveryContext,
  fallback: string,
  field: string,
): string {
  const resolved = (
    typeof value === 'function' ? value(context) : value
  ) ?? fallback
  if (
    typeof resolved !== 'string'
    || resolved.length === 0
    || resolved.length > 1_024
    || /[\u0000-\u001f\u007f]/.test(resolved)
  ) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      `${field} resolved to an invalid value.`,
    )
  }
  return resolved
}

function promptTooLarge(): never {
  throw new BasicAgentRunnerSdkError(
    'prompt-too-large',
    'The prompt cannot be delivered within the configured byte ceiling.',
  )
}

export function promptFetchWrapper(
  shell: string,
  inlineInstructions = '',
): string {
  const instructions = inlineInstructions.trim()
  return [
    instructions
      ? [
          '## Request instructions',
          '',
          instructions,
          '',
          'These instructions are repeated in the offloaded full prompt.',
          '',
        ].join('\n')
      : '',
    '## Full prompt (offloaded)',
    '',
    'Before you do anything else, run this command in the Agent Runner:',
    '',
    `    ${shell}`,
    '',
    'Read the returned Markdown as the complete prompt and follow it exactly.',
    'After loading it, echo the exact NAX-BLOB-SENTINEL line found at the top of the blob.',
    '',
    'The blob contains the complete prompt. Do not proceed from this wrapper alone.',
  ].filter(Boolean).join('\n')
}

function compactInlineInstructions(value: string, maximumBytes: number): string {
  if (byteLength(value) <= maximumBytes) return value
  const notice = '\n\n[... remaining instructions are in the offloaded full prompt ...]'
  const noticeBytes = byteLength(notice)
  if (noticeBytes >= maximumBytes) return takePrefix(value, maximumBytes)
  return `${takePrefix(value, maximumBytes - noticeBytes)}${notice}`
}

function boundedPromptFetchWrapper(
  shell: string,
  inlineInstructions: string,
  decorate: (deliveredPrompt: string) => string,
  maximumBytes: number,
): string {
  const instructions = inlineInstructions.trim()
  let instructionBudget = byteLength(instructions)
  let wrapper = promptFetchWrapper(shell, instructions)
  let submittedBytes = byteLength(decorate(wrapper))
  while (submittedBytes > maximumBytes && instructionBudget > 1) {
    const nextBudget = Math.max(
      1,
      instructionBudget - Math.max(1, submittedBytes - maximumBytes),
    )
    if (nextBudget === instructionBudget) break
    instructionBudget = nextBudget
    wrapper = promptFetchWrapper(
      shell,
      compactInlineInstructions(instructions, instructionBudget),
    )
    submittedBytes = byteLength(decorate(wrapper))
  }
  return wrapper
}

function safeFetchInstruction(
  blobStore: BlobStore,
  ref: BlobRef,
): { shell: string; sentinel: string } {
  try {
    return blobStore.runnerFetchInstruction(ref)
  } catch (error: unknown) {
    if (isAgentRunnerSdkError(error)) throw error
    throw new BasicAgentRunnerSdkError(
      'blob-read-failed',
      'The prompt blob fetch instruction could not be created.',
    )
  }
}

export async function preparePromptDelivery(
  options: PreparePromptDeliveryOptions,
): Promise<PreparedPromptDelivery> {
  const policy = options.policy ?? {}
  const env = policy.env ?? process.env
  const safeBytes = configuredPositiveInteger(
    policy.safeBytes ?? env.NAX_SAFE_PROMPT_BYTES,
    'safeBytes',
    DEFAULT_SAFE_PROMPT_BYTES,
  )
  const hardMaxBytes = configuredPositiveInteger(
    policy.hardMaxBytes,
    'hardMaxBytes',
    MAX_PROMPT_BLOB_BYTES,
  )
  if (safeBytes > hardMaxBytes) {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'safeBytes cannot exceed hardMaxBytes.',
    )
  }
  const blobTtlSeconds = configuredPositiveInteger(
    policy.blobTtlSeconds,
    'blobTtlSeconds',
    DEFAULT_PROMPT_BLOB_TTL_SECONDS,
  )
  const now = options.now ?? Date.now
  const inlineInstructions = policy.inlineInstructions === undefined
    ? ''
    : policy.inlineInstructions
  if (typeof inlineInstructions !== 'string') {
    throw new BasicAgentRunnerSdkError(
      'validation-error',
      'inlineInstructions must be a string.',
    )
  }
  const wrapperByteCeiling = Math.min(safeBytes, hardMaxBytes)

  if (options.promptInput.promptRef !== undefined) {
    const ref = options.promptInput.promptRef
    if (ref.expiresAt <= now()) {
      throw new BasicAgentRunnerSdkError(
        'prompt-ref-expired',
        'The Agent Runner prompt reference has expired.',
      )
    }
    let deliveredPrompt: string
    let sentinel: string | undefined
    if (options.promptRefDelivery !== undefined) {
      try {
        deliveredPrompt = await options.promptRefDelivery(ref)
      } catch (error: unknown) {
        if (isAgentRunnerSdkError(error)) throw error
        throw new BasicAgentRunnerSdkError(
          'blob-read-failed',
          'The prompt blob fetch instruction could not be created.',
        )
      }
    } else if (options.blobStore !== undefined) {
      const instruction = safeFetchInstruction(options.blobStore, ref)
      deliveredPrompt = boundedPromptFetchWrapper(
        instruction.shell,
        inlineInstructions,
        options.decorate,
        wrapperByteCeiling,
      )
      sentinel = instruction.sentinel
    } else {
      throw new BasicAgentRunnerSdkError(
        'validation-error',
        'Prompt-reference delivery is not configured.',
      )
    }
    const submittedBytes = byteLength(options.decorate(deliveredPrompt))
    if (submittedBytes > safeBytes || submittedBytes > hardMaxBytes) {
      promptTooLarge()
    }
    return {
      effectivePrompt: { promptRef: ref },
      deliveredPrompt,
      attempt: {
        kind: 'blob',
        safeBytes,
        submittedBytes,
        promptRef: ref,
        ...(sentinel === undefined ? {} : { sentinel }),
      },
    }
  }

  const prompt = options.promptInput.prompt
  const semanticBytes = byteLength(prompt)
  const inlineBytes = byteLength(options.decoratedPrompt)
  if (inlineBytes <= safeBytes && inlineBytes <= hardMaxBytes) {
    return {
      effectivePrompt: { prompt },
      attempt: {
        kind: 'inline',
        safeBytes,
        semanticBytes,
        submittedBytes: inlineBytes,
      },
    }
  }

  if (policy.compact !== undefined) {
    let compacted: string
    try {
      compacted = await policy.compact(prompt, {
        maxBytes: Math.max(1, safeBytes - requestMarkerOverheadBytes),
      })
    } catch {
      throw new BasicAgentRunnerSdkError(
        'prompt-compaction-failed',
        'The prompt could not be compacted.',
      )
    }
    if (typeof compacted !== 'string') {
      throw new BasicAgentRunnerSdkError(
        'validation-error',
        'The prompt compactor must return a string.',
      )
    }
    const compactBytes = byteLength(options.decorate(compacted))
    if (compactBytes <= safeBytes && compactBytes <= hardMaxBytes) {
      return {
        effectivePrompt: { prompt },
        deliveredPrompt: compacted,
        attempt: {
          kind: 'compact',
          safeBytes,
          semanticBytes,
          submittedBytes: compactBytes,
        },
      }
    }
  }

  if (
    options.blobStore === undefined
    || semanticBytes > hardMaxBytes
  ) {
    promptTooLarge()
  }

  const tenant = resolveContextValue(
    policy.tenant,
    options.context,
    options.context.siteId,
    'prompt tenant',
  )
  const key = resolveContextValue(
    policy.key,
    options.context,
    options.context.operation === 'start'
      ? 'runner-prompt'
      : `runner-follow-up-${options.context.runnerId ?? 'unknown'}`,
    'prompt key',
  )
  let ref: BlobRef
  try {
    ref = await options.blobStore.put(
      key,
      encoder.encode(prompt),
      { ttlSeconds: blobTtlSeconds, tenant },
    )
  } catch (error: unknown) {
    if (isAgentRunnerSdkError(error)) throw error
    throw new BasicAgentRunnerSdkError(
      'blob-write-failed',
      'The prompt blob could not be stored.',
    )
  }
  let instruction: { shell: string; sentinel: string }
  try {
    instruction = safeFetchInstruction(options.blobStore, ref)
  } catch (error: unknown) {
    try {
      await options.blobStore.delete(ref)
    } catch {
      // Best-effort rollback is intentionally value-free.
    }
    throw error
  }
  const deliveredPrompt = boundedPromptFetchWrapper(
    instruction.shell,
    inlineInstructions,
    options.decorate,
    wrapperByteCeiling,
  )
  const submittedBytes = byteLength(options.decorate(deliveredPrompt))
  if (submittedBytes > safeBytes || submittedBytes > hardMaxBytes) {
    try {
      await options.blobStore.delete(ref)
    } catch {
      // Best-effort rollback is intentionally value-free.
    }
    promptTooLarge()
  }
  return {
    effectivePrompt: { promptRef: ref },
    deliveredPrompt,
    attempt: {
      kind: 'blob',
      safeBytes,
      semanticBytes,
      submittedBytes,
      promptRef: ref,
      sentinel: instruction.sentinel,
    },
  }
}

function takePrefix(value: string, maximumBytes: number): string {
  let output = ''
  let used = 0
  for (const character of value) {
    const size = byteLength(character)
    if (used + size > maximumBytes) break
    output += character
    used += size
  }
  return output
}

function takeSuffix(value: string, maximumBytes: number): string {
  const characters = [...value]
  let output = ''
  let used = 0
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index] as string
    const size = byteLength(character)
    if (used + size > maximumBytes) break
    output = character + output
    used += size
  }
  return output
}

export function compactPromptByBytes(
  prompt: string,
  { maxBytes }: PromptCompactionContext,
): string {
  const maximum = configuredPositiveInteger(maxBytes, 'maxBytes', 1)
  if (byteLength(prompt) <= maximum) return prompt
  const separator = '\n\n[... prompt compacted deterministically ...]\n\n'
  const separatorBytes = byteLength(separator)
  if (separatorBytes >= maximum) return takePrefix(prompt, maximum)
  const remaining = maximum - separatorBytes
  const prefixBudget = Math.ceil(remaining / 2)
  const suffixBudget = remaining - prefixBudget
  return [
    takePrefix(prompt, prefixBudget),
    separator,
    takeSuffix(prompt, suffixBudget),
  ].join('')
}

export function classifySentinelEvidence(
  evidence: SentinelEvidence,
): SentinelClassification {
  const resultText = String(evidence.resultText ?? '')
  const proofText = [
    evidence.transcript,
    evidence.commandOutput,
  ].map((value) => String(value ?? '')).filter(Boolean).join('\n')
  const needle = `NAX-BLOB-SENTINEL ${evidence.expectedSentinel}`
  if (proofText.includes(needle) || resultText.includes(needle)) {
    return {
      verdict: 'confirmed',
      confirmed: true,
      signals: ['sentinel'],
    }
  }
  const failureText = String(
    evidence.fetchError
      || evidence.commandOutput
      || evidence.transcript
      || '',
  )
  if (
    (
      evidence.fetchExitCode !== null
      && evidence.fetchExitCode !== undefined
      && evidence.fetchExitCode !== 0
    )
    || /(?:blobs:get|blob).*(?:failed|error|forbidden|unauthori[sz]ed|not found)|permission denied/is.test(
      failureText,
    )
  ) {
    return {
      verdict: 'failed',
      confirmed: false,
      signals: ['fetch-error'],
    }
  }
  if (
    (evidence.blobOnlyNeedles ?? []).some(
      (candidate) => candidate && resultText.includes(candidate),
    )
  ) {
    return {
      verdict: 'probable',
      confirmed: true,
      signals: ['blob-only-detail'],
    }
  }
  if (
    /not enough context|missing context|no prior results|cannot access|unable to fetch|need the full/i.test(
      resultText,
    )
    // Short results without a sentinel are too weak to prove blob retrieval.
    || byteLength(resultText.trim()) < MIN_SUBSTANTIVE_RESULT_BYTES
  ) {
    return {
      verdict: 'suspect',
      confirmed: false,
      signals: ['context-starved'],
    }
  }
  return {
    verdict: 'probable',
    confirmed: true,
    signals: ['substantive-output'],
  }
}
