// Parses GitHub unified diff patches into the right-side line numbers a review can comment on.
// Only added and context lines inside hunks are commentable; others are rejected by the API.

/**
 * @param {string | undefined} patch
 * @returns {Set<number>}
 */
function rightSideLines(patch) {
  /** @type {Set<number>} */
  const lines = new Set()
  let next = 0
  let inHunk = false
  for (const line of String(patch || '').split('\n')) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (header) {
      next = Number(header[1])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('-')) continue
    if (line.startsWith('+') || line.startsWith(' ')) {
      lines.add(next)
      next += 1
    }
  }
  return lines
}

module.exports = {
  rightSideLines,
}
