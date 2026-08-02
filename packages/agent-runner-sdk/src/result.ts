import type {
  DiffRef,
  FailureClassification,
  Usage,
} from './domain.js'
import type { Handle, RunHandle } from './handles.js'

export interface RunLinks {
  runnerUrl?: string
  sessionUrl?: string
  prUrl?: string
}

export type RunResult =
  | {
      status: 'succeeded'
      runnerId: string
      sessionId: string
      resultText: string
      usage: Usage | null
      changes: 'changed' | 'unchanged' | 'unknown'
      diff?: DiffRef
      deployUrl?: string
      links: RunLinks
    }
  | {
      status: 'failed'
      runnerId: string
      sessionId?: string
      failure: FailureClassification
      usage: Usage | null
    }
  | {
      status: 'cancelled'
      runnerId: string
      sessionId?: string
      usage: Usage | null
    }
  | {
      status: 'timedOut'
      runnerId: string
      sessionId?: string
      usage: Usage | null
      cancelledRunner: boolean
    }

export type LandingOutcome =
  | {
      kind: 'merged'
      prUrl: string
      mergeSha: string
      deployUrl?: string
    }
  | {
      kind: 'prOpen'
      prUrl: string
      merged: false
    }
  | {
      kind: 'published'
      deployUrl?: string
    }
  | {
      kind: 'unsupported'
      reason: string
    }
  | {
      kind: 'failed'
      step: 'commit' | 'pr' | 'merge' | 'publish'
      failure: FailureClassification
    }
  | {
      kind: 'skipped'
    }

export interface RunOutcome<H extends Handle = RunHandle> {
  result: RunResult
  landing?: LandingOutcome
  handle: H
}

export type RunSnapshot =
  | {
      kind: 'running'
      runnerId: string
      sessionId?: string
      state: string
      latestStep?: string
      usage: Usage | null
    }
  | {
      kind: 'terminal'
      result: RunResult
    }

export interface ReconciliationCandidate {
  runnerId: string
  sessionId?: string
  createdAt: number
}

export type ReconciliationResult<H extends Handle> =
  | { kind: 'matched'; handle: H }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: ReconciliationCandidate[] }
