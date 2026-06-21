const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { buildAutomaticContext } = require('../review-context')
const {
  buildIssueBody,
  buildIssueTitle,
  getLocalDate,
  loadPrompt,
  resolveRepo,
  titleCase,
} = require('../prompts')
const { fetchRoundResults, formatRoundResults } = require('../round-results')
const { runGh } = require('../gh-cli')
const { utf8ByteLength } = require('./prompt-budget')

const ROUND_LABEL_BY_PROMPT = {
  'cross-review': 'Round 1 Outputs',
  'summarize-consensus': 'Round 2 Cross-Review Outputs',
  'cross-score': 'Idea Proposals',
  react: 'Ideas And Cross-Scores',
  'synthesize-ideas': 'Idea Duel Outputs',
}

/**
 * Options used by GitHub issue/comment planning.
 * @typedef {Record<string, unknown> & {
 *   repo?: string,
 *   repoRoot?: string,
 *   sha?: string,
 *   pinnedSha?: string,
 *   pinnedSource?: string,
 *   target?: import('../types').TargetLike | null,
 *   prLimit?: number,
 *   context?: string,
 *   contextFile?: string,
 *   autoContext?: boolean,
 *   fetchResults?: boolean,
 *   fromIssues?: string,
 *   fromIssue?: string,
 *   allReplies?: boolean,
 *   models?: string,
 *   labels?: string,
 *   label?: string,
 *   date?: string,
 *   runner?: string,
 *   title?: string,
 *   issues?: string,
 *   issue?: string,
 * }} GithubPlanOptions
 *
 * Prompt object accepted by issue/comment planners.
 * @typedef {{
 *   name: string,
 *   title: string,
 *   instruction: string,
 *   body: string,
 * }} GithubPlanPrompt
 *
 * GitHub issue creation plan item.
 * @typedef {{
 *   model: string,
 *   promptName: string,
 *   title: string,
 *   body: string,
 *   promptDelivery?: import('../types').JsonMap,
 * }} GithubIssuePlanItem
 *
 * GitHub comment creation plan item.
 * @typedef {GithubIssuePlanItem & {
 *   issueNumber: string,
 *   issueTitle: string,
 *   issueUrl: string,
 *   redirected: boolean,
 *   targetKind: string,
 *   targetRepo: string,
 *   targetNumber: number,
 *   targetTitle: string,
 *   targetUrl: string,
 * }} GithubCommentPlanItem
 *
 * GitHub issue creation plan.
 * @typedef {{
 *   repo: string,
 *   labels: string[],
 *   issues: GithubIssuePlanItem[],
 * }} GithubIssuePlan
 *
 * GitHub comment creation plan.
 * @typedef {{
 *   repo: string,
 *   issues: GithubCommentPlanItem[],
 * }} GithubCommentPlan
 *
 * Resolved comment target for issue or pull-request follow-ups.
 * @typedef {{
 *   sourceIssueNumber: number,
 *   sourceIssueTitle: string,
 *   sourceIssueUrl: string,
 *   targetKind: string,
 *   targetRepo: string,
 *   targetNumber: number,
 *   targetTitle: string,
 *   targetUrl: string,
 *   redirected: boolean,
 * }} GithubCommentTarget
 *
 * Pull request reference discovered from a prior agent comment.
 * @typedef {{
 *   repo: string,
 *   number: number,
 *   url: string,
 * }} GithubLinkedPullRequest
 */

