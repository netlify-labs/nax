const { parseRunnerResultMarker } = require('../comment-markers')
const { normalizeGithubRunResult } = require('../agent-run-results')
const { WAIT_FOR_AGENT_RESULTS, isHumanReviewStep, loadStepPrompt } = require('../flows')
const { buildGithubFullPromptWrapper, applyContextFetchClassification, blobOffloadDisabled, cleanupWorkflowBlobsForRun, ensureGithubIssueFullPromptBlobOffload, ensureGithubPlanBlobOffload, githubIssueDeliveryKey, localSafePromptBytes, optionalNetlifyForBlobOffload } = require('./prompt-delivery')
const { getLocalDate, resolveRepo } = require('../prompts')
const { saveRunState, workflowStatePath } = require('../run-state')
const { clearTrackedRunState, trackRunState } = require('../graceful-run-state')
const { persistRunArtifact, persistStepArtifacts } = require('../workflow-artifacts')
const { formatRoundResults } = require('../round-results')
const { parseIssueNumberFromUrl, shouldPollGithubRun } = require('./progress')
const { emitRunArtifact, emitStepArtifacts, requireHumanReview } = require('./local-executor')
const { completedStepMapFromRunState, contextForRunState, contextWithOutputBudget, firstRunnableStepIndex, sourceIssueNumbersForStep } = require('./execution-context')
const { BODY_FALLBACK_THRESHOLD, enforceGithubActionPromptBudget, githubActionPromptBudgetLabel, githubSafePromptBytes: githubSafePromptBytesWithLocalBudget, utf8ByteLength } = require('../github/prompt-budget')
const { ROUND_LABEL_BY_PROMPT, buildCommentPlan, buildPlan, createDiscussionComment, createIssue, fetchRoundResultsForOptions, printCommentPlan, printPlan, shouldEmbedAllReplies } = require('../github/issue-plan')
const { githubStepStatus, waitForGithubStep } = require('../github/polling')

/** @param {GithubExecutorOptions} [options] @returns {number} */
function githubSafePromptBytes(options = {}) {
  return githubSafePromptBytesWithLocalBudget(options, { localSafePromptBytes })
}

/**
 * GitHub workflow execution options.
 * @typedef {import('../types').JsonMap & {
 *   contextFetchPolicy?: string,
 *   date?: string,
 *   dryRun?: boolean,
 *   fetchResults?: boolean,
 *   fromIssue?: string,
 *   fromIssues?: string,
 *   fromIssuesHeading?: string,
 *   issue?: string,
 *   issues?: string,
 *   labels?: string,
 *   repo?: string,
 *   runner?: string,
 *   timeoutMinutes?: string | number,
 * }} GithubExecutorOptions
 *
 * Runtime event callbacks used by GitHub workflow execution.
 * @typedef {import('../types').JsonMap & {
 *   agentStatus?: (status: string, run?: import('../types').AgentRun, stepState?: import('../types').WorkflowStep, step?: import('../types').WorkflowStep, details?: import('../types').JsonMap) => void,
 *   stepStatus?: (status: string, stepState?: import('../types').WorkflowStep, step?: import('../types').WorkflowStep, details?: import('../types').JsonMap) => void,
 *   workflowStatus?: (status: string, details?: import('../types').JsonMap) => void,
 *   artifactWritten?: (type: string, filePath: string, details?: import('../types').JsonMap) => void,
 * }} WorkflowRuntimeEvents
 */

