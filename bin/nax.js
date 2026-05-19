#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { Command, Option } = require('commander')
const { makeBox, makeHorizontalBoxes } = require('@davidwells/box-logger')
const flavorMessages = require('../lib/flavor-messages.json')
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
const { buildAutomaticContext, resolveRemoteBranchSha } = require('../lib/review-context')
const {
  assertCrossReviewComplete,
  fetchRoundResults,
  formatRoundResults,
  rawIssuesFromResults,
} = require('../lib/round-results')
const { formatGroupHint, listRecentIssueGroups } = require('../lib/issue-groups')
const { bodyHasRunnerResultMarker, bodyHasRunnerStatusMarker } = require('../lib/comment-markers')
const { multiline } = require('../lib/multiline')
const { WAIT_FOR_AGENT_RESULTS, listFlows, loadFlow, loadStepPrompt } = require('../lib/flows')
const { createRunState, dismissRunState, findLatestUnfinishedRun, listRunStates, saveRunState } = require('../lib/run-state')
const { clearTrackedRunState, trackRunState } = require('../lib/graceful-run-state')
const { detectTransports, formatTransportSetupHelp, resolveTransport } = require('../lib/transports')
const { enableGitHubActionsSetup, initSite, readNetlifyProject } = require('../lib/init')
const {
  buildNetlifyEnv,
  currentGitBranch,
  submitLocalAgentRun,
  waitForLocalAgentRuns,
} = require('../lib/local-runner')

const ROUND_LABEL_BY_PROMPT = {
  'cross-review': 'Round 1 Outputs',
  'summarize-consensus': 'Round 2 Cross-Review Outputs',
  'cross-score': 'Idea Proposals',
  react: 'Ideas And Cross-Scores',
  'synthesize-ideas': 'Idea Duel Outputs',
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
    pinnedSha: options.pinnedSha,
    pinnedSource: options.pinnedSource,
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

function isPullRequestSelector(value) {
  return /^#?\d+$/.test(String(value || '').trim())
}

function resolvePullRequestBranch({ selector, repo, projectRoot }) {
  const number = String(selector).trim().replace(/^#/, '')
  const result = spawnSync(
    'gh',
    ['pr', 'view', number, '--repo', repo, '--json', 'headRefName', '--jq', '.headRefName'],
    { cwd: projectRoot, encoding: 'utf8' },
  )
  const branch = (result.stdout || '').trim()
  if (result.status !== 0 || !branch) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`Could not resolve PR #${number} branch${detail ? `: ${detail}` : ''}`)
  }
  return branch
}

function resolveWorkflowBranch({ options, projectRoot }) {
  const requested = String(options.branch || '').trim()
  if (!requested) {
    const branch = currentGitBranch(projectRoot)
    if (!branch) throw new Error('Could not resolve the current git branch. Pass --branch <name> explicitly.')
    return { branch, source: 'current-branch' }
  }

  if (isPullRequestSelector(requested)) {
    const repo = resolveRepo(options.repo)
    return {
      branch: resolvePullRequestBranch({ selector: requested, repo, projectRoot }),
      source: `pr-${requested.replace(/^#/, '')}`,
    }
  }

  return { branch: requested, source: 'explicit-branch' }
}

function remotePinnedOptions({ options, projectRoot, transport }) {
  if (options.autoContext === false || options.sha || options.pinnedSha) return options
  if (transport !== 'local' && transport !== 'github') return options
  const branch = options.branch || currentGitBranch(projectRoot)
  const pinned = resolveRemoteBranchSha({ repoRoot: projectRoot, branch })
  return {
    ...options,
    pinnedSha: pinned.sha,
    pinnedSource: pinned.ref,
  }
}

function buildFlowRunContext({ options, projectRoot, transport }) {
  const contextOptions = remotePinnedOptions({ options, projectRoot, transport })
  const automatic = readAutoContext(contextOptions)
  const manual = readManualContext(options)
  return {
    automatic,
    manual,
    combined: joinContext(automatic, manual),
    pinnedSha: contextOptions.pinnedSha || contextOptions.sha || '',
    pinnedSource: contextOptions.pinnedSource || (contextOptions.sha ? 'explicit --sha' : ''),
  }
}

function extractSavedContextFromPrompt(promptText) {
  const marker = '\n## Additional Context\n\n'
  const index = String(promptText || '').lastIndexOf(marker)
  if (index === -1) return ''
  return String(promptText).slice(index + marker.length).trim()
}

function contextForRunState(runState, options) {
  if (runState.context?.combined) return runState.context.combined
  for (const step of runState.steps || []) {
    for (const run of step.runs || []) {
      const saved = extractSavedContextFromPrompt(run.promptText)
      if (saved) return saved
    }
  }
  return joinContext(readAutoContext(options), readManualContext(options))
}

