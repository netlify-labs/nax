// Verifies cost totals count every attempt exactly once: current runs plus archived superseded attempts.
// Pure aggregation over run-state objects.
const test = require('node:test')
const assert = require('node:assert/strict')

const { usageSummariesForRunState } = require('../../src/workflows/results/agent-run-results')

test('usage totals include superseded attempts once and never double-count the current attempt', () => {
  const runState = {
    steps: [{
      id: 'review',
      runs: [{ agent: 'codex', attemptId: 'a2', status: 'completed', usage: { totalCreditsCost: 5, totalTokens: 500 } }],
      attempts: [
        { attemptId: 'a1', agent: 'codex', status: 'failed', usage: { totalCreditsCost: 3, totalTokens: 300 } },
        { attemptId: 'a2', agent: 'codex', status: 'running', usage: { totalCreditsCost: 1, totalTokens: 100 } },
      ],
    }],
  }
  const summary = usageSummariesForRunState(runState)
  assert.equal(summary.total.totalCreditsCost, 8)
  assert.equal(summary.total.totalTokens, 800)
})
