const fs = require('fs')
const path = require('path')

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

function stepTitleFromDir(stepDir, meta) {
  if (meta?.title) return meta.title
  if (meta?.id) return meta.id
  return path.basename(stepDir).replace(/^\d+-/, '').replace(/-/g, ' ')
}

function buildRunDetails(runState = {}) {
  const runDir = runState.dir || ''
  const artifactsDir = runDir ? path.join(runDir, 'artifacts') : ''
  const summaryPath = artifactsDir ? path.join(artifactsDir, 'summary.md') : ''
  const summaryMarkdown = readText(summaryPath)
  const sections = []
  const sessionSections = []

  for (const stepDir of listDirectories(path.join(artifactsDir, 'steps'))) {
    const stepMeta = readJson(path.join(stepDir, 'step.json')) || {}
    const stepTitle = stepTitleFromDir(stepDir, stepMeta)
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
        links: {},
        usage: stepMeta.usage || null,
        markdown: stepSummary,
      })
    }

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
        links: metadata.links || {},
        usage: metadata.usage || null,
        markdown,
      }
      sections.push(section)
      sessionSections.push(section)
    }
  }

  const finalSection = sessionSections[sessionSections.length - 1] || sections[sections.length - 1] || null

  return {
    summaryPath: relativePath(runDir, summaryPath),
    summaryMarkdown,
    finalMarkdown: finalSection?.markdown || summaryMarkdown,
    finalTitle: finalSection?.title || 'Final result',
    sections,
  }
}

module.exports = {
  buildRunDetails,
}