/**
 * Input used to build a GitHub issue/comment plan with fallback delivery.
 * @typedef {import('../types').JsonMap & {
 *   promptName?: string,
 *   prompt?: import('../types').JsonMap,
 *   options: GithubExecutorOptions,
 *   context?: string,
 *   roundResultsRaw?: import('../types').GitHubIssue[],
 *   hasFutureSteps?: boolean,
 *   runState?: import('../types').WorkflowRunState,
 *   stepState?: import('../types').WorkflowStep,
 *   step?: import('../types').WorkflowStep,
 *   projectRoot?: string,
 *   netlify?: import('../types').JsonMap,
 * }} GithubFallbackPlanInput
 *
 * GitHub issue/comment plan produced by issue planning helpers.
 * @typedef {import('../types').JsonMap & {
 *   repo?: string,
 *   labels?: string[],
 *   issues?: Array<import('../types').JsonMap & {
 *     body?: string,
 *     issueNumber?: string | number,
 *     issueTitle?: string,
 *     issueUrl?: string,
 *     model?: string,
 *     promptDelivery?: import('../types').JsonMap & { blobRef?: import('../types').BlobRef },
 *     targetKind?: string,
 *     targetNumber?: string | number,
 *     targetRepo?: string,
 *     targetUrl?: string,
 *     title?: string,
 *   }>,
 * }} GithubIssuePlan
 *
 * Builder callback for GitHub issue/comment plans.
 * @typedef {(input: GithubFallbackPlanInput & { roundResults?: string }) => GithubIssuePlan} GithubPlanBuilder
 */

/**
 * Shared input for GitHub workflow executor helpers.
 * @typedef {{
 *   flow?: import('../types').WorkflowFlow,
 *   steps?: import('../types').WorkflowStep[],
 *   options?: GithubExecutorOptions,
 *   runState?: import('../types').WorkflowRunState,
 *   projectRoot?: string,
 *   completedStepStates?: Map<string, import('./execution-context').ExecutionStepState>,
 *   runtimeEvents?: WorkflowRuntimeEvents,
 * }} GithubWorkflowExecutionInput
 *
 * Input for completing one GitHub workflow step.
 * @typedef {GithubWorkflowExecutionInput & {
 *   repo?: string,
 *   stepState?: import('../types').WorkflowStep,
 *   step?: import('../types').WorkflowStep,
 * }} CompleteGithubStepInput
 */

