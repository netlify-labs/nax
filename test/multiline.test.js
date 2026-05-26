const test = require('node:test')
const assert = require('node:assert/strict')

const { collapseTrailingNewlines, moveCursor, rowsBelowCursor } = require('../lib/multiline')

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

test('rowsBelowCursor is 0 at end of the last line', () => {
  assert.equal(
    rowsBelowCursor({ lines: ['abc', 'def'], lineIdx: 1, colIdx: 3 }, 80),
    0,
  )
})

test('rowsBelowCursor counts logical lines below when nothing wraps', () => {
  assert.equal(
    rowsBelowCursor({ lines: ['abc', 'def', 'ghi'], lineIdx: 0, colIdx: 1 }, 80),
    2,
  )
})

test('rowsBelowCursor accounts for wrapped logical lines below', () => {
  // 200-char third line wraps to 3 rows at 80 cols.
  assert.equal(
    rowsBelowCursor({ lines: ['abc', 'def', 'x'.repeat(200)], lineIdx: 0, colIdx: 0 }, 80),
    1 + 3,
  )
})

test('rowsBelowCursor accounts for wrap within the current line', () => {
  // Current line wraps to 3 rows; cursor on the first wrap row, no further lines.
  assert.equal(
    rowsBelowCursor({ lines: ['x'.repeat(200)], lineIdx: 0, colIdx: 0 }, 80),
    2,
  )
})

test('rowsBelowCursor falls back to logical-line count when columns is unknown', () => {
  assert.equal(
    rowsBelowCursor({ lines: ['x'.repeat(200), 'abc'], lineIdx: 0, colIdx: 0 }, 0),
    1,
  )
})

test('collapseTrailingNewlines leaves text without trailing newlines alone', () => {
  assert.equal(collapseTrailingNewlines('hello'), 'hello')
  assert.equal(collapseTrailingNewlines('hello\nworld'), 'hello\nworld')
  assert.equal(collapseTrailingNewlines(''), '')
})

test('collapseTrailingNewlines preserves a single trailing newline', () => {
  assert.equal(collapseTrailingNewlines('hello\n'), 'hello\n')
})

test('collapseTrailingNewlines collapses 2+ trailing newlines to 1', () => {
  assert.equal(collapseTrailingNewlines('hello\n\n'), 'hello\n')
  assert.equal(collapseTrailingNewlines('a\n\nnice\n\n\n'), 'a\n\nnice\n')
})

test('collapseTrailingNewlines preserves embedded blank lines', () => {
  // Interior blank lines must survive — only trailing runs are collapsed.
  assert.equal(collapseTrailingNewlines('a\n\nb\n\nc'), 'a\n\nb\n\nc')
})
