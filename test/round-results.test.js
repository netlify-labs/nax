const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assertCrossReviewComplete,
  extractStructuredSection,
  fetchRoundResults,
  formatRoundResults,
  inferModelFromTitle,
  pickAgentReplyComment,
  pickAgentReplyComments,
  rawIssuesFromResults,
} = require('../lib/round-results')

test('inferModelFromTitle pulls model out of standard issue titles', () => {
  assert.equal(inferModelFromTitle('2026-05-07 Claude Review'), 'claude')
  assert.equal(inferModelFromTitle('2026-05-07 Gemini Cross Review'), 'gemini')
  assert.equal(inferModelFromTitle('2026-05-07 Codex Review'), 'codex')
})

test('inferModelFromTitle returns null when no known model is present', () => {
  assert.equal(inferModelFromTitle('Random unrelated title'), null)
  assert.equal(inferModelFromTitle(''), null)
})

test('pickAgentReplyComment skips @netlify prompt comments and picks latest reply', () => {
  const comments = [
    { body: '@netlify claude please review and access current setup', url: 'https://x/1' },
    { body: '## Findings\n- something wrong at file.js:10', url: 'https://x/2' },
    { body: '@netlify claude please cross-reference outputs', url: 'https://x/3' },
    { body: '## Cross Review\n- updated position', url: 'https://x/4' },
  ]
  const reply = pickAgentReplyComment(comments)
  assert.equal(reply.url, 'https://x/4')
})

test('pickAgentReplyComment returns null when only prompt comments exist', () => {
  const comments = [
    { body: '@netlify gemini please review', url: 'https://x/1' },
  ]
  assert.equal(pickAgentReplyComment(comments), null)
})

test('pickAgentReplyComment tolerates missing comments array', () => {
  assert.equal(pickAgentReplyComment(null), null)
  assert.equal(pickAgentReplyComment(undefined), null)
})

test('pickAgentReplyComments returns all replies when all=true', () => {
  const comments = [
    { body: '@netlify claude please review', url: 'https://x/1' },
    { body: '## Round 1 Findings', url: 'https://x/2' },
    { body: '@netlify claude please cross-reference', url: 'https://x/3' },
    { body: '## Round 2 Cross Review', url: 'https://x/4' },
  ]
  const replies = pickAgentReplyComments(comments, { all: true })
  assert.equal(replies.length, 2)
  assert.equal(replies[0].url, 'https://x/2')
  assert.equal(replies[1].url, 'https://x/4')
})

test('pickAgentReplyComments returns latest only by default', () => {
  const comments = [
    { body: '## Round 1 Findings', url: 'https://x/2' },
    { body: '## Round 2 Cross Review', url: 'https://x/4' },
  ]
  const replies = pickAgentReplyComments(comments)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].url, 'https://x/4')
})

test('pickAgentReplyComments skips comments carrying the workflow prompt marker', () => {
  const comments = [
    { body: '@netlify claude please review\n\n<!-- netlify-workflow-prompt:review:claude:2026-05-07 -->', url: 'https://x/1' },
    { body: '## Round 1 Findings\n- foo', url: 'https://x/2' },
    { body: 'Random text without @ prefix\n\n<!-- netlify-workflow-prompt:cross-review:claude:2026-05-07 -->', url: 'https://x/3' },
    { body: '## Round 2 Cross Review', url: 'https://x/4' },
  ]
  const replies = pickAgentReplyComments(comments, { all: true })
  assert.deepEqual(replies.map((r) => r.url), ['https://x/2', 'https://x/4'])
})

test('pickAgentReplyComments prefers runner result-marker matches when present', () => {
  const comments = [
    { body: '@netlify claude please review\n<!-- netlify-workflow-prompt:review:claude:2026-05-07 -->', url: 'https://x/prompt' },
    { body: '### Run #1 status link...\n<!-- netlify-agent-run-status -->', url: 'https://x/status' },
    { body: 'TOC of runs\n<!-- netlify-agent-run-history -->', url: 'https://x/history' },
    { body: '### Run #1 full result\n<!-- netlify-agent-run-result:abc123:def456 -->', url: 'https://x/result-1' },
    { body: '### Run #2 full result\n<!-- netlify-agent-run-result:abc789:def000 -->', url: 'https://x/result-2' },
  ]
  const replies = pickAgentReplyComments(comments, { all: true })
  assert.deepEqual(replies.map((r) => r.url), ['https://x/result-1', 'https://x/result-2'])
})

