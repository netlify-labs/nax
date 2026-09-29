// Tests for deciding when a finished agent run opens a pull request and how its code changes are reported.
// Covers the no-change, opened, opt-out, failed, and unsupported landing outcomes.
const test = require('node:test')
const assert = require('node:assert/strict')

const { describeRunChanges, shouldLandRun } = require('../../src/cli/display/run-landing')

/** @param {Record<string, unknown>} [overrides] */
function run(overrides = {}) {
  return { agent: 'claude', status: 'completed', runnerId: 'runner-1', fileChanges: { hasChanges: true }, links: { agentRunUrl: 'https://app.netlify.com/runs/runner-1' }, raw: {}, ...overrides }
}

test('shouldLandRun opens a PR only for completed runs with changes unless --no-pr', () => {
  assert.equal(shouldLandRun(run(), {}), true)
  assert.equal(shouldLandRun(run(), { pr: false }), false)
  assert.equal(shouldLandRun(run({ fileChanges: { hasChanges: false } }), {}), false)
  assert.equal(shouldLandRun(run({ status: 'timeout' }), {}), false)
})

test('describeRunChanges reports no changes', () => {
  assert.equal(describeRunChanges(run({ fileChanges: { hasChanges: false } })), 'Code changes: none')
})

test('describeRunChanges reports the opened pull request', () => {
  const message = describeRunChanges(run({ prUrl: 'https://github.com/o/r/pull/7', raw: { landing: { kind: 'prOpen', prUrl: 'https://github.com/o/r/pull/7' } } }))
  assert.equal(message, 'Code changes: yes\nPull request: https://github.com/o/r/pull/7')
})

test('describeRunChanges points --no-pr runs at salvage', () => {
  const message = describeRunChanges(run())
  assert.match(message, /^Code changes: yes \(no pull request opened\)/)
  assert.match(message, /nax salvage --runner runner-1 --pr/)
})

test('describeRunChanges explains a failed or unsupported landing with the run link', () => {
  const failed = describeRunChanges(run({ raw: { landing: { kind: 'failed', step: 'pr', failure: { message: 'GitHub rejected the PR' } } } }))
  assert.match(failed, /Could not open a pull request: GitHub rejected the PR/)
  assert.match(failed, /https:\/\/app\.netlify\.com\/runs\/runner-1/)
  const unsupported = describeRunChanges(run({ raw: { landing: { kind: 'unsupported', reason: 'Landing is not implemented for zip runners.' } } }))
  assert.match(unsupported, /Could not open a pull request: Landing is not implemented for zip runners\./)
})
