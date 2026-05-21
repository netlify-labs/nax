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
const { createRunState, dismissRunState, findLatestUnfinishedRun, listRunStates, saveRunState, workflowStatePath } = require('../lib/run-state')
const {
  artifactsRootForRunState,
  persistRunArtifact,
  persistStepArtifacts,
  persistWorkflowArtifacts,
  safeArtifactName,
  writeGithubStepSummary,
} = require('../lib/workflow-artifacts')
const { clearTrackedRunState, trackRunState } = require('../lib/graceful-run-state')
const { persistAgentRunnerArtifact } = require('../lib/agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('../lib/agent-session-artifacts')
const { listHandoffSources, readHandoffSource, relativeDisplayPath } = require('../lib/handoff-sources')
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
  resolveNetlifyFilter,
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
const AD_HOC_RUN_TARGET = '__ad_hoc_agent_run__'

let clackModulePromise
async function loadClack() {
  clackModulePromise = clackModulePromise || import('@clack/prompts')
  return clackModulePromise
}

function parseCsv(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function maybeReportNetlifyFilter(resolved) {
  if (!resolved?.filter) return
  if (resolved.source === 'netlify.toml') {
    console.log(`Netlify app filter: ${resolved.filter} (from netlify.toml)`)
  }
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

  const clack = await loadClack()
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
  if (resolved.where && (!resolved.transport || resolved.transport === 'auto')) {
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
  const clack = await loadClack()
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
  const clack = await loadClack()

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
  const clack = await loadClack()

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
    const clack = await loadClack()
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
    const clack = await loadClack()
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

function normalizeHandoffSourceKind(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized === 'all') return ''
  if (normalized === 'workflow' || normalized === 'workflows') return 'workflow'
  if (normalized === 'runner' || normalized === 'runners' || normalized === 'agent-runner' || normalized === 'agent-runners') return 'agent-runner'
  if (normalized === 'session' || normalized === 'sessions' || normalized === 'agent-session' || normalized === 'agent-sessions') return 'agent-session'
  throw new Error(`Unknown handoff source type "${value}". Expected workflow, agent-runner, or agent-session.`)
}

function handoffSourceQuery({ runId = '', options = {} } = {}) {
  if (options.workflow) return { kind: 'workflow', id: options.workflow }
  if (options.runner) return { kind: 'agent-runner', id: options.runner }
  if (options.session) return { kind: 'agent-session', id: options.session }
  if (runId || options.runId) return { kind: 'workflow', id: runId || options.runId }
  return {
    kind: normalizeHandoffSourceKind(options.sourceType || options.type || ''),
    id: options.source || '',
  }
}

function formatHandoffSourceKind(kind) {
  if (kind === 'workflow') return 'workflow'
  if (kind === 'agent-runner') return 'agent runner'
  if (kind === 'agent-session') return 'agent session'
  return kind || 'artifact'
}

function isAdHocRunTarget(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === AD_HOC_RUN_TARGET ||
    normalized === 'ad-hoc' ||
    normalized === 'adhoc' ||
    normalized === 'agent' ||
    normalized === 'agent-run'
}

function formatHandoffSourceLabel(source = {}) {
  const stamp = formatRunTimestamp(source.updatedAt)
  return [stamp, source.title || source.id || 'Untitled'].filter(Boolean).join('  ')
}

function formatHandoffSourceHint(source = {}, projectRoot = process.cwd()) {
  const displayPath = source.displayPath || relativeDisplayPath(projectRoot, source.summaryPath || '')
  return `${formatHandoffSourceKind(source.kind)} · ${displayPath}`
}

function truncateOneLine(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function formatRelativeTime(value, now = Date.now()) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = date.getTime() - now
  const absMs = Math.abs(diffMs)
  const units = [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ]
  const [unit, unitMs] = units.find(([, ms]) => absMs >= ms) || units[units.length - 1]
  const count = Math.max(1, Math.round(absMs / unitMs))
  const label = `${count} ${unit}${count === 1 ? '' : 's'}`
  return diffMs > 0 ? `in ${label}` : `${label} ago`
}

function formatHumanRunDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function handoffSourcePayload(source = {}) {
  return source.source || source.runState || {}
}

function sourceDisplayTitle(source = {}) {
  if (source.kind === 'workflow') return source.title || source.id || 'Workflow'
  const artifact = handoffSourcePayload(source)
  const agent = artifact.agent ? titleCase(artifact.agent) : ''
  const sourceTitle = artifact.source?.stepTitle || artifact.source?.stepId || ''
  if (agent && sourceTitle) return `${agent} · ${sourceTitle}`
  if (agent) return agent
  return source.title || source.id || 'Artifact'
}

function finalWorkflowRun(source = {}) {
  if (source.kind !== 'workflow') return null
  const payload = handoffSourcePayload(source)
  const steps = Array.isArray(payload.steps) ? payload.steps : []
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    const runs = Array.isArray(step.runs) ? step.runs : []
    for (let j = runs.length - 1; j >= 0; j -= 1) {
      const run = runs[j]
      if (run?.status === 'completed' && String(run.resultText || '').trim()) {
        return { step, run }
      }
    }
  }
  return null
}

function previewTextForHandoffSource(source = {}, max = 260) {
  const final = finalWorkflowRun(source)
  if (final?.run?.resultText) return truncateOneLine(final.run.resultText, max)
  const resultText = handoffSourcePayload(source).resultText || ''
  if (resultText) return truncateOneLine(resultText, max)
  const summaryText = String(source.summaryText || '')
  const lines = summaryText.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (/^[-*]\s+(Run ID|Flow|Transport|Status|Usage|Files|Runner ID|Session ID|Metadata|Result):/i.test(line)) return false
      if (/^[-*]\s*$/.test(line)) return false
      return !/^```/.test(line)
    })
  return truncateOneLine(lines.find((line) => !/^#\s/.test(line)) || lines[0] || '', max)
}

function usageSummaryForHandoffSource(source = {}) {
  const payload = handoffSourcePayload(source)
  if (source.kind === 'workflow') return usageSummariesForRunState(payload).totalSummary || ''
  return formatUsageSummary(payload.usage || {})
}

function handoffSourceUpdatedAt(source = {}) {
  const payload = handoffSourcePayload(source)
  return source.updatedAt || payload.updatedAt || source.createdAt || payload.createdAt || ''
}

function handoffSourceDetailTitle(source = {}) {
  const final = finalWorkflowRun(source)
  if (source.kind === 'workflow' && final) {
    return `Latest result from "${sourceDisplayTitle(source)}" workflow "${final.step.title || final.step.id || 'Final step'}" step using ${titleCase(final.run.agent || 'agent')}`
  }
  const payload = handoffSourcePayload(source)
  if (source.kind === 'agent-session') {
    return `Latest result from ${titleCase(payload.agent || 'agent')} agent session`
  }
  if (source.kind === 'agent-runner') {
    return `Latest result from ${titleCase(payload.agent || 'agent')} agent runner`
  }
  return `Latest result from ${sourceDisplayTitle(source)}`
}

const HANDOFF_DETAIL_LABEL_WIDTH = 9

function formatHandoffDetailField(label, value, width, { block = false } = {}) {
  const text = String(value || '').trim()
  if (!text) return []
  const labelText = `${label}:`
  const indent = ' '.repeat(HANDOFF_DETAIL_LABEL_WIDTH)
  const valueWidth = Math.max(24, width - HANDOFF_DETAIL_LABEL_WIDTH)
  if (block) {
    return [labelText, ...wordWrap(text, width).split('\n')]
  }
  const wrapped = wordWrap(text, valueWidth).split('\n')
  return wrapped.map((line, index) => (
    index === 0 ? `${labelText.padEnd(HANDOFF_DETAIL_LABEL_WIDTH)}${line}` : `${indent}${line}`
  ))
}

function handoffSourceDetailLines(source = {}, projectRoot = process.cwd(), { width = 100 } = {}) {
  const updatedAt = handoffSourceUpdatedAt(source)
  const date = formatHumanRunDate(updatedAt)
  const relative = formatRelativeTime(updatedAt)
  const lines = []
  if (date) {
    lines.push(...formatHandoffDetailField('Date', `${date}${relative ? ` (${relative})` : ''}`, width))
  }
  lines.push(...formatHandoffDetailField(
    'Summary',
    source.displayPath || relativeDisplayPath(projectRoot, source.summaryPath || ''),
    width,
  ))
  const preview = previewTextForHandoffSource(source)
  if (preview) lines.push(...formatHandoffDetailField('Preview', preview, width, { block: true }))
  return lines
}

function formatHandoffSourceDetailBox(source = {}, projectRoot = process.cwd()) {
  const teal = '#0d9488'
  const terminalWidth = process.stdout.columns || 120
  const width = Math.min(120, Math.max(76, Math.floor(terminalWidth * 0.95)))
  const lines = handoffSourceDetailLines(source, projectRoot, { width: width - 6 })
  return makeBox({
    title: handoffSourceDetailTitle(source),
    content: lines.join('\n'),
    borderStyle: 'rounded',
    borderColor: teal,
    width,
  })
}

function handoffSourceMenuOptions({ sources = [], latestSource = {}, projectRoot = process.cwd() } = {}) {
  const options = [
    {
      value: 'copy-latest',
      label: 'Copy latest results to clipboard',
      hint: `${latestSource.title || latestSource.id || 'Latest'} · ${formatHandoffSourceHint(latestSource, projectRoot)}`,
    },
    {
      value: 'workflow-latest',
      label: `Run another AI workflow with latest result: ${latestSource.title || latestSource.id || 'Latest'}`,
      hint: formatHandoffSourceHint(latestSource, projectRoot),
    },
  ]
  const hasKind = (kind) => sources.some((source) => source.kind === kind)
  if (hasKind('workflow')) options.push({ value: 'pick:workflow', label: 'Pick previous workflow' })
  if (hasKind('agent-session')) options.push({ value: 'pick:agent-session', label: 'Pick previous agent session' })
  if (hasKind('agent-runner')) options.push({ value: 'pick:agent-runner', label: 'Pick previous agent runner' })
  options.push({ value: 'cancel', label: 'Cancel' })
  return options
}

async function handleRecent(options) {
  const projectRoot = options.projectRoot || process.cwd()
  const requestedType = options.type || 'all'
  const sources = listHandoffSources(projectRoot)
    .filter((source) => requestedType === 'all' || source.kind === requestedType)
  if (sources.length === 0) {
    console.log(`No completed nax artifacts found under ${path.join(projectRoot, '.nax')}.`)
    return
  }
  const limit = Number.parseInt(options.limit || '25', 10)
  const choices = sources.slice(0, limit)

  let selected
  if (options.runId) {
    selected = choices.find((source) => source.id === options.runId) || null
    if (!selected) {
      throw new Error(`No artifact source found with id "${options.runId}"`)
    }
  } else {
    const clack = await loadClack()
    const picked = await clack.select({
      message: 'Pick a recent artifact',
      options: choices.map((source) => ({
        value: `${source.kind}:${source.id}`,
        label: formatHandoffSourceLabel(source),
        hint: `${formatHandoffSourceKind(source.kind)} · ${source.id}`,
      })),
    })
    if (clack.isCancel(picked)) return
    const [kind, ...idParts] = String(picked).split(':')
    const id = idParts.join(':')
    selected = choices.find((source) => source.kind === kind && source.id === id)
    if (!selected) return
  }

  if (selected.kind === 'workflow') {
    printSuccessBox({
      flow: { title: selected.source.flowTitle || selected.source.flowId },
      runState: selected.source,
      transport: selected.source.transport,
      projectRoot: selected.source.projectRoot || projectRoot,
    })
    return
  }
  console.log(`${selected.kind}: ${selected.id}`)
  console.log(`Summary: ${relativeDisplayPath(projectRoot, selected.summaryPath)}`)
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

async function runSingleNetlifyAgent({
  projectRoot,
  agent,
  promptText,
  title,
  source,
  raw = {},
  options = {},
  beforeSubmit,
  startLabel,
} = {}) {
  const branch = options.branch || currentGitBranch(projectRoot)
  const netlify = buildNetlifyEnv({ projectRoot })
  const netlifyFilter = resolveNetlifyFilter({ projectRoot, filter: options.filter })
  const runTitle = title || 'Agent Run'
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
      stepId: safeArtifactName(runTitle).toLowerCase(),
      promptName: safeArtifactName(runTitle).toLowerCase(),
      ...raw,
    },
  }

  if (typeof beforeSubmit === 'function') beforeSubmit()
  maybeReportNetlifyFilter(netlifyFilter)
  console.log(`\nStarting ${titleCase(agent)} ${startLabel || runTitle.toLowerCase()}...`)
  const startedAt = Date.now()
  const submitted = await submitLocalAgentRun({
    run,
    projectRoot,
    branch,
    siteId: netlify.siteId,
    netlifyFilter: netlifyFilter.filter,
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
    prompt: { title: runTitle },
    projectRoot,
  })
  if (boxes) {
    console.log('\nSubmitted Netlify agent run:')
    console.log(boxes)
  }

  const reporter = makeStepProgressReporter({
    stepTitle: runTitle,
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
        reportTerminalLocalRun(reporter, terminalRun, projectRoot)
      },
    })
    addLocalRunLinks(completed, projectRoot)
    const artifactSource = source || { type: 'ad-hoc' }
    const sessionArtifact = persistAgentSessionArtifact({
      projectRoot,
      run: completed,
      source: artifactSource,
      createdAt: completed.createdAt || new Date().toISOString(),
      updatedAt: completed.updatedAt || new Date().toISOString(),
    })
    const runnerArtifact = persistAgentRunnerArtifact({
      projectRoot,
      runnerId: completed.runnerId,
      agent: completed.agent,
      status: completed.status,
      session: sessionArtifact?.session || null,
      source: artifactSource,
      links: completed.links || {},
      createdAt: completed.createdAt || new Date().toISOString(),
      updatedAt: completed.updatedAt || new Date().toISOString(),
    })
    reporter.updateRun({
      run: completed,
      state: completed.status,
      terminal: true,
      terminalSuccess: completed.status === 'completed',
      terminalFailure: completed.status !== 'completed',
    })
    if (completed.status === 'completed') {
      reporter.done(`${runTitle}: ${titleCase(agent)} complete`)
    } else {
      reporter.fail(`${runTitle}: ${titleCase(agent)} ${completed.status}`)
      throw new Error(`${runTitle} did not complete successfully.`)
    }
    settled = true
    const url = completed.links?.sessionUrl || completed.links?.agentRunUrl || ''
    if (url) console.log(`Result: ${url}`)
    if (sessionArtifact?.dir || runnerArtifact?.dir) {
      console.log('')
      if (sessionArtifact?.dir) console.log(`Session artifacts: ${sessionArtifact.dir}`)
      if (runnerArtifact?.dir) console.log(`Runner artifacts:  ${runnerArtifact.dir}`)
      if (sessionArtifact?.dir && process.stdout.isTTY) {
        const summaryPath = path.join(sessionArtifact.dir, 'summary.md')
        console.log('')
        console.log(`The result from this agent session is in ${relativeDisplayPath(projectRoot, summaryPath)}`)
        console.log('')
        console.log('Hand it off again with:')
        console.log('')
        console.log('nax handoff')
        console.log('')
      }
    }
  } finally {
    if (!settled) reporter.fail(`${runTitle} failed`)
  }
}

async function runFreshHandoffAgent({ projectRoot, agent, promptText, summaryDisplayPath, source, options = {} }) {
  await runSingleNetlifyAgent({
    projectRoot,
    agent,
    promptText,
    title: 'Handoff',
    source: {
      type: 'handoff',
      priorSourceKind: source?.kind || 'workflow',
      priorSourceId: source?.id || '',
      priorSummaryPath: summaryDisplayPath,
    },
    raw: {
      stepId: 'handoff',
      promptName: 'handoff',
      summaryPath: summaryDisplayPath,
    },
    options,
    startLabel: 'handoff run',
    beforeSubmit: () => {
      console.log(`Including prior workflow summary:\n${summaryDisplayPath}`)
    },
  })
}

async function runSingleGithubAgent({ projectRoot, agent, promptText, source, options = {} } = {}) {
  const repo = resolveRepo(options.repo)
  const date = options.date || getLocalDate()
  const runner = options.runner || '@netlify'
  const labels = parseCsv(options.labels || options.label)
  const prompt = {
    name: 'netlify-agent-run',
    title: 'Netlify Agent Run',
    description: 'Run one Netlify agent with a custom prompt.',
    instruction: 'please handle this request',
    body: promptText,
  }
  const title = `${date} ${titleCase(agent)} Netlify Agent Run`
  const body = buildIssueBody({
    runner,
    model: agent,
    prompt,
    context: '',
    roundResults: '',
    date,
  })

  console.log(`\nCreating GitHub issue for ${titleCase(agent)} Netlify agent run...`)
  const issueUrl = createIssue({ repo, title, body, labels })
  const issueNumber = parseIssueNumberFromUrl(issueUrl)
  if (!Number.isFinite(issueNumber)) throw new Error(`Could not parse issue number from ${issueUrl}`)
  console.log(`${title}: ${issueUrl}`)

  const run = {
    transport: 'github',
    agent,
    status: 'submitted',
    promptText: body,
    resultText: '',
    issueNumber,
    issueUrl,
    commentUrl: '',
    prUrl: '',
    deployUrl: '',
    raw: {
      title,
      promptName: prompt.name,
    },
  }
  const step = {
    id: 'netlify-agent-run',
    title: 'Netlify Agent Run',
    agents: [agent],
    waitFor: WAIT_FOR_AGENT_RESULTS,
  }
  const runs = [run]
  const timeoutMinutes = Number.parseInt(options.timeoutMinutes || '25', 10)
  const results = await waitForGithubStep({
    repo,
    issueNumbers: [issueNumber],
    runs,
    step,
    timeoutMinutes,
    onRunResult: ({ result, reply, run: submittedRun, status }) => {
      const normalized = normalizeGithubRunResult({
        run: submittedRun,
        result,
        reply,
        status,
        marker: parseRunnerResultMarker(reply?.body || ''),
      })
      if (reply?.createdAt && !normalized.createdAt) normalized.createdAt = reply.createdAt
      if (reply?.createdAt && !normalized.updatedAt) normalized.updatedAt = reply.createdAt
      Object.assign(submittedRun, normalized)
    },
  })
  const result = results[0]
  const latest = (result?.replies || [])[(result?.replies || []).length - 1]
  const completed = normalizeGithubRunResult({
    run,
    result,
    reply: latest,
    status: latest ? 'completed' : 'timeout',
    marker: parseRunnerResultMarker(latest?.body || ''),
  })
  if (latest?.createdAt && !completed.createdAt) completed.createdAt = latest.createdAt
  if (latest?.createdAt && !completed.updatedAt) completed.updatedAt = latest.createdAt

  const artifactSource = source || {
    type: 'single-run',
    transport: 'github',
    issueNumber,
    issueUrl,
    promptLength: promptText.length,
  }
  const sessionArtifact = persistAgentSessionArtifact({
    projectRoot,
    run: completed,
    source: artifactSource,
    createdAt: completed.createdAt || new Date().toISOString(),
    updatedAt: completed.updatedAt || new Date().toISOString(),
  })
  const runnerArtifact = completed.runnerId ? persistAgentRunnerArtifact({
    projectRoot,
    runnerId: completed.runnerId,
    agent: completed.agent,
    status: completed.status,
    session: sessionArtifact?.session || null,
    source: artifactSource,
    links: completed.links || {},
    createdAt: completed.createdAt || new Date().toISOString(),
    updatedAt: completed.updatedAt || new Date().toISOString(),
  }) : null

  const url = completed.links?.sessionUrl || completed.links?.agentRunUrl || completed.commentUrl || issueUrl
  if (url) console.log(`Result: ${url}`)
  if (sessionArtifact?.dir || runnerArtifact?.dir) {
    console.log('')
    if (sessionArtifact?.dir) console.log(`Session artifacts: ${sessionArtifact.dir}`)
    if (runnerArtifact?.dir) console.log(`Runner artifacts:  ${runnerArtifact.dir}`)
  }
}

async function chooseHandoffSourceInteractively({ projectRoot, latestSource }) {
  const clack = await loadClack()
  const sources = listHandoffSources(projectRoot).map((source) => ({
    ...source,
    displayPath: relativeDisplayPath(projectRoot, source.summaryPath),
  }))
  const options = handoffSourceMenuOptions({ sources, latestSource, projectRoot })
  console.log(formatHandoffSourceDetailBox(latestSource, projectRoot))
  console.log('')

  const selected = await clack.select({
    message: 'Hand off previous results',
    options,
  })
  if (clack.isCancel(selected) || selected === 'cancel') return { action: 'cancel' }
  if (selected === 'copy-latest') return { source: latestSource, action: 'copy' }
  if (selected === 'workflow-latest') return { source: latestSource, action: 'workflow' }

  const [, kind] = String(selected).split(':')
  const choices = sources.filter((source) => source.kind === kind)
  const picked = await clack.select({
    message: `Choose ${formatHandoffSourceKind(kind)}`,
    options: choices.map((source) => ({
      value: source.id,
      label: formatHandoffSourceLabel(source),
      hint: formatHandoffSourceHint(source, projectRoot),
    })),
  })
  if (clack.isCancel(picked)) return { action: 'cancel' }
  return { source: choices.find((source) => source.id === picked) || latestSource }
}

async function chooseHandoffActionInteractively(source) {
  const clack = await loadClack()
  const selected = await clack.select({
    message: 'What should happen next?',
    options: [
      { value: 'copy', label: 'Copy selected result to clipboard', hint: source.displayPath },
      { value: 'fresh', label: 'Start a new agent session with selected result', hint: formatHandoffSourceKind(source.kind) },
      { value: 'workflow', label: 'Run another workflow with selected result', hint: formatHandoffSourceKind(source.kind) },
      { value: 'cancel', label: 'Cancel' },
    ],
  })
  if (clack.isCancel(selected)) return 'cancel'
  return selected
}

async function handleHandoff(runId, options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  let handoff = readSelectedHandoffSource({ projectRoot, runId, options })

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
        source: handoff,
        options,
      })
      return
    }
    console.log(`Including prior results summary:\n${handoff.displayPath}`)
    await handleRun(options.flow, {
      ...options,
      projectRoot,
      context: promptText,
    })
    return
  }

  if (!process.stdin.isTTY) {
    console.log(`Source: ${handoff.kind || 'workflow'}`)
    console.log(`Summary: ${handoff.displayPath}`)
    console.log('Run `nax handoff` in a TTY to copy it or start another agent run.')
    return
  }

  const selectedSource = await chooseHandoffSourceInteractively({ projectRoot, latestSource: handoff })
  if (selectedSource.action === 'cancel') return
  handoff = selectedSource.source || handoff
  const action = selectedSource.action || await chooseHandoffActionInteractively(handoff)
  if (action === 'cancel') return
  if (action === 'copy') {
    const command = copyToClipboard(handoff.summaryText)
    console.log(`\nCopied ${handoff.displayPath} to clipboard with ${command}.`)
    return
  }

  const clack = await loadClack()
  const instructions = await promptForOptionalHandoffInstructions()
  const promptText = buildHandoffPrompt({
    instructions,
    summaryPath: handoff.displayPath,
    summaryText: handoff.summaryText,
  })

  if (action === 'fresh') {
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
      source: handoff,
      options,
    })
    return
  }

  const flowId = options.flow || await pickFlowInteractively({ includeAdHoc: false })
  if (clack.isCancel(flowId)) return
  console.log(`Including prior results summary:\n${handoff.displayPath}`)
  await handleRun(flowId, {
    ...options,
    projectRoot,
    context: joinContext(options.context, promptText),
  })
}

async function handlePreviewBoxes(flowId, options) {
  const id = flowId || (await pickFlowInteractively({ includeAdHoc: false }))
  if (isAdHocRunTarget(id)) {
    throw new Error('Preview boxes are only available for workflows.')
  }
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

async function selectSearchableOption({
  clack,
  message,
  options,
  placeholder = 'Type to filter...',
  maxItems = 10,
}) {
  if (typeof clack.autocomplete === 'function') {
    return clack.autocomplete({
      message,
      placeholder,
      options,
      maxItems,
    })
  }

  return clack.select({ message, options, maxItems })
}

async function pickFlowInteractively({ includeAdHoc = true } = {}) {
  const clack = await loadClack()
  const flows = await listFlows()
  if (includeAdHoc) {
    console.log('Run a single Netlify agent or orchestrate a multi-step agentic workflow.')
  }
  const options = [
    ...(includeAdHoc ? [{
      value: AD_HOC_RUN_TARGET,
      label: 'Start a single Netlify agent',
      hint: 'Run one Netlify agent with a custom prompt.',
    }] : []),
    ...flows.map((flow) => ({
      value: flow.id,
      label: includeAdHoc ? `Workflow - ${flow.title}` : flow.title,
      hint: flow.description,
    })),
    ...(includeAdHoc ? [{ value: 'cancel', label: 'Cancel' }] : []),
  ]
  const selected = await selectSearchableOption({
    clack,
    message: includeAdHoc ? 'What do you want to run?' : 'Choose workflow',
    options,
    placeholder: 'Type to filter workflows...',
  })
  if (clack.isCancel(selected) || selected === 'cancel') process.exit(0)
  return selected
}

async function chooseAdHocAgentInteractively(initialAgent) {
  if (initialAgent) return initialAgent
  const clack = await loadClack()
  const selected = await clack.select({
    message: 'Choose agent',
    options: DEFAULT_MODELS.map((model) => ({ value: model, label: titleCase(model) })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

async function promptForAdHocAgentPrompt(initialPrompt) {
  const prompt = String(initialPrompt || '').trim()
  if (prompt) return prompt
  if (!process.stdin.isTTY) {
    throw new Error('Netlify agent run prompt is required in non-TTY mode. Pass --prompt "..." or --context "...".')
  }
  const value = await multiline({
    message: 'Prompt for the Netlify agent run',
    placeholder: 'Describe what you want this agent to do.',
  })
  const text = String(value || '').trim()
  if (!text) throw new Error('Netlify agent run prompt cannot be empty.')
  return text
}

async function chooseTransportInteractively({ requested, projectRoot }) {
  const clack = await loadClack()
  const detections = detectTransports({ projectRoot })
  if (requested && requested !== 'auto') return resolveTransport(requested, detections)

  const available = detections.filter((transport) => transport.available)
  if (available.length === 1) return available[0].id
  if (available.length === 0) {
    throw new Error(formatTransportSetupHelp(detections))
  }

  const selected = await clack.select({
    message: 'Where should nax orchestrate this workflow?',
    options: available.map((transport) => ({
      value: transport.id,
      label: transport.title,
      hint: `ready — ${transport.reason}`,
    })),
  })
  if (clack.isCancel(selected)) process.exit(0)
  return selected
}

function orderSingleRunTransports(transports = []) {
  return [...transports].sort((a, b) => {
    if (a.id === NETLIFY_API_TRANSPORT) return -1
    if (b.id === NETLIFY_API_TRANSPORT) return 1
    return 0
  })
}

async function chooseSingleRunTransportInteractively({ requested, projectRoot }) {
  const detections = detectTransports({ projectRoot })
  if (requested && requested !== 'auto') {
    return resolveTransport(requested, detections)
  }
  const available = detections.filter((transport) => transport.available)
  if (available.length === 0) {
    throw new Error(formatTransportSetupHelp(detections))
  }
  if (!process.stdin.isTTY || available.length === 1) return available[0].id

  const clack = await loadClack()
  const selected = await clack.select({
    message: 'Where should we run this Netlify agent?',
    options: orderSingleRunTransports(available).map((transport) => ({
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
  const clack = await loadClack()
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
    if (!matched) throw new Error(`Could not find workflow ${runId} under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    return matched
  }
  return states[0] || null
}

function readHandoffSummary({ projectRoot, runId } = {}) {
  if (runId) {
    const runState = findRunStateForHandoff(projectRoot, { runId })
    if (!runState) throw new Error(`No nax workflows found under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    persistWorkflowArtifacts(runState, { summaryOnly: true })
    const summaryPath = handoffSummaryPath(runState)
    if (!summaryPath || !fs.existsSync(summaryPath)) {
      throw new Error(`Workflow ${runState.runId} does not have a handoff summary yet.`)
    }
    const summaryText = fs.readFileSync(summaryPath, 'utf8').trim()
    if (!summaryText) throw new Error(`Workflow ${runState.runId} has an empty handoff summary.`)
    return {
      kind: 'workflow',
      id: runState.runId,
      title: runState.flowTitle || runState.flowId || runState.runId,
      runState,
      summaryPath,
      displayPath: relativeHandoffPath(projectRoot, summaryPath),
      summaryText,
    }
  }
  return readHandoffSource(projectRoot)
}

function readSelectedHandoffSource({ projectRoot, runId = '', options = {} } = {}) {
  const query = handoffSourceQuery({ runId, options })
  return readHandoffSource(projectRoot, query)
}

function buildHandoffPrompt({ instructions = '', summaryPath = '', summaryText = '' } = {}) {
  return [
    String(instructions || '').trim()
      ? ['# Additional Instructions', '', String(instructions).trim()].join('\n')
      : '',
    [
      '# Prior Results Summary',
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

  const clack = await loadClack()
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
    message: `Start the "${configuredFlow.title}" agent workflow?`,
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

function buildCompactLocalPromptForRetry({ flow, step, runState, run }) {
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

function dateMs(value) {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function runStartMs(run = {}) {
  const session = run.rawResult?.latestSession || {}
  const runner = run.rawResult?.runner || {}
  return [
    run.startedAt,
    run.createdAt,
    session.created_at,
    session.createdAt,
    runner.created_at,
    runner.createdAt,
  ].map(dateMs).find((value) => value !== null) ?? null
}

function runEndMs(run = {}) {
  const session = run.rawResult?.latestSession || {}
  const runner = run.rawResult?.runner || {}
  return [
    run.finishedAt,
    run.completedAt,
    run.updatedAt,
    session.done_at,
    session.doneAt,
    session.updated_at,
    session.updatedAt,
    runner.done_at,
    runner.doneAt,
    runner.updated_at,
    runner.updatedAt,
  ].map(dateMs).find((value) => value !== null) ?? null
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return ''
  let seconds = Math.max(1, Math.round(durationMs / 1000))
  const hours = Math.floor(seconds / 3600)
  seconds -= hours * 3600
  const minutes = Math.floor(seconds / 60)
  seconds -= minutes * 60
  if (hours > 0) return `${hours}h ${minutes}min ${seconds}s`
  if (minutes > 0) return `${minutes}min ${seconds}s`
  return `${seconds}s`
}

function runDurationMs(run = {}) {
  const start = runStartMs(run)
  const end = runEndMs(run)
  return start !== null && end !== null && end >= start ? end - start : null
}

function stepDurationMs(runs = []) {
  const starts = runs.map(runStartMs).filter((value) => value !== null)
  const ends = runs.map(runEndMs).filter((value) => value !== null)
  if (starts.length > 0 && ends.length > 0) {
    const start = Math.min(...starts)
    const end = Math.max(...ends)
    if (end >= start) return end - start
  }
  const durations = runs.map(runDurationMs).filter((value) => value !== null)
  return durations.length > 0 ? Math.max(...durations) : null
}

function formatCreditsValue(value) {
  return Number.isFinite(value) ? `${value.toFixed(2).replace(/\.?0+$/, '')} credits` : ''
}

function formatCountValue(value, label) {
  return Number.isFinite(value) ? `${Number(value).toLocaleString('en-US')} ${label}` : ''
}

function agentStepCompletionSummary({ stepTitle, runs = [], failedCount = 0 } = {}) {
  const doneCount = runs.filter((run) => run.status === 'completed').length
  const duration = formatDurationMs(stepDurationMs(runs))
  const headerStatus = failedCount > 0
    ? `${doneCount}/${runs.length} complete, ${failedCount} failed`
    : `${doneCount}/${runs.length} complete`
  const header = `${stepTitle}: ${headerStatus}${duration ? ` - ${duration}` : ''}`
  const rows = runs.map((run) => {
    const usage = run.usage || {}
    return {
      agent: `${titleCase(run.agent || 'agent')}:`,
      status: run.status === 'completed' ? 'complete' : run.status || 'unknown',
      duration: formatDurationMs(runDurationMs(run)),
      credits: formatCreditsValue(usage.totalCreditsCost),
      steps: formatCountValue(usage.stepsCount, 'steps'),
      tokens: formatCountValue(usage.totalTokens, 'tokens'),
    }
  })
  const totalUsage = usageSummariesForRunState({ steps: [{ runs }] }).total
  const totalRow = {
    agent: 'Total:',
    credits: formatCreditsValue(totalUsage.totalCreditsCost),
    steps: formatCountValue(totalUsage.stepsCount, 'steps'),
    tokens: formatCountValue(totalUsage.totalTokens, 'tokens'),
  }
  const widths = {
    agent: Math.max(totalRow.agent.length, ...rows.map((row) => row.agent.length)),
    status: Math.max(0, ...rows.map((row) => row.status.length)),
    duration: Math.max(0, ...rows.map((row) => row.duration.length)),
    credits: Math.max(totalRow.credits.length, ...rows.map((row) => row.credits.length)),
    steps: Math.max(totalRow.steps.length, ...rows.map((row) => row.steps.length)),
    tokens: Math.max(totalRow.tokens.length, ...rows.map((row) => row.tokens.length)),
  }
  const formattedRows = rows.map((row) => [
    row.agent.padEnd(widths.agent),
    row.status.padEnd(widths.status),
    row.duration.padEnd(widths.duration),
    row.credits.padStart(widths.credits),
    row.steps.padStart(widths.steps),
    row.tokens.padStart(widths.tokens),
  ].join('  ').trimEnd())
  const formattedTotal = [
    totalRow.agent.padEnd(widths.agent),
    totalRow.credits.padStart(widths.credits),
    totalRow.steps.padStart(widths.steps),
    totalRow.tokens.padStart(widths.tokens),
  ].join('  ').trimEnd()
  return [header, ...formattedRows, formattedTotal].join('\n')
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

function localRetryCandidates(runState, { stepId, agent } = {}) {
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

async function makeProgressReporter(initialMessage) {
  if (!process.stdout.isTTY) {
    return {
      update: (message) => console.log(message),
      done: (message) => { if (message) console.log(message) },
      fail: (message) => { if (message) console.log(message) },
    }
  }
  const clack = await loadClack()
  const spinner = clack.spinner()
  spinner.start(initialMessage)
  return {
    update: (message) => spinner.message(message),
    done: (message) => spinner.stop(message || initialMessage),
    fail: (message) => spinner.stop(message || initialMessage, 1),
  }
}

function pickFlavor({ used = new Set(), random = Math.random } = {}) {
  if (flavorMessages.length === 0) return ['', '']
  const start = Math.floor(random() * flavorMessages.length)
  for (let offset = 0; offset < flavorMessages.length; offset += 1) {
    const candidate = flavorMessages[(start + offset) % flavorMessages.length]
    if (!used.has(candidate[0])) return candidate
  }
  return flavorMessages[start]
}

function pickAgentLabel(agents) {
  if (!agents || agents.length === 0) return 'Agent'
  return titleCase(agents[Math.floor(Math.random() * agents.length)])
}

const DEFAULT_ORCHESTRATOR = "Netlify Agent runner"
const STEP_SPINNER_FRAMES = ['◐', '◓', '◑', '◒']
const DID_YOU_KNOW_ROTATE_MS = 25000
const DID_YOU_KNOW_BORDER_COLORS = ['#00ad9f', '#22c55e', '#38bdf8', '#f59e0b', '#a78bfa']
const AGENT_RUNNER_USE_CASES = [
  ['🔨 Prototyping / internal tools', 'Turn rough operational needs into working internal apps.', 'Build an internal dashboard for our HR team.'],
  ['👀 Code reviews', 'Bring in a fresh reviewer that can inspect architecture, tests, and edge cases.', 'Audit the code with fresh eyes and identify areas for improvement.'],
  ['🔐 Security audits', 'Run deeper checks for auth gaps, data exposure, injection risk, and unsafe defaults.', 'Do a deep security audit of our code base to identify any potential issues.'],
  ['💡 Feature suggestions', 'Use the current code, docs, and product shape to find the next best bet.', 'Based on our current code base and docs, what should we build next?'],
  ['⚡ Performance improvements', 'Find slow paths, heavy bundles, expensive queries, and easy wins.', 'Scan our code base for performance bottlenecks and suggest improvements.'],
  ['📊 Telemetry and analytics', 'Spot missing events, weak funnels, and visibility gaps.', 'What analytics things are we not tracking but probably should?'],
  ['🔎 SEO audit', 'Check pages for crawlability, metadata, broken links, alt text, and page speed.', 'Audit our site for SEO issues like missing meta tags, broken links, slow pages, and missing alt text.'],
  ['✍️ Copy improvements', 'Tighten messaging, calls to action, and conversion copy.', 'Rewrite our landing page copy to be more compelling and conversion-focused.'],
  ['♿ Accessibility', 'Review keyboard flows, labels, contrast, landmarks, and WCAG gaps.', 'Run an accessibility audit and fix all WCAG 2.1 AA violations.'],
  ['📱 Mobile responsiveness', 'Inspect small viewports and fix layouts that collapse poorly.', 'Improve the mobile responsiveness and audit every page on small viewports.'],
  ['🎭 End-to-end tests', 'Cover critical user journeys with browser-level tests.', 'Add end-to-end tests for our critical user flows using Playwright.'],
  ['🧪 Unit tests', 'Backfill focused tests around utility functions and tricky logic.', 'Generate unit tests for our untested utility functions.'],
  ['📚 Documentation', 'Create docs from the actual project structure and workflows.', 'Generate a README and contributing guide based on our codebase.'],
  ['🚦 Error handling', 'Improve user-facing failures, logging, empty states, and recovery paths.', 'Add proper error boundaries, logging, and user-friendly error states throughout the app.'],
  ['✨ UX polish', 'Smooth rough edges with loading states, skeletons, and transitions.', 'Add loading states, skeleton screens, and transitions to improve perceived performance.'],
]

function nextFlavorAt({ min, max }) {
  const range = Math.max(0, max - min)
  return Date.now() + min + Math.floor(Math.random() * (range + 1))
}

function wrapLine(text, { width = 100, indent = '' } = {}) {
  const maxWidth = Math.max(20, width)
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    const prefix = lines.length === 0 ? '' : indent
    const next = current ? `${current} ${word}` : `${prefix}${word}`
    if (next.length > maxWidth && current) {
      lines.push(current)
      current = `${indent}${word}`
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

function agentRunUseCaseTitle(title) {
  const value = String(title || '').trim()
  const match = value.match(/^(\S+)\s+(.+)$/)
  if (!match) return `Use Agent Runs for ${value || 'more workflows'}`
  return `${match[1]} Use Agent Runs for ${match[2]}`
}

function formatDidYouKnowLines(useCase, {
  width = process.stdout.columns || 100,
  color = DID_YOU_KNOW_BORDER_COLORS[0],
} = {}) {
  if (!Array.isArray(useCase) || useCase.length < 2) return []
  const [title, description, prompt = ''] = useCase
  const boxWidth = Math.max(64, Math.min(width || 100, 118))
  const contentWidth = boxWidth - 6
  const content = [
    ...wrapLine(description, {
      width: contentWidth,
      indent: '',
    }),
    ...(prompt ? [
      '',
      'Prompt Examples:',
      ...wrapLine(`- "${prompt}"`, {
        width: contentWidth,
        indent: '  ',
      }),
    ] : []),
  ].join('\n')
  return [
    'While agent runners are doing their magic, here are some other use cases for Netlify Agent runners',
    ...makeBox({
      title: agentRunUseCaseTitle(title),
      content,
      borderStyle: 'rounded',
      borderColor: color,
      width: boxWidth,
    }).split('\n'),
  ]
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

function compactCurrentTask(value, { max = 96 } = {}) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function formatTtyProgressRow(row, { nameWidth, frame, orchestrator = DEFAULT_ORCHESTRATOR } = {}) {
  const name = titleCase(row.agent).padEnd(nameWidth, ' ')
  if (row.status === 'completed') return `✓ ${name} · 🟢 complete${row.url ? ` - ${row.url}` : ''}`
  if (row.status === 'failed') return `✖ ${name} · failed${row.message ? ` · ${row.message}` : ''}`
  const icon = STEP_SPINNER_FRAMES[frame % STEP_SPINNER_FRAMES.length]
  const label = row.message || `${row.emoji} ${orchestrator} ${row.phrase}`
  const currentTask = compactCurrentTask(row.currentTask)
  return `${icon} ${name} · ${label}${currentTask ? ` - "${currentTask}"` : ''}`
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
  const usedFlavorPhrases = (exceptRow) => new Set([...rows.values()]
    .filter((row) => row !== exceptRow && (row.status === 'pending' || row.status === 'running'))
    .map((row) => row.phrase)
    .filter(Boolean))
  const assignFlavor = (row) => {
    const [phrase, emoji] = pickFlavor({ used: usedFlavorPhrases(row) })
    row.phrase = phrase
    row.emoji = emoji
    row.nextFlavor = nextFlavorAt({ min: flavorMinMs, max: flavorMaxMs })
  }
  const createRow = (agent) => {
    const row = {
      agent,
      emoji: '',
      phrase: '',
      nextFlavor: 0,
      state: 'pending',
      status: 'pending',
      message: '',
      currentTask: '',
    }
    assignFlavor(row)
    return row
  }
  for (const agent of agents) {
    rows.set(agent, createRow(agent))
  }
  let frame = 0
  let renderedLines = 0
  let finished = false
  let didYouKnowIndex = 0
  let nextDidYouKnowAt = Date.now() + DID_YOU_KNOW_ROTATE_MS

  const rowForAgent = (agent) => {
    const key = agent || `agent-${rows.size + 1}`
    if (!rows.has(key)) rows.set(key, createRow(key))
    return rows.get(key)
  }

  const completeCount = () => [...rows.values()].filter((row) => row.status === 'completed').length
  const displayRows = () => [...rows.values()]
  const rotateFlavor = (row) => {
    if (row.status !== 'pending' && row.status !== 'running') return
    if (Date.now() < row.nextFlavor) return
    assignFlavor(row)
  }
  const renderRow = (row, nameWidth) => {
    return formatTtyProgressRow(row, { nameWidth, frame, orchestrator })
  }
  const renderLines = () => {
    const now = Date.now()
    if (AGENT_RUNNER_USE_CASES.length > 0 && now >= nextDidYouKnowAt) {
      didYouKnowIndex = (didYouKnowIndex + 1) % AGENT_RUNNER_USE_CASES.length
      nextDidYouKnowAt = now + DID_YOU_KNOW_ROTATE_MS
    }
    for (const row of rows.values()) rotateFlavor(row)
    const visibleRows = displayRows()
    const nameWidth = visibleRows.reduce((max, row) => Math.max(max, titleCase(row.agent).length), 0)
    const useCase = AGENT_RUNNER_USE_CASES[didYouKnowIndex]
    const useCaseColor = DID_YOU_KNOW_BORDER_COLORS[didYouKnowIndex % DID_YOU_KNOW_BORDER_COLORS.length]
    return [
      ...formatDidYouKnowLines(useCase, { color: useCaseColor }),
      '',
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
  process.stdout.write('\n')
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
        row.currentTask = ''
        row.url = event.run?.links?.sessionUrl || event.run?.links?.agentRunUrl || ''
      } else if (event.terminalFailure || event.run?.status === 'failed' || event.run?.status === 'timeout') {
        row.status = 'failed'
        row.message = event.error || event.run?.resultText || event.state || ''
        row.currentTask = ''
        row.url = ''
      } else {
        row.status = 'running'
        row.message = event.retry ? 'retrying once after transient capacity error' : ''
        row.currentTask = event.currentTask || event.run?.currentTask || row.currentTask || ''
        row.url = ''
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

function reportTerminalLocalRun(reporter, run, projectRoot) {
  addLocalRunLinks(run, projectRoot)
  reporter.updateRun({
    run,
    state: run.status,
    terminal: run.status === 'completed' || run.status === 'failed' || run.status === 'timeout',
    terminalSuccess: run.status === 'completed',
    terminalFailure: run.status === 'failed' || run.status === 'timeout',
  })
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
          reportTerminalLocalRun(reporter, run, projectRoot)
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
      const failedCount = completedRuns.filter((r) => r.status === 'failed' || r.status === 'timeout').length
      const completionSummary = agentStepCompletionSummary({
        stepTitle: step.title,
        runs: completedRuns,
        failedCount,
      })
      if (failedCount > 0) {
        reporter.fail(completionSummary)
      } else {
        reporter.done(completionSummary)
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
  const netlifyFilter = resolveNetlifyFilter({ projectRoot, filter: options.filter })
  maybeReportNetlifyFilter(netlifyFilter)

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
          netlifyFilter: netlifyFilter.filter,
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
    console.log(`State: ${workflowStatePath(runState.dir)}`)
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
    console.log(`State: ${workflowStatePath(runState.dir)}`)
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

function findRunStateForRetry(projectRoot, { runId, flowId, stepId, agent } = {}) {
  const states = listRunStates(projectRoot)
  if (runId) {
    const matched = states.find((state) => state.runId === runId)
    if (!matched) throw new Error(`Could not find workflow ${runId} under ${path.join(projectRoot, '.nax', 'workflows')}.`)
    return matched
  }
  const matched = states.find((state) => {
    if (!isNetlifyApiTransport(state.transport)) return false
    if (flowId && state.flowId !== flowId) return false
    return localRetryCandidates(state, { stepId, agent }).length > 0
  })
  if (!matched) throw new Error('Could not find a failed Netlify API run to retry. Pass a run id explicitly.')
  return matched
}

async function handleRetry(runId, options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const runState = findRunStateForRetry(projectRoot, {
    runId,
    flowId: options.flow,
    stepId: options.step,
    agent: options.agent,
  })
  if (!isNetlifyApiTransport(runState.transport)) {
    throw new Error(`Run ${runState.runId} uses ${runState.transport || 'unknown'} transport; retry currently supports Netlify API runs only.`)
  }

  const flow = await loadFlow(runState.flowId)
  const candidates = localRetryCandidates(runState, {
    stepId: options.step,
    agent: options.agent,
  })
  if (candidates.length === 0) {
    throw new Error(`Run ${runState.runId} has no failed Netlify API runner matching the requested filters.`)
  }
  if (candidates.length > 1) {
    const choices = candidates.map(({ step, run }) => `${step.id}:${run.agent}`).join(', ')
    throw new Error(`More than one failed Netlify API runner can be retried (${choices}). Pass --step and --agent.`)
  }

  trackRunState(runState)
  const [{ step, stepIndex, run, runIndex }] = candidates
  const flowStep = flow.steps.find((candidate) => candidate.id === step.id)
  if (!flowStep) throw new Error(`Flow ${flow.id} no longer contains step ${step.id}.`)

  const netlify = buildNetlifyEnv({ projectRoot })
  const branch = runState.branch || runState.options?.branch || currentGitBranch(projectRoot)
  const netlifyFilter = resolveNetlifyFilter({ projectRoot, filter: options.filter || runState.options?.filter })
  const compactPromptText = buildCompactLocalPromptForRetry({ flow, step: flowStep, runState, run })
  if (!compactPromptText || compactPromptText.length >= String(run.promptText || '').length) {
    throw new Error(`Could not build a shorter prompt for ${run.agent} ${step.id}.`)
  }

  console.log(`Retrying ${titleCase(run.agent)} ${step.title}`)
  console.log(`Run: ${runState.runId}`)
  console.log(`Runner: ${run.runnerId}`)
  console.log(`Prompt: ${String(run.promptText || '').length} -> ${compactPromptText.length} chars`)
  maybeReportNetlifyFilter(netlifyFilter)

  const retryRun = {
    ...run,
    status: 'pending',
    promptText: compactPromptText,
    compactPromptText,
    resultText: '',
    existingRunnerId: run.runnerId,
    promptShrinkRetryCount: Number(run.promptShrinkRetryCount || 0) + 1,
    raw: {
      ...run.raw,
      retry: {
        reason: 'manual-compact-prompt',
        previousStatus: run.status,
        previousResultText: run.resultText || '',
      },
    },
  }
  const submitted = await submitLocalAgentRun({
    run: retryRun,
    projectRoot,
    branch,
    siteId: netlify.siteId,
    netlifyFilter: netlifyFilter.filter,
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
      reportTerminalLocalRun(reporter, terminalRun, projectRoot)
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
    throw new Error(`Retried ${run.agent} run did not complete successfully.`)
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

async function handleAdHocAgentRun(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const transport = await chooseSingleRunTransportInteractively({
    requested: options.transport || 'auto',
    projectRoot,
  })
  const agent = await chooseAdHocAgentInteractively(options.agent)
  const promptText = await promptForAdHocAgentPrompt(options.prompt || options.context)
  if (options.dryRun) {
    console.log('Netlify agent run preview')
    console.log(`Transport: ${transport}`)
    console.log(`Agent: ${titleCase(agent)}`)
    console.log(`Prompt: ${promptText.length} chars`)
    console.log('')
    console.log(promptText)
    return
  }

  if (isNetlifyApiTransport(transport)) {
    await runSingleNetlifyAgent({
      projectRoot,
      agent,
      promptText,
      title: 'Netlify Agent Run',
      source: {
        type: 'single-run',
        transport: NETLIFY_API_TRANSPORT,
        promptLength: promptText.length,
      },
      raw: {
        stepId: 'netlify-agent-run',
        promptName: 'netlify-agent-run',
      },
      options,
      startLabel: 'Netlify agent run',
    })
    return
  }

  await runSingleGithubAgent({
    projectRoot,
    agent,
    promptText,
    source: {
      type: 'single-run',
      transport: 'github',
      promptLength: promptText.length,
    },
    options,
  })
}

async function handleRun(flowId, options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  if (flowId === 'ls' || flowId === 'list') {
    await handleList()
    return
  }
  const wantsAdHoc = !flowId && (options.agent || options.prompt)
  const resolvedFlowId = flowId || (wantsAdHoc ? AD_HOC_RUN_TARGET : (process.stdin.isTTY ? await pickFlowInteractively() : 'review'))
  if (isAdHocRunTarget(resolvedFlowId)) {
    await handleAdHocAgentRun({ ...options, projectRoot })
    return
  }
  const flow = await loadFlow(resolvedFlowId)

  const resumable = findLatestUnfinishedRun(projectRoot, { flowId: flow.id })
  if (resumable && process.stdin.isTTY && !options.yes && !options.dryRun) {
    const clack = await loadClack()
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
  console.log(`State: ${workflowStatePath(runState.dir)}`)

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
  const clack = await loadClack()
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
    .option('--agent <name>', 'Agent for a Netlify agent run, e.g. codex')
    .option('--prompt <text>', 'Prompt text for a Netlify agent run')
    .option('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs')
    .option('--transport <transport>', 'Where to run: auto, github, netlify-api', 'auto')
    .addOption(new Option('--where <place>', 'Hidden compatibility alias for --transport').hideHelp())
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
    .description('Set up this repository for Netlify Agent Runner workflows')
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
    .description('Run a Netlify Agent Runner workflow')
    .option('--project-root <path>', 'Project root for flow execution')
    .option('--repo <owner/name>', 'GitHub repo; defaults to gh repo view')
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--context <text>', 'Additional context appended to each prompt')
    .option('--agent <name>', 'Agent for a Netlify agent run, e.g. codex')
    .option('--prompt <text>', 'Prompt text for a Netlify agent run')
    .option('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs')
    .option('--transport <transport>', 'Where to run: auto, github, netlify-api', 'auto')
    .addOption(new Option('--where <place>', 'Hidden compatibility alias for --transport').hideHelp())
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
    .command('recent')
    .description('Pick a recent workflow, agent runner, or agent session artifact')
    .option('--run-id <id>', 'Skip the picker and show a specific artifact id')
    .option('--type <kind>', 'Filter by workflow, agent-runner, agent-session, or all', 'all')
    .option('--limit <n>', 'Maximum artifacts to show in the picker', '25')
    .action((options, command) => handleRecent(actionOptions(options, command)))

  const addRetryOptions = (command) => command
    .option('--project-root <path>', 'Project root containing .nax workflows and agent artifacts')
    .option('--flow <id>', 'Flow id filter when run id is omitted')
    .option('--step <id>', 'Failed step id to retry')
    .option('--agent <name>', 'Failed agent to retry, e.g. claude')
    .option('--timeout-minutes <count>', 'Minutes to wait for the retried run', '25')
    .action((runId, options, command) => handleRetry(runId || '', actionOptions(options, command)))

  addRetryOptions(
    program
      .command('retry [run-id]')
      .description('Retry one failed Netlify API agent run with a compact prompt, then continue the workflow'),
  )

  program
    .command('handoff [run-id]')
    .description('Copy or continue from the latest workflow, agent runner, or agent session summary')
    .option('--project-root <path>', 'Project root containing .nax workflows and agent artifacts')
    .option('--run-id <id>', 'Workflow run id to hand off')
    .option('--source <id>', 'Artifact source id to hand off')
    .option('--source-type <kind>', 'Artifact source kind: workflow, agent-runner, or agent-session')
    .option('--workflow <id>', 'Workflow artifact id to hand off')
    .option('--runner <id>', 'Agent runner id to hand off')
    .option('--session <id>', 'Agent session id to hand off')
    .option('-c, --copy', 'Copy the selected summary to the clipboard and exit')
    .option('--agent <name>', 'Agent for a fresh handoff run, e.g. codex')
    .option('--flow <id>', 'Workflow id to run with the summary as context')
    .option('--transport <transport>', 'Transport for chained workflows: auto, github-actions, netlify-api, local-machine', 'auto')
    .addOption(new Option('--where <place>', 'Hidden compatibility alias for --transport').hideHelp())
    .option('--branch <branch-or-pr>', 'Git branch or PR number to run in Netlify agent runners')
    .option('--filter <app>', 'Netlify CLI monorepo app filter for local Netlify agent runs')
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
    .alias('ls')
    .description('List available workflows')
    .action(handleList)

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
    buildCompactLocalPromptForRetry,
    buildHandoffPrompt,
    compactTextForRetry,
    copyToClipboard,
    findGithubRunnerFailures,
    findRunStateForHandoff,
    formatDidYouKnowLines,
    formatHandoffSourceHint,
    formatHandoffSourceKind,
    formatHandoffSourceLabel,
    formatHandoffSourceDetailBox,
    handoffSourceDetailTitle,
    handoffSourceDetailLines,
    compactCurrentTask,
    formatTtyProgressRow,
    formatSubmittedLocalRunBoxes,
    handoffSummaryPath,
    handoffSourceMenuOptions,
    handoffSourceQuery,
    isAdHocRunTarget,
    orderSingleRunTransports,
    nextLocalStepMessage,
    localRetryCandidates,
    agentStepCompletionSummary,
    normalizeHandoffSourceKind,
    pickFlavor,
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
