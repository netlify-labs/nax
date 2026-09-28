// Tests for salvaging a finished or cancelled Agent Runner session diff onto a new branch.
// Covers the refusal rules, branch creation at the session base SHA, and commit polling.
const test = require('node:test')
const assert = require('node:assert/strict')

const { salvageAgentRun } = require('../../src/integrations/netlify/salvage')

const BASE_SHA = '9049b18000000000000000000000000000000000'

/**
 * @param {{ runner?: Record<string, unknown>, sessions?: Array<Record<string, unknown>>, commitResults?: Array<Record<string, unknown>> }} [input]
 */
function sdkHarness({ runner = {}, sessions, commitResults } = {}) {
  const calls = []
  const polls = [...(commitResults || [{ mergeCommitIsBeingCreated: false, mergeCommitSha: 'abc123' }])]
  let committed = false
  const baseRunner = { runnerId: 'runner-1', state: 'cancelled', branch: 'master', ...runner }
  const sdk = {
    transport: {
      getRunner: async (runnerId) => {
        calls.push(['getRunner', runnerId])
        if (!committed) return baseRunner
        return { ...baseRunner, ...(polls.length > 1 ? polls.shift() : polls[0]) }
      },
      listSessions: async (runnerId) => {
        calls.push(['listSessions', runnerId])
        return sessions || [{ sessionId: 'session-1', runnerId, state: 'cancelled', hasResultDiff: true, baseSha: BASE_SHA }]
      },
      member: async (runnerId, action, input) => {
        calls.push(['member', runnerId, action, input])
        committed = true
        return { ...baseRunner, mergeCommitIsBeingCreated: true }
      },
    },
  }
  return { sdk: /** @type {import('nax-agent-runner-sdk').AgentRunnerSdk} */ (/** @type {unknown} */ (sdk)), calls }
}

/**
 * @param {{ remoteBranches?: string[], defaultBranch?: string, hasCommit?: boolean }} [input]
 */
function gitHarness({ remoteBranches = [], defaultBranch = 'master', hasCommit = true } = {}) {
  const calls = []
  /** @param {string} command @param {string[]} args */
  const run = (command, args) => {
    calls.push([command, ...args])
    const joined = args.join(' ')
    if (joined === 'ls-remote --symref origin HEAD') {
      return { status: 0, stdout: `ref: refs/heads/${defaultBranch}\tHEAD\n${BASE_SHA}\tHEAD`, stderr: '', detail: '' }
    }
    if (joined.startsWith('ls-remote --heads origin ')) {
      const branch = args[args.length - 1]
      return { status: 0, stdout: remoteBranches.includes(branch) ? `${BASE_SHA}\trefs/heads/${branch}` : '', stderr: '', detail: '' }
    }
    if (joined.startsWith('cat-file -e ')) return { status: hasCommit ? 0 : 1, stdout: '', stderr: '', detail: '' }
    return { status: 0, stdout: '', stderr: '', detail: '' }
  }
  return { run, calls }
}

test('salvage creates the missing branch at the session base SHA and commits the diff onto it', async () => {
  const { sdk, calls } = sdkHarness()
  const git = gitHarness()
  const result = await salvageAgentRun({ runnerId: 'runner-1', branch: 'nax/fix', sdk, run: git.run, pollIntervalMs: 1 })

  assert.ok(git.calls.some((call) => call.join(' ') === `git push origin ${BASE_SHA}:refs/heads/nax/fix`))
  assert.deepEqual(calls.find(([operation]) => operation === 'member'), ['member', 'runner-1', 'commit', { targetBranch: 'nax/fix' }])
  assert.deepEqual(result, { runnerId: 'runner-1', sessionId: 'session-1', branch: 'nax/fix', baseSha: BASE_SHA, createdBranch: true, commitSha: 'abc123' })
})