/** @param {string | null | undefined} value @returns {string[]} */
function parseCsv(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** @param {GithubPlanOptions} options @returns {string} */
function readManualContext(options) {
  const parts = []
  if (options.context) parts.push(String(options.context))
  if (options.contextFile) {
    parts.push(fs.readFileSync(path.resolve(String(options.contextFile)), 'utf8').trim())
  }
  return parts.filter(Boolean).join('\n\n')
}

/** @param {GithubPlanOptions} options @returns {string} */
function readAutoContext(options) {
  if (options.autoContext === false) return ''
  return buildAutomaticContext({
    repo: resolveRepo(options.repo),
    repoRoot: options.repoRoot,
    sha: options.sha,
    pinnedSha: options.pinnedSha,
    pinnedSource: options.pinnedSource,
    target: options.target,
    prLimit: options.prLimit,
  })
}

/** @param {...string} parts @returns {string} */
function joinContext(...parts) {
  return parts.filter(Boolean).join('\n\n')
}

/** @param {GithubPlanOptions} options @returns {string} */
function readContext(options) {
  return joinContext(readAutoContext(options), readManualContext(options))
}

/** @param {string} promptName @returns {boolean} */
function shouldEmbedAllReplies(promptName) {
  return ['summarize-consensus', 'react', 'synthesize-ideas'].includes(promptName)
}

/** @param {string} promptName @returns {boolean} */
function shouldFetchResults(promptName) {
  return promptName === 'cross-review' || promptName === 'summarize-consensus'
}

/**
 * Loads prior round results requested by CLI options.
 * @param {GithubPlanOptions} options
 * @param {{ embedAll?: boolean }} [input]
 * @returns {import('../round-results').RoundResult[]}
 */
function fetchRoundResultsForOptions(options, { embedAll } = {}) {
  if (options.fetchResults === false) return []
  const issueNumbers = parseCsv(options.fromIssues || options.fromIssue)
  if (issueNumbers.length === 0) return []

  const repo = resolveRepo(options.repo)
  const shouldEmbedAll = options.allReplies === true || embedAll === true
  const noun = issueNumbers.length === 1 ? 'issue' : 'issues'
  console.error(`Loading ${issueNumbers.length} source ${noun} from ${repo}...`)

  const onProgress = (event) => {
    const prefix = event.phase === 'fetching' ? '  →' : '  ✓'
    console.error(`${prefix} ${event.message}`)
  }

  const results = fetchRoundResults({
    repo,
    issueNumbers,
    embedAll: shouldEmbedAll,
    onProgress,
  })

  const totalReplies = results.reduce((sum, result) => sum + (result.replies?.length || 0), 0)
  const replyLabel = totalReplies === 1 ? 'reply' : 'replies'
  console.error(`Loaded ${results.length} source issues, embedded ${totalReplies} ${replyLabel}`)
  return results
}

/**
 * Creates a GitHub issue.
 * @param {{
 *   repo: string,
 *   title: string,
 *   body: string,
 *   labels?: string[],
 * }} input
 * @returns {string}
 */
function createIssue({ repo, title, body, labels = [] }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-issue-'))
  const bodyFile = path.join(tmpDir, 'body.md')

  try {
    fs.writeFileSync(bodyFile, body)
    const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile]
    for (const label of labels) args.push('--label', label)

    const result = runGh(args, { errorPrefix: `gh issue create failed for "${title}"` })
    return result.stdout.trim()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** @param {{ repo: string, issueNumber: string | number, body: string }} input @returns {string} */
function createComment({ repo, issueNumber, body }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-comment-'))
  const bodyFile = path.join(tmpDir, 'body.md')

  try {
    fs.writeFileSync(bodyFile, body)
    const args = ['issue', 'comment', String(issueNumber), '--repo', repo, '--body-file', bodyFile]
    const result = runGh(args, { errorPrefix: `gh issue comment failed for issue #${issueNumber}` })
    return result.stdout.trim()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** @param {{ repo: string, prNumber: string | number, body: string }} input @returns {string} */
function createPullRequestComment({ repo, prNumber, body }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-pr-comment-'))
  const bodyFile = path.join(tmpDir, 'body.md')

  try {
    fs.writeFileSync(bodyFile, body)
    const args = ['pr', 'comment', String(prNumber), '--repo', repo, '--body-file', bodyFile]
    const result = runGh(args, { errorPrefix: `gh pr comment failed for PR #${prNumber}` })
    return result.stdout.trim()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** @param {{ repo: string, targetKind: string, targetNumber: string | number, body: string }} input @returns {string} */
function createDiscussionComment({ repo, targetKind, targetNumber, body }) {
  if (targetKind === 'pr') {
    return createPullRequestComment({ repo, prNumber: targetNumber, body })
  }
  return createComment({ repo, issueNumber: targetNumber, body })
}

/**
 * Loads GitHub issue metadata via gh.
 * @param {{ repo: string, issueNumber: string | number, includeComments?: boolean }} input
 * @returns {import('../types').JsonMap}
 */
function loadIssueMeta({ repo, issueNumber, includeComments = false }) {
  const fields = ['number', 'title', 'url']
  if (includeComments) fields.push('comments')
  const result = spawnSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--repo', repo, '--json', fields.join(',')],
    { encoding: 'utf8' },
  )

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`Could not load issue #${issueNumber} from ${repo}: ${detail}`)
  }

  return JSON.parse(result.stdout)
}

/** @param {{ repo: string, prNumber: string | number }} input @returns {import('../types').JsonMap} */
function loadPullRequestMeta({ repo, prNumber }) {
  const result = spawnSync(
    'gh',
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'number,title,url'],
    { encoding: 'utf8' },
  )

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`Could not load PR #${prNumber} from ${repo}: ${detail}`)
  }

  return JSON.parse(result.stdout)
}

/** @param {string} title @returns {string} */
function inferModelFromIssueTitle(title) {
  const match = String(title).match(/\b(claude|gemini|codex)\b/i)
  if (!match) {
    throw new Error(`Could not infer model from issue title "${title}"`)
  }
  return match[1].toLowerCase()
}

