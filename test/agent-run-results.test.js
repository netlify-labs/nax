const test = require('node:test')
const assert = require('node:assert/strict')

const {
  aggregateRunUsage,
  formatAgentRunUrl,
  formatAgentRunUrlFromAdminUrl,
  formatUsageSummary,
  normalizeAgentRunResult,
  normalizeGithubRunResult,
  normalizeUsage,
  usageSummariesForRunState,
} = require('../lib/agent-run-results')
const { parseRunnerResultMarker } = require('../lib/comment-markers')

test('normalizeUsage standardizes compact usage fields from snake_case and camelCase payloads', () => {
  assert.deepEqual(normalizeUsage({
    total_tokens: '661381',
    total_credits_cost: '145.98018',
    steps_count: 46.8,
    credit_limit_exceeded: false,
    total_input_tokens: 69605,
  }), {
    totalTokens: 661381,
    totalCreditsCost: 145.98018,
    stepsCount: 46,
    creditLimitExceeded: false,
  })

  assert.deepEqual(normalizeUsage({
    totalTokens: 85131,
    totalCreditsCost: 18.06858,
    stepsCount: 10,
    creditLimitExceeded: true,
  }), {
    totalTokens: 85131,
    totalCreditsCost: 18.06858,
    stepsCount: 10,
    creditLimitExceeded: true,
  })
})

test('normalizeUsage ignores invalid values and returns null when no usage fields are present', () => {
  assert.deepEqual(normalizeUsage({
    total_tokens: -1,
    total_credits_cost: 'nope',
    steps_count: Number.NaN,
    credit_limit_exceeded: 'false',
  }), null)

  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage({ total_input_tokens: 12 }), null)
})

test('normalizeAgentRunResult produces the canonical local runner result shape', () => {
  const normalized = normalizeAgentRunResult({
    run: {
      agent: 'claude',
      runnerId: 'runner-from-run',
      links: {
        agentRunUrl: 'https://app.netlify.com/projects/site/agent-runs/runner-from-run',
      },
      usage: {
        totalTokens: 100,
      },
    },
    runner: {
      id: 'runner-from-runner',
      agent_config: { agent: 'codex' },
      deploy_url: 'https://deploy.example',
    },
    session: {
      id: 'session-1',
      result: 'finished',
      usage: {
        total_tokens: 200,
        total_credits_cost: 2.5,
      },
      steps_count: 4,
      credit_limit_exceeded: false,
      pull_request_url: 'https://github.com/o/r/pull/1',
    },
    status: 'completed',
  })

  assert.equal(normalized.runnerId, 'runner-from-run')
  assert.equal(normalized.sessionId, 'session-1')
  assert.equal(normalized.agent, 'claude')
  assert.equal(normalized.status, 'completed')
  assert.equal(normalized.resultText, 'finished')
  assert.equal(normalized.deployUrl, 'https://deploy.example')
  assert.equal(normalized.prUrl, 'https://github.com/o/r/pull/1')
  assert.deepEqual(normalized.usage, {
    totalTokens: 200,
    totalCreditsCost: 2.5,
    stepsCount: 4,
    creditLimitExceeded: false,
  })
  assert.equal(normalized.stepsCount, 4)
  assert.equal(normalized.creditLimitExceeded, false)
})

test('normalizeAgentRunResult tolerates missing ids and usage', () => {
  const normalized = normalizeAgentRunResult({
    run: {},
    runner: {},
    session: {},
    status: 'running',
  })

  assert.equal(Object.hasOwn(normalized, 'runnerId'), false)
  assert.equal(Object.hasOwn(normalized, 'sessionId'), false)
  assert.equal(normalized.agent, '')
  assert.equal(normalized.status, 'running')
  assert.equal(normalized.resultText, '')
  assert.equal(normalized.usage, null)
})

test('normalizeGithubRunResult standardizes action marker usage and links', () => {
  const body = [
    '### [Run #1 | codex | Agent Run completed](https://app.netlify.com/projects/site/agent-runs/runner-97?session=session-97)',
    '',
    '<!-- netlify-agent-run-result runnerId="runner-97" sessionId="session-97" totalTokens=85131 totalCreditsCost=18.06858 stepsCount=10 creditLimitExceeded=false -->',
  ].join('\n')
  const normalized = normalizeGithubRunResult({
    run: {
      transport: 'github',
      agent: 'codex',
      issueNumber: 97,
      issueUrl: 'https://github.com/o/r/issues/97',
      commentUrl: 'https://github.com/o/r/issues/97#issuecomment-prompt',
    },
    result: {
      issueNumber: 97,
      issueUrl: 'https://github.com/o/r/issues/97',
      model: 'codex',
    },
    reply: {
      url: 'https://github.com/o/r/issues/97#issuecomment-result',
      body,
    },
    status: 'completed',
    marker: parseRunnerResultMarker(body),
  })

  assert.equal(normalized.status, 'completed')
  assert.equal(normalized.runnerId, 'runner-97')
  assert.equal(normalized.sessionId, 'session-97')
  assert.equal(normalized.commentUrl, 'https://github.com/o/r/issues/97#issuecomment-result')
  assert.equal(normalized.issueUrl, 'https://github.com/o/r/issues/97')
  assert.deepEqual(normalized.usage, {
    totalTokens: 85131,
    totalCreditsCost: 18.06858,
    stepsCount: 10,
    creditLimitExceeded: false,
  })
  assert.equal(
    normalized.links.sessionUrl,
    'https://app.netlify.com/projects/site/agent-runs/runner-97?session=session-97',
  )
})

