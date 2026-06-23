const { DEFAULT_MODELS } = require('../../core/constants')
const { formatGroupHint, listRecentIssueGroups } = require('../../integrations/github/issue-groups')
const { resolveProjectRoot } = require('../../integrations/netlify/project-selection')
const { listPrompts, resolveRepo, titleCase } = require('../../workflows/catalog/prompts')
const { assertCrossReviewComplete, rawIssuesFromResults } = require('../../workflows/round-results')
const { multiline } = require('../../utils/multiline')
const {
  buildCommentPlan,
  buildPlan,
  createDiscussionComment,
  createIssue,
  fetchRoundResultsForOptions,
  joinContext,
  parseCsv,
  printCommentPlan,
  printPlan,
  readAutoContext,
  readContext,
  readManualContext,
  shouldEmbedAllReplies,
  shouldFetchResults,
} = require('../../integrations/github/issue-plan')

/**
 * Issue/comment command options used by the CLI handlers.
 * @typedef {import('../../integrations/github/issue-plan').GithubPlanOptions & {
 *   yes?: boolean,
 *   dryRun?: boolean,
 *   projectRoot?: string,
 *   skipRoundCheck?: boolean,
 *   contextPrompt?: boolean,
 * }} IssueCommandOptions
 *
 * Issue/comment plan input passed into the fallback planner.
 * @typedef {Record<string, unknown> & {
 *   promptName: string,
 *   options: IssueCommandOptions,
 *   context?: string,
 *   roundResultsRaw?: import('../../workflows/round-results').RoundResult[],
 *   projectRoot?: string,
 *   runState?: import('../../types').WorkflowRunState,
 *   stepState?: import('../../types').WorkflowStep,
 *   step?: import('../../types').WorkflowStep,
 * }} IssuePlanInput
 *
 * Minimal Clack prompt API used by issue/comment handlers.
 * @typedef {{
 *   select: (input: Record<string, unknown>) => Promise<unknown>,
 *   multiselect: (input: Record<string, unknown>) => Promise<unknown>,
 *   text: (input: Record<string, unknown>) => Promise<unknown>,
 *   confirm: (input: Record<string, unknown>) => Promise<unknown>,
 *   isCancel: (value: unknown) => boolean,
 * }} IssueClackApi
 *
 * Dependencies that remain owned by later extraction beads.
 * @typedef {{
 *   buildAndMaybeFallbackPlan: (
 *     input: IssuePlanInput,
 *     planBuilder: typeof buildPlan | typeof buildCommentPlan
 *   ) => import('../../integrations/github/issue-plan').GithubIssuePlan | import('../../integrations/github/issue-plan').GithubCommentPlan,
 *   loadClack?: () => Promise<IssueClackApi>,
 *   exit?: (code: number) => never,
 * }} IssueCliDependencies
 */

let clackModulePromise

/** @returns {Promise<IssueClackApi>} */
async function defaultLoadClack() {
  clackModulePromise = clackModulePromise || import('@clack/prompts')
  return clackModulePromise
}

/** @param {unknown} value @returns {string} */
function selectedString(value) {
  return String(value || '')
}

/** @param {IssueClackApi} clack @param {(code: number) => never} exit @param {unknown} value */
function exitIfCancel(clack, exit, value) {
  if (clack.isCancel(value)) exit(0)
}

/**
 * Prompts for a workflow prompt name.
 * @param {{ loadClack?: () => Promise<IssueClackApi>, exit?: (code: number) => never }} [dependencies]
 * @returns {Promise<string>}
 */
async function pickPromptInteractively({ loadClack = defaultLoadClack, exit = process.exit } = {}) {
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
  exitIfCancel(clack, exit, selected)
  return selectedString(selected)
}

