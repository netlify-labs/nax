const test = require('node:test')
const assert = require('node:assert/strict')

const { moveCursor } = require('../lib/multiline')

test('moveCursor left within a line decrements colIdx', () => {
  assert.deepEqual(
    moveCursor({ lines: ['hello'], lineIdx: 0, colIdx: 3 }, 'left'),
    { lineIdx: 0, colIdx: 2 },
  )
})

test('moveCursor left at col 0 wraps to end of previous line', () => {
  assert.deepEqual(
    moveCursor({ lines: ['abc', 'def'], lineIdx: 1, colIdx: 0 }, 'left'),
    { lineIdx: 0, colIdx: 3 },
  )
})

test('moveCursor left at start of buffer is a no-op', () => {
  assert.deepEqual(
    moveCursor({ lines: ['abc'], lineIdx: 0, colIdx: 0 }, 'left'),
    { lineIdx: 0, colIdx: 0 },
  )
})

test('moveCursor right within a line increments colIdx', () => {
  assert.deepEqual(
    moveCursor({ lines: ['hello'], lineIdx: 0, colIdx: 2 }, 'right'),
    { lineIdx: 0, colIdx: 3 },
  )
})

test('moveCursor right at end of line jumps to start of next line', () => {
  assert.deepEqual(
    moveCursor({ lines: ['abc', 'def'], lineIdx: 0, colIdx: 3 }, 'right'),
    { lineIdx: 1, colIdx: 0 },
  )
})

test('moveCursor right at end of buffer is a no-op', () => {
  assert.deepEqual(
    moveCursor({ lines: ['abc'], lineIdx: 0, colIdx: 3 }, 'right'),
    { lineIdx: 0, colIdx: 3 },
  )
})

test('moveCursor up keeps colIdx when previous line is long enough', () => {
  assert.deepEqual(
    moveCursor({ lines: ['hello world', 'short'], lineIdx: 1, colIdx: 4 }, 'up'),
    { lineIdx: 0, colIdx: 4 },
  )
})

test('moveCursor up clamps colIdx to previous line length', () => {
  assert.deepEqual(
    moveCursor({ lines: ['hi', 'much longer line'], lineIdx: 1, colIdx: 10 }, 'up'),
    { lineIdx: 0, colIdx: 2 },
  )
})

test('moveCursor up on first line is a no-op', () => {
  assert.deepEqual(
    moveCursor({ lines: ['abc'], lineIdx: 0, colIdx: 2 }, 'up'),
    { lineIdx: 0, colIdx: 2 },
  )
})

test('moveCursor down clamps colIdx to next line length', () => {
  assert.deepEqual(
    moveCursor({ lines: ['much longer line', 'hi'], lineIdx: 0, colIdx: 10 }, 'down'),
    { lineIdx: 1, colIdx: 2 },
  )
})

test('moveCursor down on last line is a no-op', () => {
  assert.deepEqual(
    moveCursor({ lines: ['abc', 'def'], lineIdx: 1, colIdx: 1 }, 'down'),
    { lineIdx: 1, colIdx: 1 },
  )
})

test('moveCursor home sets colIdx to 0', () => {
  assert.deepEqual(
    moveCursor({ lines: ['hello'], lineIdx: 0, colIdx: 4 }, 'home'),
    { lineIdx: 0, colIdx: 0 },
  )
})

test('moveCursor end sets colIdx to line length', () => {
  assert.deepEqual(
    moveCursor({ lines: ['hello world'], lineIdx: 0, colIdx: 2 }, 'end'),
    { lineIdx: 0, colIdx: 11 },
  )
})