function buildAndMaybeFallbackPlan(input, planBuilder) {
  const heading = input.options.fromIssuesHeading || ROUND_LABEL_BY_PROMPT[input.promptName] || 'Prior Round Outputs'
  const results = Array.isArray(input.roundResultsRaw) ? input.roundResultsRaw : []
  const context = contextWithOutputBudget(input.context, input.options, {
    hasPriorResults: results.length > 0,
    hasFutureSteps: input.hasFutureSteps === true,
  })

  const formatFor = (structuredOnly) =>
    results.length === 0 ? '' : formatRoundResults({ heading, results, structuredOnly })

  const fullRoundResults = formatFor(false)
  let plan = planBuilder({ ...input, context, roundResults: fullRoundResults })
  const originalIssueBodies = new Map((plan.issues || []).map((issue) => [githubIssueDeliveryKey(issue), issue.body]))
  const safeBytes = githubSafePromptBytes(input.options)
  const promptUnsafe = plan.issues.some((issue) => utf8ByteLength(issue.body) > safeBytes)

  if (promptUnsafe && results.length > 0 && !blobOffloadDisabled(input.options)) {
	    const netlify = input.netlify || optionalNetlifyForBlobOffload({ projectRoot: input.projectRoot, options: input.options })
    if (netlify) {
      try {
        const ref = ensureGithubPlanBlobOffload({
          results,
          fullRoundResults,
          runState: input.runState,
          stepState: input.stepState,
          step: input.step,
          projectRoot: input.projectRoot,
          netlify,
          options: input.options,
          dryRun: input.options.dryRun === true,
        })
        plan = planBuilder({ ...input, context, roundResults: ref.offloadedRoundResults })
        for (const issue of plan.issues) {
          issue.promptDelivery = {
            mode: 'blob',
            promptBytes: utf8ByteLength(issue.body),
            safePromptBytes: safeBytes,
            blobRef: {
              id: ref.id,
              store: ref.store,
              key: ref.key,
              marker: ref.marker,
              sentinel: ref.sentinel,
            },
            contextFetchPolicy: input.options.contextFetchPolicy || input.step?.contextFetchPolicy || 'optional',
          }
        }
      } catch (error) {
        console.error(`Warning: GitHub prompt blob offload failed; trying compact fallback. ${error?.message || String(error)}`)
      }
    } else {
      console.error('Warning: GitHub prompt blob offload skipped because Netlify site/token context is unavailable; trying compact fallback.')
    }
  }

  const oversized = plan.issues.some((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD || utf8ByteLength(issue.body) > safeBytes)
  if (oversized && results.length > 0 && !plan.issues.every((issue) => issue.promptDelivery?.mode === 'blob')) {
    const offending = plan.issues.find((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD)
    console.error(
      `Issue body is ${(offending || plan.issues[0]).body.length} chars; ` +
        'falling back to structured-findings JSON only for embedded round outputs.',
    )
    const structuredRoundResults = formatFor(true)
    plan = planBuilder({ ...input, context, roundResults: structuredRoundResults })
    const stillOversized = plan.issues.find((issue) => issue.body.length > BODY_FALLBACK_THRESHOLD)
    if (stillOversized) {
      console.error(
        `Warning: structured-only body is still ${stillOversized.body.length} chars (over ${BODY_FALLBACK_THRESHOLD}); ` +
          'gh issue create may fail. Consider --no-auto-context or fewer source issues.',
      )
    }
  }

  const stillUnsafe = (plan.issues || []).filter((issue) => utf8ByteLength(issue.body) > safeBytes)
  if (stillUnsafe.length > 0 && !blobOffloadDisabled(input.options)) {
    const netlify = input.netlify || optionalNetlifyForBlobOffload({ projectRoot: input.projectRoot, options: input.options })
    if (netlify) {
      for (const issue of stillUnsafe) {
        const originalBody = originalIssueBodies.get(githubIssueDeliveryKey(issue)) || issue.body
        const ref = ensureGithubIssueFullPromptBlobOffload({
          issue,
          promptBody: originalBody,
          runState: input.runState,
          stepState: input.stepState,
          step: input.step,
          projectRoot: input.projectRoot,
          netlify,
          options: input.options,
          dryRun: input.options.dryRun === true,
        })
        const wrapper = buildGithubFullPromptWrapper({
          runner: input.options.runner || '@netlify',
          model: issue.model,
          blobRef: ref,
        })
        const wrapperBytes = utf8ByteLength(wrapper)
        if (wrapperBytes > safeBytes) {
          throw new Error([
            `GitHub full-prompt wrapper for ${githubActionPromptBudgetLabel(issue)} still exceeds the safe prompt budget.`,
            `Wrapper prompt: ${wrapperBytes.toLocaleString()} bytes.`,
            `Safe budget: ${safeBytes.toLocaleString()} bytes.`,
            `Blob: ${ref.store}/${ref.key}.`,
          ].join(' '))
        }
        issue.body = wrapper
        issue.promptDelivery = {
          mode: 'blob',
          kind: 'full-prompt',
          promptBytes: utf8ByteLength(originalBody),
          safePromptBytes: safeBytes,
          offloadedPromptBytes: wrapperBytes,
          blobRef: {
            id: ref.id,
            store: ref.store,
            key: ref.key,
            marker: ref.marker,
            sentinel: ref.sentinel,
          },
          contextFetchPolicy: input.options.contextFetchPolicy || input.step?.contextFetchPolicy || 'optional',
        }
      }
    } else {
      console.error('Warning: GitHub full-prompt blob offload skipped because Netlify site/token context is unavailable.')
    }
  }

  return plan
}

/** @param {CompleteGithubStepInput} param0 */
async function completeGithubStep({ runState, repo, stepState, step, options, runtimeEvents }) {
  const timeoutMinutes = Number.parseInt(String(options.timeoutMinutes || '25'), 10)
  if (step.waitFor !== WAIT_FOR_AGENT_RESULTS) {
    stepState.status = 'completed'
    persistStepArtifacts(runState, stepState)
    emitStepArtifacts(runtimeEvents, runState, stepState)
    runtimeEvents?.stepStatus('completed', stepState, step)
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
	          const normalized = applyContextFetchClassification(normalizeGithubRunResult({
	            run,
	            result,
	            reply,
	            status,
	            marker: parseRunnerResultMarker(reply?.body || ''),
	          }))
          const index = stepState.runs.findIndex((candidate) => candidate.issueNumber === normalized.issueNumber)
          if (index !== -1) {
            Object.assign(stepState.runs[index], normalized)
            const artifactResult = persistRunArtifact(runState, stepState, stepState.runs[index])
            emitRunArtifact(runtimeEvents, runState, stepState, stepState.runs[index], artifactResult)
            runtimeEvents?.agentStatus(normalized.status || 'completed', stepState.runs[index], stepState, step, {
              terminal: normalized.status === 'completed' || normalized.status === 'failed' || normalized.status === 'timeout',
              usage: normalized.usage || null,
              hasResult: Boolean(normalized.resultText),
            })
            saveRunState(runState)
          }
        },
      })
      for (const run of stepState.runs) {
        if (run.status === 'failed' || run.status === 'timeout') continue
        const result = results.find((item) => item.issueNumber === run.issueNumber)
        const replies = result?.replies || []
        const latest = replies[replies.length - 1]
	        const normalized = applyContextFetchClassification(normalizeGithubRunResult({
	          run,
	          result,
	          reply: latest,
	          status: latest ? 'completed' : 'timeout',
	          marker: parseRunnerResultMarker(latest?.body || ''),
	        }))
        Object.assign(run, normalized)
        runtimeEvents?.agentStatus(normalized.status || 'completed', run, stepState, step, {
          terminal: true,
          usage: normalized.usage || null,
          hasResult: Boolean(normalized.resultText),
        })
      }
    }
    stepState.status = githubStepStatus(stepState)
    saveRunState(runState)
  } finally {
    stepState.status = githubStepStatus(stepState)
    persistStepArtifacts(runState, stepState)
    emitStepArtifacts(runtimeEvents, runState, stepState)
    runtimeEvents?.stepStatus(stepState.status, stepState, step)
  }
  return stepState
}

