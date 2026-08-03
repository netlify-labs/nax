import {
  redactSensitiveText,
} from '../auth/redaction.js'
import type {
  FailureClassification,
} from '../domain.js'
import {
  parseHandle,
} from '../handles.js'
import type {
  Handle,
} from '../handles.js'
import type {
  RecoveryAction,
  RecoveryRecommendation,
} from './recovery.js'

export const GITHUB_FAILURE_COMMENT_MARKER =
  '<!-- nax-agent-runner-sdk:failure:v1 -->'

export interface GithubFailureLinks {
  runnerUrl?: string
  sessionUrl?: string
  prUrl?: string
}

export interface GithubFailurePresentation {
  serializedHandle: string | unknown
  failure: FailureClassification
  links?: GithubFailureLinks
  recovery?: RecoveryRecommendation
}

export interface GithubComment {
  id: string | number
  body: string
  authorLogin: string
}

export interface GithubFailureCommentAdapter {
  botLogin: string
  listComments(): Promise<readonly GithubComment[]>
  createComment(body: string): Promise<GithubComment>
  updateComment(
    commentId: string | number,
    body: string,
  ): Promise<GithubComment>
}

export type GithubFailureCommentResult =
  | { kind: 'created'; comment: GithubComment }
  | { kind: 'updated'; comment: GithubComment }
  | { kind: 'unchanged'; comment: GithubComment }

export interface GithubFailureCheck {
  externalId: string
  name: 'Netlify Agent Runner'
  status: 'completed'
  conclusion: 'failure'
  title: string
  summary: string
  detailsUrl?: string
}

export interface GithubFailureCheckAdapter {
  upsertCheck(check: GithubFailureCheck): Promise<void>
}

export interface GithubFailureLabel {
  name: string
  color: 'b60205'
  description: string
}

export interface GithubFailureLabelAdapter {
  ensureLabel(label: GithubFailureLabel): Promise<void>
}

const GITHUB_FAILURE_TEXT_LIMIT = 60_000
const GITHUB_CHECK_TITLE_LIMIT = 255
const GITHUB_TRUNCATION_NOTICE =
  '\n\n_Output truncated to fit GitHub limits._'
const SECRET_ASSIGNMENT_PATTERN =
  /\b(authorization|github_token|netlify_auth_token|token)\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[^\s,;]+/gi

function truncateGithubText(
  value: string,
  limit: number,
  suffix = GITHUB_TRUNCATION_NOTICE,
): string {
  if (value.length <= limit) return value
  return [
    value.slice(0, limit - suffix.length),
    suffix,
  ].join('')
}

function handleSensitiveValues(handle: Handle): unknown[] {
  return [
    handle.input.prompt,
    handle.input.promptRef,
    handle.input.requestId,
    handle.promptDelivery?.promptRef,
    handle.promptDelivery?.sentinel,
    ...(handle.kind === 'session'
      ? [
          handle.sessionInput.prompt,
          handle.sessionInput.promptRef,
          handle.sessionInput.requestId,
        ]
      : []),
  ].filter((value) => value !== undefined)
}

function safeText(value: unknown, handle: Handle): string {
  return redactSensitiveText(
    value,
    handleSensitiveValues(handle),
  ).replace(SECRET_ASSIGNMENT_PATTERN, '$1=[redacted]')
}

function safeUrl(
  value: string | undefined,
  handle: Handle,
): string | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = new URL(safeText(value, handle))
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined
    }
    if (parsed.username || parsed.password) return undefined
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return undefined
  }
}

function recoveryGuidance(action: RecoveryAction): string {
  switch (action.kind) {
    case 'refreshResult':
      return 'Refresh the exact runner/session snapshot and result.'
    case 'reconcileCreate':
      return 'Reconcile the uncertain create with its bounded window and exact private request marker.'
    case 'reconcileSession':
      return 'Reconcile the uncertain follow-up with its bounded window and exact private request marker.'
    case 'resumeLanding':
      return `Resume the persisted ${action.step} landing step.`
    case 'stopAtDeadline':
      return `Stop the exact ${action.target}; its original deadline elapsed.`
    case 'escalateChangedHead':
      return 'Manual review is required because the pull request head changed. Do not merge the newer head automatically.'
    case 'manualReview':
      return 'Manual review is required before another mutation.'
    case 'none':
      return action.reason === 'landing-complete'
        ? 'Landing is already complete.'
        : 'Landing was intentionally skipped.'
  }
}

function safeLines(
  values: readonly string[],
  handle: Handle,
): string[] {
  return values
    .map((value) => safeText(value, handle).trim())
    .filter(Boolean)
}