function readRemoteInvisibleGitState(projectRoot) {
  const result = spawnSync('git', ['status', '--short', '--branch'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) return { dirty: false, lines: [] }

  const lines = (result.stdout || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
  const branchLine = lines.find((line) => line.startsWith('##')) || ''
  const fileLines = lines.filter((line) => !line.startsWith('##'))
  const hasUnpushedCommits = /\[(?:ahead|gone)\b/.test(branchLine)
  const displayLines = [
    ...(hasUnpushedCommits ? [branchLine] : []),
    ...fileLines,
  ]

  return {
    dirty: hasUnpushedCommits || fileLines.length > 0,
    lines: displayLines,
  }
}

async function confirmRemoteRunnerCanMissLocalChanges({ projectRoot, branch, options }) {
  if (!process.stdin.isTTY || options.yes || options.dryRun) return

  const state = readRemoteInvisibleGitState(projectRoot)
  if (!state.dirty) return

  const clack = require('@clack/prompts')
  console.log('')
  console.log('Local git state not visible to remote Netlify agent runners:')
  for (const line of state.lines) {
    console.log(`  ${line}`)
  }
  const confirmed = await clack.confirm({
    message: `You have uncommitted or unpushed changes on '${branch}' branch that remote Netlify agent runners will not know about.`,
    active: 'Yes, continue',
    inactive: 'No, cancel',
    initialValue: true,
  })
  if (clack.isCancel(confirmed) || !confirmed) {
    console.log('Cancelled')
    process.exit(0)
  }
}

function shouldEmbedAllReplies(promptName) {
  return ['summarize-consensus', 'react', 'synthesize-ideas'].includes(promptName)
}

function shouldFetchResults(promptName) {
  return promptName === 'cross-review' || promptName === 'summarize-consensus'
}

function commandOptions(value) {
  return value && typeof value.opts === 'function' ? value.opts() : value
}

function optionWasSet(command, name) {
  if (!command || typeof command.getOptionValueSource !== 'function') return false
  const source = command.getOptionValueSource(name)
  return Boolean(source && source !== 'default')
}

function normalizeOptionAliases(resolved) {
  if (resolved.dry && resolved.dryRun !== true) {
    resolved.dryRun = true
  }
  if (resolved.force && resolved.yes !== true) {
    resolved.yes = true
  }
  if (resolved.where && !resolved.transport) {
    resolved.transport = resolved.where
  }
  return resolved
}

function mergeCommandOptions(command, options) {
  const local = commandOptions(options) || {}
  const parentCommand = command?.parent
  const parent = parentCommand && typeof parentCommand.opts === 'function' ? parentCommand.opts() : {}
  const resolved = {
    ...parent,
    ...local,
  }

  for (const key of Object.keys(parent)) {
    if (optionWasSet(parentCommand, key) && !optionWasSet(command, key)) {
      resolved[key] = parent[key]
    }
  }

  return normalizeOptionAliases(resolved)
}

function actionOptions(options, command) {
  if (command && typeof command.opts === 'function') {
    return mergeCommandOptions(command, command.opts())
  }
  return normalizeOptionAliases(commandOptions(options) || {})
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

function buildPlan({ promptName, prompt: promptOverride, options, context, roundResults, roundResultsRaw }) {
  const prompt = promptOverride || loadPrompt(promptName)
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

function buildCommentPlan({ promptName, prompt: promptOverride, options, context, roundResults }) {
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

async function handleList() {
  for (const flow of await listFlows()) {
    console.log(`${flow.id}\t${flow.title}\t${flow.description}`)
  }
}

function formatRunTimestamp(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function runHasFinalArtifact(state) {
  const final = finalRunForRunState(state)
  if (!final) return false
  const { run } = final
  return Boolean(run.commentUrl || run.issueUrl || run.runnerId || run.deployUrl || run.prUrl)
}

async function handleRecent(options) {
  const projectRoot = options.projectRoot || process.cwd()
  const all = listRunStates(projectRoot)
  const usable = all.filter(runHasFinalArtifact)
  if (usable.length === 0) {
    if (all.length === 0) {
      console.log('No runs found in .nax/runs/.')
    } else {
      console.log('No completed runs with a final artifact found.')
    }
    return
  }
  const limit = Number.parseInt(options.limit || '25', 10)
  const choices = usable.slice(0, limit)

  let selected
  if (options.runId) {
    selected = choices.find((state) => state.runId === options.runId) || null
    if (!selected) {
      throw new Error(`No run found with id "${options.runId}"`)
    }
  } else {
    const clack = require('@clack/prompts')
    const picked = await clack.select({
      message: 'Pick a recent run',
      options: choices.map((state) => ({
        value: state.runId,
        label: `${formatRunTimestamp(state.updatedAt || state.createdAt)}  ${state.flowTitle || state.flowId} (${state.transport})`,
        hint: state.runId,
      })),
    })
    if (clack.isCancel(picked)) return
    selected = choices.find((state) => state.runId === picked)
    if (!selected) return
  }

  printSuccessBox({
    flow: { title: selected.flowTitle || selected.flowId },
    runState: selected,
    transport: selected.transport,
    projectRoot: selected.projectRoot || projectRoot,
  })
}

async function handlePreviewSpinner(options) {
  const total = Number.parseInt(options.count || '3', 10)
  const tickMs = Number.parseInt(options.tickMs || '10000', 10)
  const stepTitle = options.label || 'Review'
  const parsed = parseCsv(options.agents)
  const agents = parsed.length > 0 ? parsed : ['claude', 'gemini', 'codex']
  const flavorMinMs = Number.parseInt(options.flavorMinMs || '10000', 10)
  const flavorMaxMs = Number.parseInt(options.flavorMaxMs || '15000', 10)
  console.log(`TTY: ${process.stdout.isTTY ? 'yes (spinner + flavor)' : 'no (plain logs)'}`)
  const reporter = makeStepProgressReporter({
    stepTitle,
    total,
    agents,
    orchestrator: options.orchestrator || DEFAULT_ORCHESTRATOR,
    flavorMinMs,
    flavorMaxMs,
  })
  let settled = false
  try {
    for (let i = 1; i <= total; i++) {
      await new Promise((resolve) => setTimeout(resolve, tickMs))
      reporter.setCount(i)
    }
    reporter.done(`${stepTitle}: ${total}/${total} complete`)
    settled = true
  } finally {
    if (!settled) reporter.fail(`${stepTitle} failed`)
  }
}

async function handlePreviewBoxes(flowId, options) {
  const id = flowId || (await pickFlowInteractively())
  const flow = await loadFlow(id)
  const steps = flow.steps.filter((step) => (step.agents || []).length > 0)
  const transport = options.transport === 'local' ? 'local' : 'github'
  const projectRoot = options.projectRoot || process.cwd()
  printFlowPlan({
    flow,
    steps,
    transport,
    branch: options.branch || 'master',
    context: options.context || '',
  })
  const lastStep = steps[steps.length - 1]
  const fakeRunState = {
    steps: steps.map((step, i) => ({
      ...step,
      status: 'completed',
      runs: step.agents.map((agent) => ({
        agent,
        status: 'completed',
        runnerId: `preview-runner-${i}-${agent}`,
        issueUrl: `https://github.com/example/repo/issues/${100 + i}`,
        commentUrl: i === steps.length - 1
          ? `https://github.com/example/repo/issues/${100 + i}#issuecomment-9999999`
          : '',
        deployUrl: '',
        prUrl: '',
      })),
    })),
  }
  printSuccessBox({ flow, runState: fakeRunState, transport, projectRoot })
}

async function pickFlowInteractively() {
  const clack = require('@clack/prompts')
  const flows = await listFlows()
  if (flows.length === 0) {
    throw new Error('No flows found in flows/*/flow.yml')
  }
  const selected = await clack.select({
    message: 'Choose workflow',
    options: flows.map((flow) => ({
      value: flow.id,
      label: flow.title,
      hint: flow.description,
    })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

async function chooseTransportInteractively({ requested, projectRoot }) {
  const clack = require('@clack/prompts')
  const detections = detectTransports({ projectRoot })
  if (requested && requested !== 'auto') return resolveTransport(requested, detections)

  const available = detections.filter((transport) => transport.available)
  if (available.length === 1) return available[0].id
  if (available.length === 0) {
    throw new Error(formatTransportSetupHelp(detections))
  }

  const selected = await clack.select({
    message: 'Where do you want to run the workflow?',
    options: available.map((transport) => ({
      value: transport.id,
      label: transport.title,
      hint: `ready — ${transport.reason}`,
    })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

async function collectFlowOptions(flow, options) {
  if (!process.stdin.isTTY || options.yes) return options
  const clack = require('@clack/prompts')
  const resolved = { ...options }
  for (const [key, spec] of Object.entries(flow.options || {})) {
    if (resolved[key]) continue
    const required = spec && spec.required === true
    if (!required) continue
    const value = await clack.text({
      message: spec.prompt || key,
      validate: (input) => (input && input.trim() ? undefined : `${key} is required`),
    })
    if (clack.isCancel(value)) process.exit(0)
    resolved[key] = value.trim()
  }
  return resolved
}

function flowAgents(flow) {
  const agents = []
  for (const agent of normalizeArray(flow.defaults?.agents)) agents.push(agent)
  for (const step of flow.steps || []) {
    for (const agent of normalizeArray(step.agents)) agents.push(agent)
  }
  return [...new Set(agents.filter(Boolean))]
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

function withSelectedAgents(flow, selectedAgents) {
  const selected = new Set(selectedAgents)
  return {
    ...flow,
    defaults: {
      ...flow.defaults,
      agents: normalizeArray(flow.defaults?.agents).filter((agent) => selected.has(agent)),
    },
    steps: flow.steps.map((step) => ({
      ...step,
      agents: normalizeArray(step.agents).length > 0
        ? normalizeArray(step.agents).filter((agent) => selected.has(agent))
        : normalizeArray(step.agents),
    })),
  }
}

function runnableSteps(flow, options) {
  return findStepRange(flow, options).filter((step) => normalizeArray(step.agents).length > 0)
}

function resolveStepDescription(flow, step) {
  if (step.description) return step.description
  try {
    return loadStepPrompt(flow, step).description || ''
  } catch (_err) {
    return ''
  }
}

function stepActionLabel(step, transport) {
  const action = String(step.action || 'issue')
  const submit = String(step.submit || 'new-run')
  if (transport === 'local') {
    if (submit === 'new-run') return 'new agent run'
    if (submit === 'follow-up') return 'follow-up session'
    return submit
  }
  if (action === 'issue' && submit === 'new-run') return 'new issue'
  if (action === 'comment' && submit === 'follow-up') return 'follow-up comment'
  if (action === 'comment') return 'comment'
  if (action === 'issue') return 'issue'
  return [action, submit].filter(Boolean).join(' / ')
}

function wordWrap(text, width) {
  if (!text) return ''
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    lines.push(line)
  }
  return lines.join('\n')
}

const STEP_MAX_WIDTH = 200
const OUTER_TERMINAL_RATIO = 0.8

function printFlowPlan({ flow, steps, transport, branch, context }) {
  const teal = '#0d9488'
  const terminalWidth = process.stdout.columns || 100
  const outerMaxWidth = Math.max(60, Math.floor(terminalWidth * OUTER_TERMINAL_RATIO))
  const hasContext = context && context.trim()
  const flowDescriptionLines = flow.description
    ? wordWrap(flow.description, outerMaxWidth - 6).split('\n')
    : []
  const metaLines = [
    ...flowDescriptionLines,
    ...(flowDescriptionLines.length > 0 ? [''] : []),
    `Orchestrated from: ${transport === 'local' ? 'This machine' : 'GitHub Actions'}`,
    `Branch: ${branch}`,
    ...(hasContext ? ['Additional context: yes'] : []),
  ]
  const headings = steps.map((step, i) => `${i + 1}. ${step.title}`)
  const actionLabels = steps.map((step) => stepActionLabel(step, transport))
  const descriptions = steps.map((step) => resolveStepDescription(flow, step))
  const chipsWidth = (agents) =>
    agents.reduce((sum, a) => sum + titleCase(a).length + 4, 0) + Math.max(0, agents.length - 1)
  const naturalStepInner = Math.max(
    ...headings.map((h, i) => h.length + actionLabels[i].length + 2),
    ...descriptions.map((d) => d.length),
    ...steps.map((step) => chipsWidth(step.agents)),
  )
  const targetStepInner = Math.min(naturalStepInner, STEP_MAX_WIDTH - 6, outerMaxWidth - 12)
  const wrappedDescriptions = descriptions.map((d) => (d ? wordWrap(d, targetStepInner) : ''))
  const stepWidth = targetStepInner + 6
  const outerInnerNeeded = Math.max(...metaLines.map((l) => l.length), stepWidth)
  const outerWidth = Math.min(outerInnerNeeded + 6, outerMaxWidth)
  const arrowPad = ' '.repeat(Math.floor(stepWidth / 2) - 1)

  const stepBlocks = steps.map((step, i) => {
    const chips = makeHorizontalBoxes(
      step.agents.map((agent) => ({
        content: titleCase(agent),
        borderStyle: 'rounded',
        paddingLeft: 1,
        paddingRight: 1,
      })),
      { gap: 1 },
    )
    const content = wrappedDescriptions[i]
      ? `${wrappedDescriptions[i]}\n${chips}`
      : chips
    const box = makeBox({
      title: {
        left: headings[i],
        right: actionLabels[i],
      },
      content,
      borderStyle: 'rounded',
      borderColor: teal,
      width: stepWidth,
    })
    if (i === steps.length - 1) return box
    return `${box}\n${arrowPad}│\n${arrowPad}▼`
  }).join('\n')

  console.log('')
  console.log(makeBox({
    title: `Multi step agent workflow: "${flow.title}"`,
    content: `${metaLines.join('\n')}\n\n${stepBlocks}`,
    borderStyle: 'rounded',
    borderColor: teal,
    width: outerWidth,
  }))
  console.log('')
}

function finalRunForRunState(runState) {
  const completed = (runState.steps || []).filter((s) => s.status === 'completed' || s.status === 'dry-run')
  if (completed.length === 0) return null
  const lastStep = completed[completed.length - 1]
  const runs = (lastStep.runs || []).filter((r) => r.status === 'completed' || r.status === 'dry-run')
  if (runs.length === 0) return null
  return { step: lastStep, run: runs[runs.length - 1] }
}

function localAgentRunUrl({ projectRoot, runnerId }) {
  if (!runnerId) return ''
  try {
    const project = readNetlifyProject(projectRoot)
    if (project?.adminUrl) return `${project.adminUrl}/agents/${runnerId}`
  } catch (_err) {
    /* ignore */
  }
  return ''
}

function printSuccessBox({ flow, runState, transport, projectRoot }) {
  const green = '#22c55e'
  const final = finalRunForRunState(runState)
  if (!final) return
  const lines = [`Workflow "${flow.title}" complete.`, `Final step: ${final.step.title}`]
  if (transport === 'local') {
    const url = localAgentRunUrl({ projectRoot, runnerId: final.run.runnerId })
    if (url) {
      lines.push(`Final agent run: ${url}`)
    } else if (final.run.runnerId) {
      lines.push(`Final agent runner ID: ${final.run.runnerId}`)
    }
    if (final.run.deployUrl) lines.push(`Deploy: ${final.run.deployUrl}`)
    if (final.run.prUrl) lines.push(`PR: ${final.run.prUrl}`)
  } else {
    const url = final.run.commentUrl || final.run.issueUrl
    if (url) lines.push(`Final result: ${url}`)
  }
  const terminalWidth = process.stdout.columns || 100
  const outerMax = Math.max(60, Math.floor(terminalWidth * OUTER_TERMINAL_RATIO))
  const wrapped = lines.map((l) => wordWrap(l, outerMax - 6)).join('\n')
  const longest = Math.max(...wrapped.split('\n').map((l) => l.length))
  console.log('')
  console.log(makeBox({
    title: 'Success',
    content: wrapped,
    borderStyle: 'rounded',
    borderColor: green,
    width: Math.min(longest + 6, outerMax),
  }))
  console.log('')
}

async function prepareInteractiveFlowRun({ flow, options, transport, projectRoot }) {
  if (!process.stdin.isTTY || options.yes) {
    const selected = parseCsv(options.models)
    const configuredFlow = selected.length > 0 ? withSelectedAgents(flow, selected) : flow
    const steps = runnableSteps(configuredFlow, options)
    if (steps.length === 0) {
      throw new Error('No workflow steps have selected agents.')
    }
    return {
      flow: configuredFlow,
      options,
      steps,
    }
  }

  const clack = require('@clack/prompts')
  const agents = flowAgents(flow)
  let selectedAgents = parseCsv(options.models)
  if (selectedAgents.length === 0) {
    const selected = await clack.multiselect({
      message: 'Choose Netlify agent models',
      options: agents.map((agent) => ({
        value: agent,
        label: titleCase(agent),
      })),
      initialValues: agents,
      required: true,
    })
    if (clack.isCancel(selected)) process.exit(0)
    selectedAgents = selected
  }

  let manualContext = readManualContext(options)
  if (!manualContext && options.contextPrompt !== false) {
    manualContext = await multiline({
      message: 'Additional context/instructions (optional)',
      placeholder: 'Hit enter to proceed. Ok if this is empty.',
    })
  }

  const configuredOptions = {
    ...options,
    context: manualContext || options.context,
    models: selectedAgents.join(','),
  }
  const configuredFlow = withSelectedAgents(flow, selectedAgents)
  const steps = runnableSteps(configuredFlow, configuredOptions)
  if (steps.length === 0) {
    throw new Error('No workflow steps have selected agents.')
  }

  await confirmRemoteRunnerCanMissLocalChanges({
    projectRoot,
    branch: configuredOptions.branch,
    options: configuredOptions,
  })

  printFlowPlan({
    flow: configuredFlow,
    steps,
    transport,
    branch: configuredOptions.branch,
    context: manualContext,
  })

  const confirmed = await clack.confirm({
    message: 'Start this agent workflow?',
    initialValue: true,
  })
  if (clack.isCancel(confirmed)) process.exit(0)
  if (!confirmed) {
    console.log('Cancelled')
    process.exit(0)
  }

  return {
    flow: configuredFlow,
    options: configuredOptions,
    steps,
  }
}

function findStepRange(flow, options) {
  let steps = flow.steps
  if (options.step) {
    steps = steps.filter((step) => step.id === options.step)
    if (steps.length === 0) throw new Error(`Unknown step "${options.step}" in flow "${flow.id}"`)
  }
  if (options.fromStep) {
    const index = flow.steps.findIndex((step) => step.id === options.fromStep)
    if (index === -1) throw new Error(`Unknown from-step "${options.fromStep}" in flow "${flow.id}"`)
    steps = flow.steps.slice(index)
  }
  return steps
}

function issueNumbersFromStep(stepState) {
  return (stepState?.runs || [])
    .map((run) => run.issueNumber)
    .filter((number) => Number.isFinite(number))
}

function runsFromStep(stepState) {
  return Array.isArray(stepState?.runs) ? stepState.runs : []
}

function uniqueNumbers(numbers) {
  return [...new Set(numbers.filter((number) => Number.isFinite(number)))]
}

function sourceIssueNumbersForStep(step, completedStepStates) {
  if (!Array.isArray(step.input)) return []
  const numbers = []
  for (const input of step.input) {
    numbers.push(...issueNumbersFromStep(completedStepStates.get(input.step)))
  }
  return uniqueNumbers(numbers)
}

function sourceRunsForStep(step, completedStepStates) {
  if (!Array.isArray(step.input)) return []
  const runs = []
  for (const input of step.input) {
    const seen = new Set()
    for (const run of runsFromStep(completedStepStates.get(input.step))) {
      const key = run.runnerId || `${run.agent}:${run.stepId || input.step}:${runs.length}`
      if (seen.has(key)) continue
      seen.add(key)
      runs.push({ ...run, sourceStep: input.step })
    }
  }
  return runs
}

function formatLocalRunResults(runs) {
  const completed = runs.filter((run) => run.resultText && run.resultText.trim())
  if (completed.length === 0) return ''

  const parts = ['## Prior Agent Results']
  for (const run of completed) {
    const source = run.sourceStep ? ` from ${run.sourceStep}` : ''
    const title = `${titleCase(run.agent || 'agent')}${source}`
    parts.push(
      '',
      `<details>`,
      `<summary>${title}</summary>`,
      '',
      run.resultText.trim(),
      '',
      `</details>`,
    )
  }
  return parts.join('\n')
}

function buildLocalAgentPrompt({ model, prompt, context, roundResults }) {
  const summaryLabel = `${titleCase(prompt.name)} instructions`
  const parts = [
    `${titleCase(model)}: ${prompt.instruction}`.trim(),
    '',
    '<details>',
    `<summary>${summaryLabel}</summary>`,
    '',
    prompt.body,
    '',
    '</details>',
  ]

  if (roundResults && roundResults.trim()) {
    parts.push('', '---', '', roundResults.trim())
  }

  if (context && context.trim()) {
    parts.push('', '---', '', '## Additional Context', '', context.trim())
  }

  return parts.join('\n')
}

function completedStepMapFromRunState(runState) {
  const completed = new Map()
  for (const step of runState.steps || []) {
    if (step.status === 'completed' || step.status === 'dry-run') {
      completed.set(step.id, step)
    }
  }
  return completed
}

function firstRunnableStepIndex(flow, runState) {
  const byId = new Map((runState.steps || []).map((step) => [step.id, step]))
  for (let index = 0; index < flow.steps.length; index += 1) {
    const saved = byId.get(flow.steps[index].id)
    if (!saved || saved.status !== 'completed' && saved.status !== 'dry-run') return index
  }
  return flow.steps.length
}

function localStepStatus(stepState) {
  return stepState.runs.every((run) => run.status === 'completed' || run.status === 'dry-run')
    ? 'completed'
    : 'failed'
}

function shouldPollLocalRun(run) {
  if (!run.runnerId) return false
  if (run.status === 'dry-run') return false
  if (run.status === 'failed' || run.status === 'timeout') return false
  if (run.status === 'completed' && run.resultText) return false
  return true
}

function shouldPollGithubRun(run) {
  if (!run.issueNumber) return false
  if (run.status === 'dry-run') return false
  if (run.status === 'failed' || run.status === 'timeout') return false
  if (run.status === 'completed' && run.resultText) return false
  return true
}

function parseIssueNumberFromUrl(url) {
  const match = String(url || '').match(/\/issues\/(\d+)(?:#.*)?$/)
  return match ? Number(match[1]) : null
}

function makeProgressReporter(initialMessage) {
  if (!process.stdout.isTTY) {
    return {
      update: (message) => console.log(message),
      done: (message) => { if (message) console.log(message) },
      fail: (message) => { if (message) console.log(message) },
    }
  }
  const clack = require('@clack/prompts')
  const spinner = clack.spinner()
  spinner.start(initialMessage)
  return {
    update: (message) => spinner.message(message),
    done: (message) => spinner.stop(message || initialMessage),
    fail: (message) => spinner.stop(message || initialMessage, 1),
  }
}

function pickFlavor() {
  return flavorMessages[Math.floor(Math.random() * flavorMessages.length)]
}

function pickAgentLabel(agents) {
  if (!agents || agents.length === 0) return 'Agent'
  return titleCase(agents[Math.floor(Math.random() * agents.length)])
}

const DEFAULT_ORCHESTRATOR = "Netlify Agent runner"

function makeStepProgressReporter({
  stepTitle,
  total,
  agents = [],
  orchestrator = DEFAULT_ORCHESTRATOR,
  flavorMinMs = 10000,
  flavorMaxMs = 15000,
}) {
  if (!process.stdout.isTTY) {
    let lastCount = -1
    return {
      setCount: (n) => {
        if (n === lastCount) return
        lastCount = n
        console.log(`Waiting for ${stepTitle}: ${n}/${total} complete`)
      },
      message: (msg) => console.log(msg),
      done: (msg) => { if (msg) console.log(msg) },
      fail: (msg) => { if (msg) console.log(msg) },
    }
  }
  const clack = require('@clack/prompts')
  const spinner = clack.spinner()
  let count = 0
  const possessive = orchestrator ? `${orchestrator}'s ` : ''
  const render = () => {
    const [phrase, emoji] = pickFlavor()
    const agent = pickAgentLabel(agents)
    return `Waiting for ${stepTitle}: ${count}/${total} complete · ${emoji} ${possessive}${agent} ${phrase}`
  }
  spinner.start(render())
  let timer = null
  const scheduleNext = () => {
    const range = Math.max(0, flavorMaxMs - flavorMinMs)
    const delay = flavorMinMs + Math.floor(Math.random() * (range + 1))
    timer = setTimeout(() => {
      spinner.message(render())
      scheduleNext()
    }, delay)
  }
  scheduleNext()
  return {
    setCount: (n) => {
      count = n
      spinner.message(render())
    },
    message: (msg) => spinner.message(msg),
    done: (msg) => {
      if (timer) clearTimeout(timer)
      spinner.stop(msg || `${stepTitle}: ${total}/${total} complete`)
    },
    fail: (msg) => {
      if (timer) clearTimeout(timer)
      spinner.stop(msg || `Failed waiting for ${stepTitle}`, 1)
    },
  }
}

function commentsAfterGithubPrompt(result, run = {}) {
  const comments = Array.isArray(result?.comments) ? result.comments : []
  if (!run.commentUrl) return comments
  const promptIndex = comments.findIndex((comment) => comment.url === run.commentUrl)
  return promptIndex === -1 ? comments : comments.slice(promptIndex + 1)
}

function isGithubFailureResultBody(body) {
  return bodyHasRunnerResultMarker(body) && /\bAgent Run failed\b/i.test(body)
}

function githubResultRepliesForRun(result, run = {}) {
  return commentsAfterGithubPrompt(result, run).filter((comment) => {
    const body = comment?.body || ''
    return bodyHasRunnerResultMarker(body) && !isGithubFailureResultBody(body)
  })
}

function githubFailureCommentsForRun(result, run = {}) {
  return commentsAfterGithubPrompt(result, run).filter((comment) => {
    const body = String(comment?.body || '')
    return isGithubFailureResultBody(body) || (bodyHasRunnerStatusMarker(body) && /\bNetlify Agent Run failed\b/i.test(body))
  })
}

function resultsScopedToGithubRuns(results, runs = []) {
  if (!Array.isArray(runs) || runs.length === 0) return results
  return results.map((result) => {
    const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber)
    if (!run) return result
    return {
      ...result,
      replies: githubResultRepliesForRun(result, run),
    }
  })
}

function findGithubRunnerFailures(results, runs = []) {
  const failures = []
  for (const result of results || []) {
    const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
    if (githubResultRepliesForRun(result, run).length > 0) continue
    for (const comment of githubFailureCommentsForRun(result, run)) {
      const body = String(comment?.body || '')
      const summary = body.match(/\*\*Failure summary:\*\*\s*([^\n]+)/i)?.[1]?.trim() || 'Agent run failed'
      failures.push({
        issueNumber: result.issueNumber,
        issueTitle: result.issueTitle,
        url: comment.url || result.issueUrl || '',
        summary,
      })
    }
  }
  return failures
}

async function waitForGithubStep({ repo, issueNumbers = [], runs = [], step, timeoutMinutes }) {
  const numbers = issueNumbers.length > 0
    ? issueNumbers
    : runs.map((run) => run.issueNumber).filter((number) => Number.isFinite(number))
  if (!numbers.length) return []
  const deadline = Date.now() + timeoutMinutes * 60 * 1000
  const pollMs = 15000
  const reporter = makeStepProgressReporter({
    stepTitle: step.title,
    total: numbers.length,
    agents: step.agents || [],
  })
  let settled = false

  try {
    while (Date.now() < deadline) {
      const results = fetchRoundResults({
        repo,
        issueNumbers: numbers,
        embedAll: true,
        requireResultMarker: true,
      })
      const scopedResults = resultsScopedToGithubRuns(results, runs)
      const completeCount = scopedResults.filter((r) => (r.replies || []).length > 0).length
      reporter.setCount(completeCount)
      const failures = findGithubRunnerFailures(results, runs)
      if (failures.length > 0) {
        const detail = failures
          .map((failure) => `#${failure.issueNumber} ${failure.issueTitle}: ${failure.summary}${failure.url ? ` (${failure.url})` : ''}`)
          .join('\n')
        reporter.fail(`${step.title}: ${completeCount}/${scopedResults.length} complete, ${failures.length} failed`)
        settled = true
        throw new Error(`Step "${step.id}" has failed agent runs:\n${detail}`)
      }
      if (completeCount === scopedResults.length) {
        reporter.done(`${step.title}: ${completeCount}/${scopedResults.length} complete`)
        settled = true
        return scopedResults
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    reporter.fail(`Timed out waiting for ${step.title}`)
    settled = true
    throw new Error(`Timed out waiting for step "${step.id}" after ${timeoutMinutes} minutes`)
  } finally {
    if (!settled) reporter.fail(`Failed waiting for ${step.title}`)
  }
}

function githubStepStatus(stepState) {
  return stepState.runs.every((run) => run.status === 'completed' || run.status === 'dry-run')
    ? 'completed'
    : 'submitted'
}

async function completeGithubStep({ repo, stepState, step, options }) {
  const timeoutMinutes = Number.parseInt(options.timeoutMinutes || '25', 10)
  if (step.waitFor !== WAIT_FOR_AGENT_RESULTS) {
    stepState.status = 'completed'
    return stepState
  }

  if (stepState.runs.some(shouldPollGithubRun)) {
    const issueNumbers = stepState.runs.map((run) => run.issueNumber).filter((number) => Number.isFinite(number))
    const results = await waitForGithubStep({
      repo,
      issueNumbers,
      runs: stepState.runs,
      step,
      timeoutMinutes,
    })
    for (const run of stepState.runs) {
      const result = results.find((item) => item.issueNumber === run.issueNumber)
      const replies = result?.replies || []
      const latest = replies[replies.length - 1]
      run.status = latest ? 'completed' : 'timeout'
      run.resultText = latest?.body || ''
      run.commentUrl = latest?.url || run.commentUrl
      run.rawResult = result || null
    }
  }

  stepState.status = githubStepStatus(stepState)
  return stepState
}

async function executeGithubFlow({ flow, steps, options, runState, completedStepStates = new Map() }) {
  const repo = resolveRepo(options.repo)
  const date = options.date || getLocalDate()
  const baseContext = contextForRunState(runState, options)

  for (const step of steps) {
    const prompt = loadStepPrompt(flow, step)
    const stepState = {
      id: step.id,
      title: step.title,
      action: step.action,
      agents: step.agents,
      status: 'running',
      runs: [],
    }
    runState.steps.push(stepState)
    saveRunState(runState)

    const sourceIssues = sourceIssueNumbersForStep(step, completedStepStates).join(',')
    const recoveryIssues = step.action === 'comment' ? (options.fromIssues || options.fromIssue || options.issues || options.issue || '') : ''
    const fromIssues = sourceIssues || recoveryIssues
    const targetIssues = step.action === 'comment' ? fromIssues : ''
    const stepOptions = {
      ...options,
      repo,
      date,
      models: step.agents.join(','),
      issues: targetIssues || options.issues,
      issue: targetIssues || options.issue,
      fromIssues,
      fromIssue: fromIssues,
      yes: true,
      fetchResults: fromIssues ? options.fetchResults : false,
    }
    const roundResultsRaw = fetchRoundResultsForOptions(stepOptions, {
      embedAll: shouldEmbedAllReplies(prompt.name),
    })
    const input = {
      promptName: prompt.name,
      prompt,
      options: stepOptions,
      context: baseContext,
      roundResultsRaw,
    }
    const plan = buildAndMaybeFallbackPlan(
      input,
      step.action === 'comment' ? buildCommentPlan : buildPlan,
    )

    if (step.action === 'comment') {
      printCommentPlan(plan, { dryRun: options.dryRun })
    } else {
      printPlan(plan, { dryRun: options.dryRun })
    }

    if (options.dryRun) {
      stepState.status = 'dry-run'
      stepState.runs = (plan.issues || []).map((issue) => ({
        transport: 'github',
        agent: issue.model,
        status: 'dry-run',
        promptText: issue.body,
        resultText: '',
        raw: issue,
      }))
      completedStepStates.set(step.id, stepState)
      saveRunState(runState)
      continue
    }

    if (step.action === 'comment') {
      for (const issue of plan.issues) {
        const url = createDiscussionComment({
          repo: issue.targetRepo,
          targetKind: issue.targetKind,
          targetNumber: issue.targetNumber,
          body: issue.body,
        })
        const issueNumber = Number(issue.issueNumber)
        stepState.runs.push({
          transport: 'github',
          agent: issue.model,
          status: 'submitted',
          promptText: issue.body,
          resultText: '',
          issueNumber,
          issueUrl: issue.issueUrl,
          commentUrl: url,
          prUrl: issue.targetKind === 'pr' ? issue.targetUrl : '',
          raw: issue,
        })
        saveRunState(runState)
        console.log(`#${issue.issueNumber} ${issue.issueTitle}: ${url}`)
      }
    } else {
      for (const issue of plan.issues) {
        const url = createIssue({
          repo: plan.repo,
          title: issue.title,
          body: issue.body,
          labels: plan.labels,
        })
        const issueNumber = parseIssueNumberFromUrl(url)
        stepState.runs.push({
          transport: 'github',
          agent: issue.model,
          status: 'submitted',
          promptText: issue.body,
          resultText: '',
          issueNumber,
          issueUrl: url,
          commentUrl: '',
          prUrl: '',
          raw: issue,
        })
        saveRunState(runState)
        console.log(`${issue.title}: ${url}`)
      }
    }

    await completeGithubStep({ repo, stepState, step, options })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
  }
}

async function completeLocalStep({ stepState, step, options, projectRoot, netlify, initialDelayMs }) {
  const timeoutMinutes = Number.parseInt(options.timeoutMinutes || '25', 10)
  if (step.waitFor === WAIT_FOR_AGENT_RESULTS && stepState.runs.some(shouldPollLocalRun)) {
    const reporter = makeStepProgressReporter({
      stepTitle: step.title,
      total: stepState.runs.length,
      agents: step.agents || [],
    })
    let settled = false
    try {
      const terminalRunners = new Set()
      const completedRuns = await waitForLocalAgentRuns({
        projectRoot,
        runs: stepState.runs,
        siteId: netlify.siteId,
        env: netlify.env,
        timeoutMinutes,
        initialDelayMs,
        onProgress: (event) => {
          if (event.run?.runnerId && /^(completed|done|failed|error|cancelled|canceled|timeout)$/i.test(event.state || '')) {
            terminalRunners.add(event.run.runnerId)
            reporter.setCount(terminalRunners.size)
          }
        },
      })
      stepState.runs = completedRuns
      const doneCount = completedRuns.filter((r) => r.status === 'completed').length
      const failedCount = completedRuns.filter((r) => r.status === 'failed' || r.status === 'timeout').length
      if (failedCount > 0) {
        reporter.fail(`${step.title}: ${doneCount}/${completedRuns.length} complete, ${failedCount} failed`)
      } else {
        reporter.done(`${step.title}: ${doneCount}/${completedRuns.length} complete`)
      }
      settled = true
    } finally {
      if (!settled) reporter.fail(`Failed waiting for ${step.title}`)
    }
  }
  stepState.status = localStepStatus(stepState)
  return stepState
}

async function executeLocalFlow({ flow, steps, options, runState, projectRoot, completedStepStates = new Map() }) {
  const date = options.date || getLocalDate()
  const baseContext = contextForRunState(runState, options)
  const branch = options.branch || currentGitBranch(projectRoot)
  const netlify = buildNetlifyEnv({ projectRoot })

  for (const step of steps) {
    const prompt = loadStepPrompt(flow, step)
    const stepState = {
      id: step.id,
      title: step.title,
      action: step.action,
      agents: step.agents,
      status: 'running',
      runs: [],
    }
    runState.steps.push(stepState)
    saveRunState(runState)

    const sourceRuns = sourceRunsForStep(step, completedStepStates)
    const roundResults = formatLocalRunResults(sourceRuns)
    const runs = step.agents.map((agent) => {
      const followUpRun = step.submit === 'follow-up'
        ? sourceRuns.find((sourceRun) => sourceRun.agent === agent && sourceRun.runnerId)
        : null
      const promptText = buildLocalAgentPrompt({
        model: agent,
        prompt,
        context: baseContext,
        roundResults,
        date,
      })
      return {
        transport: 'local',
        agent,
        status: options.dryRun ? 'dry-run' : 'pending',
        promptText,
        resultText: '',
        runnerId: '',
        issueUrl: '',
        commentUrl: '',
        prUrl: '',
        deployUrl: '',
        existingRunnerId: followUpRun?.runnerId || '',
        raw: {
          stepId: step.id,
          promptName: prompt.name,
        },
      }
    })

    console.log(`\nRun local agents: ${step.title}`)
    for (const run of runs) {
      console.log(`\n- ${titleCase(run.agent)} ${prompt.title}`)
      console.log(`  prompt: ${prompt.name}`)
      console.log(`  body: ${run.promptText.length} chars`)
    }

    if (options.dryRun) {
      stepState.status = 'dry-run'
      stepState.runs = runs
      completedStepStates.set(step.id, stepState)
      saveRunState(runState)
      continue
    }

    stepState.runs = runs
    saveRunState(runState)

    console.log(`\nSubmitting ${runs.length} Netlify agent ${runs.length === 1 ? 'run' : 'runs'} in parallel...`)
    const startedAt = Date.now()
    const submissions = await Promise.allSettled(runs.map(async (run, index) => {
      const label = `${titleCase(run.agent)} ${prompt.title}`
      console.log(`\n- ${label}: submitting${run.existingRunnerId ? ' follow-up' : ''}...`)
      try {
        const submitted = await submitLocalAgentRun({
          run,
          projectRoot,
          branch,
          siteId: netlify.siteId,
          env: netlify.env,
        })
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
        stepState.runs[index] = submitted
        saveRunState(runState)
        console.log(`  ${label}: ${submitted.runnerId}${submitted.existingRunnerId ? ' (follow-up)' : ''} after ${elapsedSeconds}s`)
        return submitted
      } catch (error) {
        const failedRun = {
          ...run,
          status: 'failed',
          resultText: error?.message || String(error || 'Submission failed'),
          raw: {
            ...run.raw,
            submissionError: error?.message || String(error || 'Submission failed'),
          },
        }
        stepState.runs[index] = failedRun
        saveRunState(runState)
        console.log(`  ${label}: submission failed`)
        throw error
      }
    }))
    const failedSubmission = submissions.find((result) => result.status === 'rejected')
    const submittedRuns = submissions.map((result, index) => {
      if (result.status === 'fulfilled') return result.value
      return stepState.runs[index]
    })
    stepState.runs = submittedRuns
    saveRunState(runState)
    if (failedSubmission) {
      throw failedSubmission.reason
    }

    await completeLocalStep({ stepState, step, options, projectRoot, netlify })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)

    if (stepState.status !== 'completed' && stepState.status !== 'dry-run') {
      throw new Error(`Local step "${step.id}" did not complete successfully.`)
    }
  }
}

async function resumeLocalFlow({ flow, runState, projectRoot }) {
  trackRunState(runState)
  const options = runState.options || {}
  const netlify = buildNetlifyEnv({ projectRoot })
  const completedStepStates = completedStepMapFromRunState(runState)
  const startIndex = firstRunnableStepIndex(flow, runState)
  if (startIndex >= flow.steps.length) {
    console.log(`Run ${runState.runId} is already complete.`)
    clearTrackedRunState(runState, { completed: true })
    return
  }

  const step = flow.steps[startIndex]
  const stepState = (runState.steps || []).find((candidate) => candidate.id === step.id)
  if (stepState && stepState.runs?.some(shouldPollLocalRun)) {
    console.log(`Resuming ${runState.runId}`)
    console.log(`Flow: ${flow.title}`)
    console.log(`State: ${path.join(runState.dir, 'run.json')}`)
    console.log(`Repair and continue: ${step.title}`)
    await completeLocalStep({ stepState, step, options, projectRoot, netlify, initialDelayMs: 0 })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
    if (stepState.status !== 'completed' && stepState.status !== 'dry-run') {
      throw new Error(`Local step "${step.id}" did not complete successfully.`)
    }
    await executeLocalFlow({
      flow,
      steps: flow.steps.slice(startIndex + 1),
      options,
      runState,
      projectRoot,
      completedStepStates,
    })
    clearTrackedRunState(runState, { completed: true })
    return
  }

  await executeLocalFlow({
    flow,
    steps: flow.steps.slice(startIndex),
    options,
    runState,
    projectRoot,
    completedStepStates,
  })
  clearTrackedRunState(runState, { completed: true })
}

async function resumeGithubFlow({ flow, runState }) {
  trackRunState(runState)
  const options = runState.options || {}
  const repo = resolveRepo(options.repo)
  const completedStepStates = completedStepMapFromRunState(runState)
  const startIndex = firstRunnableStepIndex(flow, runState)
  if (startIndex >= flow.steps.length) {
    console.log(`Run ${runState.runId} is already complete.`)
    clearTrackedRunState(runState, { completed: true })
    return
  }

  const step = flow.steps[startIndex]
  const stepState = (runState.steps || []).find((candidate) => candidate.id === step.id)
  if (stepState && stepState.runs?.some(shouldPollGithubRun)) {
    console.log(`Resuming ${runState.runId}`)
    console.log(`Flow: ${flow.title}`)
    console.log(`State: ${path.join(runState.dir, 'run.json')}`)
    console.log(`Repair and continue: ${step.title}`)
    await completeGithubStep({ repo, stepState, step, options })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
    if (stepState.status !== 'completed' && stepState.status !== 'dry-run') {
      throw new Error(`GitHub step "${step.id}" did not complete successfully.`)
    }
    await executeGithubFlow({
      flow,
      steps: flow.steps.slice(startIndex + 1),
      options,
      runState,
      completedStepStates,
    })
    clearTrackedRunState(runState, { completed: true })
    return
  }

  await executeGithubFlow({
    flow,
    steps: flow.steps.slice(startIndex),
    options,
    runState,
    completedStepStates,
  })
  clearTrackedRunState(runState, { completed: true })
}

async function handleRun(flowId, options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const resolvedFlowId = flowId || (process.stdin.isTTY ? await pickFlowInteractively() : 'review')
  const flow = await loadFlow(resolvedFlowId)

  const resumable = findLatestUnfinishedRun(projectRoot, { flowId: flow.id })
  if (resumable && process.stdin.isTTY && !options.yes && !options.dryRun) {
    const clack = require('@clack/prompts')
    const selected = await clack.confirm({
      message: `Found unfinished ${resumable.transport || 'workflow'} run ${resumable.runId}. Resume and complete it?`,
      initialValue: true,
    })
    if (clack.isCancel(selected)) process.exit(0)
    if (selected) {
      if (resumable.transport === 'github') {
        await resumeGithubFlow({ flow, runState: resumable })
      } else {
        await resumeLocalFlow({ flow, runState: resumable, projectRoot })
      }
      return
    }
    dismissRunState(resumable)
    console.log(`Dismissed unfinished run ${resumable.runId}`)
  }

  const flowOptions = await collectFlowOptions(flow, options)
  const detections = detectTransports({ projectRoot })
  const requestedTransport = flowOptions.transport || flow.defaults.transport
  if ((requestedTransport === 'auto' || !requestedTransport) && detections.every((candidate) => !candidate.available)) {
    throw new Error(formatTransportSetupHelp(detections))
  }
  const transport = process.stdin.isTTY
    ? await chooseTransportInteractively({ requested: requestedTransport, projectRoot })
    : resolveTransport(requestedTransport, detections)
  const selectedDetection = detections.find((candidate) => candidate.id === transport)
  if (!selectedDetection?.available) {
    throw new Error(
      [
        `Transport "${transport}" is not available: ${selectedDetection?.reason || 'unknown reason'}`,
        '',
        formatTransportSetupHelp(detections),
      ].join('\n'),
    )
  }

  const resolvedBranch = resolveWorkflowBranch({ options: flowOptions, projectRoot })
  const branchOptions = {
    ...flowOptions,
    branch: resolvedBranch.branch,
    branchSource: resolvedBranch.source,
  }

  const prepared = await prepareInteractiveFlowRun({ flow, options: branchOptions, transport, projectRoot })
  const configuredFlow = prepared.flow
  const configuredOptions = prepared.options
  const steps = prepared.steps
  const runContext = buildFlowRunContext({ options: configuredOptions, projectRoot, transport })

  const runState = createRunState({
    projectRoot,
    flow: configuredFlow,
    transport,
    options: {
      ...configuredOptions,
      projectRoot,
    },
  })
  trackRunState(runState)
  runState.context = runContext
  runState.branch = configuredOptions.branch
  runState.branchSource = configuredOptions.branchSource
  saveRunState(runState)
  console.log(`Run ${runState.runId}`)
  console.log(`Flow: ${configuredFlow.title}`)
  console.log(`Transport: ${transport}`)
  console.log(`Branch: ${configuredOptions.branch}`)
  console.log(`State: ${path.join(runState.dir, 'run.json')}`)

  if (transport === 'local') {
    await executeLocalFlow({ flow: configuredFlow, steps, options: configuredOptions, runState, projectRoot })
  } else {
    await executeGithubFlow({ flow: configuredFlow, steps, options: configuredOptions, runState })
  }

  clearTrackedRunState(runState, { completed: true })
  printSuccessBox({ flow: configuredFlow, runState, transport, projectRoot })

  if (configuredOptions.notify) {
    if (process.platform === 'darwin') {
      spawnSync('osascript', ['-e', `display notification "Flow ${configuredFlow.title} finished" with title "nax"`])
    } else {
      console.log(`--notify is only supported on macOS; skipping desktop notification.`)
    }
  }
}

function printInitResult(result, { dryRun = false } = {}) {
  const prefix = dryRun ? 'Would initialize' : 'Initialized'
  console.log(`${prefix}: ${result.projectRoot}`)
  if (result.repo) console.log(`GitHub repo: ${result.repo}`)
  if (result.netlify.siteId) {
    console.log(`Netlify site ID: ${result.netlify.siteId}`)
  } else if (result.netlify.siteName) {
    console.log(`Netlify project: ${result.netlify.siteName}`)
  }
  if (result.netlify.siteName && result.netlify.siteId) console.log(`Netlify project: ${result.netlify.siteName}`)
  if (result.netlify.siteUrl) console.log(`Netlify URL: ${result.netlify.siteUrl}`)
  if (result.netlify.adminUrl) console.log(`Netlify admin: ${result.netlify.adminUrl}`)
  if (result.netlify.accountName || result.netlify.accountEmail) {
    const account = [result.netlify.accountName, result.netlify.accountEmail && `<${result.netlify.accountEmail}>`].filter(Boolean).join(' ')
    console.log(`Netlify account: ${account}`)
  }
  console.log(`Netlify link: ${result.netlify.status}`)
  console.log(`GitHub Actions: ${result.githubActions ? 'enabled' : 'skipped'}`)
  if (result.workflow) {
    console.log(`Workflow: ${path.relative(result.projectRoot, result.workflow.path)} (${result.workflow.status})`)
  }
  for (const secret of result.secrets) {
    console.log(`Secret: ${secret.name} (${secret.status})`)
  }
}

async function shouldEnableGithubActions(options) {
  if (options.githubActions === true) return true
  if (options.githubActions === false) return false
  if (!process.stdin.isTTY || options.yes) return true
  const clack = require('@clack/prompts')
  const selected = await clack.confirm({
    message: 'Enable GitHub Actions for this workflow?',
    initialValue: true,
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected === true
}

async function handleInit(options) {
  const site = initSite({
    projectRoot: options.projectRoot || process.cwd(),
    repo: options.repo,
    siteId: options.siteId,
    siteName: options.siteName,
    create: options.create === true,
    dryRun: options.dryRun === true,
  })
  const githubActions = await shouldEnableGithubActions(options)
  if (!githubActions) {
    printInitResult(site, { dryRun: options.dryRun })
    return
  }

  const result = enableGitHubActionsSetup({
    projectRoot: site.projectRoot,
    repo: options.repo,
    netlify: site.netlify,
    siteId: options.siteId,
    force: options.force === true || options.yes === true,
    dryRun: options.dryRun === true,
    skipSecrets: options.skipSecrets === true,
  })
  printInitResult(result, { dryRun: options.dryRun })
}

function buildProgram() {
  const program = new Command()

  program
    .name('nax')
    .description('Run multi step Netlify agent workflows using the worlds leading AI models')
    .argument('[workflow]', 'Workflow to run, e.g. review')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--where <place>', 'Where to run: auto, github-actions, local-machine', 'auto')
    .option('--dry', 'Preview the workflow without creating issues/comments')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Skip confirmation prompts')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--notify', 'Show a desktop notification when the flow finishes')
    .action((workflow, options, command) => {
      const resolvedOptions = actionOptions(options, command)
      return handleRun(workflow || null, resolvedOptions)
    })

  program
    .command('init')
    .description('Set up this repository for nax workflows')
    .option('--project-root <path>', 'Project root to initialize')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--site-id <id>', 'Link this directory to an existing Netlify site ID')
    .option('--site-name <name>', 'Link to or create a Netlify project by name')
    .option('--create', 'Create a new Netlify project if this directory is not linked')
    .option('--dry', 'Preview setup without writing files or secrets')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Overwrite an existing non-nax workflow file')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--github-actions', 'Enable GitHub Actions transport setup')
    .option('--no-github-actions', 'Only set up/link the Netlify site')
    .option('--skip-secrets', 'Create/link project and workflow without setting GitHub secrets')
    .action((options, command) => handleInit(actionOptions(options, command)))

  program
    .command('run [flow]')
    .description('Run a multi-step workflow')
    .option('--where <place>', 'Where to run: auto, github-actions, local-machine', 'auto')
    .option('--project-root <path>', 'Project root for flow execution')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--context <text>', 'Additional context appended to each prompt')
    .option('--context-file <path>', 'Read additional context from a file')
    .option('--sha <rev>', 'Override the pinned git revision injected into the review context')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--label <list>', 'Comma-separated labels to add')
    .option('--labels <list>', 'Alias for --label')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--date <yyyy-mm-dd>', 'Issue title date prefix; defaults to local date')
    .option('--step <id>', 'Run only one flow step')
    .option('--from-step <id>', 'Run from a flow step through the end')
    .option('--issue <list>', 'Recovery: comma-separated issue numbers for comment steps')
    .option('--issues <list>', 'Alias for --issue')
    .option('--from-issues <list>', 'Recovery: comma-separated source issue numbers to embed for comment steps')
    .option('--from-issue <list>', 'Alias for --from-issues')
    .option('--timeout-minutes <count>', 'Minutes to wait for each step to complete', '25')
    .option('--dry', 'Preview the workflow without creating issues/comments')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Skip confirmation prompts')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--notify', 'Show a desktop notification when the flow finishes')
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-fetch-results', 'Do not fetch round results from prior steps')
    .action((flow, options, command) => handleRun(flow, actionOptions(options, command)))

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
    .option('--sha <rev>', 'Override the pinned git revision injected into the review context')
    .option('--repo-root <path>', 'Repository root used to compute the pinned SHA and working tree snapshot')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--label <list>', 'Comma-separated labels to add')
    .option('--labels <list>', 'Alias for --label')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--dry', 'Print issues without creating them')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Skip confirmation')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
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
    .option('--sha <rev>', 'Override the pinned git revision injected into the review context')
    .option('--repo-root <path>', 'Repository root used to compute the pinned SHA and working tree snapshot')
    .option('--pr-limit <count>', 'Maximum number of open PRs to include in the merge-state ledger', '10')
    .option('--runner <mention>', 'Agent runner mention (default: @netlify)')
    .option('--dry', 'Print comments without creating them')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .option('--force', 'Skip confirmation')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--no-auto-context', 'Do not inject the automatic review contract, pinned SHA snapshot, or PR ledger')
    .option('--no-context-prompt', 'Do not ask for free-form context in interactive mode')
    .option('--no-fetch-results', 'Do not fetch round results from --from-issues')
    .action((prompt, options, command) => handleComment(prompt, mergeCommandOptions(command, options)))

  program
    .command('list')
    .description('List available workflows')
    .action(handleList)

  program
    .command('recent')
    .description('Pick a recent run and reprint its final success box')
    .option('--run-id <id>', 'Skip the picker and re-render a specific run id')
    .option('--limit <n>', 'Maximum runs to show in the picker', '25')
    .action((options, command) => handleRecent(actionOptions(options, command)))

  program
    .command('preview-boxes [flow]')
    .description('Preview the flow plan and success boxes without running the workflow')
    .option('--transport <transport>', 'Transport to render (github|local)', 'github')
    .option('--branch <branch>', 'Branch label to display', 'master')
    .option('--context <context>', 'Additional context indicator', '')
    .action((flow, options, command) => handlePreviewBoxes(flow, actionOptions(options, command)))

  program
    .command('preview-spinner')
    .description('Preview the wait-for-step progress reporter without running a workflow')
    .option('--count <n>', 'How many agent results to simulate', '3')
    .option('--tick-ms <ms>', 'Delay between simulated completions', '10000')
    .option('--flavor-min-ms <ms>', 'Minimum delay between flavor rotations', '10000')
    .option('--flavor-max-ms <ms>', 'Maximum delay between flavor rotations', '15000')
    .option('--label <label>', 'Step title to display', 'Review')
    .option('--agents <list>', 'Comma-separated agent names', 'claude,gemini,codex')
    .option('--orchestrator <name>', 'Orchestrator label prefixed to agent', DEFAULT_ORCHESTRATOR)
    .action((options, command) => handlePreviewSpinner(actionOptions(options, command)))

  for (const hiddenCommandName of ['issue', 'comment', 'preview-boxes', 'preview-spinner']) {
    const command = program.commands.find((candidate) => candidate.name() === hiddenCommandName)
    if (command) command._hidden = true
  }

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
  _private: {
    completedStepMapFromRunState,
    firstRunnableStepIndex,
    flowAgents,
    findGithubRunnerFailures,
    resultsScopedToGithubRuns,
    runnableSteps,
    sourceIssueNumbersForStep,
    sourceRunsForStep,
    withSelectedAgents,
    uniqueNumbers,
  },
}
