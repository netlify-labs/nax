#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { Command } = require('commander')
const {
  DEFAULT_MODELS,
  buildIssueBody,
  buildIssueTitle,
  getLocalDate,
  listPrompts,
  loadPrompt,
  resolveRepo,
  titleCase,
} = require('../lib/prompts')
const { buildAutomaticContext } = require('../lib/review-context')
const {
  assertCrossReviewComplete,
  fetchRoundResults,
  formatRoundResults,
  rawIssuesFromResults,
} = require('../lib/round-results')
const { formatGroupHint, listRecentIssueGroups } = require('../lib/issue-groups')
const { multiline } = require('../lib/multiline')

const ROUND_LABEL_BY_PROMPT = {
  'cross-review': 'Round 1 Outputs',
  'summarize-consensus': 'Round 2 Cross-Review Outputs',
}

const GITHUB_ISSUE_BODY_LIMIT = 65536
const BODY_SAFETY_MARGIN = 536
const BODY_FALLBACK_THRESHOLD = GITHUB_ISSUE_BODY_LIMIT - BODY_SAFETY_MARGIN

function parseCsv(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function readManualContext(options) {
  const parts = []
  if (options.context) parts.push(options.context)
  if (options.contextFile) {
    parts.push(fs.readFileSync(path.resolve(options.contextFile), 'utf8').trim())
  }
  return parts.filter(Boolean).join('\n\n')
}

function readAutoContext(options) {
  if (options.autoContext === false) return ''
  return buildAutomaticContext({
    repo: resolveRepo(options.repo),
    repoRoot: options.repoRoot,
    sha: options.sha,
    prLimit: options.prLimit,
  })
}

function joinContext(...parts) {
  return parts.filter(Boolean).join('\n\n')
}

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

  const totalReplies = results.reduce((sum, r) => sum + (r.replies?.length || 0), 0)
  const replyLabel = totalReplies === 1 ? 'reply' : 'replies'
  console.error(`Loaded ${results.length} source issues, embedded ${totalReplies} ${replyLabel}`)

  return results
}

function readContext(options) {
  return joinContext(readAutoContext(options), readManualContext(options))
}

function shouldEmbedAllReplies(promptName) {
  return promptName === 'summarize-consensus'
}

function shouldFetchResults(promptName) {
  return promptName === 'cross-review' || promptName === 'summarize-consensus'
}

function mergeCommandOptions(command, options) {
  return {
    ...(command.parent ? command.parent.opts() : {}),
    ...options,
  }
}

function createIssue({ repo, title, body, labels }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-issue-'))
  const bodyFile = path.join(tmpDir, 'body.md')

  try {
    fs.writeFileSync(bodyFile, body)
    const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile]
    for (const label of labels) args.push('--label', label)

    const result = spawnSync('gh', args, { encoding: 'utf8' })
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(`gh issue create failed for "${title}": ${detail}`)
    }
    return result.stdout.trim()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function createComment({ repo, issueNumber, body }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-comment-'))
  const bodyFile = path.join(tmpDir, 'body.md')

  try {
    fs.writeFileSync(bodyFile, body)
    const args = ['issue', 'comment', issueNumber, '--repo', repo, '--body-file', bodyFile]

    const result = spawnSync('gh', args, { encoding: 'utf8' })
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(`gh issue comment failed for issue #${issueNumber}: ${detail}`)
    }
    return result.stdout.trim()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function createPullRequestComment({ repo, prNumber, body }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-pr-comment-'))
  const bodyFile = path.join(tmpDir, 'body.md')

  try {
    fs.writeFileSync(bodyFile, body)
    const args = ['pr', 'comment', prNumber, '--repo', repo, '--body-file', bodyFile]

    const result = spawnSync('gh', args, { encoding: 'utf8' })
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(`gh pr comment failed for PR #${prNumber}: ${detail}`)
    }
    return result.stdout.trim()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function createDiscussionComment({ repo, targetKind, targetNumber, body }) {
  if (targetKind === 'pr') {
    return createPullRequestComment({ repo, prNumber: targetNumber, body })
  }
  return createComment({ repo, issueNumber: targetNumber, body })
}

function loadIssueMeta({ repo, issueNumber, includeComments = false }) {
  const fields = ['number', 'title', 'url']
  if (includeComments) fields.push('comments')
  const result = spawnSync(
    'gh',
    ['issue', 'view', issueNumber, '--repo', repo, '--json', fields.join(',')],
    { encoding: 'utf8' },
  )

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`Could not load issue #${issueNumber} from ${repo}: ${detail}`)
  }

  return JSON.parse(result.stdout)
}