test('salvage fetches the base SHA when it is not in the local clone', async () => {
  const { sdk } = sdkHarness()
  const git = gitHarness({ hasCommit: false })
  await salvageAgentRun({ runnerId: 'runner-1', branch: 'nax/fix', sdk, run: git.run, pollIntervalMs: 1 })

  const fetchIndex = git.calls.findIndex((call) => call.join(' ') === `git fetch origin ${BASE_SHA}`)
  const pushIndex = git.calls.findIndex((call) => call[1] === 'push')
  assert.ok(fetchIndex >= 0 && fetchIndex < pushIndex)
})

test('salvage commits onto an existing branch without pushing', async () => {
  const { sdk } = sdkHarness()
  const git = gitHarness({ remoteBranches: ['nax/fix'] })
  const result = await salvageAgentRun({ runnerId: 'runner-1', branch: 'nax/fix', sdk, run: git.run, pollIntervalMs: 1 })

  assert.equal(git.calls.some((call) => call[1] === 'push'), false)
  assert.equal(result.createdBranch, false)
})

test('salvage names the branch after the runner when none is given', async () => {
  const { sdk } = sdkHarness()
  const git = gitHarness()
  const result = await salvageAgentRun({ runnerId: 'runner-1', sdk, run: git.run, pollIntervalMs: 1 })
  assert.equal(result.branch, 'nax/salvage-runner-1')
})

test('salvage refuses a runner that is still running', async () => {
  const { sdk, calls } = sdkHarness({ runner: { state: 'running' } })
  await assert.rejects(
    salvageAgentRun({ runnerId: 'runner-1', branch: 'nax/fix', sdk, run: gitHarness().run }),
    /still running/,
  )
  assert.equal(calls.some(([operation]) => operation === 'member'), false)
})

test('salvage refuses a session without a diff', async () => {
  const { sdk } = sdkHarness({ sessions: [{ sessionId: 'session-1', state: 'cancelled', hasResultDiff: false, hasCumulativeDiff: false, baseSha: BASE_SHA }] })
  await assert.rejects(
    salvageAgentRun({ runnerId: 'runner-1', branch: 'nax/fix', sdk, run: gitHarness().run }),
    /has no diff/,
  )
})

test('salvage refuses the default branch unless allowed', async () => {
  const { sdk, calls } = sdkHarness()
  const git = gitHarness({ remoteBranches: ['master'] })
  await assert.rejects(
    salvageAgentRun({ runnerId: 'runner-1', branch: 'master', sdk, run: git.run }),
    /default branch "master".*--allow-default-branch/,
  )
  assert.equal(calls.some(([operation]) => operation === 'member'), false)

  const allowed = await salvageAgentRun({ runnerId: 'runner-1', branch: 'master', allowDefaultBranch: true, sdk, run: git.run, pollIntervalMs: 1 })
  assert.equal(allowed.branch, 'master')
})

test('salvage needs the base SHA to create a missing branch', async () => {
  const { sdk } = sdkHarness({ sessions: [{ sessionId: 'session-1', state: 'cancelled', hasResultDiff: true }] })
  await assert.rejects(
    salvageAgentRun({ runnerId: 'runner-1', branch: 'nax/fix', sdk, run: gitHarness().run }),
    /no base SHA.*Create nax\/fix first/,
  )
})

test('salvage reports the platform commit error', async () => {
  const { sdk } = sdkHarness({ commitResults: [{ mergeCommitIsBeingCreated: false, mergeCommitError: 'Failed to apply commit' }] })
  await assert.rejects(
    salvageAgentRun({ runnerId: 'runner-1', branch: 'nax/fix', sdk, run: gitHarness().run, pollIntervalMs: 1 }),
    /Failed to apply commit/,
  )
})

test('salvage waits while the commit is being created', async () => {
  const { sdk } = sdkHarness({
    commitResults: [
      { mergeCommitIsBeingCreated: true },
      { mergeCommitIsBeingCreated: false, mergeCommitSha: 'def456' },
    ],
  })
  const result = await salvageAgentRun({ runnerId: 'runner-1', branch: 'nax/fix', sdk, run: gitHarness().run, pollIntervalMs: 1 })
  assert.equal(result.commitSha, 'def456')
})
