import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_RUNNER_SDK_HANDLE_VERSION,
  GITHUB_FAILURE_COMMENT_MARKER,
  ensureGithubFailureLabel,
  renderGithubFailureComment,
  serializeHandle,
  upsertGithubFailureCheck,
  upsertGithubFailureComment,
} from '../src/index.js'
import type {
  FailureClassification,
  GithubComment,
  GithubFailureCheck,
  GithubFailureLabel,
  GithubFailurePresentation,
  SessionHandle,
} from '../src/index.js'

const PROMPT_SECRET = 'TOP SECRET CUSTOMER PROMPT'
const BLOB_INSTRUCTION_SECRET = 'FETCH BLOB FROM secret-store/path'
const TOKEN_SECRET = 'github-token-secret'
const REQUEST_ID = '33333333-3333-4333-8333-333333333333'

function handle(): SessionHandle {
  return {
    v: AGENT_RUNNER_SDK_HANDLE_VERSION,
    kind: 'session',
    runnerId: 'runner-1',
    siteId: 'site-1',
    agent: 'claude',
    origin: {
      codeOrigin: 'github',
      branch: 'feature/presenter',
    },
    input: {
      siteId: 'site-1',
      prompt: PROMPT_SECRET,
      requestId: REQUEST_ID,
      land: 'merge',
    },
    policy: {
      landing: 'merge',
      deadlineAt: 2_000_000_000_000,
      retryBudget: { capacity: 0 },
    },
    retries: { capacity: 0 },
    currentSessionId: 'session-2',
    sessionId: 'session-2',
    sessionInput: {
      prompt: BLOB_INSTRUCTION_SECRET,
      requestId: '44444444-4444-4444-8444-444444444444',
    },
  }
}

function failure(
  overrides: Partial<FailureClassification> = {},
): FailureClassification {
  return {
    category: 'github',
    code: 'pr-head-changed',
    title: `Landing failed for ${PROMPT_SECRET}`,
    message: [
      `Bearer ${TOKEN_SECRET}`,
      `token=${TOKEN_SECRET}`,
      `Authorization: token ${TOKEN_SECRET}`,
      `Authorization: Basic ${TOKEN_SECRET}`,
      '<!-- agent-runner-sdk-request-id:33333333-3333-4333-8333-333333333333 -->',
    ].join(' '),
    remediation: [
      BLOB_INSTRUCTION_SECRET,
      'Review the pull request head manually.',
    ],
    severity: 'error',
    retryable: false,
    userActionRequired: true,
    stage: 'github',
    ...overrides,
  }
}

function presentation(
  overrides: Partial<GithubFailurePresentation> = {},
): GithubFailurePresentation {
  return {
    serializedHandle: serializeHandle(handle()),
    failure: failure(),
    links: {
      runnerUrl: `https://app.netlify.com/runner/1?token=${TOKEN_SECRET}`,
      sessionUrl: 'https://app.netlify.com/runner/1/session/2',
      prUrl: 'https://github.com/netlify-labs/repo/pull/7',
    },
    recovery: {
      confidence: 'high',
      recoveryAction: {
        kind: 'escalateChangedHead',
        prUrl: 'https://github.com/netlify-labs/repo/pull/7',
        expectedHeadSha: 'old-head',
        observedHeadSha: 'new-head',
      },
    },
    ...overrides,
  }
}

function assertRedacted(value: string): void {
  assert.doesNotMatch(
    value,
    new RegExp([
      PROMPT_SECRET,
      BLOB_INSTRUCTION_SECRET,
      TOKEN_SECRET,
      'agent-runner-sdk-request-id',
      REQUEST_ID,
    ].join('|'), 'i'),
  )
}

test('GitHub failure comments render stable safe recovery guidance', () => {
  const body = renderGithubFailureComment(presentation())

  assert.equal(body.startsWith(GITHUB_FAILURE_COMMENT_MARKER), true)
  assert.match(body, /Category: `github`/)
  assert.match(body, /Code: `pr-head-changed`/)
  assert.match(body, /Handle version: `1`/)
  assert.match(body, /Automatic retry is not permitted/)
  assert.match(body, /Do not merge the newer head automatically/)
  assert.match(body, /https:\/\/app\.netlify\.com\/runner\/1\)/)
  assert.doesNotMatch(body, /\?token=/)
  assertRedacted(body)
})

