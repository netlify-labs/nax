const test = require('node:test')
const assert = require('node:assert/strict')

const { extractLinkedPullRequest } = require('../bin/nax')

test('extractLinkedPullRequest reads structured session-data PR URLs', () => {
  const linked = extractLinkedPullRequest([
    '<!-- netlify-agent-session-data:{"session_1":{"pr_url":"https://github.com/netlify-labs/gmail-emailer/pull/81"}} -->',
  ].join('\n'), 'netlify-labs/gmail-emailer')

  assert.deepEqual(linked, {
    repo: 'netlify-labs/gmail-emailer',
    number: 81,
    url: 'https://github.com/netlify-labs/gmail-emailer/pull/81',
  })
})

test('extractLinkedPullRequest reads explicit follow-up PR instructions', () => {
  const linked = extractLinkedPullRequest(
    'This issue already has a linked pull request. Leave follow-up prompts on PR #81.',
    'netlify-labs/gmail-emailer',
  )

  assert.deepEqual(linked, {
    repo: 'netlify-labs/gmail-emailer',
    number: 81,
    url: 'https://github.com/netlify-labs/gmail-emailer/pull/81',
  })
})

test('extractLinkedPullRequest ignores incidental PR URLs in embedded agent output', () => {
  const linked = extractLinkedPullRequest([
    '## Merge-State Ledger',
    '',
    '| PR | Base | Head |',
    '| --- | --- | --- |',
    '| [#81](https://github.com/netlify-labs/gmail-emailer/pull/81) | `master` | `agent-consensus` |',
    '| [#73](https://github.com/netlify-labs/gmail-emailer/pull/73) | `master` | `agent-engine` |',
  ].join('\n'), 'netlify-labs/gmail-emailer')

  assert.equal(linked, null)
})