function renderLinks(
  links: GithubFailureLinks | undefined,
  handle: Handle,
): string[] {
  const values = [
    ['Runner', safeUrl(links?.runnerUrl, handle)],
    ['Session', safeUrl(links?.sessionUrl, handle)],
    ['Pull request', safeUrl(links?.prUrl, handle)],
  ] as const
  const rendered: string[] = []
  for (const [label, url] of values) {
    if (url !== undefined) rendered.push(`- [${label}](${url})`)
  }
  return rendered.length === 0
    ? []
    : ['### Links', '', ...rendered, '']
}

function renderGithubFailure(
  input: GithubFailurePresentation,
  includeMarker: boolean,
): {
  body: string
  handle: Handle
  runnerUrl?: string
} {
  const handle = parseHandle(input.serializedHandle)
  const title = safeText(input.failure.title, handle).trim()
    || 'Agent Runner failure'
  const message = safeText(input.failure.message, handle).trim()
    || 'The Agent Runner operation failed.'
  const remediation = safeLines(input.failure.remediation, handle)
  const retryGuidance = input.failure.retryable
    ? 'Use only the SDK retry policy and its persisted budget.'
    : 'Automatic retry is not permitted for this failure.'
  const recovery = input.recovery === undefined
    ? 'Refresh the exact runner/session state before deciding on recovery.'
    : recoveryGuidance(input.recovery.recoveryAction)
  const runnerUrl = safeUrl(input.links?.runnerUrl, handle)
  const lines = [
    ...(includeMarker ? [GITHUB_FAILURE_COMMENT_MARKER, ''] : []),
    '## Netlify Agent Runner failure',
    '',
    `**${title}**`,
    '',
    message,
    '',
    `- Category: \`${safeText(input.failure.category, handle)}\``,
    `- Code: \`${safeText(input.failure.code, handle)}\``,
    `- Stage: \`${safeText(input.failure.stage, handle)}\``,
    `- Handle version: \`${handle.v}\``,
    '',
    ...renderLinks(input.links, handle),
    '### Recovery',
    '',
    recovery,
    '',
    `Retry guidance: ${retryGuidance}`,
    ...(remediation.length === 0
      ? []
      : [
          '',
          '### Remediation',
          '',
          ...remediation.map((item) => `- ${item}`),
        ]),
  ]
  return {
    body: lines.join('\n').trim(),
    handle,
    ...(runnerUrl === undefined ? {} : { runnerUrl }),
  }
}

export function renderGithubFailureComment(
  input: GithubFailurePresentation,
): string {
  return truncateGithubText(
    renderGithubFailure(input, true).body,
    GITHUB_FAILURE_TEXT_LIMIT,
  )
}

export async function upsertGithubFailureComment(
  input: GithubFailurePresentation,
  adapter: GithubFailureCommentAdapter,
): Promise<GithubFailureCommentResult> {
  const body = renderGithubFailureComment(input)
  const botLogin = adapter.botLogin.trim().toLowerCase()
  if (!botLogin) {
    throw new TypeError(
      'GitHub failure comment presentation requires a bot login.',
    )
  }
  const comments = await adapter.listComments()
  const existing = comments.find((comment) => (
    comment.authorLogin.trim().toLowerCase() === botLogin
    && comment.body.includes(GITHUB_FAILURE_COMMENT_MARKER)
  ))
  if (existing === undefined) {
    return {
      kind: 'created',
      comment: await adapter.createComment(body),
    }
  }
  if (existing.body === body) {
    return { kind: 'unchanged', comment: existing }
  }
  return {
    kind: 'updated',
    comment: await adapter.updateComment(existing.id, body),
  }
}

export async function upsertGithubFailureCheck(
  input: GithubFailurePresentation,
  adapter: GithubFailureCheckAdapter,
): Promise<void> {
  const rendered = renderGithubFailure(input, false)
  await adapter.upsertCheck({
    externalId: [
      'nax-agent-runner-sdk',
      rendered.handle.runnerId,
      rendered.handle.currentSessionId,
      'failure',
    ].join(':'),
    name: 'Netlify Agent Runner',
    status: 'completed',
    conclusion: 'failure',
    title: truncateGithubText(
      safeText(input.failure.title, rendered.handle)
        || 'Agent Runner failure',
      GITHUB_CHECK_TITLE_LIMIT,
      '…',
    ),
    summary: truncateGithubText(
      rendered.body,
      GITHUB_FAILURE_TEXT_LIMIT,
    ),
    ...(rendered.runnerUrl === undefined
      ? {}
      : { detailsUrl: rendered.runnerUrl }),
  })
}

export async function ensureGithubFailureLabel(
  input: GithubFailurePresentation,
  adapter: GithubFailureLabelAdapter,
): Promise<void> {
  const handle = parseHandle(input.serializedHandle)
  const category = safeText(input.failure.category, handle)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown'
  await adapter.ensureLabel({
    name: `agent-runner:${category}`,
    color: 'b60205',
    description: 'Netlify Agent Runner failure requiring attention.',
  })
}
