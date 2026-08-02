export interface BlobRef {
  store: string
  key: string
  tenant: string
  expiresAt: number
}

export interface BlobStore {
  put(
    key: string,
    bytes: Uint8Array,
    opts: { ttlSeconds: number; tenant: string },
  ): Promise<BlobRef>
  delete(ref: BlobRef): Promise<void>
  runnerFetchInstruction(ref: BlobRef): { shell: string; sentinel: string }
}

export type PromptInput =
  | { prompt: string; promptRef?: never }
  | { prompt?: never; promptRef: BlobRef }

export type LandingMode = 'pr' | 'merge' | 'publish' | 'none' | 'auto'
export type RunnerMode = 'normal' | 'create' | 'ask'

interface StartOptions {
  siteId: string
  agent?: string
  model?: string
  branch?: string
  deployId?: string
  mode?: RunnerMode
  fileKeys?: string[]
  land?: LandingMode
  deadlineMs?: number
  retryBudget?: { capacity: number }
  requestId?: string
}

export type StartInput = PromptInput & StartOptions

interface FollowUpOptions {
  agent?: string
  model?: string
  mode?: RunnerMode
  fileKeys?: string[]
  requestId?: string
}

export type FollowUpInput = PromptInput & FollowUpOptions

export type WithRequestId<T> =
  T extends { requestId?: string }
    ? Omit<T, 'requestId'> & { requestId: string }
    : never

export type EffectiveStartInput = WithRequestId<StartInput>
export type EffectiveFollowUpInput = WithRequestId<FollowUpInput>

export interface OriginInfo {
  codeOrigin: string
  gitHost?: string
  repository?: {
    owner: string
    name: string
  }
  branch?: string
}

export interface Usage {
  totalTokens?: number
  totalCreditsCost?: number
  stepsCount?: number
  creditLimitExceeded?: boolean
}

export type DiffRef =
  | { kind: 'inline'; text: string }
  | { kind: 'url'; url: string }

export type FailureCategory =
  | 'authentication'
  | 'permission'
  | 'validation'
  | 'capacity'
  | 'rate-limit'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'platform'
  | 'github'
  | 'unknown'

export interface FailureClassification {
  category: FailureCategory
  code: string
  message: string
  retryable: boolean
  status?: number
}

export type ProgressEvent =
  | {
      kind: 'started'
      runnerId: string
      sessionId: string
      at: number
    }
  | {
      kind: 'stateChanged'
      runnerId: string
      sessionId?: string
      state: string
      latestStep?: string
      at: number
    }
  | {
      kind: 'retrying'
      runnerId: string
      retry: number
      reason: FailureClassification
      at: number
    }
  | {
      kind: 'landing'
      runnerId: string
      step: 'commit' | 'pr' | 'merge' | 'publish'
      at: number
    }
  | {
      kind: 'finished'
      runnerId: string
      status: 'succeeded' | 'failed' | 'cancelled' | 'timedOut'
      at: number
    }

export interface RequestWindow {
  sentAt: number
  failedAt: number
}

export type EmptyMemberInput = Record<PropertyKey, never>

export interface MemberActionInputMap {
  archive: EmptyMemberInput
  pull_request: {
    title?: string
    body?: string
  }
  commit: {
    sessionId: string
    message?: string
  }
  merge_target: EmptyMemberInput
  sync_git_origin: EmptyMemberInput
  diff: {
    sessionId?: string
  }
  revert: {
    sessionId?: string
  }
  rebase: EmptyMemberInput
  publish_to_production: EmptyMemberInput
}

export type MemberAction = keyof MemberActionInputMap

export interface MemberAccepted {
  accepted: boolean
}

export interface MemberActionResultMap {
  archive: MemberAccepted
  pull_request: MemberAccepted & { prUrl?: string }
  commit: MemberAccepted & { commitSha?: string }
  merge_target: MemberAccepted
  sync_git_origin: MemberAccepted
  diff: { diff: DiffRef | null }
  revert: MemberAccepted
  rebase: MemberAccepted
  publish_to_production: MemberAccepted & { deployUrl?: string }
}

export type MemberInput<A extends MemberAction> = MemberActionInputMap[A]
export type MemberResult<A extends MemberAction> = MemberActionResultMap[A]