function loadPullRequestMeta({ repo, prNumber }) {
  const result = spawnSync(
    'gh',
    ['pr', 'view', prNumber, '--repo', repo, '--json', 'number,title,url'],
    { encoding: 'utf8' },
  )

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`Could not load PR #${prNumber} from ${repo}: ${detail}`)
  }

  return JSON.parse(result.stdout)
}

function inferModelFromIssueTitle(title) {
  const match = String(title).match(/\b(claude|gemini|codex)\b/i)
  if (!match) {
    throw new Error(`Could not infer model from issue title "${title}"`)
  }
  return match[1].toLowerCase()
}

function parseGitHubPullRequestUrl(url) {
  const match = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i)
  if (!match) return null
  return {
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  }
}

function extractLinkedPullRequest(commentBody, fallbackRepo) {
  const body = String(commentBody || '')

  const sessionDataMatch = body.match(/<!--\s*netlify-agent-session-data:(\{[\s\S]*?\})\s*-->/)
  if (sessionDataMatch) {
    try {
      const sessionData = JSON.parse(sessionDataMatch[1])
      for (const value of Object.values(sessionData)) {
        const parsed = value?.pr_url ? parseGitHubPullRequestUrl(value.pr_url) : null
        if (parsed) return parsed
      }
    } catch {
      // Ignore malformed machine comments and fall back to text parsing.
    }
  }

  const directUrlMatches = body.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/gi) || []
  for (const match of directUrlMatches) {
    const parsed = parseGitHubPullRequestUrl(match)
    if (parsed) return parsed
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

function resolveCommentTarget({ repo, issueNumber }) {
  const issueMeta = loadIssueMeta({ repo, issueNumber, includeComments: true })
  const linkedPullRequest = (issueMeta.comments || [])
    .map((comment) => extractLinkedPullRequest(comment.body, repo))
    .find(Boolean)

  if (!linkedPullRequest) {
    return {
      sourceIssueNumber: issueMeta.number,
      sourceIssueTitle: issueMeta.title,
      sourceIssueUrl: issueMeta.url,
      targetKind: 'issue',
      targetRepo: repo,
      targetNumber: issueMeta.number,
      targetTitle: issueMeta.title,
      targetUrl: issueMeta.url,
      redirected: false,
    }
  }

  const targetRepo = linkedPullRequest.repo || repo
  const prMeta = loadPullRequestMeta({ repo: targetRepo, prNumber: linkedPullRequest.number })

  return {
    sourceIssueNumber: issueMeta.number,
    sourceIssueTitle: issueMeta.title,
    sourceIssueUrl: issueMeta.url,
    targetKind: 'pr',
    targetRepo,
    targetNumber: prMeta.number,
    targetTitle: prMeta.title,
    targetUrl: prMeta.url,
    redirected: true,
  }
}

function printPlan(plan, { dryRun }) {
  console.log(`\n${dryRun ? 'Dry run' : 'Create issues'}: ${plan.repo}`)
  for (const issue of plan.issues) {
    console.log(`\n- ${issue.title}`)
    console.log(`  model: ${issue.model}`)
    console.log(`  prompt: ${issue.promptName}`)
    console.log(`  body: ${issue.body.length} chars`)
  }
}

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
    console.log(`  body: ${issue.body.length} chars`)
  }
}

function buildPlan({ promptName, options, context, roundResults, roundResultsRaw }) {
  const prompt = loadPrompt(promptName)
  const models = parseCsv(options.models).length > 0 ? parseCsv(options.models) : DEFAULT_MODELS
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
    promptName: prompt.name,
    title: buildIssueTitle({ date, model, prompt, title: options.title, sourceModels }),
    body: buildIssueBody({ runner, model, prompt, context, roundResults, date, resolves }),
  }))

  return { repo, labels, issues }
}

