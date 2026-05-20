#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
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
const { bodyHasRunnerResultMarker, bodyHasRunnerStatusMarker, parseRunnerResultMarker } = require('../lib/comment-markers')
const {
  formatAgentRunUrl,
  formatAgentRunUrlFromAdminUrl,
  formatUsageSummary,
  normalizeGithubRunResult,
  usageSummariesForRunState,
} = require('../lib/agent-run-results')
const { runGh } = require('../lib/gh-cli')
const { multiline } = require('../lib/multiline')
const { WAIT_FOR_AGENT_RESULTS, listFlows, loadFlow, loadStepPrompt } = require('../lib/flows')
const { createRunState, dismissRunState, findLatestUnfinishedRun, listRunStates, saveRunState } = require('../lib/run-state')
const {
  artifactsRootForRunState,
  persistRunArtifact,
  persistStepArtifacts,
  persistWorkflowArtifacts,
  writeGithubStepSummary,
} = require('../lib/workflow-artifacts')
const { clearTrackedRunState, trackRunState } = require('../lib/graceful-run-state')
const {
  PROVIDER_DIRS,
  checkSkills,
  installSkills,
  listBundledSkills,
  updateSkills,
} = require('../lib/skills')
const { NETLIFY_API_TRANSPORT, detectTransports, formatTransportSetupHelp, isNetlifyApiTransport, resolveTransport } = require('../lib/transports')
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
const COMPACT_LOCAL_RESULT_CHAR_LIMIT = 6000
const COMPACT_LOCAL_RESULTS_TOTAL_LIMIT = 36000
const COMPACT_LOCAL_CONTEXT_CHAR_LIMIT = 12000

