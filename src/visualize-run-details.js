const fs = require('fs')
const path = require('path')

const { loadStepPrompt } = require('./flows')

/**
 * File-name predicate used while scanning artifact directories.
 * @callback FileNamePredicate
 * @param {string} name
 * @returns {boolean}
 */

/**
 * Step metadata persisted beside visualizer step artifacts.
 * @typedef {import('./types').JsonMap & {
 *   id?: string,
 *   title?: string,
 *   status?: string,
 *   usage?: import('./types').UsageSummary,
 * }} StepArtifactMetadata
 *
 * Agent metadata persisted beside visualizer result artifacts.
 * @typedef {import('./types').JsonMap & {
 *   agent?: string,
 *   stepId?: string,
 *   status?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   links?: import('./types').StringMap,
 *   usage?: import('./types').UsageSummary,
 * }} AgentArtifactMetadata
 *
 * Prompt details associated with a workflow step.
 * @typedef {{
 *   promptMarkdown: string,
 *   promptPath: string,
 *   promptTitle: string,
 * }} PromptDetails
 */

/**
 * Input for constructing a selectable follow-up target.
 * @typedef {{
 *   kind: string,
 *   label: string,
 *   filePath: string,
 *   runDir: string,
 *   status?: string,
 *   agent?: string,
 *   stepId?: string,
 *   stepNumber?: number,
 *   stepTitle?: string,
 *   runnerId?: string,
 *   sessionId?: string,
 *   links?: import('./types').StringMap,
 *   defaultMode?: string,
 * }} FollowupTargetInput
 *
 * Selectable follow-up target shown in the visualizer.
 * @typedef {import('./types').FollowupTarget & {
 *   id: string,
 *   kind: string,
 *   label: string,
 *   agent: string,
 *   stepId: string,
 *   stepNumber: number,
 *   stepTitle: string,
 *   runnerId: string,
 *   sessionId: string,
 *   status: string,
 *   path: string,
 *   absolutePath: string,
 *   links: import('./types').StringMap,
 *   defaultMode: string,
 *   isDefault: boolean,
 * }} RunDetailFollowupTarget
 */

/**
 * Input for constructing a selectable follow-up artifact.
 * @typedef {{
 *   kind: string,
 *   label: string,
 *   filePath: string,
 *   runDir: string,
 *   defaultSelected?: boolean,
 *   advanced?: boolean,
 *   stepId?: string,
 *   stepNumber?: number,
 *   runnerId?: string,
 *   sessionId?: string,
 * }} FollowupArtifactInput
 *
 * Selectable follow-up artifact shown in the visualizer.
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   label: string,
 *   path: string,
 *   absolutePath: string,
 *   sizeBytes: number,
 *   defaultSelected: boolean,
 *   advanced: boolean,
 *   stepNumber: number,
 *   source: {
 *     stepId: string,
 *     stepNumber: number,
 *     runnerId: string,
 *     sessionId: string,
 *   },
 * }} RunDetailFollowupArtifact
 */

/**
 * Markdown section displayed in visualizer run details.
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   title: string,
 *   stepId: string,
 *   stepTitle: string,
 *   agent: string,
 *   status: string,
 *   runnerId: string,
 *   sessionId: string,
 *   path: string,
 *   absolutePath: string,
 *   links: import('./types').StringMap,
 *   usage: import('./types').UsageSummary | null,
 *   markdown: string,
 *   promptMarkdown?: string,
 *   promptPath?: string,
 *   promptTitle?: string,
 * }} RunDetailSection
 *
 * Options for building visualizer run details.
 * @typedef {{
 *   flow?: import('./types').WorkflowFlow | null,
 * }} BuildRunDetailsOptions
 *
 * Visualizer run detail payload.
 * @typedef {{
 *   summaryPath: string,
 *   summaryAbsolutePath: string,
 *   summaryMarkdown: string,
 *   finalMarkdown: string,
 *   finalTitle: string,
 *   sections: RunDetailSection[],
 *   followupTargets: RunDetailFollowupTarget[],
 *   followupArtifacts: RunDetailFollowupArtifact[],
 * }} RunDetails
 */

