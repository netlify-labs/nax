const fs = require('fs')
const path = require('path')
const { artifactMeta } = require('../../core/artifact-metadata')
const { formatFileChangesSummary, formatUsageSummary, usageSummariesForRunState } = require('../results/agent-run-results')
const { persistAgentRunnerArtifact } = require('./agent-runner-artifacts')
const { persistAgentSessionArtifact } = require('./agent-session-artifacts')

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled', 'canceled', 'dry-run'])
const GITHUB_STEP_SUMMARY_LIMIT_BYTES = 900 * 1024

function artifactsRootForRunState(runState = {}) {
  return runState.dir ? path.join(runState.dir, 'artifacts') : ''
}

function safeArtifactName(value, fallback = 'run') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+/, '')
    .slice(0, 64)
  return slug || fallback
}

function stepDirectoryName(step = {}, ordinal = 1) {
  return `${String(ordinal).padStart(2, '0')}-${safeArtifactName(step.id || step.title, 'step')}`
}

function stepOrdinal(runState = {}, step = {}) {
  const index = (runState.steps || []).indexOf(step)
  if (index !== -1) return index + 1
  const byId = (runState.steps || []).findIndex((candidate) => candidate.id === step.id)
  return byId === -1 ? 1 : byId + 1
}

function stepArtifactsDir(runState, step) {
  return path.join(artifactsRootForRunState(runState), 'steps', stepDirectoryName(step, stepOrdinal(runState, step)))
}

function posixPath(filePath) {
  return String(filePath || '').split(path.sep).join('/')
}

function joinLinkPath(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part) !== '')
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .join('/')
}

function stepLinkPrefix(runState, step) {
  return posixPath(path.join('steps', stepDirectoryName(step, stepOrdinal(runState, step))))
}

function runsArtifactsDir(runState, step) {
  return path.join(stepArtifactsDir(runState, step), 'agent-runners')
}

function hasMeaningfulRunArtifact(run = {}) {
  return Boolean(
    String(run.resultText || '').trim() ||
    String(run.error || '').trim() ||
    run.usage ||
    run.fileChanges ||
    run.runnerId ||
    run.sessionId ||
    Object.values(run.links || {}).some(Boolean) ||
    run.issueUrl ||
    run.commentUrl ||
    run.deployUrl ||
    run.prUrl,
  )
}

function isTerminalRun(run = {}) {
  return TERMINAL_STATUSES.has(String(run.status || '').toLowerCase())
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

function writeAtomic(target, content) {
  ensureDir(path.dirname(target))
  const next = String(content)
  if (readFileIfExists(target) === next) return false
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, target)
  return true
}

function writeJson(target, value) {
  return writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`)
}

function existingAttemptFiles(runsDir, agent) {
  if (!fs.existsSync(runsDir)) return []
  const prefix = `${safeArtifactName(agent)}.attempt-`
  return fs.readdirSync(runsDir)
    .map((name) => {
      const match = name.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\\.json$`))
      return match ? { name, number: Number(match[1]) } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number)
}

function existingAttemptCount(runsDir, agent) {
  return existingAttemptFiles(runsDir, agent).reduce((max, item) => Math.max(max, item.number), 0)
}

