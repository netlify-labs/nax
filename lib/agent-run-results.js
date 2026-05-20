const ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function normalizeUsage(usage, extras = {}) {
  if ((!usage || typeof usage !== 'object' || Array.isArray(usage)) && (!extras || typeof extras !== 'object')) return null
  const record = {
    ...(usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {}),
    ...(extras && typeof extras === 'object' && !Array.isArray(extras) ? extras : {}),
  }
  const out = {}

  const totalTokens = finiteNumber(record.totalTokens ?? record.total_tokens)
  if (totalTokens !== null) out.totalTokens = totalTokens

  const totalCreditsCost = finiteNumber(record.totalCreditsCost ?? record.total_credits_cost)
  if (totalCreditsCost !== null) out.totalCreditsCost = totalCreditsCost

  const stepsCount = finiteNumber(record.stepsCount ?? record.steps_count)
  if (stepsCount !== null) out.stepsCount = Math.floor(stepsCount)

  if (typeof record.creditLimitExceeded === 'boolean') {
    out.creditLimitExceeded = record.creditLimitExceeded
  } else if (typeof record.credit_limit_exceeded === 'boolean') {
    out.creditLimitExceeded = record.credit_limit_exceeded
  }

  return Object.keys(out).length > 0 ? out : null
}

function usageFromSessionOrRunner(session = {}, runner = {}, fallback = null) {
  return normalizeUsage(
    session.usage || runner.usage || fallback,
    {
      steps_count: session.steps_count ?? runner.steps_count,
      credit_limit_exceeded: session.credit_limit_exceeded ?? runner.credit_limit_exceeded,
    },
  )
}

function addUsage(a = {}, b = {}) {
  const result = { ...a }
  for (const [key, value] of Object.entries(b || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = (result[key] || 0) + value
    } else if (key === 'creditLimitExceeded' && typeof value === 'boolean') {
      result.creditLimitExceeded = Boolean(result.creditLimitExceeded || value)
    }
  }
  return result
}

function usageForRun(run = {}) {
  return normalizeUsage(run.usage) ||
    usageFromSessionOrRunner(run.rawResult?.latestSession, run.rawResult?.runner) ||
    null
}

function aggregateRunUsage(runs = []) {
  return runs.reduce((total, run) => {
    const usage = usageForRun(run)
    return usage ? addUsage(total, usage) : total
  }, {})
}

function usageSummariesForRunState(runState = {}) {
  const steps = []
  let total = {}
  for (const step of runState.steps || []) {
    const usage = aggregateRunUsage(step.runs || [])
    if (!hasUsage(usage)) continue
    steps.push({
      id: step.id,
      title: step.title || step.id,
      usage,
      summary: formatUsageSummary(usage),
    })
    total = addUsage(total, usage)
  }
  return {
    steps,
    total,
    totalSummary: hasUsage(total) ? formatUsageSummary(total) : '',
  }
}

function hasUsage(usage = {}) {
  return Object.keys(usage).some((key) => (
    typeof usage[key] === 'number' && Number.isFinite(usage[key])
  ) || (
    key === 'creditLimitExceeded' && usage[key] === true
  ))
}

function numberWithCommas(value) {
  return Number(value || 0).toLocaleString('en-US')
}

function formatCredits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return value.toFixed(2).replace(/\.?0+$/, '')
}

function formatUsageSummary(usage = {}) {
  const normalized = normalizeUsage(usage)
  if (!normalized) return ''
  const parts = []
  if (Number.isFinite(normalized.totalTokens)) parts.push(`${numberWithCommas(normalized.totalTokens)} tokens`)
  if (Number.isFinite(normalized.stepsCount)) parts.push(`${numberWithCommas(normalized.stepsCount)} steps`)
  if (Number.isFinite(normalized.totalCreditsCost)) parts.push(`${formatCredits(normalized.totalCreditsCost)} credits`)
  if (normalized.creditLimitExceeded) parts.push('credit limit exceeded')
  return parts.join(', ')
}

function formatAgentRunUrl(siteName, runnerId, sessionId = '') {
  if (!siteName || !ID_FORMAT.test(String(runnerId || ''))) return ''
  const base = `https://app.netlify.com/projects/${siteName}/agent-runs/${runnerId}`
  if (!ID_FORMAT.test(String(sessionId || ''))) return base
  return `${base}?session=${encodeURIComponent(String(sessionId))}`
}

