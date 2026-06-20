const fs = require('fs')
const path = require('path')

const { loadStepPrompt } = require('./flows')

function readText(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return ''
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function readJson(filePath) {
  try {
    const text = readText(filePath)
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function fileSize(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return 0
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function listDirectories(dir) {
  try {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  } catch {
    return []
  }
}

function listFiles(dir, predicate = (_name) => true) {
  try {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  } catch {
    return []
  }
}

function listMarkdownFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.includes('.attempt-'))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  } catch {
    return []
  }
}

function relativePath(fromDir, filePath) {
  return filePath ? path.relative(fromDir, filePath) : ''
}

function absolutePath(filePath) {
  return filePath ? path.resolve(filePath) : ''
}

function artifactId(kind, ...parts) {
  return [kind, ...parts.map((part) => String(part || '').replace(/:/g, '-')).filter(Boolean)].join(':')
}

function completed(status) {
  return String(status || '').toLowerCase() === 'completed'
}

function sameTarget(a = {}, b = {}) {
  return a.id && b.id && a.id === b.id
}

function addUnique(items, item) {
  if (!item?.id || items.some((candidate) => candidate.id === item.id)) return
  items.push(item)
}

function followupTargetFromArtifact({
  kind,
  label,
  filePath,
  runDir,
  status = '',
  agent = '',
  stepId = '',
  stepNumber = 0,
  stepTitle = '',
  runnerId = '',
  sessionId = '',
  links = {},
  defaultMode = '',
}) {
  if (!filePath) return null
  return {
    id: artifactId(kind, stepId, runnerId, sessionId, agent || path.basename(filePath, path.extname(filePath))),
    kind,
    label,
    agent,
    stepId,
    stepNumber,
    stepTitle,
    runnerId,
    sessionId,
    status,
    path: relativePath(runDir, filePath),
    absolutePath: absolutePath(filePath),
    links,
    defaultMode: defaultMode || (runnerId ? 'follow-up-thread' : 'fresh-runner'),
    isDefault: false,
  }
}

function followupArtifact({
  kind,
  label,
  filePath,
  runDir,
  defaultSelected = false,
  advanced = false,
  stepId = '',
  stepNumber = 0,
  runnerId = '',
  sessionId = '',
}) {
  if (!filePath) return null
  return {
    id: artifactId(kind, stepId, runnerId, sessionId, path.basename(filePath)),
    kind,
    label,
    path: relativePath(runDir, filePath),
    absolutePath: absolutePath(filePath),
    sizeBytes: fileSize(filePath),
    defaultSelected,
    advanced,
    stepNumber,
    source: {
      stepId,
      stepNumber,
      runnerId,
      sessionId,
    },
  }
}

function externalAgentArtifactPath(runDir, collection, id, fileName = 'summary.md') {
  if (!runDir || !id) return ''
  return path.resolve(runDir, '..', '..', collection, id, fileName)
}

function orderWithDefault(items, defaultItem) {
  return items.map((item) => ({ ...item, isDefault: Boolean(defaultItem && sameTarget(item, defaultItem)) }))
}

function stepTitleFromDir(stepDir, meta) {
  if (meta?.title) return meta.title
  if (meta?.id) return meta.id
  return path.basename(stepDir).replace(/^\d+-/, '').replace(/-/g, ' ')
}

function stepNumberFromDir(stepDir) {
  const match = path.basename(stepDir).match(/^(\d+)-/)
  return match ? Number.parseInt(match[1], 10) : 0
}

function stepNumberLookup(runState = {}) {
  const lookup = new Map()
  const steps = Array.isArray(runState.steps) && runState.steps.length > 0
    ? runState.steps
    : Array.isArray(runState.flow?.steps)
      ? runState.flow.steps
      : []
  steps.forEach((step, index) => {
    if (step?.id) lookup.set(String(step.id), index + 1)
  })
  return lookup
}

function stepNumberFor(stepDir, stepMeta, lookup) {
  const fromId = lookup.get(String(stepMeta?.id || ''))
  if (fromId) return fromId
  return stepNumberFromDir(stepDir)
}

function stepLabel(stepNumber, label) {
  return stepNumber > 0 ? `Step ${stepNumber}: ${label}` : label
}

function promptDetailsForStep(flow, stepMeta = {}) {
  const stepId = String(stepMeta.id || '')
  if (!flow || !Array.isArray(flow.steps) || !stepId) return null
  const step = flow.steps.find((candidate) => String(candidate?.id || '') === stepId)
  if (!step?.prompt) return null
  try {
    const prompt = loadStepPrompt(flow, step)
    return {
      promptMarkdown: prompt.body || '',
      promptPath: prompt.path || '',
      promptTitle: prompt.title || step.title || stepMeta.title || stepId,
    }
  } catch {
    return null
  }
}

function targetSortRank(target = {}) {
  return target.stepNumber || 0
}

function targetKindPriority(kind) {
  switch (kind) {
    case 'step-summary':
      return 0
    case 'agent-result':
      return 1
    case 'runner-summary':
      return 2
    case 'session-result':
      return 3
    case 'workflow-summary':
      return 4
    default:
      return 5
  }
}

function sortTargetsNewestFirst(targets = []) {
  return [...targets].sort((left, right) => {
    const rankDiff = targetSortRank(right) - targetSortRank(left)
    if (rankDiff !== 0) return rankDiff
    const kindDiff = targetKindPriority(left.kind) - targetKindPriority(right.kind)
    if (kindDiff !== 0) return kindDiff
    return String(left.label || '').localeCompare(String(right.label || ''))
  })
}

function artifactKindPriority(kind) {
  switch (kind) {
    case 'workflow-summary':
      return 0
    case 'step-summary':
      return 1
    case 'agent-result':
      return 2
    case 'runner-summary':
      return 3
    case 'session-result':
      return 4
    case 'metadata-json':
      return 5
    case 'attempt-markdown':
      return 6
    case 'usage-json':
      return 7
    default:
      return 8
  }
}

function sortArtifactsNewestFirst(artifacts = []) {
  return [...artifacts].sort((left, right) => {
    if (left.kind === 'workflow-summary' && right.kind !== 'workflow-summary') return -1
    if (right.kind === 'workflow-summary' && left.kind !== 'workflow-summary') return 1
    const rankDiff = (right.stepNumber || 0) - (left.stepNumber || 0)
    if (rankDiff !== 0) return rankDiff
    const kindDiff = artifactKindPriority(left.kind) - artifactKindPriority(right.kind)
    if (kindDiff !== 0) return kindDiff
    return String(left.label || '').localeCompare(String(right.label || ''))
  })
}

function buildRunDetails(runState = {}, options = {}) {
  const runDir = runState.dir || ''
  const artifactsDir = runDir ? path.join(runDir, 'artifacts') : ''
  const summaryPath = artifactsDir ? path.join(artifactsDir, 'summary.md') : ''
  const summaryMarkdown = readText(summaryPath)
  const sections = []
  const sessionSections = []
  const stepTargets = []
  const sessionTargets = []
  const alternateTargets = []
  const followupArtifacts = []
  const stepNumbers = stepNumberLookup(runState)
  const flow = options.flow || runState.flow || null

  if (summaryMarkdown) {
    addUnique(followupArtifacts, followupArtifact({
      kind: 'workflow-summary',
      label: 'Workflow summary',
      filePath: summaryPath,
      runDir,
    }))
  }

  for (const usagePath of listFiles(artifactsDir, (name) => name === 'usage.json')) {
    addUnique(followupArtifacts, followupArtifact({
      kind: 'usage-json',
      label: 'Workflow usage JSON',
      filePath: usagePath,
      runDir,
      advanced: true,
    }))
  }

  for (const stepDir of listDirectories(path.join(artifactsDir, 'steps'))) {
    const stepMeta = readJson(path.join(stepDir, 'step.json')) || {}
    const stepNumber = stepNumberFor(stepDir, stepMeta, stepNumbers)
    const stepTitle = stepTitleFromDir(stepDir, stepMeta)
    const promptDetails = promptDetailsForStep(flow, stepMeta) || {}
    const stepSummaryPath = path.join(stepDir, 'summary.md')
    const stepSummary = readText(stepSummaryPath)

    if (stepSummary) {
      sections.push({
        id: `step:${stepMeta.id || path.basename(stepDir)}`,
        kind: 'step',
        title: stepTitle,
        stepId: stepMeta.id || '',
        stepTitle,
        agent: '',
        status: stepMeta.status || '',
        runnerId: '',
        sessionId: '',
        path: relativePath(runDir, stepSummaryPath),
        absolutePath: absolutePath(stepSummaryPath),
        links: {},
        usage: stepMeta.usage || null,
        markdown: stepSummary,
        ...promptDetails,
      })
      const stepTarget = followupTargetFromArtifact({
        kind: 'step-summary',
        label: `${stepTitle} step summary`,
        filePath: stepSummaryPath,
        runDir,
        status: stepMeta.status || '',
        stepId: stepMeta.id || path.basename(stepDir),
        stepNumber,
        stepTitle,
        defaultMode: 'fresh-runner',
      })
      if (stepTarget) stepTargets.push(stepTarget)
      addUnique(followupArtifacts, followupArtifact({
        kind: 'step-summary',
        label: `${stepTitle} step summary`,
        filePath: stepSummaryPath,
        runDir,
        stepId: stepMeta.id || path.basename(stepDir),
        stepNumber,
      }))
    }

    addUnique(followupArtifacts, followupArtifact({
      kind: 'metadata-json',
      label: `${stepTitle} step metadata JSON`,
      filePath: path.join(stepDir, 'step.json'),
      runDir,
      advanced: true,
      stepId: stepMeta.id || path.basename(stepDir),
      stepNumber,
    }))

    for (const markdownPath of listMarkdownFiles(path.join(stepDir, 'agent-runners'))) {
      const metadataPath = markdownPath.replace(/\.md$/, '.json')
      const metadata = readJson(metadataPath) || {}
      const agent = metadata.agent || path.basename(markdownPath, '.md')
      const markdown = readText(markdownPath)
      if (!markdown) continue
      const section = {
        id: `session:${metadata.runnerId || ''}:${metadata.sessionId || ''}:${agent}:${sections.length}`,
        kind: 'session',
        title: `${stepTitle} · ${agent}`,
        stepId: metadata.stepId || stepMeta.id || '',
        stepTitle,
        agent,
        status: metadata.status || '',
        runnerId: metadata.runnerId || '',
        sessionId: metadata.sessionId || '',
        path: relativePath(runDir, markdownPath),
        absolutePath: absolutePath(markdownPath),
        links: metadata.links || {},
        usage: metadata.usage || null,
        markdown,
        ...promptDetails,
      }
      sections.push(section)
      sessionSections.push(section)
      const sessionTarget = followupTargetFromArtifact({
        kind: 'agent-result',
        label: `${stepTitle} · ${agent} result`,
        filePath: markdownPath,
        runDir,
        status: metadata.status || '',
        agent,
        stepId: metadata.stepId || stepMeta.id || '',
        stepNumber,
        stepTitle,
        runnerId: metadata.runnerId || '',
        sessionId: metadata.sessionId || '',
        links: metadata.links || {},
      })
      if (sessionTarget) sessionTargets.push(sessionTarget)
      addUnique(followupArtifacts, followupArtifact({
        kind: 'agent-result',
        label: `${stepTitle} · ${agent} result`,
        filePath: markdownPath,
        runDir,
        stepId: metadata.stepId || stepMeta.id || '',
        stepNumber,
        runnerId: metadata.runnerId || '',
        sessionId: metadata.sessionId || '',
      }))
      addUnique(followupArtifacts, followupArtifact({
        kind: 'metadata-json',
        label: `${stepTitle} · ${agent} metadata JSON`,
        filePath: metadataPath,
        runDir,
        advanced: true,
        stepId: metadata.stepId || stepMeta.id || '',
        stepNumber,
        runnerId: metadata.runnerId || '',
        sessionId: metadata.sessionId || '',
      }))

      const runnerSummaryPath = externalAgentArtifactPath(runDir, 'agent-runners', metadata.runnerId)
      if (readText(runnerSummaryPath)) {
        const runnerTarget = followupTargetFromArtifact({
          kind: 'runner-summary',
          label: `${agent} runner summary`,
          filePath: runnerSummaryPath,
          runDir,
          status: metadata.status || '',
          agent,
          stepId: metadata.stepId || stepMeta.id || '',
          stepNumber,
          stepTitle,
          runnerId: metadata.runnerId || '',
          sessionId: metadata.sessionId || '',
          links: metadata.links || {},
        })
        if (runnerTarget) alternateTargets.push(runnerTarget)
        addUnique(followupArtifacts, followupArtifact({
          kind: 'runner-summary',
          label: `${agent} runner summary`,
          filePath: runnerSummaryPath,
          runDir,
          stepId: metadata.stepId || stepMeta.id || '',
          stepNumber,
          runnerId: metadata.runnerId || '',
          sessionId: metadata.sessionId || '',
        }))
      }

      const sessionSummaryPath = externalAgentArtifactPath(runDir, 'agent-sessions', metadata.sessionId)
      if (readText(sessionSummaryPath)) {
        const externalSessionTarget = followupTargetFromArtifact({
          kind: 'session-result',
          label: `${agent} session summary`,
          filePath: sessionSummaryPath,
          runDir,
          status: metadata.status || '',
          agent,
          stepId: metadata.stepId || stepMeta.id || '',
          stepNumber,
          stepTitle,
          runnerId: metadata.runnerId || '',
          sessionId: metadata.sessionId || '',
          links: metadata.links || {},
        })
        if (externalSessionTarget) alternateTargets.push(externalSessionTarget)
        addUnique(followupArtifacts, followupArtifact({
          kind: 'session-result',
          label: `${agent} session summary`,
          filePath: sessionSummaryPath,
          runDir,
          stepId: metadata.stepId || stepMeta.id || '',
          stepNumber,
          runnerId: metadata.runnerId || '',
          sessionId: metadata.sessionId || '',
        }))
      }
    }

    for (const attemptPath of listFiles(path.join(stepDir, 'agent-runners'), (name) => /\.attempt-\d+\.md$/.test(name))) {
      addUnique(followupArtifacts, followupArtifact({
        kind: 'attempt-markdown',
        label: `${stepTitle} · ${path.basename(attemptPath, '.md')} attempt markdown`,
        filePath: attemptPath,
        runDir,
        advanced: true,
        stepId: stepMeta.id || path.basename(stepDir),
        stepNumber,
      }))
    }
  }

  const finalSection = sessionSections[sessionSections.length - 1] || sections[sections.length - 1] || null
  const workflowTarget = summaryMarkdown ? followupTargetFromArtifact({
    kind: 'workflow-summary',
    label: 'Workflow summary',
    filePath: summaryPath,
    runDir,
    status: runState.status || '',
    defaultMode: 'fresh-runner',
  }) : null
  const latestCompletedSessionTarget = [...sessionTargets].reverse().find((target) => completed(target.status)) || sessionTargets[sessionTargets.length - 1] || null
  const defaultTarget = [...stepTargets].reverse().find((target) => target.absolutePath) || workflowTarget || latestCompletedSessionTarget
  const labelledTargets = [
    ...stepTargets,
    ...sessionTargets,
    ...(workflowTarget ? [workflowTarget] : []),
    ...alternateTargets,
  ].map((target) => ({
    ...target,
    label: target.stepNumber ? stepLabel(target.stepNumber, target.label) : target.label,
  }))
  const followupTargets = orderWithDefault(sortTargetsNewestFirst(labelledTargets), defaultTarget)
  const defaultArtifactPath = summaryMarkdown ? summaryPath : defaultTarget?.absolutePath || ''
  const finalArtifacts = sortArtifactsNewestFirst(followupArtifacts.map((artifact) => ({
    ...artifact,
    label: artifact.stepNumber ? stepLabel(artifact.stepNumber, artifact.label) : artifact.label,
    defaultSelected: Boolean(defaultArtifactPath && artifact.absolutePath === defaultArtifactPath),
  })))

  return {
    summaryPath: relativePath(runDir, summaryPath),
    summaryAbsolutePath: absolutePath(summaryPath),
    summaryMarkdown,
    finalMarkdown: finalSection?.markdown || summaryMarkdown,
    finalTitle: finalSection?.title || 'Final result',
    sections,
    followupTargets,
    followupArtifacts: finalArtifacts,
  }
}

module.exports = {
  buildRunDetails,
}