function nextAttemptNumber(runsDir, agent) {
  return existingAttemptCount(runsDir, agent) + 1
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function attemptNumberForRun(runsDir, run) {
  const agent = safeArtifactName(run.agent || 'agent')
  const attempts = existingAttemptFiles(runsDir, agent)
  for (const attempt of attempts) {
    const parsed = readJsonIfExists(path.join(runsDir, attempt.name))
    if (!parsed) continue
    if (
      String(parsed.runnerId || '') === String(run.runnerId || '') &&
      String(parsed.sessionId || '') === String(run.sessionId || '') &&
      String(parsed.status || '') === String(run.status || '')
    ) {
      return attempt.number
    }
  }
  return 0
}

function runLinks(run = {}) {
  return {
    ...(run.links || {}),
    ...(run.deployUrl ? { deployUrl: run.deployUrl } : {}),
    ...(run.prUrl ? { prUrl: run.prUrl } : {}),
    ...(run.issueUrl ? { issueUrl: run.issueUrl } : {}),
    ...(run.commentUrl ? { commentUrl: run.commentUrl } : {}),
  }
}

function resultUrlForRun(run = {}) {
  const links = runLinks(run)
  return links.sessionUrl || links.agentRunUrl || links.commentUrl || links.issueUrl || links.deployUrl || links.prUrl || ''
}

/**
 * Agent artifact JSON build options.
 * @typedef {{
 *   runState?: import('../../types').WorkflowRunState,
 *   step?: import('../../types').WorkflowStep,
 *   run?: import('../../types').AgentRun,
 *   attemptNumber?: number | null,
 * }} BuildAgentJsonInput
 *
 * Agent artifact Markdown build options.
 * @typedef {{
 *   runState: import('../../types').WorkflowRunState,
 *   step: import('../../types').WorkflowStep,
 *   run: import('../../types').AgentRun,
 * }} BuildAgentMarkdownInput
 */

/** @param {BuildAgentJsonInput} param0 */
function buildAgentJson({ runState = {}, step = {}, run = {}, attemptNumber = null } = {}) {
  return {
    ...artifactMeta(),
    runId: runState.runId || '',
    stepId: step.id || '',
    stepTitle: step.title || step.id || '',
    stepOrdinal: stepOrdinal(runState, step),
    agent: run.agent || '',
    status: run.status || '',
    runnerId: run.runnerId || '',
    sessionId: run.sessionId || '',
    attemptOf: attemptNumber ? (run.agent || '') : null,
    attemptNumber,
    usage: run.usage || null,
    fileChanges: run.fileChanges || null,
    promptDelivery: run.promptDelivery || null,
    contextFetchStatus: run.contextFetchStatus || '',
    contextFetchSignals: run.contextFetchSignals || [],
    contextFetchConfirmed: run.contextFetchConfirmed === true,
    links: runLinks(run),
    error: run.error || (run.status === 'failed' ? run.resultText || '' : ''),
    resultText: run.resultText || '',
  }
}

/** @param {BuildAgentMarkdownInput} param0 */
function buildAgentMarkdown({ runState, step, run }) {
  const title = `${run.agent || 'Agent'} · ${step.title || step.id || 'Step'}`
  const lines = [
    `# ${title}`,
    '',
    `- Status: ${run.status || 'unknown'}`,
  ]
  if (run.runnerId) lines.push(`- Runner ID: \`${run.runnerId}\``)
  if (run.sessionId) lines.push(`- Session ID: \`${run.sessionId}\``)
  const usage = formatUsageSummary(run.usage || {})
  if (usage) lines.push(`- Usage: ${usage}`)
  if (run.promptDelivery?.mode) lines.push(`- Prompt delivery: ${run.promptDelivery.mode}`)
  if (run.contextFetchStatus) lines.push(`- Offloaded context: ${run.contextFetchStatus}`)
  const fileChanges = formatFileChangesSummary(run.fileChanges || {})
  if (fileChanges) lines.push(`- File changes: ${fileChanges}`)
  const url = resultUrlForRun(run)
  if (url) lines.push(`- Link: ${url}`)
  lines.push('', '---', '')
  if (String(run.resultText || '').trim()) {
    lines.push(formatAgentResultMarkdown(String(run.resultText).trimEnd()))
  } else if (run.error || run.status === 'failed' || run.status === 'timeout') {
    lines.push(`**${run.status || 'failed'}**: ${run.error || run.resultText || 'No result text was returned.'}`)
  } else {
    lines.push('_No result text._')
  }
  lines.push('')
  return lines.join('\n')
}

function demoteMarkdownHeadings(markdown, by = 1) {
  let inFence = false
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^(#{1,6})(\s+)/, (_match, hashes, spacing) => {
        const nextLevel = Math.min(6, hashes.length + by)
        return `${'#'.repeat(nextLevel)}${spacing}`
      })
    })
    .join('\n')
}

