const assert = require('node:assert/strict')
const test = require('node:test')

const { branchNameFromRef, listKnownGitBranches } = require('../../src/dashboard/runtime/git-branches')

test('branchNameFromRef normalizes local and remote refs for run targeting', () => {
  assert.equal(branchNameFromRef('refs/heads/main'), 'main')
  assert.equal(branchNameFromRef('refs/heads/feat/dashboard'), 'feat/dashboard')
  assert.equal(branchNameFromRef('refs/remotes/origin/feat/remote'), 'feat/remote')
  assert.equal(branchNameFromRef('refs/remotes/upstream/release'), 'release')
  assert.equal(branchNameFromRef('refs/remotes/origin/HEAD'), '')
})

test('listKnownGitBranches puts the current branch first and deduplicates remote refs', () => {
  /** @type {string[][]} */
  const calls = []
  const result = listKnownGitBranches('/repo', {
    run: (args) => {
      calls.push(args)
      if (args[0] === 'branch') return { status: 0, stdout: 'feat/dashboard' }
      return {
        status: 0,
        stdout: [
          'refs/heads/main',
          'refs/heads/feat/dashboard',
          'refs/remotes/origin/HEAD',
          'refs/remotes/origin/main',
          'refs/remotes/origin/feat/remote',
        ].join('\n'),
      }
    },
  })

  assert.deepEqual(result, {
    currentBranch: 'feat/dashboard',
    branches: ['feat/dashboard', 'main', 'feat/remote'],
  })
  assert.equal(calls.length, 2)
})