test('normalizeGithubRunResult preserves legacy marker ids without usage', () => {
  const body = [
    'Done',
    '<!-- netlify-agent-run-result:runner-legacy:session-legacy -->',
  ].join('\n')
  const normalized = normalizeGithubRunResult({
    run: {
      agent: 'gemini',
      issueUrl: 'https://github.com/o/r/issues/5',
    },
    reply: {
      url: 'https://github.com/o/r/issues/5#issuecomment-result',
      body,
    },
    status: 'completed',
    marker: parseRunnerResultMarker(body),
  })

  assert.equal(normalized.runnerId, 'runner-legacy')
  assert.equal(normalized.sessionId, 'session-legacy')
  assert.equal(normalized.usage, null)
  assert.equal(normalized.links.agentRunUrl, undefined)
})

test('aggregateRunUsage sums usage across runs and preserves credit limit flags', () => {
  assert.deepEqual(aggregateRunUsage([
    { usage: { totalTokens: 10, totalCreditsCost: 1.25, stepsCount: 2 } },
    { usage: { totalTokens: 25, totalCreditsCost: 2, stepsCount: 3, creditLimitExceeded: true } },
    { usage: null },
  ]), {
    totalTokens: 35,
    totalCreditsCost: 3.25,
    stepsCount: 5,
    creditLimitExceeded: true,
  })
})

test('usageSummariesForRunState returns per-step and total usage summaries', () => {
  const summaries = usageSummariesForRunState({
    steps: [
      {
        id: 'review',
        title: 'Review',
        runs: [
          { usage: { totalTokens: 1000, totalCreditsCost: 2.5, stepsCount: 3 } },
          { usage: { totalTokens: 2000, totalCreditsCost: 3.5, stepsCount: 4 } },
        ],
      },
      {
        id: 'synthesize',
        title: 'Synthesize',
        runs: [
          { usage: { totalTokens: 500, totalCreditsCost: 1, stepsCount: 1 } },
        ],
      },
      {
        id: 'empty',
        title: 'Empty',
        runs: [{ usage: null }],
      },
    ],
  })

  assert.deepEqual(summaries.steps, [
    {
      id: 'review',
      title: 'Review',
      usage: { totalTokens: 3000, totalCreditsCost: 6, stepsCount: 7 },
      summary: '6 credits, 7 steps, 3,000 tokens',
    },
    {
      id: 'synthesize',
      title: 'Synthesize',
      usage: { totalTokens: 500, totalCreditsCost: 1, stepsCount: 1 },
      summary: '1 credits, 1 steps, 500 tokens',
    },
  ])
  assert.deepEqual(summaries.total, {
    totalTokens: 3500,
    totalCreditsCost: 7,
    stepsCount: 8,
  })
  assert.equal(summaries.totalSummary, '7 credits, 8 steps, 3,500 tokens')
})

test('usage helpers can format partial usage summaries', () => {
  assert.equal(formatUsageSummary({ totalTokens: 1234 }), '1,234 tokens')
  assert.equal(formatUsageSummary({ stepsCount: 2, creditLimitExceeded: true }), '2 steps, credit limit exceeded')
  assert.equal(formatUsageSummary({}), '')
})

test('agent run URL helpers include session links only for valid ids', () => {
  assert.equal(
    formatAgentRunUrl('netlify-agent-executor', 'runner_1-2', 'session_3-4'),
    'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/runner_1-2?session=session_3-4',
  )
  assert.equal(
    formatAgentRunUrl('netlify-agent-executor', 'runner_1-2', 'bad/session'),
    'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/runner_1-2',
  )
  assert.equal(formatAgentRunUrl('netlify-agent-executor', 'bad/runner', 'session'), '')
  assert.equal(
    formatAgentRunUrlFromAdminUrl('https://app.netlify.com/projects/site/', 'runner-1', 'session-1'),
    'https://app.netlify.com/projects/site/agent-runs/runner-1?session=session-1',
  )
})
