const test = require('node:test')
const assert = require('node:assert/strict')

const { _private } = require('../bin/nax')
const { parseRunnerResultMarker } = require('../lib/comment-markers')

test('sourceIssueNumbersForStep dedupes issue numbers across prior steps', () => {
  const completed = new Map([
    ['review', { runs: [{ issueNumber: 83 }, { issueNumber: 84 }, { issueNumber: 85 }] }],
    ['cross-review', { runs: [{ issueNumber: 83 }, { issueNumber: 84 }, { issueNumber: 85 }] }],
  ])
  const step = {
    input: [
      { step: 'review', results: 'all' },
      { step: 'cross-review', results: 'all' },
    ],
  }

  assert.deepEqual(_private.sourceIssueNumbersForStep(step, completed), [83, 84, 85])
})

test('sourceRunsForStep keeps follow-up results per input step even when runner id is reused', () => {
  const completed = new Map([
    ['review', { runs: [{ agent: 'codex', runnerId: 'runner-1', resultText: 'done' }] }],
    ['cross-review', { runs: [{ agent: 'codex', runnerId: 'runner-1', resultText: 'done again' }] }],
  ])
  const step = {
    input: [
      { step: 'review', results: 'all' },
      { step: 'cross-review', results: 'all' },
    ],
  }

  assert.deepEqual(_private.sourceRunsForStep(step, completed), [
    { agent: 'codex', runnerId: 'runner-1', resultText: 'done', sourceStep: 'review' },
    { agent: 'codex', runnerId: 'runner-1', resultText: 'done again', sourceStep: 'cross-review' },
  ])
})

test('sourceRunsForStep dedupes within a single input step', () => {
  const completed = new Map([
    ['review', { runs: [
      { agent: 'codex', runnerId: 'runner-1', resultText: 'a' },
      { agent: 'codex', runnerId: 'runner-1', resultText: 'b' },
    ] }],
  ])
  const step = { input: [{ step: 'review', results: 'all' }] }

  assert.deepEqual(_private.sourceRunsForStep(step, completed), [
    { agent: 'codex', runnerId: 'runner-1', resultText: 'a', sourceStep: 'review' },
  ])
})

test('formatCompactLocalRunResults truncates prior local outputs for retry prompts', () => {
  const longResult = `${'A'.repeat(800)}\nimportant tail`
  const formatted = _private.formatCompactLocalRunResults([
    {
      agent: 'claude',
      sourceStep: 'ideate',
      resultText: longResult,
    },
  ], {
    perRunLimit: 300,
    totalLimit: 1000,
  })

  assert.match(formatted, /## Prior Agent Results/)
  assert.match(formatted, /Claude from ideate/)
  assert.match(formatted, /compacted from/)
  assert.match(formatted, /important tail/)
  assert.ok(formatted.length < longResult.length)
})

test('usageSummariesForRunState aggregates usage by step and total', () => {
  const summary = _private.usageSummariesForRunState({
    steps: [
      {
        id: 'review',
        title: 'Review',
        runs: [
          {
            agent: 'claude',
            usage: {
              totalTokens: 420,
              totalCreditsCost: 1.25,
              stepsCount: 10,
            },
          },
          {
            agent: 'codex',
            rawResult: {
              latestSession: {
                usage: {
                  total_tokens: 650,
                  total_credits_cost: 2.5,
                },
                steps_count: 46,
              },
            },
          },
        ],
      },
      {
        id: 'synthesize',
        title: 'Summarize Consensus',
        runs: [
          {
            agent: 'codex',
            usage: {
              totalTokens: 15,
              totalCreditsCost: 0.1,
              stepsCount: 1,
            },
          },
        ],
      },
    ],
  })

  assert.equal(summary.steps.length, 2)
  assert.equal(summary.steps[0].title, 'Review')
  assert.equal(summary.steps[0].usage.totalTokens, 1070)
  assert.equal(summary.steps[0].usage.stepsCount, 56)
  assert.equal(summary.total.totalTokens, 1085)
  assert.equal(summary.total.totalCreditsCost, 3.85)
  assert.equal(summary.total.stepsCount, 57)
  assert.match(summary.totalSummary, /1,085 tokens/)
  assert.match(summary.totalSummary, /57 steps/)
  assert.match(summary.totalSummary, /3.85 credits/)
})

test('non-TTY progress reporter repeats unchanged run status after heartbeat interval', () => {
  const originalLog = console.log
  const originalNow = Date.now
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  let now = 1000
  console.log = (line) => lines.push(line)
  Date.now = () => now
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = _private.makeStepProgressReporter({
      stepTitle: 'Review',
      total: 1,
      agents: ['codex'],
      nonTtyHeartbeatMs: 1000,
    })
    const event = {
      run: { agent: 'codex', runnerId: 'runner-1' },
      state: 'running',
    }
    reporter.updateRun(event)
    now += 500
    reporter.updateRun(event)
    now += 500
    reporter.updateRun(event)
  } finally {
    console.log = originalLog
    Date.now = originalNow
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'codex runner-1: running (check #1)',
    'codex runner-1: running (check #3)',
  ])
})

