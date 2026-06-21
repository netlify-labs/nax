const { spawnSync } = require('child_process')
const {
  bodyHasPromptMarker,
  bodyHasRunnerHistoryMarker,
  bodyHasRunnerResultMarker,
  bodyHasRunnerStatusMarker,
  parsePromptMarker,
} = require('./comment-markers')

const PROMPT_HEADER_PATTERN = /^@\S+\s+(claude|gemini|codex)\b/i
const STRUCTURED_HEADING_PATTERN = /^##\s+2\.\s+Structured\s+(Findings|Consensus)[^\n]*$/m
const NEXT_SECTION_PATTERN = /^##\s+3\./m
const FENCED_JSON_PATTERN = /```json\s*\n([\s\S]*?)\n```/
const RESULT_HEADING_PATTERN = /^###\s+Result:[^\n]*\n+/m
const CHAINING_NOISE_SECTION_NAMES = new Set([
  'repository state',
  'architecture report',
  'reality check',
  'scoring notes',
  'score calibration',
  'idea selection rationale',
])

/**
 * Round result summary assembled from one GitHub issue.
 * @typedef {{
 *   issueNumber?: string | number,
 *   issueTitle?: string,
 *   issueUrl?: string,
 *   model?: string | null,
 *   replies?: import('./types').GitHubComment[],
 *   reply?: import('./types').GitHubComment,
 *   comments?: import('./types').GitHubComment[],
 * }} RoundResult
 *
 * Fetch progress event for round-result loading.
 * @typedef {{
 *   phase?: string,
 *   issueNumber?: string | number,
 *   index?: number,
 *   total?: number,
 *   replyCount?: number,
 *   message?: string,
 * }} RoundResultProgress
 *
 * Loader for one GitHub issue with comments.
 * @callback RoundIssueLoader
 * @param {{ repo?: string, issueNumber?: string | number }} input
 * @returns {import('./types').GitHubIssue}
 *
 * Fetch prior round result options.
 * @typedef {{
 *   repo?: string,
 *   issueNumbers: Array<string | number>,
 *   embedAll?: boolean,
 *   requireResultMarker?: boolean,
 *   loader?: RoundIssueLoader,
 *   onProgress?: ((event: RoundResultProgress) => void) | null,
 * }} FetchRoundResultsInput
 */

/** @param {{ repo?: string, issueNumber?: string | number }} param0 */
function loadIssueWithComments({ repo, issueNumber }) {
  const result = spawnSync(
    'gh',
    [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repo,
      '--json',
      'number,title,url,body,author,comments',
    ],
    { encoding: 'utf8' },
  )

  if (result.status !== 0) {
    const detail = (result.stderr || '').trim() || (result.stdout || '').trim()
    throw new Error(`Could not load issue #${issueNumber} from ${repo}: ${detail}`)
  }

  return JSON.parse(result.stdout)
}

/** @param {unknown} comments @param {{ all?: boolean, requireResultMarker?: boolean }} param1 */
function pickAgentReplyComments(comments, { all = false, requireResultMarker = false } = {}) {
  if (!Array.isArray(comments)) return []

  const resultMarkerMatches = comments.filter((comment) => {
    const body = String(comment?.body || '').trim()
    if (!body) return false
    if (bodyHasPromptMarker(body)) return false
    return bodyHasRunnerResultMarker(body)
  })

  if (requireResultMarker) {
    if (resultMarkerMatches.length === 0) return []
    return all ? resultMarkerMatches : [resultMarkerMatches[resultMarkerMatches.length - 1]]
  }

  let replies
  if (resultMarkerMatches.length > 0) {
    replies = resultMarkerMatches
  } else {
    replies = comments.filter((comment) => {
      const body = String(comment?.body || '').trim()
      if (!body) return false
      if (bodyHasPromptMarker(body)) return false
      if (bodyHasRunnerHistoryMarker(body)) return false
      if (bodyHasRunnerStatusMarker(body)) return false
      if (PROMPT_HEADER_PATTERN.test(body)) return false
      return true
    })
  }

  if (replies.length === 0) return []
  if (all) return replies
  return [replies[replies.length - 1]]
}

function pickAgentReplyComment(comments) {
  const [reply] = pickAgentReplyComments(comments)
  return reply || null
}

function inferModelFromTitle(title) {
  const match = String(title || '').match(/\b(claude|gemini|codex)\b/i)
  if (!match) return null
  return match[1].toLowerCase()
}

