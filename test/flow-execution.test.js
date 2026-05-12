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

test('sourceRunsForStep dedupes local runner ids across prior steps', () => {
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