test('formatSubmittedLocalRunBoxes renders submitted local run details', () => {
  const output = _private.formatSubmittedLocalRunBoxes({
    prompt: { title: 'Review' },
    runs: [
      {
        agent: 'claude',
        runnerId: 'runner-1',
        sessionId: 'session-1',
        status: 'submitted',
        submittedAfterSeconds: 6,
      },
    ],
  })

  assert.match(output, /Claude Review/)
  assert.match(output, /Status: submitted/)
  assert.match(output, /Runner ID: runner-1/)
  assert.match(output, /Session ID: session-1/)
  assert.match(output, /Submitted after: 6s/)
})

test('non-TTY progress reporter aligns agent and state columns', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  console.log = (line) => lines.push(line)
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = _private.makeStepProgressReporter({
      stepTitle: 'Review',
      total: 3,
      agents: ['claude', 'gemini', 'codex'],
    })
    reporter.updateRun({
      run: { agent: 'claude', runnerId: '6a0e1befb595e97af9a2c165' },
      state: 'running',
    })
    reporter.updateRun({
      run: { agent: 'gemini', runnerId: '6a0e1bee848af0ba500f3c89' },
      state: 'running',
    })
    reporter.updateRun({
      run: { agent: 'codex', runnerId: '6a0e1bf1c1a717707743f5c5' },
      state: 'running',
    })
    reporter.updateRun({
      run: { agent: 'codex', runnerId: '6a0e1bf1c1a717707743f5c5' },
      state: 'done',
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'claude 6a0e1befb595e97af9a2c165: running (check #1)',
    'gemini 6a0e1bee848af0ba500f3c89: running (check #1)',
    'codex  6a0e1bf1c1a717707743f5c5: running (check #1)',
    'codex  6a0e1bf1c1a717707743f5c5: done    (check #2)',
  ])
})

test('non-TTY progress reporter prints usage when a local run completes', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const lines = []
  console.log = (line) => lines.push(line)
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  try {
    const reporter = _private.makeStepProgressReporter({
      stepTitle: 'Review',
      total: 1,
      agents: ['codex'],
    })
    reporter.updateRun({
      run: {
        agent: 'codex',
        runnerId: 'runner-1',
        status: 'completed',
        usage: {
          totalTokens: 85131,
          stepsCount: 10,
          totalCreditsCost: 18.06858,
        },
      },
      state: 'completed',
      terminal: true,
      terminalSuccess: true,
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
  }

  assert.deepEqual(lines, [
    'codex runner-1: completed (check #1)\n**Usage:** 85,131 tokens · 10 steps · 18.07 credits',
  ])
})

test('success box keeps non-TTY links on one line', () => {
  const originalLog = console.log
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
  const lines = []
  const longUrl = 'https://app.netlify.com/projects/netlify-agent-executor/agent-runs/6a0e1ce1f8fc93c4132a27de?session=6a0e1ce1f8fc93c4132a27e0'
  console.log = (line = '') => lines.push(String(line))
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 })
  try {
    _private.printSuccessBox({
      flow: { title: 'Do Next' },
      transport: 'local',
      projectRoot: process.cwd(),
      runState: {
        steps: [
          {
            id: 'synthesize',
            title: 'Synthesize Next Task',
            status: 'completed',
            runs: [
              {
                agent: 'codex',
                status: 'completed',
                runnerId: '6a0e1ce1f8fc93c4132a27de',
                sessionId: '6a0e1ce1f8fc93c4132a27e0',
                links: { sessionUrl: longUrl },
              },
            ],
          },
        ],
      },
    })
  } finally {
    console.log = originalLog
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    } else {
      delete process.stdout.isTTY
    }
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns)
    } else {
      delete process.stdout.columns
    }
  }

  const output = lines.join('\n')
  assert.match(output, /Final agent run:/)
  assert.ok(output.includes(longUrl))
})

