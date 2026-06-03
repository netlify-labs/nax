const ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled', 'canceled', 'dry-run'])
const NETLIFY_CREDITS_PER_USD = 180

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

function booleanValue(value) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function firstBoolean(...values) {
  for (const value of values) {
    const parsed = booleanValue(value)
    if (parsed !== null) return parsed
  }
  return null
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => stringValue(item))
    .filter(Boolean)
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

function fileChangesFromSessionOrRunner(session = {}, runner = {}, fallback = null) {
  const normalizedFallback = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {}
  const hasSessionDiff = firstBoolean(
    session.has_result_diff,
    session.has_diff,
    session.hasSessionDiff,
    normalizedFallback.hasSessionDiff,
  )
  const hasRunnerDiff = firstBoolean(
    runner.has_result_diff,
    runner.has_diff,
    runner.hasRunnerDiff,
    normalizedFallback.hasRunnerDiff,
  )
  const hasCumulativeDiff = firstBoolean(
    session.has_cumulative_diff,
    runner.has_cumulative_diff,
    session.hasCumulativeDiff,
    runner.hasCumulativeDiff,
    normalizedFallback.hasCumulativeDiff,
  )
  const explicitHasChanges = firstBoolean(
    normalizedFallback.hasChanges,
    normalizedFallback.has_changes,
  )
  const knownBooleans = [hasSessionDiff, hasRunnerDiff, hasCumulativeDiff].filter((value) => value !== null)
  const hasChanges = explicitHasChanges !== null
    ? explicitHasChanges
    : knownBooleans.some(Boolean)
  const commitSha = stringValue(
    session.commit_sha ||
    runner.commit_sha ||
    session.commitSha ||
    runner.commitSha ||
    normalizedFallback.commitSha ||
    normalizedFallback.commit_sha,
  )
  const attachedFileKeys = [
    ...stringArray(normalizedFallback.attachedFileKeys || normalizedFallback.attached_file_keys),
    ...stringArray(runner.attached_file_keys || runner.attachedFileKeys),
    ...stringArray(session.attached_file_keys || session.attachedFileKeys),
  ].filter((value, index, all) => all.indexOf(value) === index)
  const resultZipFileName = stringValue(
    session.result_zip_file_name ||
    runner.result_zip_file_name ||
    session.resultZipFileName ||
    runner.resultZipFileName ||
    normalizedFallback.resultZipFileName ||
    normalizedFallback.result_zip_file_name,
  )
  const hasMetadata = Boolean(commitSha || attachedFileKeys.length > 0 || resultZipFileName)
  if (explicitHasChanges === null && knownBooleans.length === 0 && !hasMetadata) return null

  return {
    hasChanges,
    ...(hasSessionDiff !== null ? { hasSessionDiff } : {}),
    ...(hasRunnerDiff !== null ? { hasRunnerDiff } : {}),
    ...(hasCumulativeDiff !== null ? { hasCumulativeDiff } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(attachedFileKeys.length > 0 ? { attachedFileKeys } : {}),
    ...(resultZipFileName ? { resultZipFileName } : {}),
  }
}

function normalizeFileChanges(fileChanges) {
  return fileChangesFromSessionOrRunner({}, {}, fileChanges)
}

function aggregateFileChanges(records = []) {
  const normalizedRecords = records
    .map((record) => normalizeFileChanges(record))
    .filter(Boolean)
  if (normalizedRecords.length === 0) return null

  const attachedFileKeys = []
  const out = {
    hasChanges: normalizedRecords.some((record) => record.hasChanges),
  }
  for (const key of ['hasSessionDiff', 'hasRunnerDiff', 'hasCumulativeDiff']) {
    const values = normalizedRecords
      .map((record) => typeof record[key] === 'boolean' ? record[key] : null)
      .filter((value) => value !== null)
    if (values.length > 0) out[key] = values.some(Boolean)
  }
  for (const record of normalizedRecords) {
    if (record.commitSha) out.commitSha = record.commitSha
    if (record.resultZipFileName) out.resultZipFileName = record.resultZipFileName
    for (const key of record.attachedFileKeys || []) {
      if (!attachedFileKeys.includes(key)) attachedFileKeys.push(key)
    }
  }
  if (attachedFileKeys.length > 0) out.attachedFileKeys = attachedFileKeys
  return out
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

function usageSummariesForRunState(runState = {}, options = {}) {
  const steps = []
  let total = {}
  for (const step of runState.steps || []) {
    const usage = aggregateRunUsage(step.runs || [])
    if (!hasUsage(usage)) continue
    steps.push({
      id: step.id,
      title: step.title || step.id,
      usage,
      summary: formatUsageSummary(usage, options),
    })
    total = addUsage(total, usage)
  }
  return {
    steps,
    total,
    totalSummary: hasUsage(total) ? formatUsageSummary(total, options) : '',
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

function shouldIncludeCost(options = {}) {
  if (typeof options.includeCost === 'boolean') return options.includeCost
  const env = options.env || process.env
  const value = String(env.NAX_INCLUDE_COST || '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function usdFromCredits(credits) {
  return credits / NETLIFY_CREDITS_PER_USD
}

function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value > 0 && value < 0.01) {
    return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatCreditsWithCost(value, options = {}) {
  const credits = formatCredits(value)
  if (!credits) return ''
  const base = `${credits} credits`
  if (!shouldIncludeCost(options)) return base
  return `${base} (${formatUsd(usdFromCredits(value))})`
}

function formatUsageSummary(usage = {}, options = {}) {
  const normalized = normalizeUsage(usage)
  if (!normalized) return ''
  const parts = []
  if (Number.isFinite(normalized.totalCreditsCost)) parts.push(formatCreditsWithCost(normalized.totalCreditsCost, options))
  if (Number.isFinite(normalized.stepsCount)) parts.push(`${numberWithCommas(normalized.stepsCount)} steps`)
  if (Number.isFinite(normalized.totalTokens)) parts.push(`${numberWithCommas(normalized.totalTokens)} tokens`)
  if (normalized.creditLimitExceeded) parts.push('credit limit exceeded')
  return parts.join(', ')
}

function formatFileChangesSummary(fileChanges = {}) {
  const normalized = normalizeFileChanges(fileChanges)
  if (!normalized) return ''
  const parts = [normalized.hasChanges ? 'yes' : 'no']
  if (normalized.commitSha) parts.push(`commit ${normalized.commitSha.slice(0, 12)}`)
  if (Array.isArray(normalized.attachedFileKeys) && normalized.attachedFileKeys.length > 0) {
    const count = normalized.attachedFileKeys.length
    parts.push(`${numberWithCommas(count)} attached ${count === 1 ? 'file' : 'files'}`)
  }
  if (normalized.resultZipFileName) parts.push(normalized.resultZipFileName)
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

function safeArtifactId(value, fallback = 'artifact') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+/, '')
    .slice(0, 128)
  return slug || fallback
}

function statusIsTerminal(status) {
  return TERMINAL_STATUSES.has(String(status || '').toLowerCase())
}

function sessionArtifactId({ sessionId, agent, createdAt, updatedAt } = {}) {
  if (sessionId && ID_FORMAT.test(String(sessionId))) return String(sessionId)
  const stamp = String(updatedAt || createdAt || new Date().toISOString()).replace(/[:.]/g, '-')
  return safeArtifactId(`${stamp}-${agent || 'agent'}`, `${Date.now()}-agent`)
}

function buildAgentSessionJson(input = {}) {
  const run = normalizeAgentRunResult({
    run: input.run || input,
    runner: input.runner || input.run?.rawResult?.runner || input.rawResult?.runner || {},
    session: input.session || input.run?.rawResult?.latestSession || input.run?.rawResult?.session || input.rawResult?.latestSession || input.rawResult?.session || {},
    status: input.status || input.run?.status || input.status,
    usage: input.usage || input.run?.usage,
    fileChanges: input.fileChanges || input.run?.fileChanges,
    links: input.links || input.run?.links,
  })
  const createdAt = input.createdAt || run.createdAt || run.rawResult?.created_at || ''
  const updatedAt = input.updatedAt || run.updatedAt || run.rawResult?.updated_at || ''
  const sessionId = sessionArtifactId({
    sessionId: input.sessionId || run.sessionId,
    agent: input.agent || run.agent,
    createdAt,
    updatedAt,
  })
  return {
    schemaVersion: 1,
    sessionId,
    runnerId: input.runnerId || run.runnerId || '',
    agent: input.agent || run.agent || '',
    status: input.status || run.status || '',
    createdAt,
    updatedAt,
    source: input.source || run.source || null,
    usage: normalizeUsage(input.usage || run.usage) || null,
    fileChanges: normalizeFileChanges(input.fileChanges || run.fileChanges) || null,
    links: normalizeLinks(input.links || run.links || {}),
    resultText: input.resultText !== undefined ? String(input.resultText || '') : String(run.resultText || ''),
  }
}

function buildAgentSessionUsageJson(input = {}) {
  const session = input.sessionId ? input : buildAgentSessionJson(input)
  const usage = normalizeUsage(input.usage || session.usage) || {}
  return {
    schemaVersion: 1,
    sessionId: session.sessionId || '',
    runnerId: session.runnerId || '',
    agent: session.agent || '',
    usage,
    summary: formatUsageSummary(usage),
  }
}

function bestAgentRunUrl(links = {}) {
  return links.sessionUrl || links.agentRunUrl || links.commentUrl || links.issueUrl || links.deployUrl || links.prUrl || ''
}

function buildAgentSessionResultMarkdown(input = {}) {
  const session = input.sessionId ? input : buildAgentSessionJson(input)
  const result = String(session.resultText || '').trimEnd()
  return result ? `${result}\n` : ''
}

function buildAgentSessionMarkdown(input = {}) {
  const session = input.sessionId ? input : buildAgentSessionJson(input)
  const titleAgent = session.agent ? `${titleCaseLocal(session.agent)} Session` : 'Agent Session'
  const lines = [
    `# ${titleAgent} · ${session.sessionId || ''}`.trim(),
    '',
    `- Status: ${session.status || 'unknown'}`,
  ]
  if (session.agent) lines.push(`- Agent: ${titleCaseLocal(session.agent)}`)
  if (session.runnerId) lines.push(`- Runner ID: \`${session.runnerId}\``)
  if (session.sessionId) lines.push(`- Session ID: \`${session.sessionId}\``)
  const usageSummary = formatUsageSummary(session.usage || {})
  if (usageSummary) lines.push(`- Usage: ${usageSummary}`)
  const fileChangesSummary = formatFileChangesSummary(session.fileChanges || {})
  if (fileChangesSummary) lines.push(`- File changes: ${fileChangesSummary}`)
  const url = bestAgentRunUrl(session.links || {})
  if (url) lines.push(`- Netlify: ${url}`)
  if (String(session.resultText || '').trim()) lines.push('- Result: [result.md](result.md)')
  lines.push('- Metadata: [agent-session.json](agent-session.json)', '')
  const result = String(session.resultText || '').trimEnd()
  if (result) lines.push('---', '', result, '')
  return lines.join('\n')
}

function titleCaseLocal(value) {
  return String(value || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildAgentRunnerJson(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : []
  const latestSession = input.latestSession || sessions[sessions.length - 1] || null
  let usage = {}
  for (const session of sessions) {
    const normalized = normalizeUsage(session.usage)
    if (normalized) usage = addUsage(usage, normalized)
  }
  if (!hasUsage(usage)) usage = normalizeUsage(input.usage || latestSession?.usage) || {}
  return {
    schemaVersion: 1,
    runnerId: input.runnerId || latestSession?.runnerId || '',
    agent: input.agent || latestSession?.agent || '',
    status: input.status || latestSession?.status || '',
    createdAt: input.createdAt || sessions[0]?.createdAt || '',
    updatedAt: input.updatedAt || latestSession?.updatedAt || '',
    latestSessionId: input.latestSessionId || latestSession?.sessionId || '',
    sessionIds: sessions.map((session) => session.sessionId).filter(Boolean),
    source: input.source || latestSession?.source || null,
    usage,
    fileChanges: aggregateFileChanges([
      input.fileChanges,
      latestSession?.fileChanges,
      ...sessions.map((session) => session.fileChanges),
    ]) || null,
    links: normalizeLinks(input.links || latestSession?.links || {}),
  }
}

function buildAgentRunnerUsageJson(input = {}) {
  const runner = input.runnerId ? input : buildAgentRunnerJson(input)
  const usage = normalizeUsage(runner.usage) || {}
  return {
    schemaVersion: 1,
    runnerId: runner.runnerId || '',
    agent: runner.agent || '',
    usage,
    summary: formatUsageSummary(usage),
  }
}

function buildAgentRunnerMarkdown(input = {}) {
  const runner = input.runnerId ? input : buildAgentRunnerJson(input)
  const sessions = Array.isArray(input.sessions) ? input.sessions : []
  const titleAgent = runner.agent ? `${titleCaseLocal(runner.agent)} Agent Runner` : 'Agent Runner'
  const lines = [
    `# ${titleAgent} · ${runner.runnerId || ''}`.trim(),
    '',
    `- Status: ${runner.status || 'unknown'}`,
  ]
  if (runner.agent) lines.push(`- Agent: ${titleCaseLocal(runner.agent)}`)
  if (runner.runnerId) lines.push(`- Runner ID: \`${runner.runnerId}\``)
  if (runner.latestSessionId) lines.push(`- Latest session: [${runner.latestSessionId}](sessions/${runner.latestSessionId}.json)`)
  const usageSummary = formatUsageSummary(runner.usage || {})
  if (usageSummary) lines.push(`- Usage: ${usageSummary}`)
  const fileChangesSummary = formatFileChangesSummary(runner.fileChanges || {})
  if (fileChangesSummary) lines.push(`- File changes: ${fileChangesSummary}`)
  const url = bestAgentRunUrl(runner.links || {})
  if (url) lines.push(`- Netlify: ${url}`)
  if (sessions.length > 0) {
    lines.push('', '## Sessions', '')
    sessions.forEach((session, index) => {
      const usage = formatUsageSummary(session.usage || {})
      const label = [session.status || 'unknown', usage].filter(Boolean).join(' · ')
      lines.push(`${index + 1}. [${session.sessionId}](../../agent-sessions/${session.sessionId}/summary.md)${label ? ` · ${label}` : ''}`)
    })
  }
  lines.push('')
  return lines.join('\n')
}

function normalizeAgentRunResult({
  run = {},
  runner = {},
  session = {},
  status = run.status || '',
  resultText,
  usage,
  fileChanges,
  links = {},
  rawResult,
} = {}) {
  const runnerId = String(run.runnerId || runner.id || session.agent_runner_id || '')
  const sessionId = String(run.sessionId || session.id || '')
  const normalizedUsage = normalizeUsage(usage) || usageFromSessionOrRunner(session, runner, run.usage)
  const normalizedFileChanges = fileChangesFromSessionOrRunner(session, runner, fileChanges || run.fileChanges)
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
    fileChanges: normalizedFileChanges,
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
  buildAgentRunnerJson,
  buildAgentRunnerMarkdown,
  buildAgentRunnerUsageJson,
  buildAgentSessionJson,
  buildAgentSessionMarkdown,
  buildAgentSessionResultMarkdown,
  buildAgentSessionUsageJson,
  formatAgentRunUrl,
  formatAgentRunUrlFromAdminUrl,
  formatCreditsWithCost,
  formatFileChangesSummary,
  formatUsageSummary,
  NETLIFY_CREDITS_PER_USD,
  hasUsage,
  normalizeFileChanges,
  normalizeAgentRunResult,
  normalizeGithubRunResult,
  normalizeUsage,
  netlifyAgentRunUrlFromBody,
  safeArtifactId,
  sessionArtifactId,
  statusIsTerminal,
  usageForRun,
  usageFromSessionOrRunner,
  usageSummariesForRunState,
}