/** @param {string} filePath @returns {string} */
function readText(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return ''
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** @param {string} filePath @returns {import('./types').JsonMap | null} */
function readJson(filePath) {
  try {
    const text = readText(filePath)
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** @param {string} filePath @returns {number} */
function fileSize(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return 0
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

/** @param {string} dir @returns {string[]} */
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

/** @param {string} dir @param {FileNamePredicate} [predicate] @returns {string[]} */
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

/** @param {string} dir @returns {string[]} */
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

/** @param {string} fromDir @param {string} filePath @returns {string} */
function relativePath(fromDir, filePath) {
  return filePath ? path.relative(fromDir, filePath) : ''
}

/** @param {string} filePath @returns {string} */
function absolutePath(filePath) {
  return filePath ? path.resolve(filePath) : ''
}

/** @param {string} kind @param {...unknown} parts @returns {string} */
function artifactId(kind, ...parts) {
  return [kind, ...parts.map((part) => String(part || '').replace(/:/g, '-')).filter(Boolean)].join(':')
}

/** @param {unknown} status @returns {boolean} */
function completed(status) {
  return String(status || '').toLowerCase() === 'completed'
}

/** @param {{ id?: string }} [a] @param {{ id?: string }} [b] @returns {boolean} */
function sameTarget(a = {}, b = {}) {
  return a.id && b.id && a.id === b.id
}

/**
 * @template {{ id?: string }} T
 * @param {T[]} items
 * @param {T | null} item
 * @returns {void}
 */
function addUnique(items, item) {
  if (!item?.id || items.some((candidate) => candidate.id === item.id)) return
  items.push(item)
}

/** @param {FollowupTargetInput} input @returns {RunDetailFollowupTarget | null} */
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

/** @param {FollowupArtifactInput} input @returns {RunDetailFollowupArtifact | null} */
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

/**
 * @param {string} runDir
 * @param {string} collection
 * @param {string} id
 * @param {string} [fileName]
 * @returns {string}
 */
function externalAgentArtifactPath(runDir, collection, id, fileName = 'summary.md') {
  if (!runDir || !id) return ''
  return path.resolve(runDir, '..', '..', collection, id, fileName)
}

/**
 * @param {RunDetailFollowupTarget[]} items
 * @param {RunDetailFollowupTarget | null} defaultItem
 * @returns {RunDetailFollowupTarget[]}
 */
function orderWithDefault(items, defaultItem) {
  return items.map((item) => ({ ...item, isDefault: Boolean(defaultItem && sameTarget(item, defaultItem)) }))
}

/** @param {string} stepDir @param {StepArtifactMetadata} meta @returns {string} */
function stepTitleFromDir(stepDir, meta) {
  if (meta?.title) return meta.title
  if (meta?.id) return meta.id
  return path.basename(stepDir).replace(/^\d+-/, '').replace(/-/g, ' ')
}

/** @param {string} stepDir @returns {number} */
function stepNumberFromDir(stepDir) {
  const match = path.basename(stepDir).match(/^(\d+)-/)
  return match ? Number.parseInt(match[1], 10) : 0
}

/** @param {import('./types').WorkflowRunState} [runState] @returns {Map<string, number>} */
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

/**
 * @param {string} stepDir
 * @param {StepArtifactMetadata} stepMeta
 * @param {Map<string, number>} lookup
 * @returns {number}
 */
function stepNumberFor(stepDir, stepMeta, lookup) {
  const fromId = lookup.get(String(stepMeta?.id || ''))
  if (fromId) return fromId
  return stepNumberFromDir(stepDir)
}

/** @param {number} stepNumber @param {string} label @returns {string} */
function stepLabel(stepNumber, label) {
  return stepNumber > 0 ? `Step ${stepNumber}: ${label}` : label
}

/**
 * @param {import('./types').WorkflowFlow | null} flow
 * @param {StepArtifactMetadata} [stepMeta]
 * @returns {PromptDetails | null}
 */
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

/** @param {{ stepNumber?: number }} [target] @returns {number} */
function targetSortRank(target = {}) {
  return target.stepNumber || 0
}

/** @param {string} kind @returns {number} */
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

/** @param {RunDetailFollowupTarget[]} [targets] @returns {RunDetailFollowupTarget[]} */
function sortTargetsNewestFirst(targets = []) {
  return [...targets].sort((left, right) => {
    const rankDiff = targetSortRank(right) - targetSortRank(left)
    if (rankDiff !== 0) return rankDiff
    const kindDiff = targetKindPriority(left.kind) - targetKindPriority(right.kind)
    if (kindDiff !== 0) return kindDiff
    return String(left.label || '').localeCompare(String(right.label || ''))
  })
}

/** @param {string} kind @returns {number} */
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

/** @param {RunDetailFollowupArtifact[]} [artifacts] @returns {RunDetailFollowupArtifact[]} */
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

/**
 * @param {import('./types').WorkflowRunState} [runState]
 * @param {BuildRunDetailsOptions} [options]
 * @returns {RunDetails}
 */
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
    /** @type {StepArtifactMetadata} */
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
      /** @type {AgentArtifactMetadata} */
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