function modelLabel(model) {
  if (!model) return 'Unknown'
  return model.charAt(0).toUpperCase() + model.slice(1)
}

/** @param {FetchRoundResultsInput} param0 */
function fetchRoundResults({
  repo,
  issueNumbers,
  embedAll = false,
  requireResultMarker = false,
  loader = loadIssueWithComments,
  onProgress = null,
}) {
  const total = issueNumbers.length
  return issueNumbers.map((issueNumber, index) => {
    if (onProgress) {
      onProgress({
        phase: 'fetching',
        issueNumber,
        index,
        total,
        message: `Fetching issue #${issueNumber} (${index + 1}/${total})`,
      })
    }
    const issue = loader({ repo, issueNumber })
    const replies = pickAgentReplyComments(issue.comments || [], { all: embedAll, requireResultMarker })

    if (onProgress) {
      const replyCount = replies.length
      const replyLabel = replyCount === 1 ? 'reply' : 'replies'
      onProgress({
        phase: 'fetched',
        issueNumber: issue.number,
        index,
        total,
        replyCount,
        message: `Fetched #${issue.number} ${issue.title} (${replyCount} ${replyLabel})`,
      })
    }

    return {
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      model: inferModelFromTitle(issue.title),
      replies,
      comments: issue.comments || [],
    }
  })
}

function rawIssuesFromResults(results) {
  if (!Array.isArray(results)) return []
  return results.map((result) => ({
    number: result.issueNumber,
    title: result.issueTitle,
    url: result.issueUrl,
    comments: Array.isArray(result.comments) ? result.comments : [],
  }))
}

function extractStructuredSection(body) {
  const text = String(body || '')
  const headingMatch = STRUCTURED_HEADING_PATTERN.exec(text)
  if (!headingMatch) return null

  const after = text.slice(headingMatch.index + headingMatch[0].length)
  const stop = NEXT_SECTION_PATTERN.exec(after)
  const sectionBody = stop ? after.slice(0, stop.index) : after

  const jsonMatch = FENCED_JSON_PATTERN.exec(sectionBody)
  if (!jsonMatch) return null

  return {
    heading: headingMatch[0].trim(),
    json: jsonMatch[1].trim(),
  }
}

function normalizeHeadingName(value) {
  return String(value || '')
    .replace(/^[0-9]+[.)]\s*/, '')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
}

function stripTopLevelSections(body, sectionNames = CHAINING_NOISE_SECTION_NAMES) {
  const text = String(body || '')
  const headingPattern = /^##\s+([^\n]+)\n?/gm
  const matches = [...text.matchAll(headingPattern)]
  if (matches.length === 0) return text

  let output = ''
  let cursor = 0
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const start = match.index || 0
    const end = index + 1 < matches.length ? matches[index + 1].index || text.length : text.length
    const headingName = normalizeHeadingName(match[1])
    if (!sectionNames.has(headingName)) {
      output += text.slice(cursor, end)
    } else {
      output += text.slice(cursor, start)
    }
    cursor = end
  }
  output += text.slice(cursor)
  return output
}

function stripRunnerResultWrapper(body) {
  const text = String(body || '').trim()
  const resultMatch = RESULT_HEADING_PATTERN.exec(text)
  if (resultMatch) return text.slice(resultMatch.index + resultMatch[0].length).trim()
  return text
}

function sanitizeAgentReplyBody(body) {
  const original = String(body || '').trim()
  if (!original) return ''

  const withoutWrapper = stripRunnerResultWrapper(original)
  const withoutNoise = stripTopLevelSections(withoutWrapper).trim()
  return withoutNoise || withoutWrapper || original
}

/** @param {unknown} body @param {{ structuredOnly?: boolean, sanitize?: boolean }} param1 */
function renderReplyBody(body, { structuredOnly, sanitize = true } = {}) {
  const trimmed = sanitize ? sanitizeAgentReplyBody(body) : String(body || '').trim()
  if (!structuredOnly) return trimmed

  const section = extractStructuredSection(trimmed)
  if (!section) {
    return '_Structured findings block not found in this reply; see the comment URL for the full prose._'
  }
  return [
    section.heading,
    '',
    '```json',
    section.json,
    '```',
    '',
    '_Prose sections omitted to fit the GitHub issue body limit; follow the comment URL for the full report._',
  ].join('\n')
}