test('pickAgentReplyComments fallback keeps the legacy single-comment status (which contains the full result) but excludes history TOC', () => {
  const comments = [
    { body: '@netlify claude please review\n<!-- netlify-workflow-prompt:review:claude:2026-05-07 -->', url: 'https://x/prompt' },
    { body: '### Run #1 result narrative\n<!-- netlify-agent-run-status -->', url: 'https://x/status' },
    { body: 'TOC\n<!-- netlify-agent-run-history -->', url: 'https://x/history' },
  ]
  const replies = pickAgentReplyComments(comments, { all: true })
  assert.deepEqual(replies.map((r) => r.url), ['https://x/status'])
})

test('formatRoundResults produces collapsible details with single-reply summary', () => {
  const out = formatRoundResults({
    heading: 'Round 1 Outputs',
    results: [
      {
        issueNumber: 29,
        issueTitle: '2026-05-07 Claude Review',
        issueUrl: 'https://github.com/x/y/issues/29',
        model: 'claude',
        replies: [
          {
            body: '## Findings\n- foo',
            url: 'https://github.com/x/y/issues/29#issuecomment-1',
            author: { login: 'netlify-runner' },
            createdAt: '2026-05-07T18:00:00Z',
          },
        ],
      },
      {
        issueNumber: 30,
        issueTitle: '2026-05-07 Gemini Review',
        issueUrl: 'https://github.com/x/y/issues/30',
        model: 'gemini',
        replies: [],
      },
    ],
  })

  assert.match(out, /^## Round 1 Outputs/)
  assert.match(out, /<summary>Claude — issue #29: 2026-05-07 Claude Review \(1 reply\)<\/summary>/)
  assert.match(out, /Author: `netlify-runner`/)
  assert.match(out, /Posted: `2026-05-07T18:00:00Z`/)
  assert.match(out, /## Findings/)
  assert.doesNotMatch(out, /### Reply 1 of 1/)
  assert.match(out, /<summary>Gemini — issue #30: 2026-05-07 Gemini Review \(no replies\)<\/summary>/)
  assert.match(out, /No agent reply was found/)
})

test('formatRoundResults adds per-reply sub-headings when multiple replies are embedded', () => {
  const out = formatRoundResults({
    heading: 'Prior Round Outputs',
    results: [
      {
        issueNumber: 29,
        issueTitle: '2026-05-07 Claude Review',
        issueUrl: 'https://github.com/x/y/issues/29',
        model: 'claude',
        replies: [
          { body: '## Round 1 Findings', url: 'https://x/r1', createdAt: '2026-05-07T18:00:00Z' },
          { body: '## Round 2 Cross Review', url: 'https://x/r2', createdAt: '2026-05-08T18:00:00Z' },
        ],
      },
    ],
  })

  assert.match(out, /\(2 replies\)/)
  assert.match(out, /### Reply 1 of 2/)
  assert.match(out, /### Reply 2 of 2/)
  assert.match(out, /## Round 1 Findings/)
  assert.match(out, /## Round 2 Cross Review/)
})

test('formatRoundResults still accepts the legacy single-reply shape', () => {
  const out = formatRoundResults({
    heading: 'Round 1 Outputs',
    results: [
      {
        issueNumber: 29,
        issueTitle: '2026-05-07 Claude Review',
        issueUrl: 'https://github.com/x/y/issues/29',
        model: 'claude',
        reply: {
          body: '## Findings',
          url: 'https://x/1',
        },
      },
    ],
  })

  assert.match(out, /\(1 reply\)/)
  assert.match(out, /## Findings/)
})

test('formatRoundResults returns empty string when no results', () => {
  assert.equal(formatRoundResults({ results: [] }), '')
  assert.equal(formatRoundResults({ results: null }), '')
})

test('fetchRoundResults emits fetching/fetched progress events per issue', () => {
  const fakeIssues = {
    63: {
      number: 63,
      title: '2026-05-07 Claude Review',
      url: 'https://x/63',
      comments: [{ body: '## Findings', url: 'https://x/63#c1' }],
    },
    64: {
      number: 64,
      title: '2026-05-07 Gemini Review',
      url: 'https://x/64',
      comments: [],
    },
  }
  const events = []
  fetchRoundResults({
    repo: 'org/repo',
    issueNumbers: [63, 64],
    loader: ({ issueNumber }) => fakeIssues[issueNumber],
    onProgress: (event) => events.push(event),
  })

  assert.equal(events.length, 4)
  assert.equal(events[0].phase, 'fetching')
  assert.equal(events[0].issueNumber, 63)
  assert.equal(events[0].index, 0)
  assert.equal(events[0].total, 2)
  assert.equal(events[1].phase, 'fetched')
  assert.equal(events[1].replyCount, 1)
  assert.equal(events[2].phase, 'fetching')
  assert.equal(events[2].issueNumber, 64)
  assert.equal(events[3].phase, 'fetched')
  assert.equal(events[3].replyCount, 0)
})

test('pickAgentReplyComments excludes our own prompt comments even when they carry an embedded run-result marker', () => {
  const comments = [
    {
      body: '### Run #1 result\n<!-- netlify-agent-run-result:abc:def -->',
      url: 'https://x/round-1',
    },
    {
      body:
        '@netlify claude please cross-reference\n' +
        '<!-- netlify-workflow-prompt:cross-review:claude:2026-05-09 -->\n' +
        '<details><summary>Round 1</summary>\n' +
        '### Run #1 embedded\n<!-- netlify-agent-run-result:abc:def -->\n' +
        '</details>',
      url: 'https://x/our-cross-review-prompt',
    },
    {
      body: '### Run #2 result\n<!-- netlify-agent-run-result:ghi:jkl -->',
      url: 'https://x/round-2',
    },
  ]
  const replies = pickAgentReplyComments(comments, { all: true })
  assert.deepEqual(replies.map((r) => r.url), ['https://x/round-1', 'https://x/round-2'])
})

test('extractStructuredSection grabs the JSON block under a Structured Findings heading', () => {
  const body = [
    '### Result',
    '## 1. Repository State',
    'state: ok',
    '## 2. Structured Findings',
    '',
    '```json',
    '[{"id":"R1","claim":"foo"}]',
    '```',
    '',
    '## 3. Prose',
    'long prose text',
  ].join('\n')

  const section = extractStructuredSection(body)
  assert.ok(section)
  assert.match(section.heading, /^## 2\. Structured Findings/)
  assert.equal(section.json, '[{"id":"R1","claim":"foo"}]')
})

test('extractStructuredSection also matches Structured Consensus headings', () => {
  const body = '## 2. Structured Consensus\n\n```json\n{"x":1}\n```\n## 3. Next'
  const section = extractStructuredSection(body)
  assert.ok(section)
  assert.match(section.heading, /Structured Consensus/)
  assert.equal(section.json, '{"x":1}')
})

test('extractStructuredSection returns null when no fenced JSON is present', () => {
  assert.equal(extractStructuredSection('## 2. Structured Findings\n\nno fence here'), null)
  assert.equal(extractStructuredSection('no heading at all'), null)
})

test('formatRoundResults with structuredOnly replaces prose with the JSON block and keeps the comment URL', () => {
  const out = formatRoundResults({
    heading: 'Round 2 Cross-Review Outputs',
    structuredOnly: true,
    results: [
      {
        issueNumber: 67,
        issueTitle: '2026-05-09 Claude Review',
        issueUrl: 'https://x/67',
        model: 'claude',
        replies: [
          {
            url: 'https://x/67#c1',
            body: '## 1. Repository State\nok\n## 2. Structured Findings\n\n```json\n[{"id":"S1"}]\n```\n## 3. Prose blah blah',
          },
        ],
      },
    ],
  })

  assert.match(out, /reduced to its structured-findings JSON block/)
  assert.match(out, /## 2\. Structured Findings/)
  assert.match(out, /\[\{"id":"S1"\}\]/)
  assert.doesNotMatch(out, /Prose blah blah/)
  assert.match(out, /Comment: https:\/\/x\/67#c1/)
})

test('formatRoundResults with structuredOnly notes when a reply has no JSON block', () => {
  const out = formatRoundResults({
    heading: 'Round 2',
    structuredOnly: true,
    results: [
      {
        issueNumber: 68,
        issueTitle: '2026-05-09 Gemini Review',
        issueUrl: 'https://x/68',
        model: 'gemini',
        replies: [{ url: 'https://x/68#c1', body: 'free-form text only' }],
      },
    ],
  })
  assert.match(out, /Structured findings block not found/)
})

test('assertCrossReviewComplete passes when each issue has a cross-review prompt followed by a runner result', () => {
  const issues = [
    {
      number: 67,
      title: '2026-05-09 Claude Review',
      comments: [
        { body: '### round 1 result\n<!-- netlify-agent-run-result:a:b -->' },
        { body: '@netlify claude please cross-reference\n<!-- netlify-workflow-prompt:cross-review:claude:2026-05-09 -->' },
        { body: '### round 2 result\n<!-- netlify-agent-run-result:c:d -->' },
      ],
    },
  ]
  assert.doesNotThrow(() => assertCrossReviewComplete(issues))
})

test('assertCrossReviewComplete throws when cross-review prompt is missing', () => {
  const issues = [
    {
      number: 67,
      title: '2026-05-09 Claude Review',
      comments: [{ body: '### round 1 only\n<!-- netlify-agent-run-result:a:b -->' }],
    },
  ]
  assert.throws(
    () => assertCrossReviewComplete(issues),
    /no cross-review prompt found/,
  )
})

test('assertCrossReviewComplete throws when cross-review prompt has no runner result yet', () => {
  const issues = [
    {
      number: 67,
      title: '2026-05-09 Claude Review',
      comments: [
        { body: '### round 1\n<!-- netlify-agent-run-result:a:b -->' },
        { body: '@netlify claude please cross-reference\n<!-- netlify-workflow-prompt:cross-review:claude:2026-05-09 -->' },
      ],
    },
  ]
  assert.throws(
    () => assertCrossReviewComplete(issues),
    /no agent-runner result followed it/,
  )
})

test('assertCrossReviewComplete reports all incomplete issues, not just the first', () => {
  const issues = [
    {
      number: 67,
      title: 'Claude',
      comments: [
        { body: '### round 1\n<!-- netlify-agent-run-result:a:b -->' },
        { body: '@netlify claude please cross-reference\n<!-- netlify-workflow-prompt:cross-review:claude:2026-05-09 -->' },
        { body: '### round 2\n<!-- netlify-agent-run-result:c:d -->' },
      ],
    },
    {
      number: 68,
      title: 'Gemini',
      comments: [{ body: '### round 1\n<!-- netlify-agent-run-result:e:f -->' }],
    },
  ]
  assert.throws(
    () => assertCrossReviewComplete(issues),
    /#68 Gemini/,
  )
})

test('rawIssuesFromResults projects fetched results back into the loader-shaped issues array', () => {
  const results = [
    {
      issueNumber: 67,
      issueTitle: 'Claude',
      issueUrl: 'https://x/67',
      replies: [{ url: 'https://x/67#c1' }],
      comments: [{ body: 'comment 1' }, { body: 'comment 2' }],
    },
  ]
  const raw = rawIssuesFromResults(results)
  assert.deepEqual(raw, [
    {
      number: 67,
      title: 'Claude',
      url: 'https://x/67',
      comments: [{ body: 'comment 1' }, { body: 'comment 2' }],
    },
  ])
})
