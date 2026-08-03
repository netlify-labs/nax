import type {
  EffectiveFollowUpInput,
  EffectiveStartInput,
  MemberAction,
  MemberInput,
  MemberResult,
  Runner,
  RunnerPage,
  Session,
} from '../domain.js'

export type AgentRunnerApiStyle = 'v1' | 'bb-api'

export interface TransportRequestOptions {
  token?: string
  signal?: AbortSignal
}

export interface RunnerListQuery {
  siteId: string
  accountId?: string
  branch?: string
  from?: number
  page?: number
  perPage?: number
  resultBranch?: string
  state?: 'live' | 'error'
  title?: string
  to?: number
  userId?: string
}

export interface AccountRunnerListQuery {
  accountSlug: string
  page?: number
  perPage?: number
}

export interface Transport {
  createRunner(
    input: EffectiveStartInput,
    options?: TransportRequestOptions,
  ): Promise<Runner>
  createSession(
    runnerId: string,
    input: EffectiveFollowUpInput,
    options?: TransportRequestOptions,
  ): Promise<Session>
  getRunner(
    runnerId: string,
    options?: TransportRequestOptions,
  ): Promise<Runner>
  listRunners(
    query: RunnerListQuery,
    options?: TransportRequestOptions,
  ): Promise<RunnerPage>
  listAccountRunners(
    query: AccountRunnerListQuery,
    options?: TransportRequestOptions,
  ): Promise<RunnerPage>
  getSession(
    runnerId: string,
    sessionId: string,
    options?: TransportRequestOptions,
  ): Promise<Session>
  listSessions(
    runnerId: string,
    options?: TransportRequestOptions,
  ): Promise<Session[]>
  cancelRunner(
    runnerId: string,
    options?: TransportRequestOptions,
  ): Promise<void>
  cancelSession(
    runnerId: string,
    sessionId: string,
    options?: TransportRequestOptions,
  ): Promise<void>
  member<A extends MemberAction>(
    runnerId: string,
    action: A,
    input: MemberInput<A>,
    options?: TransportRequestOptions,
  ): Promise<MemberResult<A>>
}
