// Handoff target that posts selected findings as one advisory GitHub PR review (event COMMENT).
// Inline comments only on lines proven to be in the diff; everything else goes to "Outside this diff".
const fs = require('fs')
const os = require('os')
const path = require('path')
const { runGh } = require('../../integrations/github/gh-cli')
const { rightSideLines } = require('./diff-lines')
const { plainLocation } = require('./finding-body')

/**
 * @typedef {import('../findings').Finding} Finding
 * @typedef {import('../findings').FindingsArtifact} FindingsArtifact
 * @typedef {import('./index').HandoffAction} HandoffAction
 * @typedef {import('./index').HandoffPlan} HandoffPlan
 * @typedef {import('./index').HandoffApplyResult} HandoffApplyResult
 * @typedef {import('./github-issues').GhRunner} GhRunner
 * @typedef {{ repo: string, artifact: FindingsArtifact, gh?: GhRunner, pr?: number, force?: boolean }} PrReviewContext
 * @typedef {{ path: string, line: number, side: 'RIGHT', body: string }} ReviewComment
 */

/** @param {Record<string, unknown>} context @returns {PrReviewContext} */
function reviewContext(context) {
  return /** @type {PrReviewContext} */ (/** @type {unknown} */ (context))
}

/** @param {PrReviewContext} context @returns {GhRunner} */
function ghRunner(context) {
  return context.gh || ((args, options = {}) => runGh(args, options))
}

/** Hidden review-body marker that prevents posting the same run twice. @param {string} runId */
function reviewMarker(runId) {
  return `<!-- nax-review:${runId} -->`
}

/**
 * Reads every page of a GitHub list endpoint through `gh api --paginate --slurp`.
 * @param {GhRunner} gh
 * @param {string} route
 * @returns {Array<Record<string, unknown>>}
 */
function listAll(gh, route) {
  const result = gh(['api', route, '--paginate', '--slurp'], { errorPrefix: `Could not read ${route}` })
  /** @type {unknown[]} */
  const pages = JSON.parse(result.stdout || '[]')
  return pages.flatMap((page) => (Array.isArray(page) ? page : [page]))
}

/**
 * Resolves the PR number: run target, then --pr, then the open PR for the run branch.
 * @param {PrReviewContext} context
 * @param {GhRunner} gh
 * @returns {number}
 */
function resolvePullRequestNumber(context, gh) {
  const fromTarget = context.artifact.target.pullRequest?.number
  if (fromTarget) return fromTarget
  if (context.pr) return context.pr
  const branch = context.artifact.target.branch
  if (branch) {
    const viewed = gh(['pr', 'view', branch, '--repo', context.repo, '--json', 'number'], { allowFailure: true, attempts: 1 })
    if (viewed.status === 0) {
      const number = Number(JSON.parse(viewed.stdout || '{}').number)
      if (Number.isInteger(number) && number > 0) return number
    }
  }
  throw Object.assign(new Error(`No pull request found for this run${branch ? ` (branch ${branch})` : ''}. Pass --pr <number>.`), { code: 'pr_not_found' })
}

/** @param {Finding} finding */
function inlineCommentBody(finding) {
  return [
    `**[${finding.severity}] ${finding.title}**`,
    finding.claim && finding.claim !== finding.title ? finding.claim : '',
    finding.suggestedFix ? `**Suggested fix:** ${finding.suggestedFix}` : '',
    finding.agents.length > 0 ? `_Reported by ${finding.agents.join(', ')} · ${finding.localId}_` : `_${finding.localId}_`,
  ].filter(Boolean).join('\n\n')
}

/**
 * Plans a single review for the run, or skips when this run's review is already posted.
 * @param {Finding[]} findings
 * @param {Record<string, unknown>} rawContext
 * @returns {HandoffPlan}
 */
