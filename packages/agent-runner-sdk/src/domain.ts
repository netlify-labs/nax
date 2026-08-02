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
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCachedInputTokens?: number
  totalCachedOutputTokens?: number
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

export interface Runner {
  runnerId: string
  state: string
  siteId?: string
  siteName?: string
  branch?: string
  title?: string
  codeOrigin?: string
  createdAt?: number
  updatedAt?: number
  doneAt?: number
  lastSessionCreatedAt?: number
  activeSessionCreatedAt?: number
  currentTask?: string
  latestSessionState?: string
  latestSessionMode?: string
  latestSessionIsPublished?: boolean
  hasResultDiff?: boolean
  needsGitSync?: boolean
  mergeTargetAvailable?: boolean
  prUrl?: string
  prNumber?: number
  prBranch?: string
  prState?: string
  prError?: string
  prIsBeingCreated?: boolean
  mergeCommitSha?: string
  mergeCommitError?: string
  mergeCommitIsBeingCreated?: boolean
}

export interface Session {
  sessionId: string
  runnerId: string
  state: string
  prompt?: string
  resultText?: string
  title?: string
  agent?: string
  model?: string
  mode?: string
  createdAt?: number
  updatedAt?: number
  doneAt?: number
  currentTask?: string
  commitSha?: string
  deployId?: string
  deployUrl?: string
  hasResultDiff?: boolean
  hasCumulativeDiff?: boolean
  isPublished?: boolean
  isDiscarded?: boolean
  creditLimitExceeded?: boolean
  creditLimitExceededMessage?: string
  usage: Usage | null
}

export interface RunnerPage {
  items: Runner[]
  nextPage?: number
  total?: number
}

export type EmptyMemberInput = Record<PropertyKey, never>

export interface MemberActionInputMap {
  archive: EmptyMemberInput
  pull_request: EmptyMemberInput
  commit: {
    targetBranch: string
  }
  merge_target: EmptyMemberInput
  sync_git_origin: EmptyMemberInput
  diff: {
    page?: number
    perPage?: number
    stripBinary?: boolean
  }
  revert: {
    sessionId: string
  }
  rebase: EmptyMemberInput
  publish_to_production: EmptyMemberInput
}

export type MemberAction = keyof MemberActionInputMap

export interface MemberAccepted {
  accepted: boolean
}

export interface MemberActionResultMap {
  archive: void
  pull_request: Runner
  commit: Runner
  merge_target: Session
  sync_git_origin: Runner
  diff: { diff: DiffRef | null }
  revert: Runner
  rebase: Session
  publish_to_production: Runner
}

export type MemberInput<A extends MemberAction> = MemberActionInputMap[A]
export type MemberResult<A extends MemberAction> = MemberActionResultMap[A]