/**
 * Selects a recent issue group or manual issue list.
 * @param {{
 *   clack: IssueClackApi,
 *   options: IssueCommandOptions,
 *   message: string,
 *   allowSkip?: boolean,
 *   exit?: (code: number) => never,
 * }} input
 * @returns {Promise<string | null>}
 */
async function selectIssueGroup({ clack, options, message, allowSkip = false, exit = process.exit }) {
  let groups
  try {
    groups = listRecentIssueGroups({ repo: resolveRepo(options.repo) })
  } catch (error) {
    const detail = error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error)
    console.error(`Could not load recent issues for auto-discovery: ${detail}`)
    return null
  }

  const groupOptions = groups.slice(0, 12).map((group) => ({
    value: group.issueNumbers.join(','),
    label: `${group.date} ${group.promptTitle}`,
    hint: formatGroupHint(group),
  }))

  groupOptions.push({ value: '__manual__', label: 'Enter issue numbers manually', hint: '' })
  if (allowSkip) groupOptions.push({ value: '__skip__', label: 'Skip — no prior round results', hint: '' })

  const selected = await clack.select({ message, options: groupOptions })
  exitIfCancel(clack, exit, selected)

  if (selected === '__skip__') return ''
  if (selected === '__manual__') {
    const text = await clack.text({
      message: 'Issue numbers (comma-separated)',
      placeholder: '29,30,31',
      validate: (value) => (value && String(value).trim() ? undefined : 'Enter at least one issue number'),
    })
    exitIfCancel(clack, exit, text)
    return selectedString(text).trim()
  }
  return selectedString(selected)
}

/**
 * Collects issue creation input interactively.
 * @param {string | undefined} initialPromptName
 * @param {IssueCommandOptions} options
 * @param {{ loadClack?: () => Promise<IssueClackApi>, exit?: (code: number) => never }} [dependencies]
 * @returns {Promise<IssuePlanInput>}
 */
