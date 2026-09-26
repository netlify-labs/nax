// Verifies right-side line numbers are derived exactly from unified diff hunks.
// Pure parser tests over representative GitHub file patches.
const test = require('node:test')
const assert = require('node:assert/strict')

const { rightSideLines } = require('../../src/workflows/handoff-targets/diff-lines')

test('added and context lines are commentable; removed lines are not', () => {
  const patch = [
    '@@ -10,4 +10,5 @@ function example() {',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    ' return a',
  ].join('\n')
  assert.deepEqual([...rightSideLines(patch)], [10, 11, 12, 13])
})

test('multiple hunks and single-line hunk headers are parsed', () => {
  const patch = ['@@ -1 +1 @@', '-old', '+new', '@@ -40,2 +41,3 @@', ' keep', '+added', ' keep'].join('\n')
  assert.deepEqual([...rightSideLines(patch)], [1, 41, 42, 43])
})

test('missing patches (binary or huge files) yield no commentable lines', () => {
  assert.equal(rightSideLines(undefined).size, 0)
  assert.equal(rightSideLines('').size, 0)
})

test('"\\ No newline at end of file" markers do not advance line numbers', () => {
  const patch = ['@@ -1,1 +1,2 @@', ' a', '+b', '\\ No newline at end of file'].join('\n')
  assert.deepEqual([...rightSideLines(patch)], [1, 2])
})