/** @param {GithubWorkflowExecutionInput} param0 */
async function executeGithubFlow({ flow, steps, options, runState, completedStepStates = new Map(), runtimeEvents }) {
  const repo = resolveRepo(options.repo)
  const date = options.date || getLocalDate()
  const baseContext = contextForRunState(runState, options)

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = steps[stepIndex]
    if (isHumanReviewStep(step)) {
      requireHumanReview({ runState, step, runtimeEvents })
    }
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
    runtimeEvents?.stepStatus('running', stepState, step)
    runtimeEvents?.stepStatus('running', stepState, step)

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
      fetchResults: fromIssues ? options.fetchResults === true : false,
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
      hasFutureSteps: stepIndex < steps.length - 1,
      runState,
      stepState,
      step,
      projectRoot: runState.projectRoot,
    }
    const plan = buildAndMaybeFallbackPlan(
      input,
      step.action === 'comment' ? buildCommentPlan : buildPlan,
    )

    if (step.action === 'comment') {
      printCommentPlan(plan, { dryRun: options.dryRun === true })
    } else {
      printPlan(plan, { dryRun: options.dryRun === true })
    }
    enforceGithubActionPromptBudget(plan, { dryRun: options.dryRun === true })

    if (options.dryRun) {
      stepState.status = 'dry-run'
	      stepState.runs = (plan.issues || []).map((issue) => ({
	        transport: 'github',
	        agent: issue.model,
	        status: 'dry-run',
	        promptText: issue.body,
	        resultText: '',
	        promptDelivery: issue.promptDelivery || null,
	        ...(issue.promptDelivery?.blobRef ? { blobRef: issue.promptDelivery.blobRef } : {}),
	        raw: issue,
	      }))
      completedStepStates.set(step.id, stepState)
      saveRunState(runState)
      for (const run of stepState.runs) runtimeEvents?.agentStatus('dry-run', run, stepState, step)
      runtimeEvents?.stepStatus('dry-run', stepState, step)
      continue
    }

    if (step.action === 'comment') {
      for (const issue of plan.issues) {
        const pendingRun = {
          transport: 'github',
          agent: issue.model,
          issueNumber: Number(issue.issueNumber),
          issueUrl: issue.issueUrl,
          raw: issue,
        }
        runtimeEvents?.agentStatus('submitting', pendingRun, stepState, step, { action: 'comment' })
        let url
        try {
          url = createDiscussionComment({
            repo: issue.targetRepo,
            targetKind: issue.targetKind,
            targetNumber: issue.targetNumber,
            body: issue.body,
          })
        } catch (error) {
          runtimeEvents?.agentStatus('failed', pendingRun, stepState, step, {
            phase: 'submit',
            action: 'comment',
            message: error?.message || String(error),
          })
          throw error
        }
        const issueNumber = Number(issue.issueNumber)
        stepState.runs.push({
          transport: 'github',
          agent: issue.model,
          status: 'submitted',
	          promptText: issue.body,
	          resultText: '',
	          promptDelivery: issue.promptDelivery || null,
	          ...(issue.promptDelivery?.blobRef ? { blobRef: issue.promptDelivery.blobRef } : {}),
	          issueNumber,
          issueUrl: issue.issueUrl,
          commentUrl: url,
          prUrl: issue.targetKind === 'pr' ? issue.targetUrl : '',
          raw: issue,
        })
        saveRunState(runState)
        runtimeEvents?.agentStatus('submitted', stepState.runs[stepState.runs.length - 1], stepState, step, {
          commentUrl: url,
        })
        console.log(`#${issue.issueNumber} ${issue.issueTitle}: ${url}`)
      }
    } else {
      for (const issue of plan.issues) {
        const pendingRun = {
          transport: 'github',
          agent: issue.model,
          raw: issue,
        }
        runtimeEvents?.agentStatus('submitting', pendingRun, stepState, step, { action: 'issue' })
        let url
        try {
          url = createIssue({
            repo: plan.repo,
            title: issue.title,
            body: issue.body,
            labels: plan.labels,
          })
        } catch (error) {
          runtimeEvents?.agentStatus('failed', pendingRun, stepState, step, {
            phase: 'submit',
            action: 'issue',
            message: error?.message || String(error),
          })
          throw error
        }
        const issueNumber = parseIssueNumberFromUrl(url)
        stepState.runs.push({
          transport: 'github',
          agent: issue.model,
          status: 'submitted',
	          promptText: issue.body,
	          resultText: '',
	          promptDelivery: issue.promptDelivery || null,
	          ...(issue.promptDelivery?.blobRef ? { blobRef: issue.promptDelivery.blobRef } : {}),
	          issueNumber,
          issueUrl: url,
          commentUrl: '',
          prUrl: '',
          raw: issue,
        })
        saveRunState(runState)
        runtimeEvents?.agentStatus('submitted', stepState.runs[stepState.runs.length - 1], stepState, step)
        console.log(`${issue.title}: ${url}`)
      }
    }

    for (const run of stepState.runs.filter(shouldPollGithubRun)) {
      runtimeEvents?.agentStatus('waiting', run, stepState, step)
    }

    await completeGithubStep({ runState, repo, stepState, step, options, runtimeEvents })
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
  }
}

/**
 * @param {{
 *   flow?: import('../types').WorkflowFlow,
 *   runState?: import('../types').WorkflowRunState,
 *   projectRoot?: string,
 * }} param0
 */
async function resumeGithubFlow({ flow, runState, projectRoot }) {
  const options = runState.options || {}
  trackRunState(runState, {
    onInterrupt: ({ runState: activeRunState, reason }) => {
      cleanupWorkflowBlobsForRun({
        runState: activeRunState,
        projectRoot,
        options,
        reason: `interrupted workflow (${reason})`,
      })
    },
  })
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
  if (stepState && githubStepStatus(stepState) === 'completed') {
    console.log(`Resuming ${runState.runId}`)
    console.log(`Flow: ${flow.title}`)
    console.log(`State: ${workflowStatePath(runState.dir)}`)
    console.log(`Repair and continue: ${step.title} is already complete`)
    stepState.status = 'completed'
    completedStepStates.set(step.id, stepState)
    saveRunState(runState)
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

module.exports = {
  buildAndMaybeFallbackPlan,
  completeGithubStep,
  executeGithubFlow,
  resumeGithubFlow,
}