async function chooseInteractively(initialPromptName, options, { loadClack = defaultLoadClack, exit = process.exit } = {}) {
  const clack = await loadClack()
  const promptName = initialPromptName || (await pickPromptInteractively({ loadClack, exit }))

  let fromIssues = String(options.fromIssues || options.fromIssue || '')
  if (!fromIssues && shouldFetchResults(promptName) && options.fetchResults !== false) {
    const message = promptName === 'summarize-consensus'
      ? 'Choose prior round to summarize'
      : 'Choose source round to embed'
    fromIssues = await selectIssueGroup({
      clack,
      options,
      message,
      allowSkip: true,
      exit,
    }) || ''
  }

  const isSummarize = promptName === 'summarize-consensus'
  const modelOrder = isSummarize
    ? ['codex', ...DEFAULT_MODELS.filter((model) => model !== 'codex')]
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
    exitIfCancel(clack, exit, selectedModels)
    models = Array.isArray(selectedModels) ? selectedModels.map(String) : []
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

/**
 * Collects comment creation input interactively.
 * @param {string | undefined} initialPromptName
 * @param {IssueCommandOptions} options
 * @param {{ loadClack?: () => Promise<IssueClackApi>, exit?: (code: number) => never }} [dependencies]
 * @returns {Promise<IssuePlanInput>}
 */
async function chooseCommentInteractively(initialPromptName, options, { loadClack = defaultLoadClack, exit = process.exit } = {}) {
  const clack = await loadClack()
  const promptName = initialPromptName || (await pickPromptInteractively({ loadClack, exit }))

  let issues = String(options.issues || options.issue || '')
  if (!issues) {
    if (promptName === 'cross-review') {
      issues = await selectIssueGroup({
        clack,
        options,
        message: 'Choose round to comment on',
        exit,
      }) || ''
    } else {
      const selectedIssues = await clack.text({
        message: 'Issue numbers (comma-separated)',
        placeholder: '29,30,31',
        validate: (value) => (value && String(value).trim() ? undefined : 'Enter at least one issue number'),
      })
      exitIfCancel(clack, exit, selectedIssues)
      issues = selectedString(selectedIssues).trim()
    }
  }

  let fromIssues = String(options.fromIssues || options.fromIssue || '')
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

/** @param {IssueCliDependencies} dependencies */
function createIssueHandlers({ buildAndMaybeFallbackPlan, loadClack = defaultLoadClack, exit = process.exit }) {
  /** @param {string | undefined} promptName @param {IssueCommandOptions} options */
  async function handleIssue(promptName, options) {
    const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: process.cwd() })
    const wantsInteractive = process.stdin.isTTY && (!promptName || !options.yes)
    let resolvedPromptName = promptName
    if (wantsInteractive && !resolvedPromptName) {
      resolvedPromptName = await pickPromptInteractively({ loadClack, exit })
    }
    resolvedPromptName = resolvedPromptName || 'review'
    if (wantsInteractive && resolvedPromptName === 'cross-review') {
      return handleComment(resolvedPromptName, options)
    }

    const input = wantsInteractive
      ? await chooseInteractively(resolvedPromptName, options, { loadClack, exit })
      : {
          promptName: resolvedPromptName,
          options,
          context: readContext(options),
          roundResultsRaw: fetchRoundResultsForOptions(options, {
            embedAll: shouldEmbedAllReplies(resolvedPromptName),
          }),
        }
    const stepState = input.stepState || { id: input.promptName || resolvedPromptName || 'github' }
    const runState = input.runState || {
      runId: `github-${Date.now()}`,
      projectRoot,
      blobRefs: [],
      steps: [stepState],
      transport: 'github',
    }
    const enrichedInput = {
      ...input,
      projectRoot,
      runState,
      stepState,
      step: input.step || { id: stepState.id },
    }

    if (
      input.promptName === 'summarize-consensus' &&
      options.skipRoundCheck !== true &&
      Array.isArray(enrichedInput.roundResultsRaw) &&
      enrichedInput.roundResultsRaw.length > 0
    ) {
      assertCrossReviewComplete(rawIssuesFromResults(enrichedInput.roundResultsRaw))
    }

    const plan = /** @type {import('../../integrations/github/issue-plan').GithubIssuePlan} */ (
      buildAndMaybeFallbackPlan(enrichedInput, buildPlan)
    )
    printPlan(plan, { dryRun: options.dryRun })
    if (options.dryRun) {
      for (const issue of plan.issues) console.log(`\n--- ${issue.title} ---\n${issue.body}`)
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

  /** @param {string | undefined} promptName @param {IssueCommandOptions} options */
  async function handleComment(promptName, options) {
    const projectRoot = resolveProjectRoot(options.projectRoot, { cwd: process.cwd() })
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
      ? await chooseCommentInteractively(promptName, options, { loadClack, exit })
      : {
          promptName: resolvedPromptName,
          options: nonInteractiveOptions,
          context: readContext(nonInteractiveOptions),
          roundResultsRaw: fetchRoundResultsForOptions(nonInteractiveOptions, {
            embedAll: shouldEmbedAllReplies(resolvedPromptName),
          }),
        }
    const stepState = input.stepState || { id: input.promptName || resolvedPromptName || 'github-comment' }
    const runState = input.runState || {
      runId: `github-${Date.now()}`,
      projectRoot,
      blobRefs: [],
      steps: [stepState],
      transport: 'github',
    }
    const enrichedInput = {
      ...input,
      projectRoot,
      runState,
      stepState,
      step: input.step || { id: stepState.id },
    }

    const plan = /** @type {import('../../integrations/github/issue-plan').GithubCommentPlan} */ (
      buildAndMaybeFallbackPlan(enrichedInput, buildCommentPlan)
    )
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

  return { handleComment, handleIssue }
}

module.exports = {
  chooseCommentInteractively,
  chooseInteractively,
  createIssueHandlers,
  pickPromptInteractively,
  selectIssueGroup,
}