function parseCsv(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function collectOption(value, previous) {
  return [...(Array.isArray(previous) ? previous : []), value]
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
  if (!isNetlifyApiTransport(transport) && transport !== 'github') return options
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

    const result = runGh(args, { errorPrefix: `gh issue create failed for "${title}"` })
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

    const result = runGh(args, { errorPrefix: `gh issue comment failed for issue #${issueNumber}` })
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

    const result = runGh(args, { errorPrefix: `gh pr comment failed for PR #${prNumber}` })
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

async function promptForOptionalHandoffInstructions() {
  const value = await multiline({
    message: 'Additional instructions for the next agent run',
    placeholder: 'Hit enter to just pass the workflow summary.',
  })
  return String(value || '').trim()
}

async function runFreshHandoffAgent({ projectRoot, agent, promptText, summaryDisplayPath, options = {} }) {
  const branch = options.branch || currentGitBranch(projectRoot)
  const netlify = buildNetlifyEnv({ projectRoot })
  const run = {
    transport: NETLIFY_API_TRANSPORT,
    agent,
    status: 'pending',
    promptText,
    compactPromptText: '',
    resultText: '',
    runnerId: '',
    issueUrl: '',
    commentUrl: '',
    prUrl: '',
    deployUrl: '',
    raw: {
      stepId: 'handoff',
      promptName: 'handoff',
      summaryPath: summaryDisplayPath,
    },
  }

  console.log(`Including prior workflow summary:\n${summaryDisplayPath}`)
  console.log(`\nStarting ${titleCase(agent)} handoff run...`)
  const startedAt = Date.now()
  const submitted = await submitLocalAgentRun({
    run,
    projectRoot,
    branch,
    siteId: netlify.siteId,
    env: netlify.env,
    onRetry: ({ error, nextAttempt, attempts, delayMs }) => {
      const delaySeconds = Math.round(delayMs / 1000)
      console.log(`Submission failed, retrying ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
    },
  })
  submitted.submittedAfterSeconds = Math.round((Date.now() - startedAt) / 1000)
  addLocalRunLinks(submitted, projectRoot)
  const boxes = formatSubmittedLocalRunBoxes({
    runs: [submitted],
    prompt: { title: 'Handoff' },
    projectRoot,
  })
  if (boxes) {
    console.log('\nSubmitted Netlify agent run:')
    console.log(boxes)
  }

  const reporter = makeStepProgressReporter({
    stepTitle: 'Handoff',
    total: 1,
    agents: [agent],
  })
  let settled = false
  try {
    const [completed] = await waitForLocalAgentRuns({
      projectRoot,
      runs: [submitted],
      siteId: netlify.siteId,
      env: netlify.env,
      timeoutMinutes: Number.parseInt(options.timeoutMinutes || '25', 10),
      initialDelayMs: 0,
      onProgress: (event) => {
        if (!event.run?.runnerId) return
        reporter.updateRun(event)
      },
      onTerminalRun: (terminalRun) => {
        addLocalRunLinks(terminalRun, projectRoot)
      },
    })
    addLocalRunLinks(completed, projectRoot)
    reporter.updateRun({
      run: completed,
      state: completed.status,
      terminal: true,
      terminalSuccess: completed.status === 'completed',
      terminalFailure: completed.status !== 'completed',
    })
    if (completed.status === 'completed') {
      reporter.done(`Handoff: ${titleCase(agent)} complete`)
    } else {
      reporter.fail(`Handoff: ${titleCase(agent)} ${completed.status}`)
      throw new Error(`Handoff run did not complete successfully.`)
    }
    settled = true
    const url = completed.links?.sessionUrl || completed.links?.agentRunUrl || ''
    if (url) console.log(`Result: ${url}`)
  } finally {
    if (!settled) reporter.fail('Handoff failed')
  }
}

async function handleHandoff(runId, options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const handoff = readHandoffSummary({ projectRoot, runId: runId || options.runId || '' })

  if (options.copy) {
    const command = copyToClipboard(handoff.summaryText)
    console.log(`\nCopied ${handoff.displayPath} to clipboard with ${command}.`)
    return
  }

  if (options.agent || options.flow) {
    const promptText = buildHandoffPrompt({
      instructions: options.context || '',
      summaryPath: handoff.displayPath,
      summaryText: handoff.summaryText,
    })
    if (options.agent) {
      await runFreshHandoffAgent({
        projectRoot,
        agent: options.agent,
        promptText,
        summaryDisplayPath: handoff.displayPath,
        options,
      })
      return
    }
    console.log(`Including prior workflow summary:\n${handoff.displayPath}`)
    await handleRun(options.flow, {
      ...options,
      projectRoot,
      context: promptText,
    })
    return
  }

  if (!process.stdin.isTTY) {
    console.log(`Summary: ${handoff.displayPath}`)
    console.log('Run `nax handoff` in a TTY to copy it or start another agent run.')
    return
  }

  const clack = require('@clack/prompts')
  const action = await clack.select({
    message: 'Hand off workflow results',
    options: [
      { value: 'copy', label: 'Copy previous AI workflow results to clipboard', hint: handoff.displayPath },
      { value: 'start', label: 'Start a new AI workflow run with previous results' },
      { value: 'cancel', label: 'Cancel' },
    ],
  })
  if (clack.isCancel(action) || action === 'cancel') return
  if (action === 'copy') {
    const command = copyToClipboard(handoff.summaryText)
    console.log(`\nCopied ${handoff.displayPath} to clipboard with ${command}.`)
    return
  }

  const mode = await clack.select({
    message: 'What should happen next?',
    options: [
      { value: 'fresh', label: 'Start a fresh agent run' },
      { value: 'workflow', label: 'Run another workflow with this summary as input' },
    ],
  })
  if (clack.isCancel(mode)) return

  const instructions = await promptForOptionalHandoffInstructions()
  const promptText = buildHandoffPrompt({
    instructions,
    summaryPath: handoff.displayPath,
    summaryText: handoff.summaryText,
  })

  if (mode === 'fresh') {
    const agent = options.agent || await clack.select({
      message: 'Choose agent',
      options: DEFAULT_MODELS.map((model) => ({ value: model, label: titleCase(model) })),
    })
    if (clack.isCancel(agent)) return
    await runFreshHandoffAgent({
      projectRoot,
      agent,
      promptText,
      summaryDisplayPath: handoff.displayPath,
      options,
    })
    return
  }

  const flowId = options.flow || await pickFlowInteractively()
  if (clack.isCancel(flowId)) return
  console.log(`Including prior workflow summary:\n${handoff.displayPath}`)
  await handleRun(flowId, {
    ...options,
    projectRoot,
    context: joinContext(options.context, promptText),
  })
}

async function handlePreviewBoxes(flowId, options) {
  const id = flowId || (await pickFlowInteractively())
  const flow = await loadFlow(id)
  const steps = flow.steps.filter((step) => (step.agents || []).length > 0)
  const transport = isNetlifyApiTransport(options.transport) ? NETLIFY_API_TRANSPORT : 'github'
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
  if (isNetlifyApiTransport(transport)) {
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

function isUrlLine(line) {
  return /^https?:\/\//.test(String(line || '').trim())
}

function wrapBoxLines(lines, width) {
  return lines.map((line) => (isUrlLine(line) ? line : wordWrap(line, width))).join('\n')
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
    `Orchestrated via: ${isNetlifyApiTransport(transport) ? 'Netlify API' : 'GitHub Actions'}`,
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

function localAgentRunUrl({ projectRoot, runnerId, sessionId }) {
  if (!runnerId) return ''
  try {
    const project = readNetlifyProject(projectRoot)
    if (project?.adminUrl) {
      return formatAgentRunUrlFromAdminUrl(project.adminUrl, runnerId, sessionId)
    }
    if (project?.siteName) return formatAgentRunUrl(project.siteName, runnerId, sessionId)
  } catch (_err) {
    /* ignore */
  }
  return ''
}

function formatSubmittedLocalRunBoxes({ runs = [], prompt = {}, projectRoot }) {
  if (runs.length === 0) return ''
  const teal = '#0d9488'
  const terminalWidth = process.stdout.columns || 120
  const width = Math.min(120, Math.max(76, Math.floor(terminalWidth * 0.95)))
  return runs.map((run) => {
    const label = `${titleCase(run.agent)} ${prompt.title || 'Agent Run'}`
    const runUrl = run.links?.sessionUrl ||
      run.links?.agentRunUrl ||
      (projectRoot ? localAgentRunUrl({ projectRoot, runnerId: run.runnerId, sessionId: run.sessionId }) : '')
    const content = [
      `Status: ${run.status || 'submitted'}`,
      run.existingRunnerId ? 'Type: follow-up session' : 'Type: new agent run',
      `Runner ID: ${run.runnerId || 'unknown'}`,
      run.sessionId ? `Session ID: ${run.sessionId}` : '',
      Number.isFinite(run.submittedAfterSeconds) ? `Submitted after: ${run.submittedAfterSeconds}s` : '',
      runUrl ? `View run:\n${runUrl}` : '',
    ].filter(Boolean).join('\n')
    return makeBox({
      title: {
        left: label,
        right: run.sessionId || run.runnerId || '',
      },
      content,
      borderStyle: 'rounded',
      borderColor: teal,
      width,
    })
  }).join('\n')
}

function printSuccessBox({ flow, runState, transport, projectRoot }) {
  const green = '#22c55e'
  const final = finalRunForRunState(runState)
  if (!final) return
  const lines = [`Workflow "${flow.title}" complete.`, `Final step: ${final.step.title}`]
  const usage = usageSummariesForRunState(runState)
  if (isNetlifyApiTransport(transport)) {
    const url = final.run.links?.sessionUrl ||
      final.run.links?.agentRunUrl ||
      localAgentRunUrl({ projectRoot, runnerId: final.run.runnerId, sessionId: final.run.sessionId })
    if (url) {
      lines.push('Final agent run:', url)
    } else if (final.run.runnerId) {
      lines.push(`Final agent runner ID: ${final.run.runnerId}`)
    }
    if (final.run.deployUrl) lines.push('Deploy:', final.run.deployUrl)
    if (final.run.prUrl) lines.push('PR:', final.run.prUrl)
  } else {
    const url = final.run.commentUrl || final.run.issueUrl
    if (url) lines.push('Final result:', url)
  }
  if (usage.totalSummary) {
    lines.push(`Total usage: ${usage.totalSummary}`)
    for (const step of usage.steps) {
      lines.push(`Usage ${step.title}: ${step.summary}`)
    }
  }
  const artifactsRoot = artifactsRootForRunState(runState)
  if (artifactsRoot) lines.push('Artifacts:', artifactsRoot)
  const terminalWidth = process.stdout.columns || 100
  const outerMax = Math.max(60, Math.floor(terminalWidth * OUTER_TERMINAL_RATIO))
  const wrapped = wrapBoxLines(lines, outerMax - 6)
  const longest = Math.max(...wrapped.split('\n').map((l) => l.length))
  const width = process.stdout.isTTY ? Math.min(longest + 6, outerMax) : longest + 6
  console.log('')
  console.log(makeBox({
    title: 'Success',
    content: wrapped,
    borderStyle: 'rounded',
    borderColor: green,
    width,
  }))
  console.log('')
}

function handoffSummaryPath(runState = {}) {
  const root = artifactsRootForRunState(runState)
  return root ? path.join(root, 'summary.md') : ''
}

function relativeHandoffPath(projectRoot, summaryPath) {
  const relative = path.relative(projectRoot || process.cwd(), summaryPath)
  return relative && !relative.startsWith('..') ? relative : summaryPath
}

function findRunStateForHandoff(projectRoot, { runId } = {}) {
  const states = listRunStates(projectRoot)
  if (runId) {
    const matched = states.find((state) => state.runId === runId)
    if (!matched) throw new Error(`Could not find run state ${runId} under ${path.join(projectRoot, '.nax', 'runs')}.`)
    return matched
  }
  return states[0] || null
}

function readHandoffSummary({ projectRoot, runId } = {}) {
  const runState = findRunStateForHandoff(projectRoot, { runId })
  if (!runState) throw new Error(`No nax runs found under ${path.join(projectRoot, '.nax', 'runs')}.`)
  persistWorkflowArtifacts(runState, { summaryOnly: true })
  const summaryPath = handoffSummaryPath(runState)
  if (!summaryPath || !fs.existsSync(summaryPath)) {
    throw new Error(`Run ${runState.runId} does not have a handoff summary yet.`)
  }
  const summaryText = fs.readFileSync(summaryPath, 'utf8').trim()
  if (!summaryText) throw new Error(`Run ${runState.runId} has an empty handoff summary.`)
  return {
    runState,
    summaryPath,
    displayPath: relativeHandoffPath(projectRoot, summaryPath),
    summaryText,
  }
}

function buildHandoffPrompt({ instructions = '', summaryPath = '', summaryText = '' } = {}) {
  return [
    String(instructions || '').trim()
      ? ['# Additional Instructions', '', String(instructions).trim()].join('\n')
      : '',
    [
      '# Prior Workflow Summary',
      '',
      summaryPath ? `Source: ${summaryPath}` : '',
      '',
      String(summaryText || '').trim(),
    ].filter((line) => line !== '').join('\n'),
  ].filter(Boolean).join('\n\n---\n\n')
}

function printPostSuccessHandoffHint(runState, projectRoot) {
  if (!process.stdout.isTTY) return
  const summaryPath = handoffSummaryPath(runState)
  if (!summaryPath || !fs.existsSync(summaryPath)) return
  const displayPath = relativeHandoffPath(projectRoot, summaryPath)
  console.log(`The results from your workflow are in ${displayPath}`)
  console.log('')
  console.log('Hand them off to another agent with:')
  console.log('')
  console.log('nax handoff')
  console.log('')
}

function copyToClipboard(text, { platform = process.platform, runCommand = spawnSync } = {}) {
  const candidates = platform === 'darwin'
    ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
  for (const [command, args] of candidates) {
    const result = runCommand(command, args, { input: text, encoding: 'utf8' })
    if (result.status === 0) return command
  }
  throw new Error(platform === 'darwin'
    ? 'Could not copy to clipboard with pbcopy.'
    : 'Could not copy to clipboard. Install wl-copy or xclip, or open the summary file directly.')
}

function artifactDirectoryHasFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile()) return true
    if (entry.isDirectory() && artifactDirectoryHasFiles(path.join(dir, entry.name))) return true
  }
  return false
}

function printPartialArtifactHint(runState) {
  const dir = artifactsRootForRunState(runState)
  if (!artifactDirectoryHasFiles(dir)) return
  console.log('')
  console.log(`Partial artifacts: ${dir}`)
  if (runState?.flowId) console.log(`Resume:            nax run ${runState.flowId}`)
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

function compactTextForRetry(text, limit, label = 'content') {
  const value = String(text || '').trim()
  if (!value || value.length <= limit) return value
  if (limit < 200) return value.slice(0, limit).trim()

  const note = `\n\n[${label} compacted from ${value.length} chars for retry after Netlify runner argument limit. Middle omitted.]\n\n`
  const available = Math.max(0, limit - note.length)
  const headLength = Math.ceil(available * 0.65)
  const tailLength = Math.max(0, available - headLength)
  return `${value.slice(0, headLength).trimEnd()}${note}${value.slice(value.length - tailLength).trimStart()}`
}

function formatCompactLocalRunResults(runs, {
  perRunLimit = COMPACT_LOCAL_RESULT_CHAR_LIMIT,
  totalLimit = COMPACT_LOCAL_RESULTS_TOTAL_LIMIT,
} = {}) {
  const completed = runs.filter((run) => run.resultText && run.resultText.trim())
  if (completed.length === 0) return ''

  const parts = ['## Prior Agent Results']
  let used = parts[0].length
  for (let index = 0; index < completed.length; index += 1) {
    const run = completed[index]
    const source = run.sourceStep ? ` from ${run.sourceStep}` : ''
    const title = `${titleCase(run.agent || 'agent')}${source}`
    const blockPrefix = ['', `<details>`, `<summary>${title}</summary>`, ''].join('\n')
    const blockSuffix = ['', `</details>`].join('\n')
    const remaining = totalLimit - used
    const contentLimit = Math.min(perRunLimit, remaining - blockPrefix.length - blockSuffix.length)
    if (contentLimit < 200) {
      parts.push('', `[${completed.length - index} prior results omitted to fit retry prompt size.]`)
      break
    }
    const content = compactTextForRetry(run.resultText, contentLimit, `${title} result`)
    const block = [
      '',
      `<details>`,
      `<summary>${title}</summary>`,
      '',
      content,
      '',
      `</details>`,
    ].join('\n')
    parts.push(block)
    used += block.length
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

function buildCompactLocalPromptForRedrive({ flow, step, runState, run }) {
  const savedCompact = String(run.compactPromptText || '').trim()
  const savedPrompt = String(run.promptText || '')
  if (savedCompact && savedCompact.length < savedPrompt.length) return savedCompact

  const options = runState.options || {}
  const prompt = loadStepPrompt(flow, step)
  const completedStepStates = completedStepMapFromRunState(runState)
  const sourceRuns = sourceRunsForStep(step, completedStepStates)
  const compactRoundResults = formatCompactLocalRunResults(sourceRuns)
  const compactContext = compactTextForRetry(
    contextForRunState(runState, options),
    COMPACT_LOCAL_CONTEXT_CHAR_LIMIT,
    'Additional Context',
  )
  const rebuilt = buildLocalAgentPrompt({
    model: run.agent,
    prompt,
    context: compactContext,
    roundResults: compactRoundResults,
  })
  if (rebuilt.trim() && (!savedPrompt || rebuilt.length < savedPrompt.length)) return rebuilt
  return compactTextForRetry(savedPrompt, COMPACT_LOCAL_RESULTS_TOTAL_LIMIT + COMPACT_LOCAL_CONTEXT_CHAR_LIMIT, 'Local agent prompt')
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

function localRunStatusSummary(runs = []) {
  return runs.map((run) => {
    const status = run.status === 'completed'
      ? 'complete'
      : run.status === 'timeout'
        ? 'timeout'
        : run.status === 'failed'
          ? 'failed'
          : run.status || 'unknown'
    return `${titleCase(run.agent || 'agent')}: ${status}`
  }).join(', ')
}

function nextLocalStepMessage(steps, index) {
  const nextStep = steps[index + 1]
  return nextStep ? `Preparing next step: ${nextStep.title}...` : 'Finalizing workflow outputs...'
}

function shouldPollLocalRun(run) {
  if (!run.runnerId) return false
  if (run.status === 'dry-run') return false
  if (run.status === 'failed' || run.status === 'timeout') return false
  if (run.status === 'completed' && run.resultText) return false
  return true
}

function localRedriveCandidates(runState, { stepId, agent } = {}) {
  const requestedAgent = String(agent || '').trim().toLowerCase()
  return (runState.steps || []).flatMap((step, stepIndex) => {
    if (stepId && step.id !== stepId) return []
    return (step.runs || []).map((run, runIndex) => ({
      step,
      stepIndex,
      run,
      runIndex,
    })).filter(({ run }) => {
      if (requestedAgent && String(run.agent || '').toLowerCase() !== requestedAgent) return false
      if (!run.runnerId) return false
      return run.status === 'failed' || run.status === 'timeout'
    })
  })
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
const STEP_SPINNER_FRAMES = ['◐', '◓', '◑', '◒']

function nextFlavorAt({ min, max }) {
  const range = Math.max(0, max - min)
  return Date.now() + min + Math.floor(Math.random() * (range + 1))
}

function formatNonTtyRunStatusMessage(event = {}, { agentWidth = 0, stateWidth = 0 } = {}) {
  const run = event.run || {}
  const agent = String(run.agent || 'agent')
  const id = run.runnerId || run.issueNumber || ''
  const state = String(event.state || run.status || 'unknown')
  return `${agent.padEnd(agentWidth)} ${id}: ${state.padEnd(stateWidth)}`
}

function formatUsageLogLine(usage) {
  const summary = formatUsageSummary(usage)
  return summary ? `**Usage:** ${summary.replace(/, /g, ' · ')}` : ''
}

function formatTtyProgressRow(row, { nameWidth, frame, orchestrator = DEFAULT_ORCHESTRATOR } = {}) {
  const name = titleCase(row.agent).padEnd(nameWidth, ' ')
  if (row.status === 'completed') return `✓ ${name} · 🟢 complete`
  if (row.status === 'failed') return `✖ ${name} · failed${row.message ? ` · ${row.message}` : ''}`
  const icon = STEP_SPINNER_FRAMES[frame % STEP_SPINNER_FRAMES.length]
  const label = row.message || `${row.emoji} ${orchestrator}'s ${titleCase(row.agent)} ${row.phrase}`
  return `${icon} ${name} · ${label}`
}

function makeStepProgressReporter({
  stepTitle,
  total,
  agents = [],
  orchestrator = DEFAULT_ORCHESTRATOR,
  flavorMinMs = 10000,
  flavorMaxMs = 15000,
  nonTtyHeartbeatMs = 60000,
}) {
  if (!process.stdout.isTTY) {
    let lastCount = -1
    const lastRunLogs = new Map()
    const agentWidth = Math.max(0, ...agents.map((agent) => String(agent).length))
    let stateWidth = 0
    return {
      setCount: (n) => {
        if (n === lastCount) return
        lastCount = n
        console.log(`Waiting for ${stepTitle}: ${n}/${total} complete`)
      },
      updateRun: (event) => {
        const id = event.run?.runnerId || event.run?.issueNumber || event.run?.agent
        if (!id) return
        stateWidth = Math.max(stateWidth, String(event.state || event.run?.status || 'unknown').length)
        const statusMessage = formatNonTtyRunStatusMessage(event, { agentWidth, stateWidth })
        const useStatusMessage = event.run && (event.state || event.run?.status) && !event.retry && !event.error
        const message = useStatusMessage ? statusMessage : (event.message || statusMessage)
        const previous = lastRunLogs.get(id) || {}
        const checkCount = Number(previous.checkCount || 0) + 1
        const now = Date.now()
        if (previous?.message === message && now - previous.loggedAt < nonTtyHeartbeatMs) {
          lastRunLogs.set(id, { ...previous, checkCount })
          return
        }
        lastRunLogs.set(id, { message, loggedAt: now, checkCount })
        const usageLine = event.terminalSuccess ? formatUsageLogLine(event.run?.usage) : ''
        console.log([
          `${message} (check #${checkCount})`,
          usageLine,
        ].filter(Boolean).join('\n'))
      },
      message: (msg) => console.log(msg),
      done: (msg) => { if (msg) console.log(msg) },
      fail: (msg) => { if (msg) console.log(msg) },
    }
  }

  const rows = new Map()
  for (const agent of agents) {
    const [phrase, emoji] = pickFlavor()
    rows.set(agent, {
      agent,
      emoji,
      phrase,
      nextFlavor: nextFlavorAt({ min: flavorMinMs, max: flavorMaxMs }),
      state: 'pending',
      status: 'pending',
      message: '',
    })
  }
  let frame = 0
  let renderedLines = 0
  let finished = false

  const rowForAgent = (agent) => {
    const key = agent || `agent-${rows.size + 1}`
    if (!rows.has(key)) {
      const [phrase, emoji] = pickFlavor()
      rows.set(key, {
        agent: key,
        emoji,
        phrase,
        nextFlavor: nextFlavorAt({ min: flavorMinMs, max: flavorMaxMs }),
        state: 'pending',
        status: 'pending',
        message: '',
      })
    }
    return rows.get(key)
  }

  const completeCount = () => [...rows.values()].filter((row) => row.status === 'completed').length
  const displayRows = () => [...rows.values()]
  const rotateFlavor = (row) => {
    if (row.status !== 'pending' && row.status !== 'running') return
    if (Date.now() < row.nextFlavor) return
    const [phrase, emoji] = pickFlavor()
    row.phrase = phrase
    row.emoji = emoji
    row.nextFlavor = nextFlavorAt({ min: flavorMinMs, max: flavorMaxMs })
  }
  const renderRow = (row, nameWidth) => {
    return formatTtyProgressRow(row, { nameWidth, frame, orchestrator })
  }
  const renderLines = () => {
    for (const row of rows.values()) rotateFlavor(row)
    const visibleRows = displayRows()
    const nameWidth = visibleRows.reduce((max, row) => Math.max(max, titleCase(row.agent).length), 0)
    return [
      `Waiting for ${stepTitle}: ${completeCount()}/${total} complete`,
      ...visibleRows.map((row) => renderRow(row, nameWidth)),
    ]
  }
  const writeLines = (lines) => {
    if (finished) return
    if (renderedLines > 0) {
      readline.moveCursor(process.stdout, 0, -renderedLines)
      readline.cursorTo(process.stdout, 0)
      readline.clearScreenDown(process.stdout)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    renderedLines = lines.length
  }
  const redraw = () => {
    frame += 1
    writeLines(renderLines())
  }
  writeLines(renderLines())
  const timer = setInterval(redraw, 180)
  timer.unref?.()
  const stop = (msg) => {
    finished = true
    clearInterval(timer)
    if (renderedLines > 0) {
      readline.moveCursor(process.stdout, 0, -renderedLines)
      readline.cursorTo(process.stdout, 0)
      readline.clearScreenDown(process.stdout)
    }
    const lines = renderLines()
    process.stdout.write(`${lines.join('\n')}\n`)
    renderedLines = 0
    if (msg) console.log(`\n${msg}`)
  }
  return {
    setCount: (n) => {
      let remaining = n
      for (const row of rows.values()) {
        row.status = remaining > 0 ? 'completed' : 'running'
        row.message = ''
        remaining -= 1
      }
      redraw()
    },
    updateRun: (event) => {
      const row = rowForAgent(event.run?.agent)
      row.state = event.state || row.state
      if (event.terminalSuccess || event.run?.status === 'completed') {
        row.status = 'completed'
        row.message = ''
      } else if (event.terminalFailure || event.run?.status === 'failed' || event.run?.status === 'timeout') {
        row.status = 'failed'
        row.message = event.error || event.run?.resultText || event.state || ''
      } else {
        row.status = 'running'
        row.message = event.retry ? 'retrying once after transient capacity error' : ''
      }
      redraw()
    },
    message: (msg) => {
      if (!msg) return
      const row = rowForAgent('status')
      row.status = 'running'
      row.message = msg
      redraw()
    },
    done: (msg) => {
      stop(msg || `${stepTitle}: ${total}/${total} complete`)
    },
    fail: (msg) => {
      stop(msg || `Failed waiting for ${stepTitle}`)
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

const GITHUB_POLL_MAX_CONSECUTIVE_FAILURES = 5

async function waitForGithubStep({
  repo,
  issueNumbers = [],
  runs = [],
  step,
  timeoutMinutes,
  pollMs = 15000,
  loader,
  onRunResult = () => {},
  maxConsecutiveFailures = GITHUB_POLL_MAX_CONSECUTIVE_FAILURES,
}) {
  const numbers = issueNumbers.length > 0
    ? issueNumbers
    : runs.map((run) => run.issueNumber).filter((number) => Number.isFinite(number))
  if (!numbers.length) return []
  const deadline = Date.now() + timeoutMinutes * 60 * 1000
  const reporter = makeStepProgressReporter({
    stepTitle: step.title,
    total: numbers.length,
    agents: step.agents || [],
  })
  let settled = false
  let consecutiveFailures = 0
  const emittedResults = new Set()

  try {
    while (Date.now() < deadline) {
      let results
      try {
        results = fetchRoundResults({
          repo,
          issueNumbers: numbers,
          embedAll: true,
          requireResultMarker: true,
          loader,
        })
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures += 1
        if (consecutiveFailures >= maxConsecutiveFailures) {
          reporter.fail(`${step.title}: poll failed ${consecutiveFailures} times in a row`)
          settled = true
          throw new Error(
            `Step "${step.id}" aborted after ${consecutiveFailures} consecutive poll failures: ${err.message}`,
          )
        }
        reporter.message(
          `transient poll error (${consecutiveFailures}/${maxConsecutiveFailures}); retrying — ${err.message}`,
        )
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        continue
      }
      const scopedResults = resultsScopedToGithubRuns(results, runs)
      for (const result of scopedResults) {
        const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
        const replies = result.replies || []
        const latest = replies[replies.length - 1]
        if (!latest?.url) continue
        const key = `${result.issueNumber}:${latest.url}`
        if (emittedResults.has(key)) continue
        emittedResults.add(key)
        await onRunResult({ result, reply: latest, run, status: 'completed' })
      }
      const completeCount = scopedResults.filter((r) => (r.replies || []).length > 0).length
      reporter.setCount(completeCount)
      const failures = findGithubRunnerFailures(results, runs)
      if (failures.length > 0) {
        for (const result of results || []) {
          const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
          for (const reply of githubFailureCommentsForRun(result, run)) {
            const key = `${result.issueNumber}:${reply.url || 'failed'}`
            if (emittedResults.has(key)) continue
            emittedResults.add(key)
            await onRunResult({ result, reply, run, status: 'failed' })
          }
        }
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

async function completeGithubStep({ runState, repo, stepState, step, options }) {
  const timeoutMinutes = Number.parseInt(options.timeoutMinutes || '25', 10)
  if (step.waitFor !== WAIT_FOR_AGENT_RESULTS) {
    stepState.status = 'completed'
    persistStepArtifacts(runState, stepState)
    return stepState
  }

  try {
    if (stepState.runs.some(shouldPollGithubRun)) {
      const issueNumbers = stepState.runs.map((run) => run.issueNumber).filter((number) => Number.isFinite(number))
      const results = await waitForGithubStep({
        repo,
        issueNumbers,
        runs: stepState.runs,
        step,
        timeoutMinutes,
        onRunResult: ({ result, reply, run, status }) => {
          const normalized = normalizeGithubRunResult({
            run,
            result,
            reply,
            status,
            marker: parseRunnerResultMarker(reply?.body || ''),
          })
          const index = stepState.runs.findIndex((candidate) => candidate.issueNumber === normalized.issueNumber)
          if (index !== -1) {
            Object.assign(stepState.runs[index], normalized)
            persistRunArtifact(runState, stepState, stepState.runs[index])
          }
        },
      })
      for (const run of stepState.runs) {
        const result = results.find((item) => item.issueNumber === run.issueNumber)
        const replies = result?.replies || []
        const latest = replies[replies.length - 1]
        const normalized = normalizeGithubRunResult({
          run,
          result,
          reply: latest,
          status: latest ? 'completed' : 'timeout',
          marker: parseRunnerResultMarker(latest?.body || ''),
        })
        Object.assign(run, normalized)
      }
    }
    stepState.status = githubStepStatus(stepState)
  } finally {
    persistStepArtifacts(runState, stepState)
  }
  return stepState
}

async function executeGithubFlow({ flow, steps, options, runState, completedStepStates = new Map() }) {
  const repo = resolveRepo(options.repo)
  const date = options.date || getLocalDate()
  const baseContext = contextForRunState(runState, options)

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex]
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

    await completeGithubStep({ runState, repo, stepState, step, options })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
  }
}

function addLocalRunLinks(run, projectRoot) {
  const runUrl = localAgentRunUrl({ projectRoot, runnerId: run.runnerId, sessionId: run.sessionId })
  const baseRunUrl = localAgentRunUrl({ projectRoot, runnerId: run.runnerId })
  run.links = {
    ...(run.links || {}),
    ...(baseRunUrl ? { agentRunUrl: baseRunUrl } : {}),
    ...(runUrl ? { sessionUrl: runUrl } : {}),
  }
  return run
}

async function completeLocalStep({ runState, stepState, step, options, projectRoot, netlify, initialDelayMs }) {
  const timeoutMinutes = Number.parseInt(options.timeoutMinutes || '25', 10)
  if (step.waitFor === WAIT_FOR_AGENT_RESULTS && stepState.runs.some(shouldPollLocalRun)) {
    const reporter = makeStepProgressReporter({
      stepTitle: step.title,
      total: stepState.runs.length,
      agents: step.agents || [],
    })
    let settled = false
    try {
      const completedRuns = await waitForLocalAgentRuns({
        projectRoot,
        runs: stepState.runs,
        siteId: netlify.siteId,
        env: netlify.env,
        timeoutMinutes,
        initialDelayMs,
        onProgress: (event) => {
          if (!event.run?.runnerId) return
          reporter.updateRun(event)
        },
        onTerminalRun: (run) => {
          addLocalRunLinks(run, projectRoot)
          const index = stepState.runs.findIndex((candidate) => candidate.runnerId === run.runnerId)
          if (index !== -1) stepState.runs[index] = run
          persistRunArtifact(runState, stepState, run)
        },
      })
      for (const run of completedRuns) {
        addLocalRunLinks(run, projectRoot)
      }
      stepState.runs = completedRuns
      for (const run of completedRuns) {
        reporter.updateRun({
          run,
          state: run.status,
          terminal: run.status === 'completed' || run.status === 'failed' || run.status === 'timeout',
          terminalSuccess: run.status === 'completed',
          terminalFailure: run.status === 'failed' || run.status === 'timeout',
        })
      }
      const doneCount = completedRuns.filter((r) => r.status === 'completed').length
      const failedCount = completedRuns.filter((r) => r.status === 'failed' || r.status === 'timeout').length
      const statusSummary = localRunStatusSummary(completedRuns)
      if (failedCount > 0) {
        reporter.fail(`${step.title}: ${doneCount}/${completedRuns.length} complete, ${failedCount} failed · ${statusSummary}`)
      } else {
        reporter.done(`${step.title}: ${doneCount}/${completedRuns.length} complete · ${statusSummary}`)
      }
      settled = true
    } finally {
      if (!settled) reporter.fail(`Failed waiting for ${step.title}`)
      stepState.status = localStepStatus(stepState)
      persistStepArtifacts(runState, stepState)
    }
  }
  stepState.status = localStepStatus(stepState)
  persistStepArtifacts(runState, stepState)
  return stepState
}

async function executeLocalFlow({ flow, steps, options, runState, projectRoot, completedStepStates = new Map() }) {
  const date = options.date || getLocalDate()
  const baseContext = contextForRunState(runState, options)
  const branch = options.branch || currentGitBranch(projectRoot)
  const netlify = buildNetlifyEnv({ projectRoot })

  for (const [stepIndex, step] of steps.entries()) {
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
    const compactRoundResults = formatCompactLocalRunResults(sourceRuns)
    const compactContext = compactTextForRetry(baseContext, COMPACT_LOCAL_CONTEXT_CHAR_LIMIT, 'Additional Context')
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
      const compactPromptText = buildLocalAgentPrompt({
        model: agent,
        prompt,
        context: compactContext,
        roundResults: compactRoundResults,
        date,
      })
      return {
        transport: NETLIFY_API_TRANSPORT,
        agent,
        status: options.dryRun ? 'dry-run' : 'pending',
        promptText,
        compactPromptText: compactPromptText.length < promptText.length ? compactPromptText : '',
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

    console.log(`\nRun Netlify API agents: ${step.title}`)
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
      console.log(`- ${label}: submitting${run.existingRunnerId ? ' follow-up' : ''}...`)
      try {
        const submitted = await submitLocalAgentRun({
          run,
          projectRoot,
          branch,
          siteId: netlify.siteId,
          env: netlify.env,
          onRetry: ({ error, nextAttempt, attempts, delayMs }) => {
            const delaySeconds = Math.round(delayMs / 1000)
            console.log(`  ${label}: submission failed, retrying ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
          },
        })
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
        submitted.submittedAfterSeconds = elapsedSeconds
        stepState.runs[index] = submitted
        saveRunState(runState)
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
    const submissionBoxes = formatSubmittedLocalRunBoxes({ runs: submittedRuns, prompt, projectRoot })
    if (submissionBoxes) {
      console.log('\nSubmitted Netlify agent runs:')
      console.log(submissionBoxes)
    }

    await completeLocalStep({ runState, stepState, step, options, projectRoot, netlify })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)

    if (stepState.status !== 'completed' && stepState.status !== 'dry-run') {
      throw new Error(`Local step "${step.id}" did not complete successfully.`)
    }
    console.log(`\n${nextLocalStepMessage(steps, stepIndex)}`)
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
    await completeLocalStep({ runState, stepState, step, options, projectRoot, netlify, initialDelayMs: 0 })
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
    await completeGithubStep({ runState, repo, stepState, step, options })
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

function findRunStateForRedrive(projectRoot, { runId, flowId, stepId, agent } = {}) {
  const states = listRunStates(projectRoot)
  if (runId) {
    const matched = states.find((state) => state.runId === runId)
    if (!matched) throw new Error(`Could not find run state ${runId} under ${path.join(projectRoot, '.nax', 'runs')}.`)
    return matched
  }
  const matched = states.find((state) => {
    if (!isNetlifyApiTransport(state.transport)) return false
    if (flowId && state.flowId !== flowId) return false
    return localRedriveCandidates(state, { stepId, agent }).length > 0
  })
  if (!matched) throw new Error('Could not find a failed Netlify API run to redrive. Pass a run id explicitly.')
  return matched
}

async function handleRedrive(runId, options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const runState = findRunStateForRedrive(projectRoot, {
    runId,
    flowId: options.flow,
    stepId: options.step,
    agent: options.agent,
  })
  if (!isNetlifyApiTransport(runState.transport)) {
    throw new Error(`Run ${runState.runId} uses ${runState.transport || 'unknown'} transport; redrive currently supports Netlify API runs only.`)
  }

  const flow = await loadFlow(runState.flowId)
  const candidates = localRedriveCandidates(runState, {
    stepId: options.step,
    agent: options.agent,
  })
  if (candidates.length === 0) {
    throw new Error(`Run ${runState.runId} has no failed Netlify API runner matching the requested filters.`)
  }
  if (candidates.length > 1) {
    const choices = candidates.map(({ step, run }) => `${step.id}:${run.agent}`).join(', ')
    throw new Error(`More than one failed Netlify API runner can be redriven (${choices}). Pass --step and --agent.`)
  }

  trackRunState(runState)
  const [{ step, stepIndex, run, runIndex }] = candidates
  const flowStep = flow.steps.find((candidate) => candidate.id === step.id)
  if (!flowStep) throw new Error(`Flow ${flow.id} no longer contains step ${step.id}.`)

  const netlify = buildNetlifyEnv({ projectRoot })
  const branch = runState.branch || runState.options?.branch || currentGitBranch(projectRoot)
  const compactPromptText = buildCompactLocalPromptForRedrive({ flow, step: flowStep, runState, run })
  if (!compactPromptText || compactPromptText.length >= String(run.promptText || '').length) {
    throw new Error(`Could not build a shorter prompt for ${run.agent} ${step.id}.`)
  }

  console.log(`Redriving ${titleCase(run.agent)} ${step.title}`)
  console.log(`Run: ${runState.runId}`)
  console.log(`Runner: ${run.runnerId}`)
  console.log(`Prompt: ${String(run.promptText || '').length} -> ${compactPromptText.length} chars`)

  const redriveRun = {
    ...run,
    status: 'pending',
    promptText: compactPromptText,
    compactPromptText,
    resultText: '',
    existingRunnerId: run.runnerId,
    promptShrinkRetryCount: Number(run.promptShrinkRetryCount || 0) + 1,
    raw: {
      ...run.raw,
      redrive: {
        reason: 'manual-compact-prompt',
        previousStatus: run.status,
        previousResultText: run.resultText || '',
      },
    },
  }
  const submitted = await submitLocalAgentRun({
    run: redriveRun,
    projectRoot,
    branch,
    siteId: netlify.siteId,
    env: netlify.env,
    onRetry: ({ error, nextAttempt, attempts, delayMs }) => {
      const delaySeconds = Math.round(delayMs / 1000)
      console.log(`Submission failed, retrying ${nextAttempt}/${attempts} in ${delaySeconds}s — ${error.message}`)
    },
  })
  step.runs[runIndex] = submitted
  step.status = 'running'
  saveRunState(runState)

  const reporter = makeStepProgressReporter({
    stepTitle: step.title,
    total: 1,
    agents: [run.agent],
  })
  const completed = await waitForLocalAgentRuns({
    projectRoot,
    runs: [submitted],
    siteId: netlify.siteId,
    env: netlify.env,
    timeoutMinutes: Number.parseInt(options.timeoutMinutes || runState.options?.timeoutMinutes || '25', 10),
    initialDelayMs: 0,
    onProgress: (event) => reporter.updateRun(event),
    onTerminalRun: (terminalRun) => {
      addLocalRunLinks(terminalRun, projectRoot)
      step.runs[runIndex] = terminalRun
      persistRunArtifact(runState, step, terminalRun)
    },
  })
  const completedRun = completed[0]
  addLocalRunLinks(completedRun, projectRoot)
  step.runs[runIndex] = completedRun
  step.status = localStepStatus(step)
  persistStepArtifacts(runState, step)
  reporter.updateRun({
    run: completedRun,
    state: completedRun.status,
    terminal: true,
    terminalSuccess: completedRun.status === 'completed',
    terminalFailure: completedRun.status !== 'completed',
  })
  if (completedRun.status === 'completed') {
    reporter.done(`${step.title}: ${titleCase(run.agent)} complete`)
  } else {
    reporter.fail(`${step.title}: ${titleCase(run.agent)} ${completedRun.status}`)
  }
  saveRunState(runState)

  if (step.status !== 'completed') {
    throw new Error(`Redriven ${run.agent} run did not complete successfully.`)
  }

  const completedStepStates = completedStepMapFromRunState(runState)
  completedStepStates.set(step.id, step)
  await executeLocalFlow({
    flow,
    steps: flow.steps.slice(stepIndex + 1),
    options: runState.options || {},
    runState,
    projectRoot,
    completedStepStates,
  })
  clearTrackedRunState(runState, { completed: true })
  printSuccessBox({ flow, runState, transport: NETLIFY_API_TRANSPORT, projectRoot })
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

  try {
    if (isNetlifyApiTransport(transport)) {
      await executeLocalFlow({ flow: configuredFlow, steps, options: configuredOptions, runState, projectRoot })
    } else {
      await executeGithubFlow({ flow: configuredFlow, steps, options: configuredOptions, runState })
    }

    clearTrackedRunState(runState, { completed: true })
    persistWorkflowArtifacts(runState, { summaryOnly: true })
    writeGithubStepSummary(runState)
    printSuccessBox({ flow: configuredFlow, runState, transport, projectRoot })
    printPostSuccessHandoffHint(runState, projectRoot)
  } catch (error) {
    runState.status = 'failed'
    saveRunState(runState)
    persistWorkflowArtifacts(runState, { summaryOnly: true })
    writeGithubStepSummary(runState)
    printPartialArtifactHint(runState)
    throw error
  }

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
    const reason = secret.reason ? `: ${secret.reason}` : ''
    console.log(`Secret: ${secret.name} (${secret.status}${reason})`)
  }
}

function printSkillInstallResults(results) {
  for (const result of results) {
    const relative = path.join(result.provider, 'skills', result.skill)
    console.log(`${result.status} -> ${relative} (v${result.version})`)
  }
}

function printSkillCheckResults(results) {
  if (results.length === 0) {
    console.log('No bundled skills found.')
    return
  }
  for (const result of results) {
    const relative = path.join(result.provider, 'skills', result.skill)
    if (!result.installed) {
      console.log(`${relative}: not installed`)
      continue
    }
    const suffix = result.current ? 'current' : 'stale; run `nax skills update`'
    console.log(`${relative}: v${result.installedVersion || '?'} package v${result.packageVersion} (${suffix})`)
  }
}

function printSkillsHelp() {
  console.log([
    'nax skills - manage project-local agent skills',
    '',
    'Usage:',
    '  nax skills install [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax skills update  [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax skills check   [--provider=.claude] [--all-providers] [--skill=nax-workflows]',
    '  nax skills list',
    '',
    `Supported providers: ${PROVIDER_DIRS.join(', ')}`,
    '',
    'By default, install/update targets detected provider directories in the current project.',
    'If no provider directory exists, nax installs into .claude/skills by default.',
  ].join('\n'))
}

async function handleSkills(subcommand = 'help', options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const common = {
    projectRoot,
    providers: options.provider,
    allProviders: options.allProviders === true,
    skill: options.skill,
    allSkills: options.allSkills === true,
  }
  switch (subcommand) {
    case 'install':
      printSkillInstallResults(installSkills({ ...common, dryRun: options.dryRun === true }), { dryRun: options.dryRun === true })
      return
    case 'update':
      printSkillInstallResults(updateSkills({ ...common, dryRun: options.dryRun === true }), { dryRun: options.dryRun === true })
      return
    case 'check':
      printSkillCheckResults(checkSkills(common))
      return
    case 'list':
      for (const skill of listBundledSkills()) console.log(skill)
      return
    case 'help':
    case undefined:
    case null:
      printSkillsHelp()
      return
    default:
      throw new Error(`Unknown skills subcommand "${subcommand}".`)
  }
}

async function shouldEnableGithubActions(options) {
  if (options.githubActions === true) return true
  if (options.githubActions === false) return false
  if (!process.stdin.isTTY || options.yes) return true
  const clack = require('@clack/prompts')
  const selected = await clack.confirm({
    message: 'Install the Netlify Agent Runner GitHub Actions workflow for this repo?',
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
    .option('--where <place>', 'Where to run: auto, github-actions, netlify-api, local-machine', 'auto')
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
    .option('--where <place>', 'Where to run: auto, github-actions, netlify-api, local-machine', 'auto')
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
    .command('redrive [run-id]')
    .description('Retry one failed Netlify API agent run with a compact prompt and continue the workflow')
    .option('--project-root <path>', 'Project root containing .nax/runs')
    .option('--flow <id>', 'Flow id filter when run id is omitted')
    .option('--step <id>', 'Failed step id to redrive')
    .option('--agent <name>', 'Failed agent to redrive, e.g. claude')
    .option('--timeout-minutes <count>', 'Minutes to wait for the redriven run', '25')
    .action((runId, options, command) => handleRedrive(runId || '', actionOptions(options, command)))

  program
    .command('handoff [run-id]')
    .description('Copy or continue from the latest workflow artifact summary')
    .option('--project-root <path>', 'Project root containing .nax/runs')
    .option('--run-id <id>', 'Run id to hand off; defaults to the latest .nax run')
    .option('--copy', 'Copy the summary to the clipboard and exit')
    .option('--agent <name>', 'Agent for a fresh handoff run, e.g. codex')
    .option('--flow <id>', 'Workflow id to run with the summary as context')
    .option('--where <place>', 'Where to run chained workflows: auto, github-actions, netlify-api, local-machine', 'auto')
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--context <text>', 'Additional context prepended before the handoff summary')
    .option('--timeout-minutes <count>', 'Minutes to wait for each Netlify API step or fresh handoff run', '25')
    .option('--force', 'Skip confirmation prompts for chained workflow runs')
    .addOption(new Option('--yes', 'Hidden compatibility alias for --force').hideHelp())
    .option('--no-auto-context', 'Do not inject automatic context for chained workflow runs')
    .action((runId, options, command) => handleHandoff(runId || '', actionOptions(options, command)))

  program
    .command('skills [subcommand]')
    .description('Install, update, and check project-local agent skills')
    .option('--project-root <path>', 'Project root for skill installation')
    .option('--provider <name>', 'Provider directory to install into, e.g. .claude or codex; repeatable', collectOption, [])
    .option('--all-providers', 'Install/check every supported provider directory')
    .option('--skill <name>', 'Bundled skill to install/check; repeatable', collectOption, [])
    .option('--all-skills', 'Install/check every bundled skill')
    .option('--dry', 'Preview installs without writing files')
    .addOption(new Option('--dry-run', 'Hidden compatibility alias for --dry').hideHelp())
    .action((subcommand, options, command) => handleSkills(subcommand || 'help', actionOptions(options, command)))

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
    .option('--transport <transport>', 'Transport to render (github|netlify-api|local)', 'github')
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
    buildCompactLocalPromptForRedrive,
    buildHandoffPrompt,
    compactTextForRetry,
    copyToClipboard,
    findGithubRunnerFailures,
    findRunStateForHandoff,
    formatTtyProgressRow,
    formatSubmittedLocalRunBoxes,
    handoffSummaryPath,
    nextLocalStepMessage,
    localRedriveCandidates,
    formatCompactLocalRunResults,
    makeStepProgressReporter,
    normalizeGithubRunResult,
    printPostSuccessHandoffHint,
    printSuccessBox,
    readHandoffSummary,
    relativeHandoffPath,
    usageSummariesForRunState,
    resultsScopedToGithubRuns,
    runnableSteps,
    waitForGithubStep,
    sourceIssueNumbersForStep,
    sourceRunsForStep,
    withSelectedAgents,
    uniqueNumbers,
  },
}