test('GitHub failure comments create once and update the same bot-owned marker', async () => {
  const comments: GithubComment[] = [{
    id: 'user-comment',
    authorLogin: 'human-user',
    body: `${GITHUB_FAILURE_COMMENT_MARKER}\nnot bot owned`,
  }]
  let creates = 0
  let updates = 0
  const adapter = {
    botLogin: 'netlify-agent[bot]',
    listComments: async () => comments,
    createComment: async (body: string): Promise<GithubComment> => {
      creates += 1
      const comment = {
        id: 'bot-comment',
        authorLogin: 'netlify-agent[bot]',
        body,
      }
      comments.push(comment)
      return comment
    },
    updateComment: async (
      id: string | number,
      body: string,
    ): Promise<GithubComment> => {
      updates += 1
      const index = comments.findIndex((comment) => comment.id === id)
      assert.notEqual(index, -1)
      const comment = {
        id,
        authorLogin: 'netlify-agent[bot]',
        body,
      }
      comments[index] = comment
      return comment
    },
  }

  const created = await upsertGithubFailureComment(
    presentation(),
    adapter,
  )
  assert.equal(created.kind, 'created')
  assert.equal(creates, 1)
  assert.equal(updates, 0)

  const resumed = await upsertGithubFailureComment(
    presentation(),
    adapter,
  )
  assert.equal(resumed.kind, 'unchanged')
  assert.equal(creates, 1)
  assert.equal(updates, 0)

  const updated = await upsertGithubFailureComment(
    presentation({
      failure: failure({
        code: 'github-permission-denied',
        title: 'GitHub permission denied',
        message: 'Grant the bot access.',
        remediation: ['Grant the required repository permissions.'],
      }),
    }),
    adapter,
  )
  assert.equal(updated.kind, 'updated')
  assert.equal(creates, 1)
  assert.equal(updates, 1)
  assert.equal(
    comments.filter((comment) => (
      comment.authorLogin === 'netlify-agent[bot]'
      && comment.body.includes(GITHUB_FAILURE_COMMENT_MARKER)
    )).length,
    1,
  )

  await assert.rejects(
    () => upsertGithubFailureComment(presentation(), {
      ...adapter,
      botLogin: ' ',
    }),
    /requires a bot login/,
  )
})

test('GitHub failure comments and checks stay within API text limits', async () => {
  const oversized = presentation({
    failure: failure({
      title: 'T'.repeat(300),
      message: 'M'.repeat(70_000),
    }),
  })
  const comment = renderGithubFailureComment(oversized)
  assert.equal(comment.length <= 60_000, true)
  assert.match(comment, /Output truncated to fit GitHub limits/)

  let check: GithubFailureCheck | undefined
  await upsertGithubFailureCheck(oversized, {
    upsertCheck: async (value) => {
      check = value
    },
  })
  assert.equal((check?.title.length ?? 0) <= 255, true)
  assert.equal((check?.summary.length ?? 0) <= 60_000, true)
  assert.match(
    check?.summary ?? '',
    /Output truncated to fit GitHub limits/,
  )
})

test('check-run and label presenters remain separate idempotent capabilities', async () => {
  let commentCalls = 0
  const checks: GithubFailureCheck[] = []
  const labels: GithubFailureLabel[] = []

  await upsertGithubFailureComment(presentation(), {
    botLogin: 'netlify-agent[bot]',
    listComments: async () => [],
    createComment: async (body) => {
      commentCalls += 1
      return {
        id: 1,
        authorLogin: 'netlify-agent[bot]',
        body,
      }
    },
    updateComment: async () => {
      throw new Error('unexpected update')
    },
  })
  assert.equal(commentCalls, 1)
  assert.equal(checks.length, 0)
  assert.equal(labels.length, 0)

  await upsertGithubFailureCheck(presentation(), {
    upsertCheck: async (check) => {
      checks.push(check)
    },
  })
  assert.equal(checks.length, 1)
  assert.equal(checks[0]?.externalId, [
    'nax-agent-runner-sdk',
    'runner-1',
    'session-2',
    'failure',
  ].join(':'))
  assert.equal(checks[0]?.conclusion, 'failure')
  assertRedacted(checks[0]?.summary ?? '')

  await ensureGithubFailureLabel(presentation(), {
    ensureLabel: async (label) => {
      labels.push(label)
    },
  })
  assert.deepEqual(labels, [{
    name: 'agent-runner:github',
    color: 'b60205',
    description: 'Netlify Agent Runner failure requiring attention.',
  }])
  assert.equal(commentCalls, 1)
})