test('localRedriveCandidates finds failed local runs by step and agent', () => {
  const runState = {
    steps: [
      {
        id: 'ideate',
        runs: [{ agent: 'claude', runnerId: 'runner-1', status: 'completed', resultText: 'done' }],
      },
      {
        id: 'react',
        runs: [
          { agent: 'claude', runnerId: 'runner-2', status: 'failed', resultText: 'argument list too long' },
          { agent: 'gemini', runnerId: 'runner-3', status: 'completed', resultText: 'done' },
        ],
      },
    ],
  }

  const candidates = _private.localRedriveCandidates(runState, { stepId: 'react', agent: 'claude' })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].step.id, 'react')
  assert.equal(candidates[0].run.runnerId, 'runner-2')
  assert.equal(candidates[0].runIndex, 0)
})

test('firstRunnableStepIndex finds incomplete saved local step', () => {
  const flow = {
    steps: [
      { id: 'review' },
      { id: 'cross-review' },
      { id: 'synthesize' },
    ],
  }
  const runState = {
    steps: [
      { id: 'review', status: 'completed' },
      { id: 'cross-review', status: 'running' },
    ],
  }

  assert.equal(_private.firstRunnableStepIndex(flow, runState), 1)
})

test('findGithubRunnerFailures extracts failed Netlify status comments', () => {
  const failures = _private.findGithubRunnerFailures([
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      issueUrl: 'https://github.com/example/repo/issues/91',
      comments: [
        {
          url: 'https://github.com/example/repo/issues/91#issuecomment-1',
          body: [
            '### [Netlify Agent Run Status](https://app.netlify.com/projects/example/agent-runs/abc) ❌',
            '',
            'Netlify Agent Run failed.',
            '',
            '**Failure summary:** Agent timed out before completion',
            '',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
      ],
    },
    {
      issueNumber: 92,
      issueTitle: '2026-05-14 Gemini Generate Ideas',
      issueUrl: 'https://github.com/example/repo/issues/92',
      comments: [
        {
          url: 'https://github.com/example/repo/issues/92#issuecomment-1',
          body: [
            '### [Netlify Agent Run Status](https://app.netlify.com/projects/example/agent-runs/def) ✅',
            '',
            'Netlify Agent Run completed.',
            '',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
      ],
    },
  ])

  assert.deepEqual(failures, [
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      url: 'https://github.com/example/repo/issues/91#issuecomment-1',
      summary: 'Agent timed out before completion',
    },
  ])
})

test('resultsScopedToGithubRuns only counts result comments after the submitted prompt comment', () => {
  const scoped = _private.resultsScopedToGithubRuns([
    {
      issueNumber: 91,
      replies: [],
      comments: [
        { url: 'https://x/issues/91#old', body: 'old result\n<!-- netlify-agent-run-result:old:session -->' },
        { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score\n<!-- netlify-workflow-prompt:cross-score:claude:2026-05-14 -->' },
        { url: 'https://x/issues/91#status', body: '### status\n<!-- netlify-agent-run-status -->' },
        { url: 'https://x/issues/91#new', body: 'new result\n<!-- netlify-agent-run-result:new:session -->' },
      ],
    },
  ], [
    { issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' },
  ])

  assert.deepEqual(scoped[0].replies.map((comment) => comment.url), ['https://x/issues/91#new'])
})

test('GitHub result comments marked failed are failures, not completed replies', () => {
  const result = {
    issueNumber: 91,
    issueTitle: '2026-05-14 Claude Generate Ideas',
    comments: [
      { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score' },
      {
        url: 'https://x/issues/91#failed-result',
        body: [
          '### [Run #2 | claude | Agent Run failed](https://app.netlify.com/projects/site/agent-runs/runner) ❌',
          '',
          '**Error excerpt:**',
          '',
          '```text',
          'Encountered a temporary issue — the agent will attempt to continue.',
          '```',
          '',
          '<!-- netlify-agent-run-result:runner:session -->',
        ].join('\n'),
      },
    ],
  }
  const runs = [{ issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' }]

  assert.deepEqual(_private.resultsScopedToGithubRuns([result], runs)[0].replies, [])
  assert.deepEqual(_private.findGithubRunnerFailures([result], runs), [
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      url: 'https://x/issues/91#failed-result',
      summary: 'Agent run failed',
    },
  ])
})

test('findGithubRunnerFailures ignores old failures before the submitted prompt comment', () => {
  const failures = _private.findGithubRunnerFailures([
    {
      issueNumber: 91,
      issueTitle: '2026-05-14 Claude Generate Ideas',
      comments: [
        {
          url: 'https://x/issues/91#old-failure',
          body: [
            'Netlify Agent Run failed.',
            '**Failure summary:** old timeout',
            '<!-- netlify-agent-run-status -->',
          ].join('\n'),
        },
        { url: 'https://x/issues/91#prompt', body: '@netlify claude cross score' },
      ],
    },
  ], [
    { issueNumber: 91, commentUrl: 'https://x/issues/91#prompt' },
  ])

  assert.deepEqual(failures, [])
})

test('normalizeGithubRunResult standardizes action marker usage and links', () => {
  const body = [
    '### [Run #1 | codex | Agent Run completed](https://app.netlify.com/projects/site/agent-runs/runner-97?session=session-97) ✅',
    '',
    '<!-- netlify-agent-run-result runnerId="runner-97" sessionId="session-97" totalTokens=85131 totalCreditsCost=18.06858 stepsCount=10 creditLimitExceeded=false -->',
  ].join('\n')
  const normalized = _private.normalizeGithubRunResult({
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

test('waitForGithubStep retries transient loader errors and still completes', async () => {
  const promptUrl = 'https://x/issues/97#prompt'
  const resultUrl = 'https://x/issues/97#result'
  const issue = {
    number: 97,
    title: '2026-05-17 Codex Review',
    url: 'https://x/issues/97',
    comments: [
      { url: promptUrl, body: '@netlify codex review\n<!-- netlify-workflow-prompt:review:codex:2026-05-17 -->' },
      { url: resultUrl, body: 'codex result body\n<!-- netlify-agent-run-result:runner-97:session-97 -->' },
    ],
  }
  let calls = 0
  const loader = () => {
    calls += 1
    if (calls === 1) {
      throw new Error('HTTP 401: Bad credentials (https://api.github.com/graphql)')
    }
    return issue
  }

  const results = await _private.waitForGithubStep({
    repo: 'example/repo',
    issueNumbers: [97],
    runs: [{ issueNumber: 97, commentUrl: promptUrl, agent: 'codex' }],
    step: { id: 'review', title: 'Review', agents: ['codex'] },
    timeoutMinutes: 1,
    pollMs: 5,
    loader,
  })

  assert.equal(calls, 2)
  assert.equal(results.length, 1)
  assert.equal(results[0].issueNumber, 97)
  assert.equal(results[0].replies.length, 1)
  assert.equal(results[0].replies[0].url, resultUrl)
})

test('waitForGithubStep aborts after maxConsecutiveFailures poll errors', async () => {
  const loader = () => {
    throw new Error('HTTP 500: gateway')
  }
  await assert.rejects(
    _private.waitForGithubStep({
      repo: 'example/repo',
      issueNumbers: [42],
      runs: [{ issueNumber: 42, commentUrl: 'https://x/issues/42#prompt', agent: 'claude' }],
      step: { id: 'review', title: 'Review', agents: ['claude'] },
      timeoutMinutes: 1,
      pollMs: 1,
      loader,
      maxConsecutiveFailures: 3,
    }),
    /aborted after 3 consecutive poll failures/,
  )
})

test('withSelectedAgents filters each workflow step and runnableSteps drops empty steps', () => {
  const flow = {
    defaults: { agents: ['claude', 'gemini', 'codex'] },
    steps: [
      { id: 'review', agents: ['claude', 'gemini', 'codex'] },
      { id: 'synthesize', agents: ['codex'] },
    ],
  }

  assert.deepEqual(_private.flowAgents(flow), ['claude', 'gemini', 'codex'])

  const filtered = _private.withSelectedAgents(flow, ['claude', 'gemini'])
  assert.deepEqual(filtered.steps[0].agents, ['claude', 'gemini'])
  assert.deepEqual(filtered.steps[1].agents, [])
  assert.deepEqual(_private.runnableSteps(filtered, {}).map((step) => step.id), ['review'])
})