/**
 * Prior round result formatting options.
 * @typedef {{
 *   heading?: string,
 *   results?: RoundResult[],
 *   structuredOnly?: boolean,
 *   sanitizeReplies?: boolean,
 * }} FormatRoundResultsInput
 */

/** @param {FormatRoundResultsInput} param0 */
function formatRoundResults({ heading = 'Prior Round Outputs', results, structuredOnly = false, sanitizeReplies = true }) {
  if (!Array.isArray(results) || results.length === 0) return ''

  const lines = [`## ${heading}`, '']
  if (structuredOnly) {
    lines.push(
      '> Note: each embedded reply was reduced to its structured-findings JSON block to fit the GitHub issue body limit. Follow the comment URLs for full prose.',
    )
    lines.push('')
  }

  for (const result of results) {
    const label = modelLabel(result.model)
    const replies = Array.isArray(result.replies)
      ? result.replies
      : result.reply
        ? [result.reply]
        : []

    lines.push('<details>')
    lines.push(
      `<summary>${label} — issue #${result.issueNumber}: ${result.issueTitle} (${replies.length || 'no'} ${replies.length === 1 ? 'reply' : 'replies'})</summary>`,
    )
    lines.push('')
    lines.push(`Source issue: ${result.issueUrl}`)
    lines.push('')

    if (replies.length === 0) {
      lines.push('_No agent reply was found on this issue thread when this prompt was generated._')
    } else {
      replies.forEach((reply, index) => {
        if (replies.length > 1) {
          lines.push(`### Reply ${index + 1} of ${replies.length}`)
          lines.push('')
        }
        lines.push(`Comment: ${reply.url}`)
        if (reply.author?.login) lines.push(`Author: \`${reply.author.login}\``)
        if (reply.createdAt) lines.push(`Posted: \`${reply.createdAt}\``)
        lines.push('')
        lines.push(renderReplyBody(reply.body, { structuredOnly, sanitize: sanitizeReplies }))
        lines.push('')
      })
    }

    lines.push('</details>')
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

function findCrossReviewPromptIndex(comments) {
  if (!Array.isArray(comments)) return -1
  return comments.findIndex((comment) => {
    const marker = parsePromptMarker(comment?.body || '')
    return marker?.promptName === 'cross-review'
  })
}

function findRunnerResultAfter(comments, startIndex) {
  if (!Array.isArray(comments) || startIndex < 0) return null
  for (let i = startIndex + 1; i < comments.length; i += 1) {
    const body = String(comments[i]?.body || '').trim()
    if (!body) continue
    if (bodyHasPromptMarker(body)) continue
    if (bodyHasRunnerResultMarker(body)) return comments[i]
  }
  return null
}

function assertCrossReviewComplete(rawIssues) {
  if (!Array.isArray(rawIssues) || rawIssues.length === 0) return

  const incomplete = []
  for (const issue of rawIssues) {
    const comments = Array.isArray(issue?.comments) ? issue.comments : []
    const promptIndex = findCrossReviewPromptIndex(comments)

    if (promptIndex === -1) {
      incomplete.push({
        issueNumber: issue?.number,
        issueTitle: issue?.title || '',
        reason: 'no cross-review prompt found on this thread',
      })
      continue
    }

    const result = findRunnerResultAfter(comments, promptIndex)
    if (!result) {
      incomplete.push({
        issueNumber: issue?.number,
        issueTitle: issue?.title || '',
        reason: 'cross-review prompt was posted but no agent-runner result followed it',
      })
    }
  }

  if (incomplete.length === 0) return

  const lines = incomplete.map(
    ({ issueNumber, issueTitle, reason }) => `  #${issueNumber} ${issueTitle} — ${reason}`,
  )
  const numbers = incomplete.map(({ issueNumber }) => issueNumber).join(',')
  throw new Error(
    [
      'Cannot summarize: round 2 (cross-review) is not complete on these issues:',
      ...lines,
      '',
      `Run: nax comment cross-review --issues ${numbers}`,
      'Or pass --skip-round-check to override.',
    ].join('\n'),
  )
}

module.exports = {
  assertCrossReviewComplete,
  extractStructuredSection,
  fetchRoundResults,
  findCrossReviewPromptIndex,
  findRunnerResultAfter,
  formatRoundResults,
  inferModelFromTitle,
  loadIssueWithComments,
  modelLabel,
  pickAgentReplyComment,
  pickAgentReplyComments,
  rawIssuesFromResults,
  sanitizeAgentReplyBody,
  stripRunnerResultWrapper,
  stripTopLevelSections,
}
