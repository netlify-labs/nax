const test = require('node:test')
const assert = require('node:assert/strict')

const { buildGroups, parseWorkflowTitle, formatGroupHint } = require('../lib/issue-groups')

test('parseWorkflowTitle extracts date, model, and prompt title', () => {
  assert.deepEqual(parseWorkflowTitle('2026-05-07 Claude Review'), {
    date: '2026-05-07',
    model: 'claude',
    promptTitle: 'Review',
  })
  assert.deepEqual(parseWorkflowTitle('2026-05-07 Gemini Summarize Consensus'), {
    date: '2026-05-07',
    model: 'gemini',
    promptTitle: 'Summarize Consensus',
  })
})

test('parseWorkflowTitle returns null for non-matching titles', () => {
  assert.equal(parseWorkflowTitle('Some random issue'), null)
  assert.equal(parseWorkflowTitle(''), null)
  assert.equal(parseWorkflowTitle('2026-05-07 Llama Review'), null)
})

test('buildGroups groups same-date same-prompt issues across models, sorted desc', () => {
  const issues = [
    { number: 64, title: '2026-05-07 Codex Review', url: 'https://x/64', state: 'OPEN' },
    { number: 62, title: '2026-05-07 Claude Review', url: 'https://x/62', state: 'OPEN' },
    { number: 63, title: '2026-05-07 Gemini Review', url: 'https://x/63', state: 'OPEN' },
    { number: 31, title: '2026-04-25 Codex Review', url: 'https://x/31', state: 'CLOSED' },
    { number: 29, title: '2026-04-25 Claude Review', url: 'https://x/29', state: 'CLOSED' },
    { number: 99, title: 'Some unrelated issue', url: 'https://x/99', state: 'OPEN' },
  ]

  const groups = buildGroups(issues)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].date, '2026-05-07')
  assert.deepEqual(groups[0].issueNumbers, [62, 63, 64])
  assert.deepEqual(groups[0].models, ['claude', 'gemini', 'codex'])
  assert.equal(groups[1].date, '2026-04-25')
  assert.deepEqual(groups[1].issueNumbers, [29, 31])
})

test('buildGroups separates groups that share a date but differ in prompt title', () => {
  const issues = [
    { number: 1, title: '2026-05-07 Claude Review', url: 'https://x/1', state: 'OPEN' },
    { number: 2, title: '2026-05-07 Claude Summarize Consensus', url: 'https://x/2', state: 'OPEN' },
  ]
  const groups = buildGroups(issues)
  assert.equal(groups.length, 2)
  const titles = groups.map((g) => g.promptTitle).sort()
  assert.deepEqual(titles, ['Review', 'Summarize Consensus'])
})

test('formatGroupHint renders a friendly summary', () => {
  const group = {
    members: [
      { number: 62, model: 'claude' },
      { number: 63, model: 'gemini' },
      { number: 64, model: 'codex' },
    ],
  }
  assert.equal(formatGroupHint(group), 'Claude #62, Gemini #63, Codex #64')
})
