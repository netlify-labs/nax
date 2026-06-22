const { bodyHasRunnerResultMarker, bodyHasRunnerStatusMarker } = require('../comment-markers')
const { netlifyAgentRunUrlFromBody } = require('../agent-run-results')
const { runGh } = require('../gh-cli')
const { fetchRoundResults } = require('../round-results')
const { titleCase } = require('../prompts')
const { GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX, githubActionTriggerTextMetrics } = require('./prompt-budget')
const { conciseErrorMessage, makeStepProgressReporter } = require('../workflow/progress')

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

function githubStatusCommentsForRun(result, run = {}) {
  return commentsAfterGithubPrompt(result, run).filter((comment) => {
    const body = String(comment?.body || '')
    return bodyHasRunnerStatusMarker(body) && netlifyAgentRunUrlFromBody(body)
  })
}

function githubPromptCommentForRun(result, run = {}) {
  if (!run.commentUrl) return null
  const comments = Array.isArray(result?.comments) ? result.comments : []
  return comments.find((comment) => comment.url === run.commentUrl) || null
}

function githubRunStatusFromStatusComment(body, fallback = 'running') {
  const text = String(body || '')
  if (/\bNetlify Agent Run completed\b/i.test(text) || /\bAgent Run completed\b/i.test(text)) return 'completed'
  if (/\bNetlify Agent Run failed\b/i.test(text) || /\bAgent Run failed\b/i.test(text)) return 'failed'
  if (/\bNetlify Agent Run timed out\b/i.test(text) || /\bAgent Run timed out\b/i.test(text)) return 'timeout'
  return fallback
}

function applyGithubStatusCommentToRun(result, run = {}) {
  const statusComments = githubStatusCommentsForRun(result, run)
  const latest = statusComments[statusComments.length - 1]
  const body = latest?.body || ''
  const agentRunUrl = netlifyAgentRunUrlFromBody(body)
  if (!agentRunUrl) return null
  const status = githubRunStatusFromStatusComment(body, 'running')
  const links = {
    ...(run.links || {}),
    agentRunUrl,
    ...(agentRunUrl.includes('?session=') ? { sessionUrl: agentRunUrl } : {}),
  }
  run.links = links
  if (!run.status || run.status === 'submitted' || run.status === 'pending' || status !== 'running') {
    run.status = status
  }
  return {
    comment: latest,
    run: {
      ...run,
      links,
      status,
    },
    agentRunUrl,
  }
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
const GITHUB_ACTION_FAILURE_GRACE_MS = 60000

function githubTerminalRunCount({ scopedResults = [], runs = [], failures = [], actionFailures = [] } = {}) {
  const terminal = new Set()
  for (const result of scopedResults) {
    if ((result.replies || []).length > 0) terminal.add(result.issueNumber)
  }
  for (const run of runs || []) {
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'timeout') terminal.add(run.issueNumber)
  }
  for (const failure of failures || []) terminal.add(failure.issueNumber)
  for (const failure of actionFailures || []) terminal.add(failure.issueNumber)
  return terminal.size
}

function githubFailureDetail(failures = []) {
  return failures
    .map((failure) => `#${failure.issueNumber} ${failure.issueTitle}: ${failure.summary}${failure.url ? ` (${failure.url})` : ''}`)
    .join('\n')
}

function githubSavedRunFailures(scopedResults = [], runs = [], existingIssueNumbers = new Set()) {
  const byIssueNumber = new Map((scopedResults || []).map((result) => [result.issueNumber, result]))
  return (runs || [])
    .filter((run) => (run.status === 'failed' || run.status === 'timeout') && !existingIssueNumbers.has(run.issueNumber))
    .map((run) => {
      const result = byIssueNumber.get(run.issueNumber) || {}
      return {
        issueNumber: run.issueNumber,
        issueTitle: result.issueTitle || run.issueTitle || titleCase(run.agent || 'agent'),
        url: run.links?.commentUrl || run.commentUrl || run.links?.agentRunUrl || '',
        summary: conciseErrorMessage(run.resultText || run.failureReason || run.status || 'Agent run failed'),
      }
    })
}

function githubCombinedFailures({ scopedResults = [], runs = [], failures = [], actionFailures = [] } = {}) {
  const seen = new Set()
  const combined = []
  for (const failure of [...failures, ...actionFailures]) {
    combined.push(failure)
    if (Number.isFinite(failure.issueNumber)) seen.add(failure.issueNumber)
  }
  combined.push(...githubSavedRunFailures(scopedResults, runs, seen))
  return combined
}