function parseMarkdownHeading(line) {
  const match = /^(#{1,6})(\s+)(.*)$/.exec(line)
  if (!match) return null
  return {
    level: match[1].length,
    text: match[3].replace(/\s+#+\s*$/, '').trim(),
  }
}

function stripHeadingNumberPrefix(text) {
  return String(text || '').replace(/^\d+\.\s+/, '').trim()
}

function isRepositoryStateHeading(text) {
  return stripHeadingNumberPrefix(text).toLowerCase() === 'repository state'
}

function formatAgentLabel(agent) {
  const normalized = String(agent || 'Agent').trim() || 'Agent'
  return normalized.replace(/(^|-)([a-z])/g, (_match, prefix, char) => `${prefix}${char.toUpperCase()}`)
}

function formatRunResultsHeading(run) {
  const label = `${formatAgentLabel(run?.agent)} Results`
  const url = resultUrlForRun(run)
  return url ? `[${label}](${url})` : label
}

function stripNumberedMarkdownHeadings(markdown) {
  let inFence = false
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/^(#{1,6}\s+)\d+\.\s+/, '$1')
    })
    .join('\n')
}

function foldRepositoryStateSections(markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  const output = []
  let inFence = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      output.push(line)
      continue
    }
    if (inFence) {
      output.push(line)
      continue
    }

    const heading = parseMarkdownHeading(line)
    if (!heading || !isRepositoryStateHeading(heading.text)) {
      output.push(line)
      continue
    }

    let end = index + 1
    let sectionFence = false
    for (; end < lines.length; end++) {
      const nextLine = lines[end]
      if (/^\s*(```|~~~)/.test(nextLine)) {
        sectionFence = !sectionFence
        continue
      }
      if (sectionFence) continue
      const nextHeading = parseMarkdownHeading(nextLine)
      if (nextHeading && nextHeading.level <= heading.level) break
    }

    const body = lines.slice(index + 1, end)
    while (body.length > 0 && !body[0].trim()) body.shift()
    while (body.length > 0 && !body[body.length - 1].trim()) body.pop()

    output.push('<details>', '<summary>Repository State</summary>', '')
    if (body.length > 0) output.push(...body, '')
    output.push('</details>', '')
    index = end - 1
  }

  return output.join('\n')
}

function nestedMarkdownHeadings(markdown, parentLevel = 2) {
  const lines = String(markdown || '').split(/\r?\n/)
  const headingLevels = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,6})\s+/.exec(line)
    if (match) headingLevels.push(match[1].length)
  }

  if (headingLevels.length === 0) return lines.join('\n')

  const firstNestedLevel = Math.min(6, parentLevel + 1)
  const minLevel = Math.min(...headingLevels)
  const offset = firstNestedLevel - minLevel
  if (offset === 0) return lines.join('\n')

  inFence = false
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    return line.replace(/^(#{1,6})(\s+)/, (_match, hashes, spacing) => {
      const nextLevel = Math.max(1, Math.min(6, hashes.length + offset))
      return `${'#'.repeat(nextLevel)}${spacing}`
    })
  }).join('\n')
}

function formatNestedAgentMarkdown(markdown) {
  return nestedMarkdownHeadings(stripNumberedMarkdownHeadings(foldRepositoryStateSections(markdown)))
}

function formatAgentResultMarkdown(markdown) {
  return stripNumberedMarkdownHeadings(foldRepositoryStateSections(markdown))
}

function attemptsForAgent(runsDir, agent) {
  const safeAgent = safeArtifactName(agent || 'agent')
  return existingAttemptFiles(runsDir, safeAgent).map((attempt) => {
    const metadataPath = `agent-runners/${safeAgent}.attempt-${attempt.number}.json`
    const resultPath = `agent-runners/${safeAgent}.attempt-${attempt.number}.md`
    const parsed = readJsonIfExists(path.join(runsDir, `${safeAgent}.attempt-${attempt.number}.json`)) || {}
    return {
      attemptNumber: attempt.number,
      resultPath,
      metadataPath,
      status: parsed.status || '',
      runnerId: parsed.runnerId || '',
      sessionId: parsed.sessionId || '',
    }
  })
}

function runArtifactLinks(runState, step, run, linkPrefix = '') {
  const runsDir = runsArtifactsDir(runState, step)
  const agent = safeArtifactName(run.agent || 'agent')
  const links = []
  const latestMarkdown = path.join(runsDir, `${agent}.md`)
  const latestJson = path.join(runsDir, `${agent}.json`)
  if (fs.existsSync(latestMarkdown)) links.push(`[result](${joinLinkPath(linkPrefix, 'agent-runners', `${agent}.md`)})`)
  if (fs.existsSync(latestJson)) links.push(`[metadata](${joinLinkPath(linkPrefix, 'agent-runners', `${agent}.json`)})`)
  for (const attempt of attemptsForAgent(runsDir, agent)) {
    links.push(`[attempt ${attempt.attemptNumber}](${joinLinkPath(linkPrefix, attempt.resultPath)})`)
  }
  return links
}

/**
 * Step artifact JSON build options.
 * @typedef {{
 *   runState?: import('../../types').WorkflowRunState,
 *   step?: import('../../types').WorkflowStep,
 *   ordinal?: number,
 * }} BuildStepJsonInput
 *
 * Step artifact Markdown build options.
 * @typedef {{
 *   runState: import('../../types').WorkflowRunState,
 *   step: import('../../types').WorkflowStep,
 *   linkPrefix?: string,
 * }} BuildStepMarkdownInput
 */

/** @param {BuildStepJsonInput} param0 */
function buildStepJson({ runState = {}, step = {}, ordinal = stepOrdinal(runState, step) } = {}) {
  const usage = usageSummariesForRunState({ steps: [step] }).steps[0]?.usage || {}
  const runsDir = runsArtifactsDir(runState, step)
  const stepDir = stepArtifactsDir(runState, step)
  return {
    ...artifactMeta(),
    ordinal,
    id: step.id || '',
    title: step.title || step.id || '',
    action: step.action || '',
    status: step.status || '',
    agents: step.agents || [],
    usage,
    runs: (step.runs || []).map((run) => {
      const agent = safeArtifactName(run.agent || 'agent')
      return {
        agent: run.agent || '',
        status: run.status || '',
        runnerId: run.runnerId || '',
        sessionId: run.sessionId || '',
        runnerPath: run.runnerId && runState.projectRoot
          ? posixPath(path.relative(stepDir, path.join(runState.projectRoot, '.nax', 'agent-runners', run.runnerId, 'summary.md')))
          : '',
        sessionPath: run.sessionId && runState.projectRoot
          ? posixPath(path.relative(stepDir, path.join(runState.projectRoot, '.nax', 'agent-sessions', run.sessionId, 'summary.md')))
          : '',
        resultPath: `agent-runners/${agent}.md`,
        metadataPath: `agent-runners/${agent}.json`,
        attempts: attemptsForAgent(runsDir, agent),
        usage: run.usage || null,
        promptDelivery: run.promptDelivery || null,
        contextFetchStatus: run.contextFetchStatus || '',
        contextFetchSignals: run.contextFetchSignals || [],
        contextFetchConfirmed: run.contextFetchConfirmed === true,
        links: runLinks(run),
      }
    }),
  }
}

/** @param {BuildStepMarkdownInput} param0 */
function buildStepMarkdown({ runState, step, linkPrefix = '' }) {
  const usage = usageSummariesForRunState({ steps: [step] }).steps[0]?.summary || ''
  const currentDir = linkPrefix ? artifactsRootForRunState(runState) : stepArtifactsDir(runState, step)
  const lines = [
    `# ${step.title || step.id || 'Step'}`,
    '',
    `- Status: ${step.status || 'unknown'}`,
  ]
  if (usage) lines.push(`- Usage: ${usage}`)
  lines.push(`- Files: [step metadata](${joinLinkPath(linkPrefix, 'step.json')}), [usage](${joinLinkPath(linkPrefix, 'usage.json')})`)
  for (const run of step.runs || []) {
    lines.push('', `## ${formatRunResultsHeading(run)}`, '')
    const links = runArtifactLinks(runState, step, run, linkPrefix)
    if (links.length > 0) lines.push(`- Files: ${links.join(', ')}`)
    if (run.runnerId || run.sessionId) {
      const canonicalLinks = []
      if (run.runnerId && runState.projectRoot) {
        canonicalLinks.push(`[runner](${posixPath(path.relative(currentDir, path.join(runState.projectRoot, '.nax', 'agent-runners', run.runnerId, 'summary.md')))})`)
      }
      if (run.sessionId && runState.projectRoot) {
        canonicalLinks.push(`[session](${posixPath(path.relative(currentDir, path.join(runState.projectRoot, '.nax', 'agent-sessions', run.sessionId, 'summary.md')))})`)
      }
      if (canonicalLinks.length > 0) lines.push(`- Canonical artifacts: ${canonicalLinks.join(', ')}`)
    }
    const filePath = path.join(runsArtifactsDir(runState, step), `${safeArtifactName(run.agent || 'agent')}.md`)
    const markdown = readFileIfExists(filePath).trim()
    if (markdown) {
      const nestedMarkdown = markdown.replace(/^# .+\n+/, '').trim()
      lines.push(formatNestedAgentMarkdown(nestedMarkdown).trim())
    } else if (run.resultText) {
      lines.push(formatNestedAgentMarkdown(String(run.resultText).trim()).trim())
    } else {
      lines.push('_No result text._')
    }
  }
  lines.push('')
  return lines.join('\n')
}

function workflowRunSource(runState = {}, step = {}) {
  return {
    type: 'workflow-step',
    workflowRunId: runState.runId || '',
    stepId: step.id || '',
    stepTitle: step.title || step.id || '',
  }
}

function persistCanonicalAgentArtifacts(runState = {}, step = {}, run = {}, options = {}) {
  if (!runState.projectRoot || !isTerminalRun(run) || !hasMeaningfulRunArtifact(run)) return null
  const source = options.source || workflowRunSource(runState, step)
  const rawSession = run.rawResult?.latestSession || run.rawResult?.session || {}
  const rawRunner = run.rawResult?.runner || {}
  const createdAt = run.createdAt || rawSession.created_at || rawRunner.created_at || runState.createdAt || ''
  const updatedAt = run.updatedAt || rawSession.done_at || rawSession.updated_at || rawRunner.done_at || rawRunner.updated_at || runState.updatedAt || ''
  const sessionResult = persistAgentSessionArtifact({
    projectRoot: runState.projectRoot,
    run,
    source,
    createdAt,
    updatedAt,
  }, options)
  if (sessionResult?.session?.sessionId && !run.sessionId) run.sessionId = sessionResult.session.sessionId
  const runnerResult = run.runnerId ? persistAgentRunnerArtifact({
    projectRoot: runState.projectRoot,
    runnerId: run.runnerId,
    agent: run.agent || '',
    status: run.status || '',
    session: sessionResult?.session || null,
    source,
    links: runLinks(run),
    createdAt,
    updatedAt,
  }, options) : null
  return { session: sessionResult, runner: runnerResult }
}

function buildTopUsageJson(runState = {}) {
  const summaries = usageSummariesForRunState(runState)
  return {
    ...artifactMeta(),
    runId: runState.runId || '',
    target: runState.target || null,
    total: summaries.total,
    totalSummary: summaries.totalSummary,
    steps: summaries.steps,
  }
}

function buildTopSummaryMarkdown(runState = {}) {
  const usage = usageSummariesForRunState(runState)
  const lines = [
    `# ${runState.flowTitle || runState.flowId || 'Workflow'} · ${runState.runId || ''}`.trim(),
    '',
    `- Run ID: \`${runState.runId || ''}\``,
    `- Flow: \`${runState.flowId || ''}\``,
    `- Transport: \`${runState.transport || ''}\``,
    `- Status: ${runState.status || 'running'}`,
  ]
  if (usage.totalSummary) lines.push(`- Usage: ${usage.totalSummary}`)
  if (runState.target) {
    lines.push(`- Target: \`${runState.target.branch || 'unknown'}\` (${runState.target.sourceType || 'unknown'}, ${runState.target.verified ? 'verified' : 'unverified'})`)
    if (runState.target.sha) lines.push(`- Target SHA: \`${runState.target.sha}\``)
    if (Array.isArray(runState.target.caveats) && runState.target.caveats.length > 0) {
      lines.push(`- Target caveats: ${runState.target.caveats.map((caveat) => `\`${caveat}\``).join(', ')}`)
    }
  }
  lines.push(`- Files: [usage](usage.json)`)
  const steps = runState.steps || []
  if (steps.length > 0) {
    lines.push('', '## Contents', '')
    steps.forEach((step, index) => {
      const prefix = stepLinkPrefix(runState, step)
      lines.push(`${index + 1}. [${step.title || step.id}](#${safeArtifactName(step.title || step.id)}) · [summary](${prefix}/summary.md) · [metadata](${prefix}/step.json) · [usage](${prefix}/usage.json)`)
    })
  }
  for (const step of steps) {
    lines.push('', '---', '')
    lines.push(buildStepMarkdown({ runState, step, linkPrefix: stepLinkPrefix(runState, step) }).trim() || `## ${step.title || step.id}`)
  }
  lines.push('')
  return lines.join('\n')
}

function writeAgentFiles(runState, step, run, options = {}) {
  if (!isTerminalRun(run) || !hasMeaningfulRunArtifact(run)) return null
  const dir = runsArtifactsDir(runState, step)
  ensureDir(dir)
  const canonical = persistCanonicalAgentArtifacts(runState, step, run, options)
  const agent = safeArtifactName(run.agent || 'agent')
  let attemptNumber = attemptNumberForRun(dir, run)
  if (!attemptNumber) attemptNumber = nextAttemptNumber(dir, agent)
  const json = buildAgentJson({ runState, step, run, attemptNumber })
  const markdown = buildAgentMarkdown({ runState, step, run })
  const attemptBase = path.join(dir, `${agent}.attempt-${attemptNumber}`)
  if (!options.dryRun) {
    writeJson(`${attemptBase}.json`, json)
    writeAtomic(`${attemptBase}.md`, markdown)
    writeJson(path.join(dir, `${agent}.json`), { ...json, attemptOf: null })
    writeAtomic(path.join(dir, `${agent}.md`), markdown)
  }
  return {
    attemptNumber,
    jsonPath: `${attemptBase}.json`,
    markdownPath: `${attemptBase}.md`,
    canonical,
  }
}

function writeStepSummaryFiles(runState, step, options = {}) {
  const dir = stepArtifactsDir(runState, step)
  if (options.dryRun) return
  ensureDir(dir)
  writeJson(path.join(dir, 'step.json'), buildStepJson({ runState, step }))
  const stepUsage = usageSummariesForRunState({ steps: [step] })
  writeJson(path.join(dir, 'usage.json'), {
    ...artifactMeta(),
    stepId: step.id || '',
    usage: stepUsage.steps[0]?.usage || {},
    summary: stepUsage.steps[0]?.summary || '',
  })
  writeAtomic(path.join(dir, 'summary.md'), buildStepMarkdown({ runState, step }))
}

function updateLatestSymlink(runState = {}) {
  if (!runState.dir) return false
  const runsDir = path.dirname(runState.dir)
  const latest = path.join(runsDir, 'latest')
  const tmp = path.join(runsDir, `latest.tmp-${process.pid}-${Date.now()}`)
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
    fs.symlinkSync(path.basename(runState.dir), tmp, 'dir')
    fs.rmSync(latest, { recursive: true, force: true })
    fs.renameSync(tmp, latest)
    return true
  } catch (error) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures.
    }
    if (process.env.NAX_DEBUG_ARTIFACTS) {
      console.error(`nax artifact latest symlink failed: ${error.message}`)
    }
    return false
  }
}

