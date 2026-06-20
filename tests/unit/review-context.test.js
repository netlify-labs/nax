const test = require('node:test')
const assert = require('node:assert/strict')

const {
  formatMergeStateLedger,
  formatRepositorySnapshot,
  formatReviewContract,
  formatUnverifiedTargetContract,
  formatWorkingTreeSummary,
  resolveRemoteBranchSha,
} = require('../../src/review-context')

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
  assert.match(contract, /fast-forward descendant/)
  assert.match(contract, /more than 5 commits/)
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

test('formatRepositorySnapshot can include the pinned remote source', () => {
  const snapshot = formatRepositorySnapshot({
    repoRoot: '/tmp/repo',
    branch: 'master',
    pinnedSha: 'deadbeef',
    pinnedSource: 'origin/master',
    generatedAt: '2026-04-25T18:00:00.000Z',
  })

  assert.match(snapshot, /Pinned source: `origin\/master`/)
})

test('formatRepositorySnapshot renders target verification metadata', () => {
  const snapshot = formatRepositorySnapshot({
    repoRoot: '/tmp/repo',
    branch: 'main',
    pinnedSha: '',
    pinnedSource: 'github-actions:main',
    generatedAt: '2026-04-25T18:00:00.000Z',
    target: {
      sourceType: 'github-actions-implicit',
      verified: false,
      caveats: ['gha-implicit'],
    },
  })

  assert.match(snapshot, /Pinned commit SHA: unverified/)
  assert.match(snapshot, /Target source type: `github-actions-implicit`/)
  assert.match(snapshot, /Target verified: no/)
  assert.match(snapshot, /Target caveats: `gha-implicit`/)
})

test('formatUnverifiedTargetContract warns for GitHub implicit targets', () => {
  const contract = formatUnverifiedTargetContract({
    target: {
      branch: 'main',
      ref: 'github-actions:main',
      sourceType: 'github-actions-implicit',
      caveats: ['gha-implicit'],
    },
  })

  assert.match(contract, /Target verification: unverified/)
  assert.match(contract, /GitHub Actions checkout is implicit/)
})

test('resolveRemoteBranchSha uses upstream branch for the current branch', () => {
  const calls = []
  const result = resolveRemoteBranchSha({
    repoRoot: '/tmp/repo',
    run(command, args, options) {
      calls.push({ command, args, options })
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
        return { status: 0, stdout: '/tmp/repo', stderr: '', detail: '/tmp/repo' }
      }
      if (args[0] === 'branch' && args.includes('--show-current')) {
        return { status: 0, stdout: 'feature/test', stderr: '', detail: 'feature/test' }
      }
      if (args[0] === 'rev-parse' && args.includes('@{u}')) {
        return { status: 0, stdout: 'upstream/feature/test', stderr: '', detail: 'upstream/feature/test' }
      }
      if (args[0] === 'ls-remote') {
        return {
          status: 0,
          stdout: '0123456789abcdef0123456789abcdef01234567\trefs/heads/feature/test',
          stderr: '',
          detail: '',
        }
      }
      throw new Error(`unexpected command ${command} ${args.join(' ')}`)
    },
  })

  assert.deepEqual(result, {
    sha: '0123456789abcdef0123456789abcdef01234567',
    remote: 'upstream',
    branch: 'feature/test',
    ref: 'upstream/feature/test',
  })
  assert.deepEqual(calls.at(-1).args, ['ls-remote', '--heads', 'upstream', 'feature/test'])
})

test('resolveRemoteBranchSha uses origin for an explicit branch', () => {
  const calls = []
  const result = resolveRemoteBranchSha({
    repoRoot: '/tmp/repo',
    branch: 'feature/test',
    run(command, args) {
      calls.push({ command, args })
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
        return { status: 0, stdout: '/tmp/repo', stderr: '', detail: '/tmp/repo' }
      }
      if (args[0] === 'ls-remote') {
        return {
          status: 0,
          stdout: 'abcdef0123456789abcdef0123456789abcdef01\trefs/heads/feature/test',
          stderr: '',
          detail: '',
        }
      }
      throw new Error(`unexpected command ${command} ${args.join(' ')}`)
    },
  })

  assert.equal(result.sha, 'abcdef0123456789abcdef0123456789abcdef01')
  assert.equal(result.ref, 'origin/feature/test')
  assert.deepEqual(calls.at(-1).args, ['ls-remote', '--heads', 'origin', 'feature/test'])
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