function plan(findings, rawContext) {
  const context = reviewContext(rawContext)
  const gh = ghRunner(context)
  const { artifact } = context
  const number = resolvePullRequestNumber(context, gh)
  const key = `review:${artifact.runId}`
  const pull = JSON.parse(gh(['pr', 'view', String(number), '--repo', context.repo, '--json', 'number,url,headRefOid'], { errorPrefix: `Could not read PR #${number}` }).stdout || '{}')
  const base = `repos/${context.repo}/pulls/${number}`
  const posted = listAll(gh, `${base}/reviews`).find((review) => String(review.body || '').includes(reviewMarker(artifact.runId)))
  if (posted && !context.force) {
    return { actions: [], skipped: [{ key, reason: 'review already posted for this run (use --force to post another)', existingUrl: String(posted.html_url || '') }] }
  }

  const sha = artifact.target.sha
  const head = String(pull.headRefOid || '')
  let commitId = ''
  let inlineAllowed = true
  /** @type {string[]} */
  const notes = []
  if (sha && head && sha !== head) {
    const commits = listAll(gh, `${base}/commits`).map((commit) => String(commit.sha || ''))
    if (commits.includes(sha)) {
      commitId = sha
      notes.push(`Findings were produced at \`${sha.slice(0, 12)}\`; the PR head is now \`${head.slice(0, 12)}\`, so inline comments may show as outdated.`)
    } else {
      inlineAllowed = false
      notes.push(`Findings were produced at \`${sha.slice(0, 12)}\`, which is not in this PR, so every finding is listed below instead of inline.`)
    }
  }

  /** @type {Map<string, Set<number>>} */
  const diffLines = new Map()
  if (inlineAllowed) {
    for (const file of listAll(gh, `${base}/files`)) diffLines.set(String(file.filename || ''), rightSideLines(typeof file.patch === 'string' ? file.patch : ''))
  }
  /** @type {ReviewComment[]} */
  const comments = []
  /** @type {Finding[]} */
  const outside = []
  for (const finding of findings) {
    const lines = diffLines.get(finding.file)
    if (inlineAllowed && finding.line !== null && lines && lines.has(finding.line)) {
      comments.push({ path: finding.file, line: finding.line, side: 'RIGHT', body: inlineCommentBody(finding) })
    } else {
      outside.push(finding)
    }
  }
  const body = [
    `## nax ${artifact.flowId} consensus review`,
    `${findings.length} finding${findings.length === 1 ? '' : 's'} from run \`${artifact.runId}\`: ${comments.length} inline, ${outside.length} outside this diff. This review is advisory.`,
    ...notes,
    outside.length > 0 ? ['### Outside this diff', ...outside.map((finding) => `- **[${finding.severity}] ${finding.title}**${finding.file ? ` — ${plainLocation(finding)}` : ''}`)].join('\n') : '',
    reviewMarker(artifact.runId),
  ].filter(Boolean).join('\n\n')
  return {
    actions: [{
      type: 'create-review',
      key,
      title: `PR #${number} review (${comments.length} inline, ${outside.length} outside diff)`,
      body,
      labels: [],
      payload: { number, ...(commitId ? { commit_id: commitId } : {}), event: 'COMMENT', body, comments },
    }],
    skipped: [],
  }
}

/**
 * Posts the planned review through the GitHub reviews API.
 * @param {HandoffAction[]} actions
 * @param {Record<string, unknown>} rawContext
 * @returns {HandoffApplyResult}
 */
function apply(actions, rawContext) {
  const context = reviewContext(rawContext)
  const gh = ghRunner(context)
  /** @type {HandoffApplyResult} */
  const result = { applied: [], failed: [], warnings: [] }
  for (const action of actions) {
    const payload = /** @type {{ number: number } & Record<string, unknown>} */ (action.payload)
    const { number, ...request } = payload
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nax-pr-review-'))
    const inputFile = path.join(tmpDir, 'review.json')
    try {
      fs.writeFileSync(inputFile, JSON.stringify(request))
      const posted = gh(['api', `repos/${context.repo}/pulls/${number}/reviews`, '--method', 'POST', '--input', inputFile], { allowFailure: true })
      if (posted.status !== 0) {
        result.failed.push({ key: action.key, error: posted.detail || posted.stderr || `gh exited ${posted.status}` })
        break
      }
      result.applied.push({ key: action.key, url: String(JSON.parse(posted.stdout || '{}').html_url || '') })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
  return result
}

/** @type {import('./index').HandoffTarget} */
const prReviewTarget = {
  id: 'pr-review',
  needsRepo: true,
  describe: (_count, context) => `Post one advisory review to a pull request in ${reviewContext(context).repo}?`,
  plan,
  apply,
}

module.exports = {
  prReviewTarget,
  reviewMarker,
}