function persistStepArtifacts(runState = {}, step = {}, options = {}) {
  if (!runState.dir) return null
  if (!options.summaryOnly) {
    for (const run of step.runs || []) writeAgentFiles(runState, step, run, options)
  }
  writeStepSummaryFiles(runState, step, options)
  persistWorkflowArtifacts(runState, { ...options, summaryOnly: true })
  return stepArtifactsDir(runState, step)
}

function persistRunArtifact(runState = {}, step = {}, run = {}, options = {}) {
  if (!runState.dir || !isTerminalRun(run)) return null
  const result = writeAgentFiles(runState, step, run, options)
  writeStepSummaryFiles(runState, step, options)
  persistWorkflowArtifacts(runState, { ...options, summaryOnly: true })
  return result
}

function persistWorkflowArtifacts(runState = {}, options = {}) {
  const root = artifactsRootForRunState(runState)
  if (!root) return null
  if (!options.dryRun) ensureDir(root)
  for (const step of runState.steps || []) {
    if (!options.summaryOnly) {
      for (const run of step.runs || []) writeAgentFiles(runState, step, run, options)
    }
    writeStepSummaryFiles(runState, step, options)
  }
  if (!options.dryRun) {
    writeJson(path.join(root, 'usage.json'), buildTopUsageJson(runState))
    writeAtomic(path.join(root, 'summary.md'), buildTopSummaryMarkdown(runState))
    if (options.updateLatest !== false) updateLatestSymlink(runState)
    if (options.writeGithubSummary) writeGithubStepSummary(runState, options)
  }
  return root
}