function formatAgentRunUrlFromAdminUrl(adminUrl, runnerId, sessionId = '') {
  if (!adminUrl || !ID_FORMAT.test(String(runnerId || ''))) return ''
  const base = `${String(adminUrl).replace(/\/+$/, '')}/agent-runs/${runnerId}`
  if (!ID_FORMAT.test(String(sessionId || ''))) return base
  return `${base}?session=${encodeURIComponent(String(sessionId))}`
}

function netlifyAgentRunUrlFromBody(body) {
  const match = String(body || '').match(/https:\/\/app\.netlify\.com\/projects\/[A-Za-z0-9_.-]+\/agent-runs\/[A-Za-z0-9_-]{1,128}(?:\?session=[A-Za-z0-9_-]{1,128})?/)
  return match ? match[0] : ''
}

function normalizeLinks(links = {}) {
  const out = {}
  for (const key of ['agentRunUrl', 'sessionUrl', 'deployUrl', 'prUrl', 'issueUrl', 'commentUrl']) {
    if (links[key]) out[key] = String(links[key])
  }
  return out
}

function normalizeAgentRunResult({
  run = {},
  runner = {},
  session = {},
  status = run.status || '',
  resultText,
  usage,
  links = {},
  rawResult,
} = {}) {
  const runnerId = String(run.runnerId || runner.id || session.agent_runner_id || '')
  const sessionId = String(run.sessionId || session.id || '')
  const normalizedUsage = normalizeUsage(usage) || usageFromSessionOrRunner(session, runner, run.usage)
  const normalizedLinks = normalizeLinks({
    agentRunUrl: links.agentRunUrl || run.links?.agentRunUrl || '',
    sessionUrl: links.sessionUrl || run.links?.sessionUrl || '',
    deployUrl: links.deployUrl || run.deployUrl || session.deploy_url || runner.deploy_url || '',
    prUrl: links.prUrl || run.prUrl || session.pull_request_url || runner.pr_url || '',
    issueUrl: links.issueUrl || run.issueUrl || '',
    commentUrl: links.commentUrl || run.commentUrl || '',
  })

  return {
    ...run,
    ...(runnerId ? { runnerId } : {}),
    ...(sessionId ? { sessionId } : {}),
    agent: run.agent || session.agent_config?.agent || runner.agent_config?.agent || '',
    status,
    resultText: resultText !== undefined ? resultText : (run.resultText || session.result || runner.result || ''),
    deployUrl: normalizedLinks.deployUrl || '',
    prUrl: normalizedLinks.prUrl || '',
    issueUrl: normalizedLinks.issueUrl || '',
    commentUrl: normalizedLinks.commentUrl || '',
    links: normalizedLinks,
    usage: normalizedUsage,
    creditLimitExceeded: normalizedUsage?.creditLimitExceeded,
    stepsCount: normalizedUsage?.stepsCount,
    rawResult: rawResult !== undefined ? rawResult : run.rawResult,
  }
}

function normalizeGithubRunResult({ run = {}, result = null, reply = null, status, marker = null }) {
  const commentUrl = reply?.url || run.commentUrl || ''
  const issueUrl = result?.issueUrl || run.issueUrl || ''
  const agentRunUrl = netlifyAgentRunUrlFromBody(reply?.body || '')
  return normalizeAgentRunResult({
    run: {
      ...run,
      runnerId: marker?.runnerId || run.runnerId || '',
      sessionId: marker?.sessionId || run.sessionId || '',
      agent: run.agent || result?.model || '',
      commentUrl,
      issueUrl,
    },
    status,
    resultText: reply?.body || '',
    usage: marker?.usage || null,
    links: {
      agentRunUrl,
      sessionUrl: agentRunUrl.includes('?session=') ? agentRunUrl : '',
      commentUrl,
      issueUrl,
      prUrl: run.prUrl || '',
    },
    rawResult: result || null,
  })
}

module.exports = {
  ID_FORMAT,
  addUsage,
  aggregateRunUsage,
  formatAgentRunUrl,
  formatAgentRunUrlFromAdminUrl,
  formatUsageSummary,
  hasUsage,
  normalizeAgentRunResult,
  normalizeGithubRunResult,
  normalizeUsage,
  netlifyAgentRunUrlFromBody,
  usageForRun,
  usageFromSessionOrRunner,
  usageSummariesForRunState,
}