/** @param {string} url @returns {GithubLinkedPullRequest | null} */
function parseGitHubPullRequestUrl(url) {
  const match = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i)
  if (!match) return null
  return {
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  }
}

/** @param {string} commentBody @param {string} fallbackRepo @returns {GithubLinkedPullRequest | null} */
function extractLinkedPullRequest(commentBody, fallbackRepo) {
  const body = String(commentBody || '')

  const sessionDataMatch = body.match(/<!--\s*netlify-agent-session-data:(\{[\s\S]*?\})\s*-->/)
  if (sessionDataMatch) {
    try {
      const sessionData = /** @type {Record<string, { pr_url?: string }>} */ (JSON.parse(sessionDataMatch[1]))
      for (const value of Object.values(sessionData)) {
        const parsed = value?.pr_url ? parseGitHubPullRequestUrl(value.pr_url) : null
        if (parsed) return parsed
      }
    } catch {
      // Ignore malformed machine comments and fall back to text parsing.
    }
  }

  const prNumberMatch =
    body.match(/A Pull Request was opened for this here #(\d+)/i) ||
    body.match(/Leave follow-up .* on PR #(\d+)/i) ||
    body.match(/Changes in Pull Request #(\d+)/i)

  if (!prNumberMatch) return null

  return {
    repo: fallbackRepo,
    number: Number(prNumberMatch[1]),
    url: `https://github.com/${fallbackRepo}/pull/${prNumberMatch[1]}`,
  }
}

/** @param {{ repo: string, issueNumber: string | number }} input @returns {GithubCommentTarget} */
function resolveCommentTarget({ repo, issueNumber }) {
  const issueMeta = loadIssueMeta({ repo, issueNumber, includeComments: true })
  const comments = Array.isArray(issueMeta.comments) ? issueMeta.comments : []
  const linkedPullRequest = comments
    .map((comment) => extractLinkedPullRequest(String(comment?.body || ''), repo))
    .find(Boolean)

  if (!linkedPullRequest) {
    return {
      sourceIssueNumber: Number(issueMeta.number),
      sourceIssueTitle: String(issueMeta.title || ''),
      sourceIssueUrl: String(issueMeta.url || ''),
      targetKind: 'issue',
      targetRepo: repo,
      targetNumber: Number(issueMeta.number),
      targetTitle: String(issueMeta.title || ''),
      targetUrl: String(issueMeta.url || ''),
      redirected: false,
    }
  }

  const targetRepo = linkedPullRequest.repo || repo
  const prMeta = loadPullRequestMeta({ repo: targetRepo, prNumber: linkedPullRequest.number })
  return {
    sourceIssueNumber: Number(issueMeta.number),
    sourceIssueTitle: String(issueMeta.title || ''),
    sourceIssueUrl: String(issueMeta.url || ''),
    targetKind: 'pr',
    targetRepo,
    targetNumber: Number(prMeta.number),
    targetTitle: String(prMeta.title || ''),
    targetUrl: String(prMeta.url || ''),
    redirected: true,
  }
}

/** @param {GithubIssuePlan} plan @param {{ dryRun?: boolean }} options */
function printPlan(plan, { dryRun }) {
  console.log(`\n${dryRun ? 'Dry run' : 'Create issues'}: ${plan.repo}`)
  for (const issue of plan.issues) {
    console.log(`\n- ${issue.title}`)
    console.log(`  model: ${issue.model}`)
    console.log(`  prompt: ${issue.promptName}`)
    console.log(`  body: ${issue.body.length} chars / ${utf8ByteLength(issue.body).toLocaleString()} bytes`)
  }
}

/** @param {GithubCommentPlan} plan @param {{ dryRun?: boolean }} options */
function printCommentPlan(plan, { dryRun }) {
  console.log(`\n${dryRun ? 'Dry run' : 'Create comments'}: ${plan.repo}`)
  for (const issue of plan.issues) {
    console.log(`\n- #${issue.issueNumber} ${issue.issueTitle}`)
    if (issue.redirected) {
      console.log(`  target: PR #${issue.targetNumber} ${issue.targetTitle}`)
      console.log(`  repo: ${issue.targetRepo}`)
    } else {
      console.log(`  target: issue #${issue.targetNumber}`)
    }
    console.log(`  model: ${issue.model}`)
    console.log(`  prompt: ${issue.promptName}`)
    console.log(`  body: ${issue.body.length} chars / ${utf8ByteLength(issue.body).toLocaleString()} bytes`)
  }
}

/**
 * Builds GitHub issue creation plan.
 * @param {{
 *   promptName: string,
 *   prompt?: GithubPlanPrompt,
 *   options: GithubPlanOptions,
 *   context?: string,
 *   roundResults?: string,
 *   roundResultsRaw?: import('../round-results').RoundResult[],
 * }} input
 * @returns {GithubIssuePlan}
 */
function buildPlan({ promptName, prompt: promptOverride, options, context = '', roundResults = '', roundResultsRaw = [] }) {
  const prompt = promptOverride || loadPrompt(promptName)
  const models = parseCsv(options.models).length > 0 ? parseCsv(options.models) : ['claude', 'gemini', 'codex']
  const labels = parseCsv(options.labels || options.label)
  const date = options.date || getLocalDate()
  const repo = resolveRepo(options.repo)
  const runner = options.runner || '@netlify'
  const resolves =
    promptName === 'summarize-consensus' && Array.isArray(roundResultsRaw)
      ? roundResultsRaw
          .map((result) => result?.issueNumber)
          .filter((number) => Number.isFinite(number))
      : []
  const sourceModels = Array.isArray(roundResultsRaw)
    ? roundResultsRaw.map((result) => result?.model).filter(Boolean)
    : []

  const issues = models.map((model) => ({
    model,
    promptName: String(prompt.name || promptName),
    title: buildIssueTitle({ date, model, prompt, title: options.title, sourceModels }),
    body: buildIssueBody({ runner, model, prompt, context, roundResults, date, resolves }),
  }))

  return { repo, labels, issues }
}

/**
 * Builds GitHub comment creation plan.
 * @param {{
 *   promptName: string,
 *   prompt?: GithubPlanPrompt,
 *   options: GithubPlanOptions,
 *   context?: string,
 *   roundResults?: string,
 * }} input
 * @returns {GithubCommentPlan}
 */
function buildCommentPlan({ promptName, prompt: promptOverride, options, context = '', roundResults = '' }) {
  const prompt = promptOverride || loadPrompt(promptName)
  const repo = resolveRepo(options.repo)
  const runner = options.runner || '@netlify'
  const date = options.date || getLocalDate()
  const issueNumbers = parseCsv(options.issues || options.issue)

  if (issueNumbers.length === 0) {
    throw new Error('No issue numbers provided. Pass --issues 29,30,31 (or --issue).')
  }

  const issues = issueNumbers.map((issueNumber) => {
    const target = resolveCommentTarget({ repo, issueNumber })
    const model = inferModelFromIssueTitle(target.sourceIssueTitle)
    return {
      issueNumber,
      issueTitle: target.sourceIssueTitle,
      issueUrl: target.sourceIssueUrl,
      redirected: target.redirected,
      targetKind: target.targetKind,
      targetRepo: target.targetRepo,
      targetNumber: target.targetNumber,
      targetTitle: target.targetTitle,
      targetUrl: target.targetUrl,
      model,
      promptName: String(prompt.name || promptName),
      title: target.sourceIssueTitle,
      body: buildIssueBody({ runner, model, prompt, context, roundResults, date }),
    }
  })

  return { repo, issues }
}

/**
 * Converts fetched GitHub issue results into workflow source runs.
 * @param {import('../round-results').RoundResult[]} [results]
 * @returns {import('../types').AgentRun[]}
 */
function githubResultsToSourceRuns(results = []) {
  const runs = []
  for (const result of results || []) {
    const replies = Array.isArray(result.replies) ? result.replies : []
    const body = replies.length > 0
      ? replies.map((reply, index) => [
          replies.length > 1 ? `### Reply ${index + 1} of ${replies.length}` : '',
          reply?.body || '',
        ].filter(Boolean).join('\n\n')).join('\n\n')
      : 'No agent reply was found.'
    runs.push({
      agent: result.model || inferModelFromIssueTitle(result.issueTitle) || 'agent',
      sourceStep: result.issueNumber ? `issue #${result.issueNumber}` : '',
      runnerId: result.issueUrl || '',
      resultText: body,
    })
  }
  return runs
}

/** @param {string} heading @param {import('../round-results').RoundResult[]} results @returns {string} */
function formatGithubRoundResults(heading, results) {
  return formatRoundResults({ heading, results })
}

module.exports = {
  ROUND_LABEL_BY_PROMPT,
  buildCommentPlan,
  buildPlan,
  createComment,
  createDiscussionComment,
  createIssue,
  createPullRequestComment,
  extractLinkedPullRequest,
  fetchRoundResultsForOptions,
  formatGithubRoundResults,
  githubResultsToSourceRuns,
  inferModelFromIssueTitle,
  joinContext,
  loadIssueMeta,
  loadPullRequestMeta,
  parseCsv,
  parseGitHubPullRequestUrl,
  printCommentPlan,
  printPlan,
  readAutoContext,
  readContext,
  readManualContext,
  resolveCommentTarget,
  shouldEmbedAllReplies,
  shouldFetchResults,
}
