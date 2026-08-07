// Partial-failure step state machine (nax-2rx6.4.5): a step with some survivors is
// completed_with_failures and the workflow proceeds; all-failed is failed and halts.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { localStepStatus, localStepProceeds } = require('../../src/workflows/engine/local-executor')

const step = (statuses) => ({ runs: statuses.map((status) => ({ status })) })

test('all instances completed -> completed', () => {
  assert.equal(localStepStatus(step(['completed', 'completed', 'completed'])), 'completed')
})

test('some completed, some failed -> completed_with_failures', () => {
  assert.equal(localStepStatus(step(['completed', 'failed', 'completed'])), 'completed_with_failures')
  assert.equal(localStepStatus(step(['completed', 'timeout'])), 'completed_with_failures')
})

test('all instances failed -> failed', () => {
  assert.equal(localStepStatus(step(['failed', 'failed'])), 'failed')
  assert.equal(localStepStatus(step(['failed', 'timeout'])), 'failed')
})

test('dry-run counts as success', () => {
  assert.equal(localStepStatus(step(['dry-run', 'dry-run'])), 'completed')
  assert.equal(localStepStatus(step(['dry-run', 'failed'])), 'completed_with_failures')
})

test('empty runs -> completed', () => {
  assert.equal(localStepStatus({ runs: [] }), 'completed')
})

test('workflow proceeds past completed and completed_with_failures, halts on failed', () => {
  assert.equal(localStepProceeds('completed'), true)
  assert.equal(localStepProceeds('completed_with_failures'), true)
  assert.equal(localStepProceeds('dry-run'), true)
  assert.equal(localStepProceeds('failed'), false)
})
