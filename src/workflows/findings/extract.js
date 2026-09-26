// Locates and parses `## Structured <Kind>` JSON blocks in agent result text.
// Shared by follow-up prompt shrinking (numbered headings only) and the findings artifact.

/** Numbered review headings used by prompt shrinking, e.g. `## 2. Structured Consensus`. */
const NUMBERED_HEADING_PATTERN = /^##\s+2\.\s+Structured\s+(Findings|Consensus)[^\n]*$/gm
/** Any structured heading, numbered or not, e.g. `## Structured Findings`, `## 2. Structured Consensus`. */
const ANY_HEADING_PATTERN = /^##\s+(?:\d+\.\s+)?Structured\s+([A-Za-z][A-Za-z ]*?)\s*$/gm
const NUMBERED_SECTION_END_PATTERN = /^##\s+3\./m
const ANY_SECTION_END_PATTERN = /^##\s/m
const FENCED_JSON_PATTERN = /```json\s*\n([\s\S]*?)\n```/

/**
 * @typedef {{
 *   heading: string,
 *   kind: string,
 *   raw: string,
 *   json: unknown,
 *   parseError?: string,
 * }} StructuredBlock
 */

/**
 * Returns the first balanced top-level JSON array/object span in text, or ''.
 * @param {string} text
 * @returns {string}
 */
function firstBalancedJsonSpan(text) {
  const start = text.search(/[[{]/)
  if (start === -1) return ''
  const open = text[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return ''
}

/**
 * Finds every structured block in an agent result.
 * `numberedOnly` keeps the prompt-shrinking contract: only `## 2. Structured Findings|Consensus`
 * headings, sections ending at `## 3.`, and fenced JSON payloads.
 * @param {string} resultText
 * @param {{ numberedOnly?: boolean }} [options]
 * @returns {StructuredBlock[]}
 */
function findStructuredBlocks(resultText, { numberedOnly = false } = {}) {
  const text = String(resultText || '')
  const headingPattern = new RegExp(numberedOnly ? NUMBERED_HEADING_PATTERN : ANY_HEADING_PATTERN)
  const sectionEnd = numberedOnly ? NUMBERED_SECTION_END_PATTERN : ANY_SECTION_END_PATTERN
  /** @type {StructuredBlock[]} */
  const blocks = []
  let match
  while ((match = headingPattern.exec(text)) !== null) {
    const after = text.slice(match.index + match[0].length)
    const stop = sectionEnd.exec(after)
    const sectionBody = stop ? after.slice(0, stop.index) : after
    const fenced = FENCED_JSON_PATTERN.exec(sectionBody)
    const raw = fenced ? fenced[1].trim() : (numberedOnly ? '' : firstBalancedJsonSpan(sectionBody))
    if (!raw) {
      // Prompt shrinking only ever considered the first numbered heading.
      if (numberedOnly) break
      continue
    }
    const kind = match[1].trim().toLowerCase()
    try {
      blocks.push({ heading: match[0].trim(), kind, raw, json: JSON.parse(raw) })
    } catch (error) {
      blocks.push({ heading: match[0].trim(), kind, raw, json: null, parseError: error instanceof Error ? error.message : String(error) })
    }
    if (numberedOnly) break
  }
  return blocks
}

module.exports = {
  findStructuredBlocks,
}