function normalizeGithubActionTitle(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function githubActionRunMatchesResult(actionRun, result, run = {}) {
  const title = normalizeGithubActionTitle(actionRun?.displayTitle)
  if (!title) return false
  const issueTitle = normalizeGithubActionTitle(result?.issueTitle)
  if (issueTitle && title === issueTitle) return true
  if (issueTitle && title.includes(issueTitle)) return true
  const agent = normalizeGithubActionTitle(run.agent || result?.model)
  return Boolean(agent && title.includes(agent))
}

function actionRunCreatedNearPrompt(actionRun, promptCreatedAt, { beforeMs = 15000, afterMs = 10 * 60 * 1000 } = {}) {
  const promptMs = Date.parse(promptCreatedAt || '')
  const actionMs = Date.parse(actionRun?.createdAt || '')
  if (!Number.isFinite(promptMs) || !Number.isFinite(actionMs)) return false
  return actionMs >= promptMs - beforeMs && actionMs <= promptMs + afterMs
}

function listRecentGithubActionRuns({ repo, since }) {
  const result = runGh([
    'run',
    'list',
    '--repo',
    repo,
    '--limit',
    '50',
    '--json',
    'databaseId,displayTitle,createdAt,conclusion,status,url',
  ], {
    attempts: 1,
    timeout: 30000,
  })
  let runs = []
  try {
    runs = JSON.parse(result.stdout || '[]')
  } catch {
    runs = []
  }
  const sinceMs = Date.parse(since || '')
  return runs.filter((run) => {
    if (run.status !== 'completed' || run.conclusion !== 'failure') return false
    if (!Number.isFinite(sinceMs)) return true
    const createdMs = Date.parse(run.createdAt || '')
    return Number.isFinite(createdMs) && createdMs >= sinceMs - 15000
  })
}

function loadGithubActionRunFailureLog({ repo, databaseId }) {
  if (!databaseId) return ''
  const result = runGh([
    'run',
    'view',
    String(databaseId),
    '--repo',
    repo,
    '--log-failed',
  ], {
    allowFailure: true,
    attempts: 1,
    timeout: 30000,
  })
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

function githubActionFailureReason(log) {
  const text = String(log || '')
  if (/argument list too long/i.test(text)) return 'argument-list-too-long'
  return 'github-action-failed'
}

function githubActionFailureSummary({ reason, promptBytes, envBytes }) {
  if (reason === 'argument-list-too-long') {
    const suffix = promptBytes
      ? ` Prompt body was ${promptBytes.toLocaleString()} bytes${envBytes ? ` (${envBytes.toLocaleString()} bytes as ${GITHUB_ACTION_TRIGGER_TEXT_ENV_PREFIX} env string)` : ''}.`
      : ''
    return `GitHub Action failed before the Netlify Agent Runner could post status comments: argument list too long.${suffix}`
  }
  return 'GitHub Action failed before the Netlify Agent Runner could post status comments.'
}

function findGithubActionRunFailures({
  repo,
  results,
  runs = [],
  actionRunLoader = listRecentGithubActionRuns,
  actionRunLogLoader = loadGithubActionRunFailureLog,
  now = Date.now(),
  graceMs = GITHUB_ACTION_FAILURE_GRACE_MS,
}) {
  const prompts = []
  for (const result of results || []) {
    const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
    if (githubResultRepliesForRun(result, run).length > 0 || githubFailureCommentsForRun(result, run).length > 0) continue
    const prompt = githubPromptCommentForRun(result, run)
    if (!prompt?.createdAt) continue
    const promptMs = Date.parse(prompt.createdAt)
    if (!Number.isFinite(promptMs) || now - promptMs < graceMs) continue
    prompts.push({ result, run, prompt, promptMs })
  }
  if (prompts.length === 0) return []

  const since = new Date(Math.min(...prompts.map((item) => item.promptMs)) - 15000).toISOString()
  let actionRuns = []
  try {
    actionRuns = actionRunLoader({ repo, since }) || []
  } catch {
    actionRuns = []
  }

  const failures = []
  const usedActionRuns = new Set()
  for (const item of prompts) {
    const candidates = actionRuns
      .filter((actionRun) => !usedActionRuns.has(actionRun.databaseId || actionRun.url))
      .filter((actionRun) => githubActionRunMatchesResult(actionRun, item.result, item.run))
      .filter((actionRun) => actionRunCreatedNearPrompt(actionRun, item.prompt.createdAt))
      .sort((a, b) => Math.abs(Date.parse(a.createdAt) - item.promptMs) - Math.abs(Date.parse(b.createdAt) - item.promptMs))
    const actionRun = candidates[0]
    if (!actionRun) continue
    usedActionRuns.add(actionRun.databaseId || actionRun.url)
    const log = actionRunLogLoader({ repo, databaseId: actionRun.databaseId }) || ''
    const reason = githubActionFailureReason(log)
    const metrics = githubActionTriggerTextMetrics(item.run.promptText || item.prompt.body || '')
    failures.push({
      issueNumber: item.result.issueNumber,
      issueTitle: item.result.issueTitle,
      agent: item.run.agent || item.result.model || '',
      url: actionRun.url || '',
      actionRunId: actionRun.databaseId || '',
      createdAt: actionRun.createdAt || '',
      reason,
      summary: githubActionFailureSummary({
        reason,
        promptBytes: metrics.bodyBytes,
        envBytes: metrics.envBytes,
      }),
      promptBytes: metrics.bodyBytes,
      promptEnvBytes: metrics.envBytes,
      result: item.result,
      run: item.run,
      log,
    })
  }
  return failures
}

/**
 * @param {{
 *   repo?: string,
 *   issueNumbers?: number[],
 *   runs?: import('../types').AgentRun[],
 *   step?: import('../types').WorkflowStep,
 *   timeoutMinutes?: number,
 *   pollMs?: number,
 *   loader?: (input: { repo?: string, issueNumber?: number }) => import('../types').GitHubIssue,
 *   onRunResult?: (event: {
 *     result?: import('../types').GitHubIssue,
 *     reply?: import('../types').GitHubComment,
 *     run?: import('../types').AgentRun,
 *     status?: string,
 *   }) => void,
 *   maxConsecutiveFailures?: number,
 *   actionRunLoader?: (input: { repo?: string, since?: string }) => import('../types').JsonMap[],
 *   actionRunLogLoader?: (input: { repo?: string, databaseId?: string | number }) => string,
 *   actionRunFailureClassifier?: (input: import('../types').JsonMap) => string,
 *   actionRunFailureGraceMs?: number,
 *   log?: (message: string) => void,
 * }} input
 */
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
  actionRunLoader = listRecentGithubActionRuns,
  actionRunLogLoader = loadGithubActionRunFailureLog,
  actionRunFailureGraceMs = GITHUB_ACTION_FAILURE_GRACE_MS,
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
  const reconcileResults = async (results) => {
    const scopedResults = resultsScopedToGithubRuns(results, runs)
    for (const result of scopedResults) {
      const run = runs.find((candidate) => candidate.issueNumber === result.issueNumber) || {}
      const statusUpdate = applyGithubStatusCommentToRun(result, run)
      if (statusUpdate) {
        reporter.updateRun({
          result,
          reply: statusUpdate.comment,
          run: statusUpdate.run,
          state: run.status || 'running',
        })
      }
      const replies = result.replies || []
      const latest = replies[replies.length - 1]
      if (!latest?.url) continue
      const key = `${result.issueNumber}:${latest.url}`
      if (emittedResults.has(key)) continue
      emittedResults.add(key)
      const agentRunUrl = netlifyAgentRunUrlFromBody(latest.body || '')
      reporter.updateRun({
        result,
        reply: latest,
        run: {
          ...run,
          links: {
            ...(run.links || {}),
            agentRunUrl: agentRunUrl || run.links?.agentRunUrl || '',
            sessionUrl: agentRunUrl.includes('?session=')
              ? agentRunUrl
              : run.links?.sessionUrl || '',
          },
          status: 'completed',
        },
        state: 'completed',
        terminalSuccess: true,
      })
      await onRunResult({ result, reply: latest, run, status: 'completed' })
    }
    const completeCount = scopedResults.filter((r) => (r.replies || []).length > 0).length
    reporter.setCount(completeCount)
    return { scopedResults, completeCount }
  }

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
      const { scopedResults, completeCount } = await reconcileResults(results)
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
      }
      const actionFailures = findGithubActionRunFailures({
        repo,
        results,
        runs,
        actionRunLoader,
        actionRunLogLoader,
        graceMs: actionRunFailureGraceMs,
      })
      if (actionFailures.length > 0) {
        for (const failure of actionFailures) {
          const run = runs.find((candidate) => candidate.issueNumber === failure.issueNumber) || failure.run || {}
          Object.assign(run, {
            status: 'failed',
            failureKind: 'github-action-launch-failed',
            failureReason: failure.reason,
            actionRunUrl: failure.url,
            actionRunId: failure.actionRunId,
            promptBytes: failure.promptBytes,
            promptEnvBytes: failure.promptEnvBytes,
            resultText: failure.summary,
          })
          await onRunResult({
            result: failure.result,
            reply: null,
            run,
            status: 'failed',
          })
        }
      }
      const combinedFailures = githubCombinedFailures({ scopedResults, runs, failures, actionFailures })
      const failureCount = combinedFailures.length
      const terminalCount = githubTerminalRunCount({ scopedResults, runs, failures, actionFailures })
      if (terminalCount === scopedResults.length) {
        if (failureCount > 0) {
          const detail = githubFailureDetail(combinedFailures)
          reporter.fail(`${step.title}: ${completeCount}/${scopedResults.length} complete, ${failureCount} failed`)
          settled = true
          throw new Error(`Step "${step.id}" has failed agent runs:\n${detail}`)
        }
        reporter.done(`${step.title}: ${completeCount}/${scopedResults.length} complete`)
        settled = true
        return scopedResults
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    try {
      reporter.message('deadline reached; reconciling GitHub comments one last time')
      const finalResults = fetchRoundResults({
        repo,
        issueNumbers: numbers,
        embedAll: true,
        requireResultMarker: true,
        loader,
      })
      const { scopedResults, completeCount } = await reconcileResults(finalResults)
      const failures = findGithubRunnerFailures(finalResults, runs)
      const actionFailures = findGithubActionRunFailures({
        repo,
        results: finalResults,
        runs,
        actionRunLoader,
        actionRunLogLoader,
        graceMs: actionRunFailureGraceMs,
      })
      if (actionFailures.length > 0) {
        for (const failure of actionFailures) {
          const run = runs.find((candidate) => candidate.issueNumber === failure.issueNumber) || failure.run || {}
          Object.assign(run, {
            status: 'failed',
            failureKind: 'github-action-launch-failed',
            failureReason: failure.reason,
            actionRunUrl: failure.url,
            actionRunId: failure.actionRunId,
            promptBytes: failure.promptBytes,
            promptEnvBytes: failure.promptEnvBytes,
            resultText: failure.summary,
          })
          await onRunResult({
            result: failure.result,
            reply: null,
            run,
            status: 'failed',
          })
        }
      }
      const combinedFailures = githubCombinedFailures({ scopedResults, runs, failures, actionFailures })
      const failureCount = combinedFailures.length
      const terminalCount = githubTerminalRunCount({ scopedResults, runs, failures, actionFailures })
      if (failureCount > 0) {
        const detail = githubFailureDetail(combinedFailures)
        const status = terminalCount === scopedResults.length
          ? `${completeCount}/${scopedResults.length} complete, ${failureCount} failed`
          : `${completeCount}/${scopedResults.length} complete, ${failureCount} failed, ${scopedResults.length - terminalCount} timed out`
        reporter.fail(`${step.title}: ${status}`)
        settled = true
        throw new Error(`Step "${step.id}" has failed agent runs:\n${detail}`)
      }
      if (completeCount === scopedResults.length) {
        reporter.done(`${step.title}: ${completeCount}/${scopedResults.length} complete`)
        settled = true
        return scopedResults
      }
    } catch (err) {
      if (/has failed agent runs/.test(String(err?.message || ''))) throw err
      reporter.message(`final GitHub reconciliation failed: ${err.message}`)
    }
    reporter.fail(`Timed out waiting for ${step.title}`)
    settled = true
    throw new Error(`Timed out waiting for step "${step.id}" after ${timeoutMinutes} minutes`)
  } finally {
    if (!settled) reporter.fail(`Failed waiting for ${step.title}`)
  }
}

