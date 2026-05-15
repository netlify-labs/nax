const test = require('node:test')
const assert = require('node:assert/strict')

const { _private } = require('../bin/nax')

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
