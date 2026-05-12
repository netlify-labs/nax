const test = require('node:test')
const assert = require('node:assert/strict')

const {
  formatMergeStateLedger,
  formatRepositorySnapshot,
  formatReviewContract,
  formatWorkingTreeSummary,
} = require('../lib/review-context')

test('formatWorkingTreeSummary reports clean state', () => {
  assert.equal(formatWorkingTreeSummary([]), 'clean')
})

test('formatWorkingTreeSummary truncates long dirty status lists', () => {
  const summary = formatWorkingTreeSummary([
    'M action.yml',
    'M README.md',
    'M src/a.js',
    'M src/b.js',
    'M src/c.js',
    'M src/d.js',
    'M src/e.js',
    'M src/f.js',
    'M src/g.js',
  ])

  assert.match(summary, /^dirty/)
  assert.match(summary, /`M action\.yml`/)
  assert.match(summary, /\.\.\. plus 1 more/)
})

test('formatReviewContract includes read-only constraints and pinned sha', () => {
  const contract = formatReviewContract({ pinnedSha: 'abc123' })
  assert.match(contract, /Mode: `review-only`/)
  assert.match(contract, /Pinned commit SHA: `abc123`/)
  assert.match(contract, /Do not edit files/)
})

test('formatRepositorySnapshot renders core repo facts', () => {
  const snapshot = formatRepositorySnapshot({
    repoRoot: '/tmp/repo',
    branch: 'main',
    pinnedSha: 'deadbeef',
    generatedAt: '2026-04-25T18:00:00.000Z',
  })

  assert.match(snapshot, /Branch at prompt generation time: `main`/)
  assert.match(snapshot, /Pinned commit SHA: `deadbeef`/)
  assert.match(snapshot, /Prompt generated at: `2026-04-25T18:00:00\.000Z`/)
  assert.doesNotMatch(snapshot, /Repository root:/)
  assert.doesNotMatch(snapshot, /Local working tree/)
})

test('formatMergeStateLedger renders a markdown table for open prs', () => {
  const ledger = formatMergeStateLedger({
    repoRoot: '/tmp/repo',
    pinnedSha: 'deadbeef',
    pullRequests: [
      {
        number: 32,
        url: 'https://github.com/example/repo/pull/32',
        baseRefName: 'main',
        headRefName: 'feature-branch',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
      },
    ],
    error: '',
  })

  assert.match(ledger, /## Merge-State Ledger/)
  assert.match(ledger, /\| PR \| Base \| Head \| Merge State \| Draft \| Head In Pinned SHA\? \|/)
  assert.match(ledger, /\[#32\]\(https:\/\/github\.com\/example\/repo\/pull\/32\)/)
})

test('formatMergeStateLedger falls back gracefully when gh data is unavailable', () => {
  const ledger = formatMergeStateLedger({
    repoRoot: '/tmp/repo',
    pinnedSha: 'deadbeef',
    pullRequests: null,
    error: 'gh auth missing',
  })

  assert.match(ledger, /Open PR ledger unavailable: gh auth missing/)
})