function compactGithubSummary(runState = {}) {
  const usage = usageSummariesForRunState(runState)
  const lines = [
    `# ${runState.flowTitle || runState.flowId || 'nax'} artifacts`,
    '',
    `- Run ID: \`${runState.runId || ''}\``,
    `- Flow: \`${runState.flowId || ''}\``,
    `- Status: ${runState.status || 'running'}`,
  ]
  if (usage.totalSummary) lines.push(`- Usage: ${usage.totalSummary}`)
  if (runState.target) {
    lines.push(`- Target: \`${runState.target.branch || 'unknown'}\` (${runState.target.sourceType || 'unknown'}, ${runState.target.verified ? 'verified' : 'unverified'})`)
    if (Array.isArray(runState.target.caveats) && runState.target.caveats.length > 0) {
      lines.push(`- Target caveats: ${runState.target.caveats.map((caveat) => `\`${caveat}\``).join(', ')}`)
    }
  }
  lines.push('', `Full output: download the \`nax-${runState.flowId || 'workflow'}-${process.env.GITHUB_RUN_ID || runState.runId || 'run'}\` artifact from this job.`, '')
  for (const step of usage.steps) lines.push(`- ${step.title}: ${step.summary}`)
  lines.push('')
  return lines.join('\n')
}

function truncateForGithubSummary(content, notice) {
  const max = GITHUB_STEP_SUMMARY_LIMIT_BYTES - Buffer.byteLength(notice)
  let truncated = String(content || '')
  while (Buffer.byteLength(truncated) > max && truncated.length > 0) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.95))
  }
  return `${truncated.trimEnd()}\n\n${notice}`
}