function buildCommentPlan({ promptName, options, context, roundResults }) {
  const prompt = loadPrompt(promptName)
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
      promptName: prompt.name,
      body: buildIssueBody({ runner, model, prompt, context, roundResults, date }),
    }
  })

  return { repo, issues }
}

async function pickPromptInteractively() {
  const clack = require('@clack/prompts')
  const prompts = listPrompts()
  const selected = await clack.select({
    message: 'Choose workflow prompt',
    options: prompts.map((prompt, i) => ({
      value: prompt.name,
      label: `${i + 1}. ${prompt.title}`,
      hint: prompt.description,
    })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

async function selectIssueGroup({ clack, options, message, allowSkip = false }) {
  let groups
  try {
    groups = listRecentIssueGroups({ repo: resolveRepo(options.repo) })
  } catch (error) {
    console.error(`Could not load recent issues for auto-discovery: ${error.message}`)
    return null
  }

  const groupOptions = groups.slice(0, 12).map((group) => ({
    value: group.issueNumbers.join(','),
    label: `${group.date} ${group.promptTitle}`,
    hint: formatGroupHint(group),
  }))

  groupOptions.push({ value: '__manual__', label: 'Enter issue numbers manually' })
  if (allowSkip) groupOptions.push({ value: '__skip__', label: 'Skip — no prior round results' })

  const selected = await clack.select({ message, options: groupOptions })
  if (clack.isCancel(selected)) process.exit(0)

  if (selected === '__skip__') return ''
  if (selected === '__manual__') {
    const text = await clack.text({
      message: 'Issue numbers (comma-separated)',
      placeholder: '29,30,31',
      validate: (value) => (value && value.trim() ? undefined : 'Enter at least one issue number'),
    })
    if (clack.isCancel(text)) process.exit(0)
    return text.trim()
  }
  return selected
}

async function chooseInteractively(initialPromptName, options) {
  const clack = require('@clack/prompts')

  const promptName = initialPromptName || (await pickPromptInteractively())

  let fromIssues = options.fromIssues || options.fromIssue || ''
  if (!fromIssues && shouldFetchResults(promptName) && options.fetchResults !== false) {
    const message = promptName === 'summarize-consensus'
      ? 'Choose prior round to summarize'
      : 'Choose source round to embed'
    fromIssues = await selectIssueGroup({
      clack,
      options,
      message,
      allowSkip: true,
    }) || ''
  }

  const isSummarize = promptName === 'summarize-consensus'
  const modelOrder = isSummarize
    ? ['codex', ...DEFAULT_MODELS.filter((m) => m !== 'codex')]
    : DEFAULT_MODELS
  const defaultModelInitialValues = isSummarize ? ['codex'] : DEFAULT_MODELS

  let models = parseCsv(options.models)
  if (models.length === 0) {
    const selectedModels = await clack.multiselect({
      message: 'Choose Netlify agent models',
      options: modelOrder.map((model) => ({
        value: model,
        label: titleCase(model),
      })),
      initialValues: defaultModelInitialValues,
      required: true,
    })
    if (clack.isCancel(selectedModels)) process.exit(0)
    models = selectedModels
  }

  const optionsWithFrom = { ...options, fromIssues }
  const roundResultsRaw = fetchRoundResultsForOptions(optionsWithFrom, {
    embedAll: shouldEmbedAllReplies(promptName),
  })

  let manualContext = readManualContext(options)
  if (!manualContext && options.contextPrompt !== false) {
    manualContext = await multiline({
      message: 'Additional context/instructions (optional)',
      placeholder: 'Hit enter to proceed. Ok if this is empty.',
    })
  }
  const context = joinContext(readAutoContext(options), manualContext)

  return {
    promptName,
    options: {
      ...optionsWithFrom,
      models: models.join(','),
    },
    context,
    roundResultsRaw,
  }
}

async function chooseCommentInteractively(initialPromptName, options) {
  const clack = require('@clack/prompts')

  const promptName = initialPromptName || (await pickPromptInteractively())

  let issues = options.issues || options.issue
  if (!issues) {
    if (promptName === 'cross-review') {
      issues = await selectIssueGroup({
        clack,
        options,
        message: 'Choose round to comment on',
      })
    } else {
      const selectedIssues = await clack.text({
        message: 'Issue numbers (comma-separated)',
        placeholder: '29,30,31',
        validate: (value) => (value && value.trim() ? undefined : 'Enter at least one issue number'),
      })
      if (clack.isCancel(selectedIssues)) process.exit(0)
      issues = selectedIssues.trim()
    }
  }

  let fromIssues = options.fromIssues || options.fromIssue || ''
  if (!fromIssues && shouldFetchResults(promptName) && options.fetchResults !== false) {
    fromIssues = issues
  }

  const optionsWithFrom = { ...options, fromIssues }
  const roundResultsRaw = fetchRoundResultsForOptions(optionsWithFrom, {
    embedAll: shouldEmbedAllReplies(promptName),
  })

  let manualContext = readManualContext(options)
  if (!manualContext && options.contextPrompt !== false) {
    manualContext = await multiline({
      message: 'Additional context/instructions (optional)',
      placeholder: 'Hit enter to proceed. Ok if this is empty.',
    })
  }
  const context = joinContext(readAutoContext(options), manualContext)

  return {
    promptName,
    options: {
      ...optionsWithFrom,
      issues,
    },
    context,
    roundResultsRaw,
  }
}

function buildAndMaybeFallbackPlan(input, planBuilder) {
  const heading = input.options.fromIssuesHeading || ROUND_LABEL_BY_PROMPT[input.promptName] || 'Prior Round Outputs'
  const results = Array.isArray(input.roundResultsRaw) ? input.roundResultsRaw : []

  const formatFor = (structuredOnly) =>
    results.length === 0 ? '' : formatRoundResults({ heading, results, structuredOnly })

  const fullRoundResults = formatFor(false)
  let plan = planBuilder({ ...input, roundResults: fullRoundResults })

  const oversized = plan.issues.some((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD)
  if (oversized && input.promptName === 'summarize-consensus' && results.length > 0) {
    const offending = plan.issues.find((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD)
    console.error(
      `Issue body is ${offending.body.length} chars (limit ${BODY_FALLBACK_THRESHOLD}); ` +
        'falling back to structured-findings JSON only for embedded round outputs.',
    )
    const structuredRoundResults = formatFor(true)
    plan = planBuilder({ ...input, roundResults: structuredRoundResults })
    const stillOversized = plan.issues.find((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD)
    if (stillOversized) {
      console.error(
        `Warning: structured-only body is still ${stillOversized.body.length} chars (over ${BODY_FALLBACK_THRESHOLD}); ` +
          'gh issue create may fail. Consider --no-auto-context or fewer source issues.',
      )
    }
  }

  return plan
}

async function handleIssue(promptName, options) {
  const wantsInteractive = process.stdin.isTTY && (!promptName || !options.yes)

  let resolvedPromptName = promptName
  if (wantsInteractive && !resolvedPromptName) {
    resolvedPromptName = await pickPromptInteractively()
  }
  resolvedPromptName = resolvedPromptName || 'review'

  if (wantsInteractive && resolvedPromptName === 'cross-review') {
    return handleComment(resolvedPromptName, options)
  }

  const input = wantsInteractive
    ? await chooseInteractively(resolvedPromptName, options)
    : {
        promptName: resolvedPromptName,
        options,
        context: readContext(options),
        roundResultsRaw: fetchRoundResultsForOptions(options, {
          embedAll: shouldEmbedAllReplies(resolvedPromptName),
        }),
      }

  if (
    input.promptName === 'summarize-consensus' &&
    options.skipRoundCheck !== true &&
    Array.isArray(input.roundResultsRaw) &&
    input.roundResultsRaw.length > 0
  ) {
    assertCrossReviewComplete(rawIssuesFromResults(input.roundResultsRaw))
  }

  const plan = buildAndMaybeFallbackPlan(input, buildPlan)
  printPlan(plan, { dryRun: options.dryRun })

  if (options.dryRun) {
    for (const issue of plan.issues) {
      console.log(`\n--- ${issue.title} ---\n${issue.body}`)
    }
    return
  }

  if (!options.yes && process.stdin.isTTY) {
    const clack = require('@clack/prompts')
    const titleList = plan.issues.map((issue) => `  • ${issue.title}`).join('\n')
    const noun = plan.issues.length === 1 ? 'issue' : 'issues'
    const confirmed = await clack.confirm({
      message: `Create ${plan.issues.length} GitHub ${noun} in ${plan.repo}?\n${titleList}`,
      initialValue: true,
    })
    if (clack.isCancel(confirmed) || !confirmed) {
      console.log('Cancelled')
      return
    }
  }

  for (const issue of plan.issues) {
    const url = createIssue({
      repo: plan.repo,
      title: issue.title,
      body: issue.body,
      labels: plan.labels,
    })
    console.log(`${issue.title}: ${url}`)
  }
}

async function handleComment(promptName, options) {
  const wantsInteractive = process.stdin.isTTY && (!promptName || !options.yes || !(options.issues || options.issue))
  const resolvedPromptName = promptName || 'cross-review'

  let nonInteractiveOptions = options
  if (!wantsInteractive) {
    const fromIssues =
      options.fromIssues ||
      options.fromIssue ||
      (shouldFetchResults(resolvedPromptName) && options.fetchResults !== false
        ? options.issues || options.issue || ''
        : '')
    nonInteractiveOptions = { ...options, fromIssues }
  }

  const input = wantsInteractive
    ? await chooseCommentInteractively(promptName, options)
    : {
        promptName: resolvedPromptName,
        options: nonInteractiveOptions,
        context: readContext(nonInteractiveOptions),
        roundResultsRaw: fetchRoundResultsForOptions(nonInteractiveOptions, {
          embedAll: shouldEmbedAllReplies(resolvedPromptName),
        }),
      }

  const plan = buildAndMaybeFallbackPlan(input, buildCommentPlan)
  printCommentPlan(plan, { dryRun: options.dryRun })

  if (options.dryRun) {
    for (const issue of plan.issues) {
      const label = issue.redirected
        ? `#${issue.issueNumber} ${issue.issueTitle} -> PR #${issue.targetNumber} ${issue.targetTitle}`
        : `#${issue.issueNumber} ${issue.issueTitle}`
      console.log(`\n--- ${label} ---\n${issue.body}`)
    }
    return
  }

  if (!options.yes && process.stdin.isTTY) {
    const clack = require('@clack/prompts')
    const targetList = plan.issues
      .map((issue) => {
        const target = issue.targetKind === 'pr'
          ? `PR #${issue.targetNumber} ${issue.targetTitle}`
          : `issue #${issue.targetNumber}`
        return `  • ${issue.model} → ${target}`
      })
      .join('\n')
    const noun = plan.issues.length === 1 ? 'comment' : 'comments'
    const confirmed = await clack.confirm({
      message: `Create ${plan.issues.length} GitHub ${noun} in ${plan.repo}?\n${targetList}`,
      initialValue: true,
    })
    if (clack.isCancel(confirmed) || !confirmed) {
      console.log('Cancelled')
      return
    }
  }

  for (const issue of plan.issues) {
    const url = createDiscussionComment({
      repo: issue.targetRepo,
      targetKind: issue.targetKind,
      targetNumber: issue.targetNumber,
      body: issue.body,
    })
    const targetLabel = issue.targetKind === 'pr' ? `PR #${issue.targetNumber}` : `#${issue.targetNumber}`
    console.log(`#${issue.issueNumber} ${issue.issueTitle} -> ${targetLabel}: ${url}`)
  }
}

function handleList() {
  for (const prompt of listPrompts()) {
    console.log(`${prompt.name}\t${prompt.title}\t${prompt.description}`)
  }
}

function buildProgram() {
  const program = new Command()

  program
    .name('nax')
    .description('Create Netlify agent workflow issues from prompt templates')
    .argument('[prompt]', 'Prompt name to run, e.g. review')
    .option('--models <list>', `Comma-separated models (default: ${DEFAULT_MODELS.join(',')})`)
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--date <yyyy-mm-dd>', 'Issue title date prefix; defaults to local date')
    .option('--title <title>', 'Issue title suffix; defaults to prompt title')
    .option('--context <text>', 'Additional context appended to each issue')
    .option('--context-file <path>', 'Read additional context from a file')
    .option('--from-issues <list>', 'Comma-separated source issue numbers; their latest agent reply is fetched and embedded as collapsible details')
    .option('--from-issue <list>', 'Alias for --from-issues')
    .option('--from-issues-heading <text>', 'Heading used for the embedded round-results section')
    .option('--sha <rev>', 'Pinned git revision injected into the review context (default: HEAD)')
    .option('--repo-root <path>', 'Repository root used to compute the pinned SHA and working tree snapshot')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--label <list>', 'Comma-separated labels to add')
    .option('--labels <list>', 'Alias for --label')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--dry-run', 'Print issues without creating them')
    .option('--yes', 'Skip confirmation')
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-context-prompt', 'Do not ask for free-form context in interactive mode')
    .option('--no-fetch-results', 'Do not fetch round results from --from-issues')
    .option('--skip-round-check', 'Skip the cross-review-completeness check for summarize-consensus')
    .action((prompt, options) => handleIssue(prompt, options))

  program
    .command('issue [prompt]')
    .description('Create issues for a prompt')
    .option('--models <list>', `Comma-separated models (default: ${DEFAULT_MODELS.join(',')})`)
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--date <yyyy-mm-dd>', 'Issue title date prefix; defaults to local date')
    .option('--title <title>', 'Issue title suffix; defaults to prompt title')
    .option('--context <text>', 'Additional context appended to each issue')
    .option('--context-file <path>', 'Read additional context from a file')
    .option('--from-issues <list>', 'Comma-separated source issue numbers; their latest agent reply is fetched and embedded as collapsible details')
    .option('--from-issue <list>', 'Alias for --from-issues')
    .option('--from-issues-heading <text>', 'Heading used for the embedded round-results section')
    .option('--sha <rev>', 'Pinned git revision injected into the review context (default: HEAD)')
    .option('--repo-root <path>', 'Repository root used to compute the pinned SHA and working tree snapshot')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--label <list>', 'Comma-separated labels to add')
    .option('--labels <list>', 'Alias for --label')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--dry-run', 'Print issues without creating them')
    .option('--yes', 'Skip confirmation')
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-context-prompt', 'Do not ask for free-form context in interactive mode')
    .option('--no-fetch-results', 'Do not fetch round results from --from-issues')
    .option('--skip-round-check', 'Skip the cross-review-completeness check for summarize-consensus')
    .action((prompt, options, command) => handleIssue(prompt, mergeCommandOptions(command, options)))

  program
    .command('comment [prompt]')
    .description('Comment on existing issues with a prompt')
    .option('--issue <list>', 'Comma-separated issue numbers')
    .option('--issues <list>', 'Alias for --issue')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--context <text>', 'Additional context appended to each comment')
    .option('--context-file <path>', 'Read additional context from a file')
    .option('--from-issues <list>', 'Comma-separated source issue numbers; their latest agent reply is fetched and embedded as collapsible details (defaults to --issues for cross-review)')
    .option('--from-issue <list>', 'Alias for --from-issues')
    .option('--from-issues-heading <text>', 'Heading used for the embedded round-results section')
    .option('--sha <rev>', 'Pinned git revision injected into the review context (default: HEAD)')
    .option('--repo-root <path>', 'Repository root used to compute the pinned SHA and working tree snapshot')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--dry-run', 'Print comments without creating them')
    .option('--yes', 'Skip confirmation')
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-context-prompt', 'Do not ask for free-form context in interactive mode')
    .option('--no-fetch-results', 'Do not fetch round results from --from-issues')
    .action((prompt, options, command) => handleComment(prompt, mergeCommandOptions(command, options)))

  program
    .command('list')
    .description('List available prompt templates')
    .action(handleList)

  return program
}

if (require.main === module) {
  buildProgram().parseAsync(process.argv).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}

module.exports = {
  buildCommentPlan,
  buildPlan,
  createComment,
  createDiscussionComment,
  buildProgram,
  createIssue,
  createPullRequestComment,
  extractLinkedPullRequest,
  inferModelFromIssueTitle,
  loadIssueMeta,
  loadPullRequestMeta,
  parseCsv,
  parseGitHubPullRequestUrl,
  resolveCommentTarget,
}