function githubStepStatus(stepState) {
  const runs = Array.isArray(stepState?.runs) ? stepState.runs : []
  if (runs.length > 0 && runs.every((run) => run.status === 'completed' || run.status === 'dry-run')) return 'completed'
  if (runs.some((run) => run.status === 'failed' || run.status === 'timeout')) return 'failed'
  return 'submitted'
}

module.exports = {
  GITHUB_ACTION_FAILURE_GRACE_MS,
  GITHUB_POLL_MAX_CONSECUTIVE_FAILURES,
  actionRunCreatedNearPrompt,
  applyGithubStatusCommentToRun,
  commentsAfterGithubPrompt,
  findGithubActionRunFailures,
  findGithubRunnerFailures,
  githubActionFailureReason,
  githubActionFailureSummary,
  githubActionRunMatchesResult,
  githubCombinedFailures,
  githubFailureCommentsForRun,
  githubFailureDetail,
  githubPromptCommentForRun,
  githubResultRepliesForRun,
  githubRunStatusFromStatusComment,
  githubSavedRunFailures,
  githubStatusCommentsForRun,
  githubStepStatus,
  githubTerminalRunCount,
  isGithubFailureResultBody,
  listRecentGithubActionRuns,
  loadGithubActionRunFailureLog,
  normalizeGithubActionTitle,
  resultsScopedToGithubRuns,
  waitForGithubStep,
}