function writeGithubStepSummary(runState = {}, options = {}) {
  const target = options.githubStepSummary || process.env.GITHUB_STEP_SUMMARY
  if (!target) return false
  const root = artifactsRootForRunState(runState)
  const summaryPath = path.join(root, 'summary.md')
  const notice = `---\n*Truncated. Full output: download the \`nax-${runState.flowId || 'workflow'}-${process.env.GITHUB_RUN_ID || runState.runId || 'run'}\` artifact from this job.*\n`
  let content = readFileIfExists(summaryPath)
  if (Buffer.byteLength(content) > GITHUB_STEP_SUMMARY_LIMIT_BYTES) {
    content = compactGithubSummary(runState)
  }
  if (Buffer.byteLength(content) > GITHUB_STEP_SUMMARY_LIMIT_BYTES) {
    content = truncateForGithubSummary(content, notice)
  }
  fs.appendFileSync(target, `${content.trimEnd()}\n`)
  return true
}

module.exports = {
  artifactsRootForRunState,
  buildAgentJson,
  buildAgentMarkdown,
  buildStepJson,
  buildStepMarkdown,
  buildTopSummaryMarkdown,
  buildTopUsageJson,
  demoteMarkdownHeadings,
  nestedMarkdownHeadings,
  existingAttemptCount,
  nextAttemptNumber,
  persistRunArtifact,
  persistStepArtifacts,
  persistWorkflowArtifacts,
  resultUrlForRun,
  safeArtifactName,
  stepArtifactsDir,
  stepDirectoryName,
  updateLatestSymlink,
  writeAtomic,
  writeGithubStepSummary,
}
